import type { Locator, Page } from 'playwright';
import type { CapturedResponse, ProviderActions, ProviderConfig } from '../types.js';

export const DOUBAO_CONFIG: ProviderConfig = {
  name: 'doubao',
  displayName: 'Doubao',
  url: 'https://www.doubao.com/chat/?from_login=1',
  loginUrl: 'https://www.doubao.com/chat/?from_login=1',
  autoHeadedLoginFallback: true,
  defaultTimeoutMs: 5 * 60 * 1000,
};

const COMPOSER_SELECTORS = [
  'textarea',
  '[role="textbox"][contenteditable="true"]',
  'div[contenteditable="true"]',
] as const;

const SEND_BUTTON_SELECTORS = [
  'button[type="submit"]',
  'button[aria-label*="发送"]',
  'button[aria-label*="Send"]',
  'button:has-text("发送")',
  'button:has-text("Send")',
  'div[role="button"]:has-text("发送")',
] as const;

const STOP_BUTTON_SELECTORS = [
  'button[aria-label*="停止"]',
  'button[aria-label*="Stop"]',
  'button:has-text("停止")',
  'button:has-text("Stop")',
] as const;

const LOGIN_INDICATOR_SELECTOR = [
  'button:has-text("登录")',
  'button:has-text("Log in")',
  'button:has-text("Sign in")',
  'text=请输入手机号',
  'text=扫码登录',
  'text=受区域限制，请先登录再使用豆包',
].join(', ');

const lastSubmittedPrompt = new WeakMap<Page, string>();

interface DoubaoSourceLink {
  href: string;
  text: string;
  sourceName?: string;
  summary?: string;
  citationIndex?: string;
  thumbnailUrl?: string;
  detectedDate?: string;
  domain?: string;
}

interface DoubaoTurnSnapshot {
  answerText: string;
  messageBlockCount: number;
  sourceLinks: DoubaoSourceLink[];
}

function normalizeText(text: string): string {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function turnSignature(turn: DoubaoTurnSnapshot): string {
  const sources = turn.sourceLinks.map((source) => source.href).join('|');
  return `${turn.messageBlockCount}\n---\n${turn.answerText}\n---\n${sources}`;
}

function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return url;
  }
}

function formatStructuredResponse(turn: DoubaoTurnSnapshot): { text: string; markdown: string } {
  const lines: string[] = [];
  lines.push('## AI Answer');
  lines.push(turn.answerText || '(empty)');
  lines.push('');
  lines.push('## AI Thinking');
  lines.push('(not available)');
  lines.push('');
  lines.push('## Sources');

  const sources = mergeSources(turn.sourceLinks).slice(0, 20);
  if (sources.length === 0) {
    lines.push('(none)');
  } else {
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i];
      const label = compactSourceLabel(source.text, source.href);
      lines.push(`${i + 1}. ${label}`);
      lines.push(`   ${source.href}`);
      if (source.sourceName) {
        lines.push(`   Source: ${source.sourceName}`);
      } else if (source.domain) {
        lines.push(`   Source: ${source.domain}`);
      }
      if (source.citationIndex) {
        lines.push(`   Citation: ${source.citationIndex}`);
      }
      if (source.detectedDate) {
        lines.push(`   Date: ${source.detectedDate}`);
      }
      if (source.summary) {
        lines.push(`   Summary: ${compactSummary(source.summary)}`);
      }
    }
  }

  const text = lines.join('\n').trim();
  return { text, markdown: text };
}

