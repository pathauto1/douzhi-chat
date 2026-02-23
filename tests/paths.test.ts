import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getAppDir,
  getConfigPath,
  getProfileDir,
  getSessionDir,
  getSessionsDir,
} from '../src/paths.js';

describe('Paths', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return default app dir', () => {
    delete process.env.DOUZHI_CHAT_HOME;
    expect(getAppDir()).toBe(path.join(os.homedir(), '.douzhi-chat'));
  });

  it('should respect DOUZHI_CHAT_HOME env var', () => {
    process.env.DOUZHI_CHAT_HOME = '/custom/path';
    expect(getAppDir()).toBe('/custom/path');
  });

  it('should return profile dir for a provider', () => {
    delete process.env.DOUZHI_CHAT_HOME;
    expect(getProfileDir('chatgpt')).toBe(
      path.join(os.homedir(), '.douzhi-chat', 'profiles', 'chatgpt'),
    );
  });

  it('should return sessions dir', () => {
    delete process.env.DOUZHI_CHAT_HOME;
    expect(getSessionsDir()).toBe(path.join(os.homedir(), '.douzhi-chat', 'sessions'));
  });

  it('should return session dir for a specific session', () => {
    delete process.env.DOUZHI_CHAT_HOME;
    expect(getSessionDir('abc-123')).toBe(
      path.join(os.homedir(), '.douzhi-chat', 'sessions', 'abc-123'),
    );
  });

  it('should return config path', () => {
    delete process.env.DOUZHI_CHAT_HOME;
    expect(getConfigPath()).toBe(path.join(os.homedir(), '.douzhi-chat', 'config.json'));
  });
});
