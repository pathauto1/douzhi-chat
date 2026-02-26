import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { getRiskDir, getRiskStatePath } from '../paths.js';
import type { ProviderName } from '../types.js';

export type ChatRunMode = 'headed' | 'headless';

export type RiskOutcomeKind =
  | 'success'
  | 'paused_generation'
  | 'captcha_or_verification'
  | 'http_429'
  | 'auth_required'
  | 'timeout'
  | 'other_error';

interface AttemptEntry {
  at: string;
  mode: ChatRunMode;
  promptHash: string;
}

interface RiskEventEntry {
  at: string;
  kind: RiskOutcomeKind;
  message: string;
}

interface ProviderRiskState {
  lastAttemptAt?: string;
  attempts: AttemptEntry[];
  riskEvents: RiskEventEntry[];
  consecutiveRiskEvents: number;
  cooldownUntil?: string;
  breakerUntil?: string;
}

interface RiskStateFile {
  version: 1;
  providers: Partial<Record<ProviderName, ProviderRiskState>>;
}

interface ProviderRiskPolicy {
  minIntervalMsHeaded: number;
  minIntervalMsHeadless: number;
  attemptsWindowMs: number;
  attemptsLimit: number;
  headlessAttemptsWindowMs: number;
  headlessAttemptsLimit: number;
  samePromptWindowMs: number;
  samePromptLimit: number;
  cooldownOnRateLimitMs: number;
  cooldownByOutcomeMs: Partial<Record<RiskOutcomeKind, number>>;
  breakerConsecutiveRiskThreshold: number;
  breakerDurationMs: number;
}

interface GuardDecision {
  allowed: boolean;
  message?: string;
  waitMs?: number;
}

const DEFAULT_POLICY: ProviderRiskPolicy = {
  minIntervalMsHeaded: 60_000,
  minIntervalMsHeadless: 180_000,
  attemptsWindowMs: 30 * 60_000,
  attemptsLimit: 5,
  headlessAttemptsWindowMs: 60 * 60_000,
  headlessAttemptsLimit: 3,
  samePromptWindowMs: 12 * 60 * 60_000,
  samePromptLimit: 2,
  cooldownOnRateLimitMs: 15 * 60_000,
  cooldownByOutcomeMs: {
    paused_generation: 20 * 60_000,
    captcha_or_verification: 45 * 60_000,
    http_429: 60 * 60_000,
    auth_required: 10 * 60_000,
  },
  breakerConsecutiveRiskThreshold: 3,
  breakerDurationMs: 6 * 60 * 60_000,
};

const POLICY_BY_PROVIDER: Partial<Record<ProviderName, Partial<ProviderRiskPolicy>>> = {
  yuanbao: {
    minIntervalMsHeaded: 3 * 60_000,
    minIntervalMsHeadless: 10 * 60_000,
    attemptsWindowMs: 30 * 60_000,
    attemptsLimit: 3,
    headlessAttemptsWindowMs: 60 * 60_000,
    headlessAttemptsLimit: 2,
    samePromptWindowMs: 24 * 60 * 60_000,
    samePromptLimit: 1,
    cooldownOnRateLimitMs: 30 * 60_000,
  },
  deepseek: {
    minIntervalMsHeaded: 2 * 60_000,
    minIntervalMsHeadless: 5 * 60_000,
    attemptsLimit: 4,
    headlessAttemptsLimit: 2,
    cooldownOnRateLimitMs: 20 * 60_000,
  },
  doubao: {
    minIntervalMsHeaded: 2 * 60_000,
    minIntervalMsHeadless: 5 * 60_000,
    attemptsLimit: 4,
    headlessAttemptsLimit: 2,
    cooldownOnRateLimitMs: 25 * 60_000,
  },
};

function getPolicy(provider: ProviderName): ProviderRiskPolicy {
  return { ...DEFAULT_POLICY, ...POLICY_BY_PROVIDER[provider] };
}