function compactSourceLabel(text: string, href: string): string {
  const normalized = normalizeText(text);
  if (!normalized) return getDomain(href);
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function compactSummary(text: string): string {
  const normalized = normalizeText(text);
  if (normalized.length <= 180) return normalized;
  return `${normalized.slice(0, 177)}...`;
}

function isInterimAnswer(text: string): boolean {
  const normalized = normalizeText(text).toLowerCase();
  if (!normalized) return true;
  return (
    normalized === '正在搜索' ||
    normalized === '搜索中' ||
    normalized === '正在思考' ||
    normalized === '思考中' ||
    normalized === '正在整理' ||
    normalized === '生成中' ||
    /找到\s*\d+\s*篇资料/.test(normalized) ||
    /分享参考\s*\d+/.test(normalized) ||
    /参考\s*\d+\s*篇资料/.test(normalized)
  );
}

function isTransientExecutionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /Execution context was destroyed/i.test(message) ||
    /Cannot find context with specified id/i.test(message) ||
    /Frame was detached/i.test(message) ||
    /Browsing context has been discarded/i.test(message) ||
    /Target closed/i.test(message)
  );
}

async function extractCurrentTurnSnapshotWithRetry(
  page: Page,
  prompt: string,
  maxAttempts = 6,
): Promise<DoubaoTurnSnapshot> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await extractCurrentTurnSnapshot(page, prompt);
    } catch (error) {
      lastError = error;
      if (page.isClosed() || !isTransientExecutionError(error) || attempt >= maxAttempts - 1) {
        throw error;
      }
      await page.waitForTimeout(Math.min(300 + attempt * 200, 1_000));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Failed to read Doubao response snapshot');
}

async function findFirstVisible(
  page: Page,
  selectors: readonly string[],
  timeoutMs: number,
): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if ((await locator.count()) === 0) continue;
      if (await locator.isVisible().catch(() => false)) return locator;
    }
    await page.waitForTimeout(200);
  }
  return null;
}

async function isAnyVisible(
  page: Page,
  selectors: readonly string[],
  timeoutMs = 300,
): Promise<boolean> {
  const found = await findFirstVisible(page, selectors, timeoutMs);
  return found !== null;
}

function mergeSourcePair(base: DoubaoSourceLink, incoming: DoubaoSourceLink): DoubaoSourceLink {
  return {
    href: incoming.href || base.href,
    text: incoming.text || base.text,
    sourceName: incoming.sourceName || base.sourceName,
    summary: incoming.summary || base.summary,
    citationIndex: incoming.citationIndex || base.citationIndex,
    thumbnailUrl: incoming.thumbnailUrl || base.thumbnailUrl,
    detectedDate: incoming.detectedDate || base.detectedDate,
    domain: incoming.domain || base.domain || getDomain(incoming.href || base.href),
  };
}

function mergeSources(...groups: Array<DoubaoSourceLink[]>): DoubaoSourceLink[] {
  const dedup = new Map<string, DoubaoSourceLink>();
  for (const group of groups) {
    for (const source of group) {
      if (!dedup.has(source.href)) {
        dedup.set(source.href, source);
      } else {
        const existing = dedup.get(source.href);
        if (existing) {
          dedup.set(source.href, mergeSourcePair(existing, source));
        }
      }
    }
  }
  return Array.from(dedup.values());
}

