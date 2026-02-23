import { readFile, writeFile } from 'node:fs/promises';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { recordErrorEvent } from '../telemetry/errors.js';

export interface SourceCrawlOptions {
  concurrency?: number;
  timeoutMs?: number;
  maxChars?: number;
}

export interface SourceExtractionResult {
  url: string;
  finalUrl?: string;
  title?: string;
  siteName?: string;
  byline?: string;
  excerpt?: string;
  content?: string;
  wordCount?: number;
  removedNoiseLineCount?: number;
  error?: string;
}

export interface SourceCrawlOutput {
  fetchedAt: string;
  total: number;
  succeeded: number;
  failed: number;
  items: SourceExtractionResult[];
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_MAX_CHARS = 8_000;

const BLOCK_SELECTORS = [
  'script',
  'style',
  'noscript',
  'iframe',
  'svg',
  'canvas',
  'header',
  'footer',
  'nav',
  'aside',
  '[role="banner"]',
  '[role="navigation"]',
  '[role="complementary"]',
  '.advertisement',
  '.ads',
  '.ad',
  '.banner',
  '.sponsor',
  '.sponsored',
  '.recommend',
  '.related',
  '.hot-news',
  '.popular',
  '[class*="ad-"]',
  '[class*="-ad"]',
  '[id*="ad-"]',
  '[id*="-ad"]',
] as const;

const NOISE_LINE_PATTERNS = [
  /^(广告|赞助|推广|商务合作|免责声明|版权声明)[:：]?\s*/i,
  /(下载|打开|安装).{0,8}(APP|应用)/i,
  /^(相关阅读|相关推荐|猜你喜欢|延伸阅读)[:：]?\s*/i,
  /扫码.{0,8}(下载|关注|查看)/i,
  /点击.{0,8}(更多|查看详情|展开全文)/i,
  /责任编辑[:：]/i,
  /来源[:：]\s*[^。]{0,30}$/i,
  /(百度百科是免费编辑平台|无收费代编服务)/i,
  /^(声明|详情)[:：]?$/i,
  /^推荐菜[:：]?$/i,
] as const;

function normalizeUrl(url: string): string {
  return url.replace(/[)\],.;]+$/g, '');
}

export function extractUrlsFromText(input: string): string[] {
  const matches = input.match(/https?:\/\/[^\s<>"']+/g) ?? [];
  const dedup = new Set<string>();
  for (const raw of matches) {
    const normalized = normalizeUrl(raw.trim());
    if (!normalized) continue;
    dedup.add(normalized);
  }
  return [...dedup];
}

function cleanMainText(
  input: string,
  maxChars: number,
): { text: string; removedNoiseLineCount: number } {
  const lines = input
    .split(/\r?\n/)
    .map((line) => line.replace(/\u00a0/g, ' ').trim())
    .filter(Boolean);

  const out: string[] = [];
  let removed = 0;
  let previous = '';

  for (const line of lines) {
    const normalized = line
      .replace(/\[\d+(?:-\d+)?\]/g, '')
      .replace(/[ \t]+/g, ' ')
      .trim();
    if (!normalized) continue;
    if (NOISE_LINE_PATTERNS.some((pattern) => pattern.test(normalized))) {
      removed++;
      continue;
    }
    const alphaNumCount = (normalized.match(/[A-Za-z0-9\u4e00-\u9fa5]/g) ?? []).length;
    if (alphaNumCount > 0 && normalized.length - alphaNumCount > alphaNumCount * 0.8) {
      removed++;
      continue;
    }
    if (normalized.length >= 60 && !/[，。！？；:：.!?,]/.test(normalized)) {
      removed++;
      continue;
    }
    if (normalized === previous) continue;
    out.push(normalized);
    previous = normalized;
  }

  const text = out.join('\n').slice(0, maxChars).trim();
  return { text, removedNoiseLineCount: removed };
}

function removeNoiseNodes(document: Document): void {
  for (const selector of BLOCK_SELECTORS) {
    for (const node of Array.from(document.querySelectorAll(selector))) {
      node.remove();
    }
  }
}

function extractFromHtml(html: string, pageUrl: string, maxChars: number): SourceExtractionResult {
  const dom = new JSDOM(html, { url: pageUrl });
  removeNoiseNodes(dom.window.document);

  const article = new Readability(dom.window.document).parse();
  if (article) {
    const cleaned = cleanMainText(article.textContent ?? '', maxChars);
    return {
      url: pageUrl,
      title: article.title ?? undefined,
      byline: article.byline ?? undefined,
      siteName: article.siteName ?? undefined,
      excerpt: article.excerpt ?? undefined,
      content: cleaned.text || undefined,
      wordCount: cleaned.text ? cleaned.text.length : 0,
      removedNoiseLineCount: cleaned.removedNoiseLineCount,
    };
  }

  const fallbackTitle = dom.window.document.title?.trim() || undefined;
  const fallbackBody = dom.window.document.body?.textContent ?? '';
  const cleaned = cleanMainText(fallbackBody, maxChars);
  return {
    url: pageUrl,
    title: fallbackTitle,
    content: cleaned.text || undefined,
    wordCount: cleaned.text ? cleaned.text.length : 0,
    removedNoiseLineCount: cleaned.removedNoiseLineCount,
  };
}

async function fetchHtml(
  url: string,
  timeoutMs: number,
): Promise<{ finalUrl: string; html: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      throw new Error(`Unsupported content type: ${contentType || 'unknown'}`);
    }

    const html = await response.text();
    return { finalUrl: response.url || url, html };
  } finally {
    clearTimeout(timer);
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runOne(): Promise<void> {
    while (true) {
      const current = nextIndex;
      nextIndex++;
      if (current >= items.length) return;
      results[current] = await worker(items[current], current);
    }
  }

  const count = Math.min(limit, Math.max(items.length, 1));
  await Promise.all(Array.from({ length: count }, () => runOne()));
  return results;
}

export async function crawlSources(
  urls: string[],
  options: SourceCrawlOptions = {},
): Promise<SourceCrawlOutput> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;

  const uniqueUrls = [...new Set(urls.map((url) => normalizeUrl(url.trim())).filter(Boolean))];

  const items = await mapWithConcurrency(uniqueUrls, concurrency, async (url) => {
    const startedAt = Date.now();
    try {
      const { finalUrl, html } = await fetchHtml(url, timeoutMs);
      const extracted = extractFromHtml(html, finalUrl, maxChars);
      return {
        ...extracted,
        url,
        finalUrl,
      } satisfies SourceExtractionResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recordErrorEvent(
        {
          module: 'sources',
          stage: 'fetch_extract',
          url,
          durationMs: Date.now() - startedAt,
          message,
        },
        error,
      );
      return {
        url,
        error: message,
      } satisfies SourceExtractionResult;
    }
  });

  const succeeded = items.filter((item) => !item.error).length;
  const failed = items.length - succeeded;

  return {
    fetchedAt: new Date().toISOString(),
    total: items.length,
    succeeded,
    failed,
    items,
  };
}

export async function loadUrlsFromFile(filePath: string): Promise<string[]> {
  const raw = await readFile(filePath, 'utf-8');
  return extractUrlsFromText(raw);
}

export async function writeCrawlOutput(filePath: string, output: SourceCrawlOutput): Promise<void> {
  await writeFile(filePath, JSON.stringify(output, null, 2), 'utf-8');
}
