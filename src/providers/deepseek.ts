import type { Locator, Page } from 'playwright';
import type { CapturedResponse, ProviderActions, ProviderConfig } from '../types.js';

export const DEEPSEEK_CONFIG: ProviderConfig = {
  name: 'deepseek',
  displayName: 'DeepSeek',
  url: 'https://chat.deepseek.com/',
  loginUrl: 'https://chat.deepseek.com/',
  defaultTimeoutMs: 5 * 60 * 1000,
};

const COMPOSER_SELECTORS = [
  'textarea[placeholder]',
  'textarea',
  '[role="textbox"]',
  'div[contenteditable="true"][role="textbox"]',
  'div[contenteditable="true"]',
] as const;

const SEND_BUTTON_SELECTORS = [
  'button[type="submit"]',
  'button[aria-label*="Send"]',
  'button[aria-label*="发送"]',
  'button:has-text("Send")',
  'button:has-text("发送")',
] as const;

const STOP_BUTTON_SELECTORS = [
  'button[aria-label*="Stop"]',
  'button:has-text("Stop")',
  'button:has-text("停止")',
] as const;

const LOGIN_INDICATOR_SELECTOR = [
  'button:has-text("Log in")',
  'button:has-text("Sign in")',
  'button:has-text("登录")',
  'a:has-text("Log in")',
  'a:has-text("Sign in")',
  'a:has-text("登录")',
].join(', ');

const DEEPTHINK_NAME_PATTERNS = [/^DeepThink$/i, /^深度思考$/];
const SEARCH_NAME_PATTERNS = [/^Search$/i, /^搜索$/, /^联网搜索$/];

const lastSubmittedPrompt = new WeakMap<Page, string>();

interface DeepseekTurnSnapshot {
  answerText: string;
  sourceCount: number;
  citationIds: string[];
}

function deepseekTurnSignature(turn: DeepseekTurnSnapshot): string {
  return [turn.answerText, String(turn.sourceCount), turn.citationIds.join(',')].join('\n---\n');
}

function formatStructuredResponse(turn: DeepseekTurnSnapshot): { text: string; markdown: string } {
  const lines: string[] = [];
  lines.push('## AI Answer');
  lines.push(turn.answerText || '(empty)');
  lines.push('');
  lines.push('## AI Thinking');
  lines.push('(not available)');
  lines.push('');
  lines.push('## Sources');

  if (turn.sourceCount > 0) {
    lines.push(`Web pages referenced: ${turn.sourceCount}`);
  } else {
    lines.push('(none)');
  }

  if (turn.citationIds.length > 0) {
    lines.push(`Inline citations: ${turn.citationIds.join(', ')}`);
  }

  const text = lines.join('\n').trim();
  return { text, markdown: text };
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
  const locator = await findFirstVisible(page, selectors, timeoutMs);
  return locator !== null;
}

function normalizeText(text: string): string {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function findToggleButton(
  page: Page,
  patterns: RegExp[],
  timeoutMs = 3_000,
): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const pattern of patterns) {
      const roleButton = page.getByRole('button', { name: pattern }).last();
      if ((await roleButton.count()) > 0 && (await roleButton.isVisible().catch(() => false))) {
        return roleButton;
      }

      const divButton = page.locator('div[role="button"]', { hasText: pattern }).last();
      if ((await divButton.count()) > 0 && (await divButton.isVisible().catch(() => false))) {
        return divButton;
      }
    }
    await page.waitForTimeout(120);
  }
  return null;
}

async function isToggleSelected(toggle: Locator): Promise<boolean> {
  try {
    return await toggle.evaluate((el) => {
      const className = (el as HTMLElement).className ?? '';
      const ariaPressed = el.getAttribute('aria-pressed') ?? '';
      const dataState = el.getAttribute('data-state') ?? '';
      return /selected|active|checked|ds-toggle-button--selected/i.test(
        `${className} ${ariaPressed} ${dataState}`,
      );
    });
  } catch {
    return false;
  }
}