async function openReferencePanel(page: Page): Promise<boolean> {
  await page
    .evaluate(() => {
      const messages = Array.from(
        document.querySelectorAll('[data-testid="receive_message"]'),
      ) as HTMLElement[];
      const last = messages[messages.length - 1];
      if (!last) return;

      last.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
      const rect = last.getBoundingClientRect();
      const x = Math.max(rect.left + 12, 12);
      const y = Math.max(rect.top + 12, 12);
      last.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
      last.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: x, clientY: y }));
    })
    .catch(() => {});
  await page.waitForTimeout(200);

  const candidates = [
    page.getByText(/参考\s*\d+\s*篇资料|参考\s*\d+/).last(),
    page.locator('[data-testid="search-reference-ui-v3"]').last(),
    page
      .locator('div[class*="message-action-button-third"], div[class*="entry-btn"]')
      .filter({ hasText: /参考/ })
      .last(),
    page.locator('span[class*="entry-btn-title"]').filter({ hasText: /参考/ }).last(),
  ];

  for (const candidate of candidates) {
    if ((await candidate.count()) === 0) continue;
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const clicked = await candidate
      .click({ timeout: 1_500 })
      .then(() => true)
      .catch(async () => {
        return candidate
          .click({ timeout: 1_500, force: true })
          .then(() => true)
          .catch(() => false);
      });
    if (clicked) {
      await page.waitForTimeout(700);
      return true;
    }
  }

  const clickedByDom = await page
    .evaluate(() => {
      const normalize = (input: string): string =>
        input
          .replace(/\u00a0/g, ' ')
          .replace(/\r/g, '')
          .replace(/[ \t]+/g, ' ')
          .trim();

      const matchesRefText = (text: string): boolean =>
        /参考\s*\d+\s*篇资料|参考\s*\d+|\d+\s*篇资料/.test(text);

      const nodes = Array.from(document.querySelectorAll('div, span, button, a')).filter((el) => {
        const text = normalize(el.textContent ?? '');
        if (!text || text.length > 80) return false;
        return matchesRefText(text);
      });

      const byPosition = nodes.sort((a, b) => {
        const ar = (a as HTMLElement).getBoundingClientRect();
        const br = (b as HTMLElement).getBoundingClientRect();
        return br.top - ar.top;
      });

      for (const node of byPosition) {
        const target = (node as HTMLElement).closest(
          'button, a, [role="button"], [class*="entry-btn"], [class*="message-action-button-third"], [class*="message-action-bar"]',
        ) as HTMLElement | null;
        const clickable = target ?? (node as HTMLElement);
        const rect = clickable.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 8) continue;
        clickable.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        clickable.click();
        return true;
      }

      return false;
    })
    .catch(() => false);

  if (clickedByDom) {
    await page.waitForTimeout(800);
    return true;
  }

  return false;
}

