import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { getErrorsDir, getErrorsLogPath } from '../paths.js';

export type ErrorModule = 'chat' | 'provider' | 'sources' | 'login' | 'status' | 'cli' | 'unknown';

export interface ErrorEvent {
  module: ErrorModule;
  stage: string;
  message: string;
  errorType?: string;
  provider?: string;
  sessionId?: string;
  url?: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

export interface StoredErrorEvent extends ErrorEvent {
  id: string;
  timestamp: string;
  errorType: string;
}

export interface ErrorQueryOptions {
  last?: number;
  module?: ErrorModule;
  provider?: string;
  errorType?: string;
  stageIncludes?: string;
  sinceHours?: number;
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function classifyErrorType(error: unknown, fallbackMessage?: string): string {
  const message = (fallbackMessage ?? normalizeErrorMessage(error)).toLowerCase();

  if (message.includes('timeout') || message.includes('timed out')) return 'timeout';
  if (message.includes('abort')) return 'aborted';
  if (message.includes('not logged in') || message.includes('login')) return 'auth_required';
  if (message.includes('selector') || message.includes('ui may have changed'))
    return 'ui_selector_changed';
  if (message.includes('unsupported content type')) return 'unsupported_content_type';
  if (message.includes('http 403')) return 'http_403';
  if (message.includes('http 401')) return 'http_401';
  if (message.includes('http 429')) return 'http_429';
  if (message.includes('http 5')) return 'http_5xx';
  if (message.includes('attachment')) return 'attachment_error';
  if (message.includes('network')) return 'network_error';
  return 'unknown_error';
}

export async function recordErrorEvent(input: ErrorEvent, rawError?: unknown): Promise<void> {
  const message = input.message || normalizeErrorMessage(rawError);
  const event: StoredErrorEvent = {
    ...input,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    message,
    errorType: input.errorType ?? classifyErrorType(rawError, message),
  };

  try {
    await mkdir(getErrorsDir(), { recursive: true });
    await appendFile(getErrorsLogPath(), `${JSON.stringify(event)}\n`, 'utf-8');
  } catch {
    // Telemetry must never break business flow.
  }
}

export async function listErrorEvents(
  options: ErrorQueryOptions = {},
): Promise<StoredErrorEvent[]> {
  const { last = 20, module, provider, errorType, stageIncludes, sinceHours } = options;

  let raw = '';
  try {
    raw = await readFile(getErrorsLogPath(), 'utf-8');
  } catch {
    return [];
  }

  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const parsed: StoredErrorEvent[] = [];
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as StoredErrorEvent;
      parsed.push(event);
    } catch {
      // Skip malformed lines.
    }
  }

  const cutoffMs =
    typeof sinceHours === 'number' && Number.isFinite(sinceHours) && sinceHours > 0
      ? Date.now() - sinceHours * 60 * 60 * 1000
      : null;

  const filtered = parsed.filter((event) => {
    if (module && event.module !== module) return false;
    if (provider && event.provider !== provider) return false;
    if (errorType && event.errorType !== errorType) return false;
    if (stageIncludes && !event.stage.toLowerCase().includes(stageIncludes.toLowerCase()))
      return false;
    if (cutoffMs !== null && new Date(event.timestamp).getTime() < cutoffMs) return false;
    return true;
  });

  const limit = Number.isFinite(last) && last > 0 ? Math.floor(last) : 20;
  return filtered.slice(Math.max(filtered.length - limit, 0)).reverse();
}
