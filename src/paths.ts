import os from 'node:os';
import path from 'node:path';

const APP_DIR_NAME = '.douzhi-chat';

/** Root directory for all douzhi-chat data: ~/.douzhi-chat */
export function getAppDir(): string {
  return process.env.DOUZHI_CHAT_HOME ?? path.join(os.homedir(), APP_DIR_NAME);
}

/** Profile directory for a specific provider: ~/.douzhi-chat/profiles/<provider> */
export function getProfileDir(provider: string): string {
  return path.join(getAppDir(), 'profiles', provider);
}

/** Sessions root: ~/.douzhi-chat/sessions */
export function getSessionsDir(): string {
  return path.join(getAppDir(), 'sessions');
}

/** Session directory for a specific session: ~/.douzhi-chat/sessions/<id> */
export function getSessionDir(sessionId: string): string {
  return path.join(getSessionsDir(), sessionId);
}

/** Config file path: ~/.douzhi-chat/config.json */
export function getConfigPath(): string {
  return path.join(getAppDir(), 'config.json');
}

/** Error telemetry directory: ~/.douzhi-chat/errors */
export function getErrorsDir(): string {
  return path.join(getAppDir(), 'errors');
}

/** Error telemetry log path: ~/.douzhi-chat/errors/errors.jsonl */
export function getErrorsLogPath(): string {
  return path.join(getErrorsDir(), 'errors.jsonl');
}