async function setToggleState(toggle: Locator, expectedOn: boolean): Promise<void> {
  const isOn = await isToggleSelected(toggle);
  if (isOn === expectedOn) return;

  await toggle.click({ timeout: 3_000 }).catch(async () => {
    await toggle.click({ timeout: 2_000, force: true }).catch(() => {});
  });
  await toggle.page().waitForTimeout(150);
}

async function ensureSearchEnabledDeepThinkDisabled(page: Page): Promise<void> {
  const deepThink = await findToggleButton(page, DEEPTHINK_NAME_PATTERNS, 5_000);
  if (deepThink) {
    await setToggleState(deepThink, false);
  }

  const search = await findToggleButton(page, SEARCH_NAME_PATTERNS, 5_000);
  if (!search) {
    throw new Error('DeepSeek Search toggle not found. The UI may have changed.');
  }
  await setToggleState(search, true);
}

async function extractCurrentTurnSnapshot(
  page: Page,
  prompt: string,
): Promise<DeepseekTurnSnapshot> {
  return page.evaluate(
    ({ promptText }) => {
      const containers = Array.from(document.querySelectorAll('div.ds-scroll-area'));
      const visible = containers.filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      const candidates = [...visible, ...containers];

      let text = '';
      const sidebarPattern = /\n(?:Today|Yesterday|30 Days|New chat)\n/i;

      const promptCandidates = candidates
        .map((candidate) => {
          let candidateText = (candidate as HTMLElement).innerText ?? '';
          candidateText = candidateText
            .replace(/\u00a0/g, ' ')
            .replace(/\r/g, '')
            .replace(/[ \t]+/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
          if (!candidateText) return null;

          const rect = (candidate as HTMLElement).getBoundingClientRect();
          const hasPrompt = !!promptText && candidateText.includes(promptText);
          const hasSidebar = sidebarPattern.test(candidateText);
          const hasFooter = /AI-generated, for reference only/i.test(candidateText);
          const hasRead = /Read\s+\d+\s+web\s+pages/i.test(candidateText);

          if (!hasPrompt) return null;

          // Prefer answer blocks in the main content pane over global containers.
          let score = 0;
          if (rect.left > 220) score += 30;
          if (rect.width > 450 && rect.width < 950) score += 35;
          if (hasRead) score += 15;
          if (!hasFooter) score += 15;
          if (hasSidebar) score -= 120;
          score -= Math.floor(Math.abs(candidateText.length - 1200) / 80);

          return { candidateText, score };
        })
        .filter((entry): entry is { candidateText: string; score: number } => !!entry)
        .sort((a, b) => b.score - a.score);

      if (promptCandidates.length > 0) {
        text = promptCandidates[0].candidateText;
      } else {
        for (const candidate of candidates) {
          let candidateText = (candidate as HTMLElement).innerText ?? '';
          candidateText = candidateText
            .replace(/\u00a0/g, ' ')
            .replace(/\r/g, '')
            .replace(/[ \t]+/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
          if (!candidateText) continue;
          if (!text && candidateText.includes('AI-generated')) {
            text = candidateText;
          } else if (!text && candidateText.length > 180) {
            text = candidateText;
          }
        }
      }

      if (!text) {
        text = (document.body.innerText ?? '')
          .replace(/\u00a0/g, ' ')
          .replace(/\r/g, '')
          .replace(/[ \t]+/g, ' ')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
      }

      const sourceCountMatch = text.match(/\b(\d+)\s+web\s+pages?\b/i);
      const sourceCount = sourceCountMatch ? Number.parseInt(sourceCountMatch[1], 10) : 0;

      const citationIdSet = new Set<string>();
      const bracketMatches = text.matchAll(/\[(\d+)\]/g);
      for (const match of bracketMatches) {
        if (match[1]) citationIdSet.add(match[1]);
      }
      const multilineMatches = text.matchAll(/\n-\s*\n(\d+)(?=\n|$)/g);
      for (const match of multilineMatches) {
        if (match[1]) citationIdSet.add(match[1]);
      }

      let answer = text;
      if (promptText) {
        const idx = answer.lastIndexOf(promptText);
        if (idx >= 0) {
          answer = answer.slice(idx + promptText.length);
        }
      }

      answer = answer.replace(/^Read\s+\d+\s+web\s+pages\s*/i, '');
      answer = answer.replace(/\n?\d+\s+web\s+pages?\b[\s\S]*$/i, '');
      answer = answer.replace(/-\s*\n\d+(?:\s*-\s*\n\d+)*/g, '');
      answer = answer.replace(/[ \t]+\./g, '.');
      answer = answer.replace(/\n([。！？；，、])/g, '$1');
      answer = answer.replace(
        /\n?(DeepThink|深度思考)\s*\n(Search|搜索|联网搜索)\s*\nAI-generated, for reference only[\s\S]*$/i,
        '',
      );
      answer = answer.replace(/\n?AI-generated, for reference only[\s\S]*$/i, '');
      answer = answer.replace(/\n?(?:Today|Yesterday|30 Days|New chat)\n[\s\S]*$/i, '');

      answer = answer
        .replace(/\u00a0/g, ' ')
        .replace(/\r/g, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      return {
        answerText: answer,
        sourceCount: Number.isFinite(sourceCount) ? sourceCount : 0,
        citationIds: Array.from(citationIdSet).sort((a, b) => Number(a) - Number(b)),
      };
    },
    { promptText: prompt },
  );
}

export const deepseekActions: ProviderActions = {
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
      )
        return false;

      return false;
    } catch {
      return false;
    }
  },

  async submitPrompt(page: Page, prompt: string): Promise<void> {
    const composer = await findFirstVisible(page, COMPOSER_SELECTORS, 15_000);
    if (!composer) {
      throw new Error(
        'DeepSeek composer not found. The UI may have changed. Try running with --headed to debug.',
      );
    }

    await composer.click();
    await ensureSearchEnabledDeepThinkDisabled(page);

    const tagName = await composer.evaluate((el) => el.tagName.toLowerCase()).catch(() => 'div');
    if (tagName === 'textarea' || tagName === 'input') {
      await composer.fill(prompt);
    } else {
      await page.keyboard.press('Meta+a').catch(() => {});
      await page.keyboard.press('Backspace').catch(() => {});
      await page.keyboard.type(prompt, { delay: 8 });

      const injected = await page.evaluate(
        ({ selector, text }) => {
          const el = document.querySelector(selector);
          const current = (el?.textContent ?? '').trim();
          return current.includes(text.slice(0, Math.min(10, text.length)));
        },
        { selector: COMPOSER_SELECTORS[COMPOSER_SELECTORS.length - 1], text: prompt },
      );

      if (!injected) {
        await page.evaluate(
          ({ text }) => {
            const nodes = Array.from(document.querySelectorAll('div[contenteditable="true"]'));
            const target = nodes.find((node) => {
              const htmlEl = node as HTMLElement;
              return htmlEl.offsetWidth > 0 && htmlEl.offsetHeight > 0;
            });
            if (!target) return;
            (target as HTMLElement).innerText = text;
            target.dispatchEvent(new Event('input', { bubbles: true }));
          },
          { text: prompt },
        );
      }
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
    const baseline = await extractCurrentTurnSnapshot(page, prompt);
    const baselineSignature = deepseekTurnSignature(baseline);

    let sawNewTurn = false;
    let lastSnapshot = baseline;
    let lastSignature = baselineSignature;
    let lastStreamedAnswer = '';
    let stableCount = 0;

    const STABLE_THRESHOLD = 3;
    const POLL_INTERVAL = 1000;

    while (Date.now() - startTime < timeoutMs) {
      const current = await extractCurrentTurnSnapshot(page, prompt);
      const currentSignature = deepseekTurnSignature(current);

      if (!sawNewTurn && currentSignature !== baselineSignature) {
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
      throw new Error('Timed out waiting for DeepSeek assistant response');
    }

    const elapsed = Date.now() - startTime;
    lastSubmittedPrompt.delete(page);

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
