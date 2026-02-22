import { mkdir } from 'node:fs/promises';
import { type BrowserContext, chromium, type Page } from 'playwright';
import { getProfileDir } from '../paths.js';
import type { ProviderName } from '../types.js';
import { acquireProfileLock, type ProfileLock } from './lock.js';

export interface BrowserSession {
  context: BrowserContext;
  page: Page;
  lock: ProfileLock;
  close: () => Promise<void>;
}

export interface LaunchOptions {
  provider: ProviderName;
  headless?: boolean;
  /** Initial URL to navigate to after launch. */
  url?: string;
}

/**
 * Launch a Playwright persistent browser context for a provider.
 * The profile directory is per-provider, ensuring login state persists.
 */
export async function launchBrowser(opts: LaunchOptions): Promise<BrowserSession> {
  const { provider, headless = true, url } = opts;
  const profileDir = getProfileDir(provider);
  await mkdir(profileDir, { recursive: true });

  // Acquire lock to prevent concurrent use of the same profile
  const lock = await acquireProfileLock(profileDir);

  let context: BrowserContext;
  let page: Page;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless,
      viewport: { width: 1280, height: 900 },
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });

    page = context.pages()[0] ?? (await context.newPage());

    if (url) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    }
  } catch (error) {
    await lock.release();
    throw error;
  }

  const close = async () => {
    try {
      await context.close();
    } finally {
      await lock.release();
    }
  };

  return { context, page, lock, close };
}
