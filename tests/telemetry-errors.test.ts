import { appendFile, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getErrorsLogPath } from '../src/paths.js';
import { classifyErrorType, listErrorEvents, recordErrorEvent } from '../src/telemetry/errors.js';

describe('error telemetry', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should classify common error categories', () => {
    expect(classifyErrorType(new Error('HTTP 503'))).toBe('http_5xx');
    expect(classifyErrorType(new Error('Login timed out'))).toBe('timeout');
    expect(classifyErrorType(new Error('Unsupported content type: application/pdf'))).toBe(
      'unsupported_content_type',
    );
  });

  it('should write error events to local jsonl log', async () => {
    const tmpHome = await mkdtemp(path.join(os.tmpdir(), 'douzhi-errors-'));
    process.env.DOUZHI_CHAT_HOME = tmpHome;

    await recordErrorEvent(
      {
        module: 'sources',
        stage: 'fetch_extract',
        message: 'HTTP 503',
        url: 'https://example.com/x',
      },
      new Error('HTTP 503'),
    );

    const raw = await readFile(getErrorsLogPath(), 'utf-8');
    const lines = raw.trim().split('\n');
    expect(lines.length).toBe(1);

    const event = JSON.parse(lines[0]) as {
      module: string;
      stage: string;
      errorType: string;
      message: string;
      url: string;
      id: string;
      timestamp: string;
    };

    expect(event.module).toBe('sources');
    expect(event.stage).toBe('fetch_extract');
    expect(event.errorType).toBe('http_5xx');
    expect(event.message).toBe('HTTP 503');
    expect(event.url).toBe('https://example.com/x');
    expect(event.id.length).toBeGreaterThan(10);
    expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp);
  });

  it('should query and filter error events', async () => {
    const tmpHome = await mkdtemp(path.join(os.tmpdir(), 'douzhi-errors-query-'));
    process.env.DOUZHI_CHAT_HOME = tmpHome;

    await recordErrorEvent({
      module: 'chat',
      stage: 'capture_response',
      message: 'Timed out waiting for response',
      provider: 'deepseek',
    });
    await recordErrorEvent({
      module: 'sources',
      stage: 'fetch_extract',
      message: 'HTTP 503',
      provider: 'yuanbao',
    });
    await recordErrorEvent({
      module: 'login',
      stage: 'wait_for_user_login',
      message: 'Login timed out',
      provider: 'yuanbao',
    });

    // Append one bad line to verify parser robustness.
    await appendFile(getErrorsLogPath(), '{bad-json}\n', 'utf-8');

    const all = await listErrorEvents({ last: 10 });
    expect(all.length).toBe(3);

    const onlySources = await listErrorEvents({ module: 'sources', last: 10 });
    expect(onlySources.length).toBe(1);
    expect(onlySources[0].module).toBe('sources');

    const onlyYuanbao = await listErrorEvents({ provider: 'yuanbao', last: 10 });
    expect(onlyYuanbao.length).toBe(2);

    const onlyTimeout = await listErrorEvents({ errorType: 'timeout', last: 10 });
    expect(onlyTimeout.length).toBe(2);
  });
});