async function extractExternalLinksFromPage(page: Page): Promise<DoubaoSourceLink[]> {
  return page.evaluate(() => {
    const normalize = (input: string): string =>
      input
        .replace(/\u00a0/g, ' ')
        .replace(/\r/g, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    const links: Array<{
      href: string;
      text: string;
      sourceName?: string;
      domain?: string;
    }> = [];
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    for (const anchor of anchors) {
      const href = normalize(anchor.getAttribute('href') ?? '');
      if (!/^https?:\/\//i.test(href)) continue;
      if (
        (() => {
          try {
            const host = new URL(href).hostname.toLowerCase();
            return host.endsWith('doubao.com') || host.endsWith('doubao.cn');
          } catch {
            return true;
          }
        })()
      ) {
        continue;
      }
      const text = normalize(
        (anchor as HTMLElement).innerText ||
          anchor.getAttribute('title') ||
          anchor.textContent ||
          '',
      );
      let domain = '';
      try {
        domain = new URL(href).hostname.replace(/^www\./i, '');
      } catch {}
      links.push({ href, text, sourceName: domain, domain });
    }

    const dedup = new Map<
      string,
      {
        href: string;
        text: string;
        sourceName?: string;
        domain?: string;
      }
    >();
    for (const link of links) {
      if (!dedup.has(link.href) || (!dedup.get(link.href)?.text && link.text)) {
        dedup.set(link.href, link);
      }
    }

    return Array.from(dedup.values());
  });
}

async function extractReferencePanelLinks(page: Page): Promise<DoubaoSourceLink[]> {
  return page.evaluate(() => {
    const decodeHtml = (input: string): string => {
      const textarea = document.createElement('textarea');
      textarea.innerHTML = input;
      return textarea.value;
    };

    const normalize = (input: string): string =>
      input
        .replace(/\u00a0/g, ' ')
        .replace(/\r/g, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    const isCitationUrl = (href: string): boolean => {
      try {
        const url = new URL(href);
        const host = url.hostname.toLowerCase();
        if (host.endsWith('doubao.com') || host.endsWith('doubao.cn')) return false;
        if (
          host.endsWith('byteimg.com') ||
          host.endsWith('bytedapm.com') ||
          host.endsWith('ibytedapm.com') ||
          host.endsWith('w3.org')
        ) {
          return false;
        }
        return true;
      } catch {
        return false;
      }
    };

    const links: Array<{
      href: string;
      text: string;
      sourceName?: string;
      summary?: string;
      citationIndex?: string;
      thumbnailUrl?: string;
      detectedDate?: string;
      domain?: string;
    }> = [];
    const itemAnchors = Array.from(
      document.querySelectorAll(
        'a.search-lIUYwC[href], [data-testid="search-text-item"] a[href], [class*="search-item"] a[href]',
      ),
    );
    for (const anchor of itemAnchors) {
      const href = decodeHtml(normalize(anchor.getAttribute('href') ?? ''));
      if (!/^https?:\/\//i.test(href)) continue;
      if (!isCitationUrl(href)) continue;

      const itemRoot = anchor.closest(
        '[data-testid="search-text-item"], [class*="search-item-transition"], [class*="search-item"]',
      ) as HTMLElement | null;
      const titleNode = itemRoot?.querySelector(
        'div[class*="search-item-title"]',
      ) as HTMLElement | null;
      const footerNode = itemRoot?.querySelector(
        'span[class*="footer-title"]',
      ) as HTMLElement | null;
      const titleText = normalize(titleNode?.innerText || anchor.textContent || '');
      const footerText = normalize(footerNode?.innerText || '');
      const summaryNode = itemRoot?.querySelector(
        'div[class*="search-item-summary"]',
      ) as HTMLElement | null;
      const citationNode = itemRoot?.querySelector(
        'span[class*="footer-citation"]',
      ) as HTMLElement | null;
      const thumbNode = itemRoot?.querySelector(
        'img[class*="footer-icon"]',
      ) as HTMLImageElement | null;

      const summary = normalize(summaryNode?.innerText || '');
      const citationIndex = normalize(citationNode?.innerText || '');
      const detectedDate =
        summary.match(/20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}(?:\s+\d{1,2}:\d{2})?/)?.[0] ?? '';
      let domain = '';
      try {
        domain = new URL(href).hostname.replace(/^www\./i, '');
      } catch {}

      links.push({
        href,
        text: titleText,
        sourceName: footerText || domain,
        summary,
        citationIndex,
        thumbnailUrl: thumbNode?.src || '',
        detectedDate,
        domain,
      });
    }

    // Fallback: parse the rendered page source and zip title order with URL order.
    if (links.length === 0) {
      const titles = Array.from(document.querySelectorAll('div[class*="search-item-title"]'))
        .map((node) => normalize((node as HTMLElement).innerText || node.textContent || ''))
        .filter(Boolean);

      const html = document.documentElement.outerHTML;
      const urlMatches = html.match(/https?:\/\/[^"'\\s<>]+/g) ?? [];
      const urls = Array.from(
        new Set(
          urlMatches
            .map((raw) => decodeHtml(normalize(raw)))
            .filter((url) => /^https?:\/\//i.test(url))
            .filter((url) => isCitationUrl(url)),
        ),
      );

      const total = Math.min(titles.length, urls.length, 30);
      for (let i = 0; i < total; i++) {
        let domain = '';
        try {
          domain = new URL(urls[i]).hostname.replace(/^www\./i, '');
        } catch {}
        links.push({
          href: urls[i],
          text: titles[i],
          sourceName: domain,
          domain,
        });
      }
    }

    const dedup = new Map<
      string,
      {
        href: string;
        text: string;
        sourceName?: string;
        summary?: string;
        citationIndex?: string;
        thumbnailUrl?: string;
        detectedDate?: string;
        domain?: string;
      }
    >();
    for (const link of links) {
      if (
        !dedup.has(link.href) ||
        (!dedup.get(link.href)?.text && link.text) ||
        (!dedup.get(link.href)?.summary && link.summary)
      ) {
        dedup.set(link.href, link);
      }
    }

    return Array.from(dedup.values());
  });
}

async function extractReferenceLinksViaPopup(page: Page): Promise<DoubaoSourceLink[]> {
  const context = page.context();
  const beforeUrl = page.url();
  const popupPromise = context.waitForEvent('page', { timeout: 3_000 }).catch(() => null);

  const clicked = await openReferencePanel(page);
  if (!clicked) return [];

  const popup = await popupPromise;
  if (popup) {
    try {
      await popup.waitForLoadState('domcontentloaded', { timeout: 8_000 }).catch(() => {});
      const links = await extractExternalLinksFromPage(popup).catch(() => []);
      return links;
    } finally {
      if (!popup.isClosed()) {
        await popup.close().catch(() => {});
      }
    }
  }

  await page.waitForTimeout(600);
  const afterUrl = page.url();
  if (afterUrl !== beforeUrl && /reference|search|source|cite|citation/i.test(afterUrl)) {
    try {
      const links = await extractExternalLinksFromPage(page).catch(() => []);
      return links;
    } finally {
      await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
    }
  }

  return [];
}

async function collectReferenceSources(page: Page): Promise<DoubaoSourceLink[]> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    await page
      .evaluate(() => {
        const messages = Array.from(
          document.querySelectorAll('[data-testid="receive_message"]'),
        ) as HTMLElement[];
        const last = messages[messages.length - 1];
        if (!last) return;
        const rect = last.getBoundingClientRect();
        const x = Math.max(rect.left + 8, 8);
        const y = Math.max(rect.top + 8, 8);
        last.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
        last.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: x, clientY: y }));
      })
      .catch(() => {});

    const baseline = await extractReferencePanelLinks(page).catch(() => []);
    if (baseline.length > 0) return baseline;

    const popupLinks = await extractReferenceLinksViaPopup(page).catch(() => []);
    if (popupLinks.length > 0) return popupLinks;

    await openReferencePanel(page).catch(() => false);
    const expanded = await extractReferencePanelLinks(page).catch(() => []);
    if (expanded.length > 0) return expanded;

    await page.waitForTimeout(900);
  }

  return [];
}

async function extractCurrentTurnSnapshot(page: Page, prompt: string): Promise<DoubaoTurnSnapshot> {
  return page.evaluate(
    ({ promptText }) => {
      const root = document.querySelector('main') ?? document.body;
      const primary = Array.from(root.querySelectorAll('[data-testid="message-block-container"]'));
      const fallbacks = [
        '[data-testid*="assistant"]',
        '[class*="assistant-message"]',
        '[class*="message-assistant"]',
        '[class*="assistant"]',
        '[class*="answer"]',
      ];
      const nodes = [
        ...primary,
        ...fallbacks.flatMap((selector) => Array.from(root.querySelectorAll(selector))),
      ];
      const uniqueNodes = Array.from(new Set(nodes));

      let answerText = '';
      let selectedNode: Element | null = null;
      let bestScore = Number.NEGATIVE_INFINITY;

      for (const node of uniqueNodes) {
        const htmlNode = node as HTMLElement;
        const className = String(htmlNode.className ?? '');
        const hasReceiveMarker =
          htmlNode.matches('[data-testid="receive_message"]') ||
          htmlNode.querySelector('[data-testid="receive_message"]') !== null;
        const hasSendMarker =
          htmlNode.matches('[data-testid="send_message"]') ||
          htmlNode.querySelector('[data-testid="send_message"]') !== null;

        if (hasSendMarker && !hasReceiveMarker) continue;
        if (
          /suggest|message-list|history|sidebar|composer|input|textarea|header|footer|message-action|entry-btn|search-item-footer|citation/i.test(
            className,
          )
        ) {
          continue;
        }

        const rect = htmlNode.getBoundingClientRect();
        if (rect.width < 40 || rect.height < 20) continue;

        const clone = htmlNode.cloneNode(true) as HTMLElement;
        for (const suggestNode of Array.from(clone.querySelectorAll('[class*="suggest"]'))) {
          suggestNode.remove();
        }

        const text = (clone.innerText ?? htmlNode.innerText ?? '')
          .replace(/\u00a0/g, ' ')
          .replace(/\r/g, '')
          .replace(/[ \t]+/g, ' ')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
        const lower = text.toLowerCase();
        if (!text) continue;
        if (promptText && text === promptText) continue;
        if (
          lower === '正在搜索' ||
          lower === '搜索中' ||
          lower === '正在思考' ||
          lower === '思考中' ||
          lower === '正在整理' ||
          lower === '生成中' ||
          /找到\s*\d+\s*篇资料/.test(lower) ||
          /分享参考\s*\d+/.test(lower) ||
          /参考\s*\d+\s*篇资料/.test(lower)
        ) {
          continue;
        }

        if (
          lower.includes('请输入手机号') ||
          lower.includes('扫码登录') ||
          lower.includes('受区域限制') ||
          /参考\s*\d+\s*篇资料|分享参考\s*\d+/.test(lower)
        ) {
          continue;
        }

        let score = 0;
        if (hasReceiveMarker) score += 260;
        if (/message-block-container/i.test(className)) score += 200;
        score += rect.top * 2;
        score += Math.min(text.length, 3000) / 20;
        if (text.includes('你好，我是豆包')) score -= 200;
        if (promptText && text.includes(promptText)) score -= 120;
        if (lower.includes('新对话')) score -= 120;

        if (score >= bestScore) {
          bestScore = score;
          answerText = text;
          selectedNode = node;
        }
      }

      const sourceLinks: Array<{ href: string; text: string; domain?: string }> = [];
      if (selectedNode) {
        const anchors = Array.from(selectedNode.querySelectorAll('a[href]'));
        for (const anchor of anchors) {
          const href = (anchor.getAttribute('href') ?? '').trim();
          if (!/^https?:\/\//i.test(href)) continue;
          const text = (anchor.textContent ?? '')
            .replace(/\u00a0/g, ' ')
            .replace(/\r/g, '')
            .replace(/[ \t]+/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
          let domain = '';
          try {
            domain = new URL(href).hostname.replace(/^www\./i, '');
          } catch {}
          sourceLinks.push({ href, text, domain });
        }
      }

      const dedup = new Map<string, { href: string; text: string; domain?: string }>();
      for (const source of sourceLinks) {
        if (!dedup.has(source.href)) dedup.set(source.href, source);
      }

      return {
        answerText,
        messageBlockCount: primary.length,
        sourceLinks: Array.from(dedup.values()),
      };
    },
    { promptText: prompt },
  );
}

export const doubaoActions: ProviderActions = {
  async isLoggedIn(page: Page): Promise<boolean> {
    try {
      await Promise.race([
        findFirstVisible(page, COMPOSER_SELECTORS, 8_000),
        page.waitForSelector(LOGIN_INDICATOR_SELECTOR, { timeout: 8_000 }).catch(() => null),
      ]);

      const composer = await findFirstVisible(page, COMPOSER_SELECTORS, 1_000);
      if (composer) return true;

      const loginIndicator = page.locator(LOGIN_INDICATOR_SELECTOR).first();
      if (
        (await loginIndicator.count()) > 0 &&
        (await loginIndicator.isVisible().catch(() => false))
      ) {
        return false;
      }

      return false;
    } catch {
      return false;
    }
  },

  async submitPrompt(page: Page, prompt: string): Promise<void> {
    const composer = await findFirstVisible(page, COMPOSER_SELECTORS, 15_000);
    if (!composer) {
      throw new Error(
        'Doubao composer not found. The UI may have changed. Try running with --headed to debug.',
      );
    }

    await composer.click();
    const tagName = await composer.evaluate((el) => el.tagName.toLowerCase()).catch(() => 'div');

    if (tagName === 'textarea' || tagName === 'input') {
      await composer.fill(prompt);
    } else {
      await page.keyboard.press('Meta+a').catch(() => {});
      await page.keyboard.press('Backspace').catch(() => {});
      await page.keyboard.type(prompt, { delay: 8 });
    }

    const sendButton = await findFirstVisible(page, SEND_BUTTON_SELECTORS, 6_000);
    if (sendButton) {
      await sendButton.click();
      lastSubmittedPrompt.set(page, prompt);
      return;
    }

    await page.keyboard.press('Enter');
    lastSubmittedPrompt.set(page, prompt);
  },

  async captureResponse(
    page: Page,
    opts: { timeoutMs: number; onChunk?: (chunk: string) => void },
  ): Promise<CapturedResponse> {
    const { timeoutMs, onChunk } = opts;
    const startTime = Date.now();
    const prompt = lastSubmittedPrompt.get(page) ?? '';
    const baseline = await extractCurrentTurnSnapshotWithRetry(page, prompt);
    const baselineSignature = turnSignature(baseline);

    let sawNewTurn = false;
    let lastSnapshot = baseline;
    let lastSignature = baselineSignature;
    let lastStreamedAnswer = '';
    let stableCount = 0;

    const STABLE_THRESHOLD = 2;
    const POLL_INTERVAL = 700;

    while (Date.now() - startTime < timeoutMs) {
      if (page.url().toLowerCase().includes('/security/doubao-region-ban')) {
        throw new Error('Doubao access blocked by region-ban page');
      }

      const current = await extractCurrentTurnSnapshotWithRetry(page, prompt);
      const currentSignature = turnSignature(current);

      if (!sawNewTurn && currentSignature !== baselineSignature && current.answerText.length > 0) {
        sawNewTurn = true;
      }

      if (sawNewTurn) {
        if (
          current.answerText.length > lastStreamedAnswer.length &&
          current.answerText.startsWith(lastStreamedAnswer)
        ) {
          if (onChunk) onChunk(current.answerText.slice(lastStreamedAnswer.length));
          lastStreamedAnswer = current.answerText;
        } else if (lastStreamedAnswer.length === 0 && current.answerText.length > 0) {
          if (onChunk) onChunk(current.answerText);
          lastStreamedAnswer = current.answerText;
        }

        if (currentSignature === lastSignature) {
          const isStreaming = await isAnyVisible(page, STOP_BUTTON_SELECTORS, 200);
          if (!isStreaming) {
            if (isInterimAnswer(current.answerText)) {
              stableCount = 0;
              await page.waitForTimeout(POLL_INTERVAL);
              continue;
            }
            stableCount++;
            if (stableCount >= STABLE_THRESHOLD) break;
          }
        } else {
          lastSignature = currentSignature;
          lastSnapshot = current;
          stableCount = 0;
        }
      }

      await page.waitForTimeout(POLL_INTERVAL);
    }

    if (!sawNewTurn && lastStreamedAnswer.length === 0) {
      throw new Error('Timed out waiting for Doubao assistant response');
    }

    const elapsed = Date.now() - startTime;
    lastSubmittedPrompt.delete(page);

    if (sawNewTurn) {
      const extraSources = await collectReferenceSources(page).catch(() => []);
      if (extraSources.length > 0) {
        lastSnapshot = {
          ...lastSnapshot,
          sourceLinks: mergeSources(lastSnapshot.sourceLinks, extraSources),
        };
      }
    }

    const formatted = sawNewTurn
      ? formatStructuredResponse({
          ...lastSnapshot,
          answerText: normalizeText(lastSnapshot.answerText),
        })
      : {
          text: '## AI Answer\n(empty)\n\n## AI Thinking\n(not available)\n\n## Sources\n(none)',
          markdown:
            '## AI Answer\n(empty)\n\n## AI Thinking\n(not available)\n\n## Sources\n(none)',
        };

    return {
      text: formatted.text,
      markdown: formatted.markdown,
      truncated: elapsed >= timeoutMs && stableCount < STABLE_THRESHOLD,
      thinkingTime: Math.round(elapsed / 1000),
    };
  },
};
