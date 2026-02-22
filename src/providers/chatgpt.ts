import type { Page } from 'playwright';
import type { CapturedResponse, ProviderActions, ProviderConfig } from '../types.js';

export const CHATGPT_CONFIG: ProviderConfig = {
  name: 'chatgpt',
  displayName: 'ChatGPT',
  url: 'https://chatgpt.com',
  loginUrl: 'https://chatgpt.com/auth/login',
  models: ['GPT-4o', 'GPT-4o mini', 'GPT-4.5', 'o1', 'o3-mini'],
  defaultModel: 'GPT-4o',
  defaultTimeoutMs: 5 * 60 * 1000,
};

const SELECTORS = {
  composer:
    '#prompt-textarea, [data-testid="composer-input"], div.ProseMirror[contenteditable="true"]',
  sendButton:
    '#composer-submit-button, button[aria-label="Send prompt"], [data-testid="send-button"]',
  stopButton: 'button[aria-label="Stop streaming"]',
  assistantTurn: '[data-message-author-role="assistant"]',
  loginPage: 'button:has-text("Log in"), button:has-text("Sign up")',
} as const;

export const chatgptActions: ProviderActions = {
  async isLoggedIn(page: Page): Promise<boolean> {
    try {
      // Wait for either composer or login indicators to appear
      await Promise.race([
        page.waitForSelector(SELECTORS.composer, { timeout: 8_000 }),
        page.waitForSelector(SELECTORS.loginPage, { timeout: 8_000 }),
      ]).catch(() => {});

      const composer = await page.$(SELECTORS.composer);
      if (composer) return true;

      const loginButton = await page.$(SELECTORS.loginPage);
      if (loginButton) return false;

      return false;
    } catch {
      return false;
    }
  },

  async submitPrompt(page: Page, prompt: string): Promise<void> {
    const composer = await page.waitForSelector(SELECTORS.composer, { timeout: 15_000 });
    if (!composer) {
      throw new Error(
        'ChatGPT composer not found. The UI may have changed. Try running with --headed to debug.',
      );
    }

    await composer.click();
    await page.keyboard.press('Meta+a');
    await page.keyboard.press('Backspace');

    // Use evaluate for large text to avoid keyboard.type slowness
    try {
      await composer.fill(prompt);
    } catch {
      // contenteditable elements sometimes reject fill() — inject via JS
      await page.evaluate(
        ({ sel, text }) => {
          const el = document.querySelector(sel);
          if (el) {
            (el as HTMLElement).innerText = text;
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
        },
        { sel: SELECTORS.composer, text: prompt },
      );
    }

    await page.waitForTimeout(300);

    const sendButton = await page.waitForSelector(SELECTORS.sendButton, { timeout: 5_000 });
    if (!sendButton) {
      throw new Error('ChatGPT send button not found. The UI may have changed.');
    }
    await sendButton.click();
  },

  async captureResponse(
    page: Page,
    opts: { timeoutMs: number; onChunk?: (chunk: string) => void },
  ): Promise<CapturedResponse> {
    const { timeoutMs, onChunk } = opts;
    const startTime = Date.now();

    // Count existing assistant turns before our submission
    const existingTurns = await page.locator(SELECTORS.assistantTurn).count();

    // Wait for a new assistant turn to appear using Playwright's locator API
    await page.locator(SELECTORS.assistantTurn).nth(existingTurns).waitFor({ timeout: timeoutMs });

    // Poll until the response stops changing (streaming complete)
    let lastText = '';
    let stableCount = 0;
    const STABLE_THRESHOLD = 3;
    const POLL_INTERVAL = 1000;

    while (Date.now() - startTime < timeoutMs) {
      // If stop button is visible, streaming is still in progress — reset stability
      const isStreaming = await page.$(SELECTORS.stopButton);

      const lastTurn = page.locator(SELECTORS.assistantTurn).last();
      const currentText = (await lastTurn.textContent())?.trim() ?? '';

      if (currentText === lastText && !isStreaming) {
        stableCount++;
        if (stableCount >= STABLE_THRESHOLD && currentText.length > 0) {
          break;
        }
      } else {
        if (onChunk && currentText.length > lastText.length) {
          onChunk(currentText.slice(lastText.length));
        }
        lastText = currentText;
        stableCount = 0;
      }

      await page.waitForTimeout(POLL_INTERVAL);
    }

    // Extract the final HTML content
    const lastTurn = page.locator(SELECTORS.assistantTurn).last();
    const markdown = (await lastTurn.innerHTML()) ?? '';

    const elapsed = Date.now() - startTime;
    const truncated = elapsed >= timeoutMs && stableCount < STABLE_THRESHOLD;

    return {
      text: lastText,
      markdown,
      truncated,
      thinkingTime: Math.round(elapsed / 1000),
    };
  },
};