function isoNow(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

function parseIsoOrZero(value?: string): number {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function hashPrompt(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex').slice(0, 16);
}

function isRiskOutcome(kind: RiskOutcomeKind): boolean {
  return (
    kind === 'paused_generation' ||
    kind === 'captcha_or_verification' ||
    kind === 'http_429' ||
    kind === 'auth_required'
  );
}

function defaultProviderState(): ProviderRiskState {
  return {
    attempts: [],
    riskEvents: [],
    consecutiveRiskEvents: 0,
  };
}

async function loadRiskState(): Promise<RiskStateFile> {
  try {
    const raw = await readFile(getRiskStatePath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<RiskStateFile>;
    if (
      parsed &&
      parsed.version === 1 &&
      parsed.providers &&
      typeof parsed.providers === 'object'
    ) {
      return {
        version: 1,
        providers: parsed.providers,
      };
    }
  } catch {
    // fall through
  }

  return { version: 1, providers: {} };
}

async function saveRiskState(state: RiskStateFile): Promise<void> {
  await mkdir(getRiskDir(), { recursive: true });
  await writeFile(getRiskStatePath(), JSON.stringify(state, null, 2), 'utf-8');
}

function pruneState(
  providerState: ProviderRiskState,
  nowMs: number,
  policy: ProviderRiskPolicy,
): void {
  const attemptsRetentionMs = Math.max(
    policy.attemptsWindowMs,
    policy.headlessAttemptsWindowMs,
    policy.samePromptWindowMs,
  );
  providerState.attempts = providerState.attempts.filter(
    (attempt) => parseIsoOrZero(attempt.at) >= nowMs - attemptsRetentionMs,
  );

  const riskRetentionMs = Math.max(policy.breakerDurationMs, 24 * 60 * 60_000);
  providerState.riskEvents = providerState.riskEvents.filter(
    (event) => parseIsoOrZero(event.at) >= nowMs - riskRetentionMs,
  );
}

function enforceRateLimits(
  provider: ProviderName,
  providerState: ProviderRiskState,
  policy: ProviderRiskPolicy,
  nowMs: number,
  mode: ChatRunMode,
  promptHash: string,
): GuardDecision {
  const breakerUntilMs = parseIsoOrZero(providerState.breakerUntil);
  if (breakerUntilMs > nowMs) {
    return {
      allowed: false,
      waitMs: breakerUntilMs - nowMs,
      message: `${provider} risk breaker is active. Retry later.`,
    };
  }

  const cooldownUntilMs = parseIsoOrZero(providerState.cooldownUntil);
  if (cooldownUntilMs > nowMs) {
    return {
      allowed: false,
      waitMs: cooldownUntilMs - nowMs,
      message: `${provider} is cooling down to avoid risk control.`,
    };
  }

  const lastAttemptMs = parseIsoOrZero(providerState.lastAttemptAt);
  const minIntervalMs =
    mode === 'headless' ? policy.minIntervalMsHeadless : policy.minIntervalMsHeaded;
  if (lastAttemptMs > 0 && nowMs - lastAttemptMs < minIntervalMs) {
    return {
      allowed: false,
      waitMs: minIntervalMs - (nowMs - lastAttemptMs),
      message: `${provider} minimum interval not reached (${mode}).`,
    };
  }

  const attemptsInWindow = providerState.attempts.filter(
    (attempt) => parseIsoOrZero(attempt.at) >= nowMs - policy.attemptsWindowMs,
  );
  if (attemptsInWindow.length >= policy.attemptsLimit) {
    providerState.cooldownUntil = isoNow(nowMs + policy.cooldownOnRateLimitMs);
    return {
      allowed: false,
      waitMs: policy.cooldownOnRateLimitMs,
      message: `${provider} request rate is too high in recent window.`,
    };
  }

  if (mode === 'headless') {
    const headlessAttempts = providerState.attempts.filter(
      (attempt) =>
        attempt.mode === 'headless' &&
        parseIsoOrZero(attempt.at) >= nowMs - policy.headlessAttemptsWindowMs,
    );
    if (headlessAttempts.length >= policy.headlessAttemptsLimit) {
      providerState.cooldownUntil = isoNow(nowMs + policy.cooldownOnRateLimitMs);
      return {
        allowed: false,
        waitMs: policy.cooldownOnRateLimitMs,
        message: `${provider} headless request rate is too high.`,
      };
    }
  }

  const samePromptAttempts = providerState.attempts.filter(
    (attempt) =>
      attempt.promptHash === promptHash &&
      parseIsoOrZero(attempt.at) >= nowMs - policy.samePromptWindowMs,
  );
  if (samePromptAttempts.length >= policy.samePromptLimit) {
    providerState.cooldownUntil = isoNow(nowMs + policy.cooldownOnRateLimitMs);
    return {
      allowed: false,
      waitMs: policy.cooldownOnRateLimitMs,
      message: `${provider} repeated prompt pattern detected.`,
    };
  }

  return { allowed: true };
}

export async function evaluateRiskGuard(params: {
  provider: ProviderName;
  mode: ChatRunMode;
  prompt: string;
}): Promise<GuardDecision> {
  const { provider, mode, prompt } = params;
  const nowMs = Date.now();
  const policy = getPolicy(provider);
  const state = await loadRiskState();
  const providerState = state.providers[provider] ?? defaultProviderState();
  pruneState(providerState, nowMs, policy);

  const decision = enforceRateLimits(
    provider,
    providerState,
    policy,
    nowMs,
    mode,
    hashPrompt(prompt),
  );

  state.providers[provider] = providerState;
  await saveRiskState(state);
  return decision;
}

export async function recordRiskAttemptStart(params: {
  provider: ProviderName;
  mode: ChatRunMode;
  prompt: string;
}): Promise<void> {
  const { provider, mode, prompt } = params;
  const nowMs = Date.now();
  const policy = getPolicy(provider);
  const state = await loadRiskState();
  const providerState = state.providers[provider] ?? defaultProviderState();
  pruneState(providerState, nowMs, policy);

  providerState.lastAttemptAt = isoNow(nowMs);
  providerState.attempts.push({
    at: isoNow(nowMs),
    mode,
    promptHash: hashPrompt(prompt),
  });

  state.providers[provider] = providerState;
  await saveRiskState(state);
}

export async function recordRiskOutcome(params: {
  provider: ProviderName;
  kind: RiskOutcomeKind;
  message?: string;
}): Promise<void> {
  const { provider, kind, message = '' } = params;
  const nowMs = Date.now();
  const policy = getPolicy(provider);
  const state = await loadRiskState();
  const providerState = state.providers[provider] ?? defaultProviderState();
  pruneState(providerState, nowMs, policy);

  if (kind === 'success') {
    providerState.consecutiveRiskEvents = 0;
    state.providers[provider] = providerState;
    await saveRiskState(state);
    return;
  }

  providerState.riskEvents.push({
    at: isoNow(nowMs),
    kind,
    message: message.slice(0, 500),
  });

  if (isRiskOutcome(kind)) {
    providerState.consecutiveRiskEvents += 1;
    const cooldownMs = policy.cooldownByOutcomeMs[kind] ?? policy.cooldownOnRateLimitMs;
    const candidateCooldownUntilMs = nowMs + cooldownMs;
    const currentCooldownUntilMs = parseIsoOrZero(providerState.cooldownUntil);
    if (candidateCooldownUntilMs > currentCooldownUntilMs) {
      providerState.cooldownUntil = isoNow(candidateCooldownUntilMs);
    }
  } else {
    providerState.consecutiveRiskEvents = 0;
  }

  if (providerState.consecutiveRiskEvents >= policy.breakerConsecutiveRiskThreshold) {
    const candidateBreakerUntilMs = nowMs + policy.breakerDurationMs;
    const currentBreakerUntilMs = parseIsoOrZero(providerState.breakerUntil);
    if (candidateBreakerUntilMs > currentBreakerUntilMs) {
      providerState.breakerUntil = isoNow(candidateBreakerUntilMs);
    }
  }

  state.providers[provider] = providerState;
  await saveRiskState(state);
}

export function detectRiskOutcomeFromError(error: unknown): RiskOutcomeKind {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (
    message.includes('验证码') ||
    message.includes('captcha') ||
    message.includes('人机验证') ||
    message.includes('verify')
  ) {
    return 'captcha_or_verification';
  }
  if (
    message.includes('http 429') ||
    message.includes('429') ||
    message.includes('too many requests')
  ) {
    return 'http_429';
  }
  if (message.includes('not logged in') || message.includes('login')) {
    return 'auth_required';
  }
  if (message.includes('timeout') || message.includes('timed out')) {
    return 'timeout';
  }
  if (message.includes('暂停生成') || message.includes('paused')) {
    return 'paused_generation';
  }
  return 'other_error';
}

export function detectRiskOutcomeFromResponse(text: string): RiskOutcomeKind {
  const normalized = text.toLowerCase();
  if (normalized.includes('已暂停生成') || normalized.includes('暂停生成')) {
    return 'paused_generation';
  }
  if (
    normalized.includes('验证码') ||
    normalized.includes('captcha') ||
    normalized.includes('人机验证') ||
    normalized.includes('verify')
  ) {
    return 'captcha_or_verification';
  }
  return 'success';
}
