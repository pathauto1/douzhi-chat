import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  crawlSources,
  extractUrlsFromText,
  loadUrlsFromFile,
  writeCrawlOutput,
} from '../src/core/sources.js';

const originalEnv = process.env;

beforeEach(async () => {
  process.env = { ...originalEnv };
  process.env.DOUZHI_CHAT_HOME = await mkdtemp(path.join(os.tmpdir(), 'douzhi-test-home-'));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env = originalEnv;
});

function htmlResponse(html: string): Response {
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
    },
  });
}

describe('extractUrlsFromText', () => {
  it('should extract and deduplicate URLs', () => {
    const input = `
      See https://example.com/a.
      And also https://example.com/b)
      Duplicate: https://example.com/a
    `;
    const urls = extractUrlsFromText(input);
    expect(urls).toEqual(['https://example.com/a', 'https://example.com/b']);
  });

  it('should handle markdown-like URLs and trailing punctuation', () => {
    const input = `
      [one](https://news.example.com/a),
      [two](https://news.example.com/b);
      duplicate: https://news.example.com/a.
    `;
    const urls = extractUrlsFromText(input);
    expect(urls).toEqual(['https://news.example.com/a', 'https://news.example.com/b']);
  });
});

describe('crawlSources', () => {
  it('should return extraction result from HTML and filter noisy lines', async () => {
    const html = `
      <html>
        <head>
          <title>Test Article</title>
        </head>
        <body>
          <article>
            <h1>A Good Title</h1>
            <p>This is the core paragraph one.</p>
            <p>相关阅读：something noisy</p>
            <p>This is the core paragraph two.</p>
          </article>
          <div class="advertisement">AD BLOCK</div>
        </body>
      </html>
    `;

    const fetchMock = vi.fn(async () => htmlResponse(html));
    vi.stubGlobal('fetch', fetchMock);

    const output = await crawlSources(['https://example.com/test']);
    expect(output.total).toBe(1);
    expect(output.failed).toBe(0);
    expect(output.items[0].title).toBeTruthy();
    expect(output.items[0].content).toContain('core paragraph one');
    expect(output.items[0].content).toContain('core paragraph two');
    expect(output.items[0].content).not.toContain('相关阅读');
    expect(output.items[0].removedNoiseLineCount).toBeGreaterThanOrEqual(1);
  });

  it('should keep processing when some URLs fail', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('ok.example.com')) {
        return htmlResponse(
          '<html><head><title>OK</title></head><body><article><p>valid content.</p></article></body></html>',
        );
      }
      if (url.includes('nonhtml.example.com')) {
        return new Response('binary', {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        });
      }
      return new Response('fail', { status: 503 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const output = await crawlSources([
      'https://ok.example.com/post',
      'https://nonhtml.example.com/file',
      'https://down.example.com/x',
    ]);

    expect(output.total).toBe(3);
    expect(output.succeeded).toBe(1);
    expect(output.failed).toBe(2);
    expect(output.items.find((item) => item.url.includes('ok.example.com'))?.content).toContain(
      'valid content',
    );
    expect(output.items.find((item) => item.url.includes('nonhtml.example.com'))?.error).toContain(
      'Unsupported content type',
    );
    expect(output.items.find((item) => item.url.includes('down.example.com'))?.error).toContain(
      'HTTP 503',
    );
  });

  it('should deduplicate normalized URLs before fetching', async () => {
    const fetchMock = vi.fn(async () =>
      htmlResponse(
        '<html><head><title>Dup</title></head><body><article><p>same url body</p></article></body></html>',
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const output = await crawlSources([
      'https://dup.example.com/a)',
      'https://dup.example.com/a',
      'https://dup.example.com/a;',
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(output.total).toBe(1);
    expect(output.succeeded).toBe(1);
  });

  it('should trim extracted content to maxChars', async () => {
    const longText = 'A long sentence with punctuation. '.repeat(200);
    const fetchMock = vi.fn(async () =>
      htmlResponse(
        `<html><head><title>Long</title></head><body><article><p>${longText}</p></article></body></html>`,
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const output = await crawlSources(['https://long.example.com'], { maxChars: 120 });
    const item = output.items[0];
    expect(item.content?.length).toBeLessThanOrEqual(120);
    expect(item.wordCount).toBe(item.content?.length ?? 0);
  });

  it('should report timeout/abort errors per URL', async () => {
    const fetchMock = vi.fn(async () => {
      throw new DOMException('The operation was aborted', 'AbortError');
    });
    vi.stubGlobal('fetch', fetchMock);

    const output = await crawlSources(['https://timeout.example.com'], { timeoutMs: 5 });
    expect(output.failed).toBe(1);
    expect((output.items[0].error ?? '').toLowerCase()).toContain('aborted');
  });
});

describe('source file io', () => {
  it('should load URLs from file and write crawl output', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'douzhi-sources-'));
    const inputPath = path.join(dir, 'input.md');
    const outputPath = path.join(dir, 'output.json');

    await writeFile(
      inputPath,
      'source1: https://io.example.com/a\nsource2: https://io.example.com/b',
      'utf-8',
    );

    const urls = await loadUrlsFromFile(inputPath);
    expect(urls).toEqual(['https://io.example.com/a', 'https://io.example.com/b']);

    await writeCrawlOutput(outputPath, {
      fetchedAt: '2026-02-23T00:00:00.000Z',
      total: 2,
      succeeded: 2,
      failed: 0,
      items: [
        { url: 'https://io.example.com/a', title: 'A' },
        { url: 'https://io.example.com/b', title: 'B' },
      ],
    });

    const raw = await readFile(outputPath, 'utf-8');
    const parsed = JSON.parse(raw) as { total: number; items: Array<{ title?: string }> };
    expect(parsed.total).toBe(2);
    expect(parsed.items[1].title).toBe('B');
  });
});
