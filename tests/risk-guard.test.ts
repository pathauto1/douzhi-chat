import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  detectRiskOutcomeFromError,
  detectRiskOutcomeFromResponse,
  evaluateRiskGuard,
  recordRiskAttemptStart,
  recordRiskOutcome,
} from '../src/core/risk-guard.js';
import { getRiskStatePath } from '../src/paths.js';

describe('risk guard', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('should persist attempts and allow the first request', async () => {
    const tmpHome = await mkdtemp(path.join(os.tmpdir(), 'douzhi-risk-first-'));
    process.env.DOUZHI_CHAT_HOME = tmpHome;

    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);

    const decision = await evaluateRiskGuard({
      provider: 'yuanbao',
      mode: 'headed',
      prompt: 'hello risk guard',
    });
    expect(decision.allowed).toBe(true);

    await recordRiskAttemptStart({
      provider: 'yuanbao',
      mode: 'headed',
      prompt: 'hello risk guard',
    });

    const raw = await readFile(getRiskStatePath(), 'utf-8');
    const state = JSON.parse(raw) as {
      providers: {
        yuanbao: {
          attempts: Array<{ mode: string; promptHash: string }>;
        };
      };
    };

    expect(state.providers.yuanbao.attempts.length).toBe(1);
    expect(state.providers.yuanbao.attempts[0].mode).toBe('headed');
    expect(state.providers.yuanbao.attempts[0].promptHash.length).toBe(16);
  });

  it('should block repeated same prompt for yuanbao', async () => {
    const tmpHome = await mkdtemp(path.join(os.tmpdir(), 'douzhi-risk-repeat-'));
    process.env.DOUZHI_CHAT_HOME = tmpHome;

    let nowMs = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);

    await recordRiskAttemptStart({
      provider: 'yuanbao',
      mode: 'headed',
      prompt: 'same prompt',
    });

    nowMs += 4 * 60 * 1000;
    const decision = await evaluateRiskGuard({
      provider: 'yuanbao',
      mode: 'headed',
      prompt: 'same prompt',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.message).toContain('repeated prompt pattern');
    expect(decision.waitMs).toBeGreaterThan(0);
  });

  it('should enable breaker after consecutive risk outcomes', async () => {
    const tmpHome = await mkdtemp(path.join(os.tmpdir(), 'douzhi-risk-breaker-'));
    process.env.DOUZHI_CHAT_HOME = tmpHome;

    let nowMs = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);

    await recordRiskOutcome({
      provider: 'yuanbao',
      kind: 'captcha_or_verification',
      message: 'captcha #1',
    });
    nowMs += 60_000;
    await recordRiskOutcome({
      provider: 'yuanbao',
      kind: 'captcha_or_verification',
      message: 'captcha #2',
    });
    nowMs += 60_000;
    await recordRiskOutcome({
      provider: 'yuanbao',
      kind: 'captcha_or_verification',
      message: 'captcha #3',
    });

    const decision = await evaluateRiskGuard({
      provider: 'yuanbao',
      mode: 'headed',
      prompt: 'new prompt',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.message).toContain('risk breaker is active');
    expect(decision.waitMs).toBeGreaterThan(0);
  });

  it('should classify risk outcomes from errors and responses', () => {
    expect(detectRiskOutcomeFromError(new Error('HTTP 429 Too Many Requests'))).toBe('http_429');
    expect(detectRiskOutcomeFromError(new Error('Not logged in'))).toBe('auth_required');
    expect(detectRiskOutcomeFromError(new Error('验证码校验失败'))).toBe('captcha_or_verification');

    expect(detectRiskOutcomeFromResponse('已暂停生成，请稍后重试')).toBe('paused_generation');
    expect(detectRiskOutcomeFromResponse('Please complete captcha verification')).toBe(
      'captcha_or_verification',
    );
    expect(detectRiskOutcomeFromResponse('正常回答内容')).toBe('success');
  });
});
