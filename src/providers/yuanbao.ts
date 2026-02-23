import type { Page } from 'playwright';
import type { CapturedResponse, ProviderActions, ProviderConfig } from '../types.js';

export const YUANBAO_CONFIG: ProviderConfig = {
  name: 'yuanbao',
  displayName: 'Yuanbao',
  url: 'https://yuanbao.tencent.com/',
  loginUrl: 'https://yuanbao.tencent.com/',
  defaultTimeoutMs: 5 * 60 * 1000,
};

const SELECTORS = {
  composer: '.ql-editor[contenteditable="true"]',
  sendButton: 'a[class*="send-btn"]',
  deepThinkingToggle: '[class*="ThinkSelector_iconDeepThinkAll"]',
  internetSearchToggle: '.yb-switch-internet-search-btn, .yb-internet-search-btn',
  internetSearchModeTrigger:
    '.yb-switch-internet-search-btn__right, .yb-internet-search-btn-switch-icon, [class*="selectArrowButtonWrapper"], [class*="selectArrow"]',
  internetSearchModeDropdown: '.switch-internet-search-dropdown, .t-dropdown',
  internetSearchModeItem: '.drop-down-item, .t-dropdown__item',
  aiBubble: '.agent-chat__bubble--ai',
  sourcesToolbarButton: '.agent-chat__toolbar__right',
  sourcesDrawer: '.agent-dialogue-references',
  sourcesDrawerItem: '.agent-dialogue-references__item .hyc-common-markdown__ref_card',
  loginButton:
    'button.agent-dialogue__tool__login, button:has-text("Log In"), button:has-text("登录")',
  notLoggedInText: 'text=Not logged in, text=未登录',
} as const;

interface YuanbaoTurnSnapshot {
  answerText: string;
  hasSourcesButton: boolean;
  citationIds: string[];
}

interface YuanbaoSourceEntry {
  index: string;
  source: string;
  title: string;
  summary: string;
}

function normalizeBlockText(text: string): string {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function turnSignature(turn: YuanbaoTurnSnapshot): string {
  return [turn.answerText, turn.citationIds.join(','), turn.hasSourcesButton ? '1' : '0'].join(
    '\n---\n',
  );
}

function formatStructuredResponse(
  turn: YuanbaoTurnSnapshot,
  sources: YuanbaoSourceEntry[],
): { text: string; markdown: string } {
  const lines: string[] = [];

  lines.push('## AI Answer');
  lines.push(turn.answerText || '(empty)');
  lines.push('');
  lines.push('## Sources');

  if (sources.length > 0) {
    for (const source of sources) {
      const label = source.index || '?';
      const title = [source.source, source.title].filter(Boolean).join(' - ') || 'Unknown source';
      const summary =
        source.summary.length > 240 ? `${source.summary.slice(0, 240)}...` : source.summary;
      lines.push(`${label}. ${title}`);
      if (summary) lines.push(`   ${summary}`);
    }
  } else if (turn.citationIds.length > 0) {
    lines.push(`Inline citations: ${turn.citationIds.join(', ')}`);
  } else {
    lines.push('(none)');
  }

  const text = lines.join('\n').trim();
  return { text, markdown: text };
}

async function isYuanbaoSessionAuthenticated(page: Page): Promise<boolean> {
  try {
    const result = await page.evaluate(async () => {
      const response = await fetch('/api/getuserinfo', {
        credentials: 'include',
      });
      return { status: response.status };
    });

    return result.status >= 200 && result.status < 300;
  } catch {
    return false;
  }
}

async function dismissBlockingOverlays(page: Page): Promise<void> {
  const closeSelectors = [
    '.t-dialog .t-dialog__close',
    '.t-dialog [class*="close"]',
    '.t-dialog button:has-text("Close")',
    '.t-dialog button:has-text("关闭")',
    '.t-dialog button:has-text("取消")',
    '.t-dialog button:has-text("稍后")',
    '.t-dialog button:has-text("我知道了")',
    '.t-dialog button:has-text("知道了")',
  ];

  for (const selector of closeSelectors) {
    const btn = page.locator(selector).first();
    if ((await btn.count()) === 0) continue;
    if (!(await btn.isVisible().catch(() => false))) continue;
    await btn.click({ timeout: 1_000 }).catch(() => {});
  }

  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(120);
}

async function ensureDeepThinkingDisabled(page: Page): Promise<void> {
  await dismissBlockingOverlays(page);

  const candidates = [
    page.locator(SELECTORS.deepThinkingToggle).first(),
    page.getByText(/^(DeepThink|Deep Thinking|DeepThinking|深度思考)$/).last(),
  ];

  let toggle = candidates[0];
  let found = false;

  for (const candidate of candidates) {
    if ((await candidate.count()) === 0) continue;
    try {
      await candidate.waitFor({ state: 'visible', timeout: 2_500 });
      toggle = candidate;
      found = true;
      break;
    } catch {
      // Try the next selector variant.
    }
  }

  if (!found) return;

  let isSelected = false;
  try {
    isSelected = await toggle.evaluate((el) => /selected|checked|active/i.test(el.className));
  } catch {
    isSelected = false;
  }

  if (isSelected) {
    await dismissBlockingOverlays(page);
    await toggle.click({ timeout: 3_000 }).catch(async () => {
      await toggle.click({ timeout: 2_000, force: true }).catch(() => {});
    });
    await page.waitForTimeout(250);
  }
}

async function extractLatestTurnSnapshot(page: Page): Promise<YuanbaoTurnSnapshot> {
  return page.evaluate(() => {
    const bubbles = Array.from(document.querySelectorAll('.agent-chat__bubble--ai'));
    const latestBubble = bubbles[bubbles.length - 1];
    if (!latestBubble) {
      return {
        answerText: '',
        hasSourcesButton: false,
        citationIds: [],
      };
    }

    const answerNodes = Array.from(
      latestBubble.querySelectorAll(
        '.hyc-common-markdown.hyc-common-markdown-style:not(.hyc-common-markdown-style-cot)',
      ),
    );
    const answerNode = answerNodes[answerNodes.length - 1];
    const answerText = (answerNode?.textContent ?? '')
      .replace(/\u00a0/g, ' ')
      .replace(/\r/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    const hasSourcesButton = Array.from(
      latestBubble.querySelectorAll('.agent-chat__toolbar__right, button, div, span, a'),
    ).some((el) => {
      const text = (el.textContent ?? '')
        .replace(/\u00a0/g, ' ')
        .replace(/\r/g, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      return text === 'Sources' || text === '参考来源' || text === '引用来源';
    });

    const citationIds = Array.from(
      latestBubble.querySelectorAll('.hyc-common-markdown__ref-list__item'),
    )
      .map((el) =>
        (el.textContent ?? '')
          .replace(/\u00a0/g, ' ')
          .replace(/\r/g, '')
          .replace(/[ \t]+/g, ' ')
          .replace(/\n{3,}/g, '\n\n')
          .trim(),
      )
      .filter((t) => /^\d+$/.test(t));

    return {
      answerText,
      hasSourcesButton,
      citationIds: Array.from(new Set(citationIds)),
    };
  });
}

async function extractSourcesFromLatestTurn(page: Page): Promise<YuanbaoSourceEntry[]> {
  const latestBubble = page.locator(SELECTORS.aiBubble).last();
  const sourcesButton = latestBubble
    .locator(SELECTORS.sourcesToolbarButton)
    .filter({ hasText: /sources|参考来源|引用来源/i })
    .first();

  if ((await sourcesButton.count()) === 0) {
    return [];
  }

  await sourcesButton.click({ timeout: 4_000 });

  const drawer = page.locator(SELECTORS.sourcesDrawer).first();
  await drawer.waitFor({ state: 'visible', timeout: 6_000 });

  const sources = await drawer.evaluate((root) => {
    const items = Array.from(
      root.querySelectorAll('.agent-dialogue-references__item .hyc-common-markdown__ref_card'),
    );
    return items
      .map((card) => {
        const index = (
          card.querySelector('.hyc-common-markdown__ref_card-foot__idx')?.textContent ?? ''
        )
          .trim()
          .replace(/\u00a0/g, ' ')
          .replace(/\r/g, '')
          .replace(/[ \t]+/g, ' ')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
        const source = (
          card.querySelector(
            '.hyc-common-markdown__ref_card-foot__txt, .hyc-common-markdown__ref_card-foot__source_txt',
          )?.textContent ?? ''
        )
          .trim()
          .replace(/\u00a0/g, ' ')
          .replace(/\r/g, '')
          .replace(/[ \t]+/g, ' ')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
        const title = ((card.querySelector('h4')?.textContent ?? '').trim() ?? '')
          .replace(/\u00a0/g, ' ')
          .replace(/\r/g, '')
          .replace(/[ \t]+/g, ' ')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
        const summary = ((card.querySelector('p')?.textContent ?? '').trim() ?? '')
          .replace(/\u00a0/g, ' ')
          .replace(/\r/g, '')
          .replace(/[ \t]+/g, ' ')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
        return { index, source, title, summary };
      })
      .filter((item) => item.index || item.source || item.title || item.summary);
  });

  const closeBtn = page.locator(`${SELECTORS.sourcesDrawer} button`).first();
  if ((await closeBtn.count()) > 0) {
    await closeBtn.click().catch(() => {});
  }
  await page.keyboard.press('Escape').catch(() => {});

  return sources.map((source) => ({
    index: normalizeBlockText(source.index),
    source: normalizeBlockText(source.source),
    title: normalizeBlockText(source.title),
    summary: normalizeBlockText(source.summary),
  }));
}

async function extractSourcesFromCitationPopover(page: Page): Promise<YuanbaoSourceEntry[]> {
  const latestBubble = page.locator(SELECTORS.aiBubble).last();
  const citationTriggers = latestBubble.locator('.hyc-common-markdown__ref-list__trigger');
  const triggerCount = await citationTriggers.count();
  if (triggerCount === 0) {
    return [];
  }

  const merged: YuanbaoSourceEntry[] = [];
  const maxTriggers = Math.min(triggerCount, 8);

  for (let i = 0; i < maxTriggers; i++) {
    const trigger = citationTriggers.nth(i);
    await trigger.click({ timeout: 2_500 }).catch(() => {});
    await page.waitForTimeout(260);

    const sources = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('.hyc-common-markdown__ref_card')).filter(
        (el) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            rect.width > 0 &&
            rect.height > 0 &&
            rect.y > 0
          );
        },
      );

      return cards
        .map((card) => {
          const index = (
            card.querySelector('.hyc-common-markdown__ref_card-foot__idx')?.textContent ?? ''
          )
            .trim()
            .replace(/\u00a0/g, ' ')
            .replace(/\r/g, '')
            .replace(/[ \t]+/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
          const source = (
            card.querySelector(
              '.hyc-common-markdown__ref_card-foot__txt, .hyc-common-markdown__ref_card-foot__source_txt',
            )?.textContent ?? ''
          )
            .trim()
            .replace(/\u00a0/g, ' ')
            .replace(/\r/g, '')
            .replace(/[ \t]+/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
          const title = (card.querySelector('h4')?.textContent ?? '')
            .trim()
            .replace(/\u00a0/g, ' ')
            .replace(/\r/g, '')
            .replace(/[ \t]+/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
          const summary = (card.querySelector('p')?.textContent ?? '')
            .trim()
            .replace(/\u00a0/g, ' ')
            .replace(/\r/g, '')
            .replace(/[ \t]+/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
          return { index, source, title, summary };
        })
        .filter((item) => item.index || item.source || item.title || item.summary);
    });

    merged.push(
      ...sources.map((source) => ({
        index: normalizeBlockText(source.index),
        source: normalizeBlockText(source.source),
        title: normalizeBlockText(source.title),
        summary: normalizeBlockText(source.summary),
      })),
    );

    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(80);
  }

  const dedup = new Map<string, YuanbaoSourceEntry>();
  for (const source of merged) {
    const key = `${source.index}|${source.source}|${source.title}`;
    if (!dedup.has(key)) dedup.set(key, source);
  }
  return Array.from(dedup.values());
}

async function ensureInternetSearchManualAndEnabled(page: Page): Promise<void> {
  await dismissBlockingOverlays(page);

  const composer = page.locator(SELECTORS.composer).first();
  if ((await composer.count()) > 0) {
    await composer.click({ timeout: 3_000 }).catch(() => {});
  }

  const toggles = page.locator(SELECTORS.internetSearchToggle);
  let searchToggle = toggles.last();
  let useTextFallback = false;

  if ((await toggles.count()) === 0) {
    const textToggle = page.getByText(/^Search$/).last();
    if ((await textToggle.count()) === 0) {
      throw new Error('Yuanbao search control not found. The UI may have changed.');
    }
    searchToggle = textToggle;
    useTextFallback = true;
  }

  await searchToggle.waitFor({ state: 'visible', timeout: 12_000 });

  let modeTrigger = searchToggle.locator(SELECTORS.internetSearchModeTrigger).first();
  if ((await modeTrigger.count()) === 0) {
    modeTrigger = page.locator(SELECTORS.internetSearchModeTrigger).last();
  }

  if ((await modeTrigger.count()) > 0) {
    await modeTrigger.click({ timeout: 3_000 }).catch(() => {});
  }

  const modeDropdown = page.locator(SELECTORS.internetSearchModeDropdown).last();
  let manualSet = false;
  if ((await modeDropdown.count()) > 0) {
    await modeDropdown.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});

    const modeItems = modeDropdown.locator(SELECTORS.internetSearchModeItem);
    if ((await modeItems.count()) > 0) {
      const manualItemByText = modeItems.filter({ hasText: /manual|手动/i }).first();
      const manualItem = (await manualItemByText.count()) > 0 ? manualItemByText : modeItems.nth(1);
      await manualItem.waitFor({ state: 'visible', timeout: 5_000 });

      const manualSelected = await manualItem.evaluate((el) =>
        /checked|active/i.test((el as HTMLElement).className),
      );

      if (!manualSelected) {
        await manualItem.click({ timeout: 3_000 });
      }
      manualSet = true;
    }
  }

  if (!manualSet) {
    const manualByText = page.getByText(/^(Manual|手动)$/).last();
    if ((await manualByText.count()) > 0) {
      await manualByText.click({ timeout: 2_000 }).catch(() => {});
    }
  }

  // Close dropdown so it doesn't block send controls.
  await page.keyboard.press('Escape').catch(() => {});

  let searchEnabled = await searchToggle.evaluate((el) => {
    const selfClass = (el as HTMLElement).className ?? '';
    const parentClass = (el.parentElement as HTMLElement | null)?.className ?? '';
    return /checked|active|selected/i.test(`${selfClass} ${parentClass}`);
  });

  if (!searchEnabled) {
    await searchToggle.click({ timeout: 3_000 });
    await page.waitForTimeout(200);
    searchEnabled = await searchToggle.evaluate((el) => {
      const selfClass = (el as HTMLElement).className ?? '';
      const parentClass = (el.parentElement as HTMLElement | null)?.className ?? '';
      return /checked|active|selected/i.test(`${selfClass} ${parentClass}`);
    });
  }

  // On some UI variants text-based Search toggle doesn't expose selected classes.
  // If we had to use text fallback, treat the click as best-effort enable.
  if (!searchEnabled && !useTextFallback) {
    await searchToggle.click({ timeout: 2_000 }).catch(() => {});
  }
}

export const yuanbaoActions: ProviderActions = {
  async isLoggedIn(page: Page): Promise<boolean> {
    try {
      await Promise.race([
        page.waitForSelector(SELECTORS.composer, { timeout: 8_000 }),
        page.waitForSelector(SELECTORS.loginButton, { timeout: 8_000 }),
      ]).catch(() => {});

      const composer = await page.$(SELECTORS.composer);
      if (!composer) return false;

      if (await isYuanbaoSessionAuthenticated(page)) {
        return true;
      }

      const loginButton = await page.$(SELECTORS.loginButton);
      if (loginButton && (await loginButton.isVisible())) return false;

      const notLoggedIn = await page.$(SELECTORS.notLoggedInText);
      if (notLoggedIn && (await notLoggedIn.isVisible())) return false;

      return true;
    } catch {
      return false;
    }
  },

  async submitPrompt(page: Page, prompt: string): Promise<void> {
    await ensureInternetSearchManualAndEnabled(page);
    await ensureDeepThinkingDisabled(page);

    const composer = await page.waitForSelector(SELECTORS.composer, { timeout: 15_000 });
    if (!composer) {
      throw new Error(
        'Yuanbao composer not found. The UI may have changed. Try running with --headed to debug.',
      );
    }

    await composer.click();
    await page.keyboard.press('Meta+a');
    await page.keyboard.press('Backspace');

    // Quill editor on Yuanbao can ignore fill() in some cases.
    // Prefer keyboard typing and verify value is present before sending.
    await page.keyboard.type(prompt, { delay: 8 });

    const hasPrompt = await page.evaluate(
      ({ sel, text }) => {
        const el = document.querySelector(sel);
        const current = (el?.textContent ?? '').trim();
        return current.includes(text.slice(0, Math.min(10, text.length)));
      },
      { sel: SELECTORS.composer, text: prompt },
    );

    if (!hasPrompt) {
      try {
        await composer.fill(prompt);
      } catch {
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
    }

    const sendButton = page.locator(SELECTORS.sendButton).first();
    await sendButton.waitFor({ state: 'visible', timeout: 10_000 });

    await page.waitForFunction(
      (selector) => {
        const el = document.querySelector(selector);
        if (!el) return false;
        return !/disabled/i.test((el as HTMLElement).className);
      },
      SELECTORS.sendButton,
      { timeout: 8_000 },
    );

    await sendButton.click();
  },

  async captureResponse(
    page: Page,
    opts: { timeoutMs: number; onChunk?: (chunk: string) => void },
  ): Promise<CapturedResponse> {
    const { timeoutMs, onChunk } = opts;
    const startTime = Date.now();

    const baseline = await extractLatestTurnSnapshot(page);
    const baselineSignature = turnSignature(baseline);
    let lastSnapshot = baseline;
    let lastSignature = baselineSignature;
    let lastStreamedAnswer = '';
    let stableCount = 0;
    let sawNewTurn = false;

    const STABLE_THRESHOLD = 2;
    const POLL_INTERVAL = 1000;

    while (Date.now() - startTime < timeoutMs) {
      const current = await extractLatestTurnSnapshot(page);
      const currentSignature = turnSignature(current);

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
          stableCount += 1;
        } else {
          lastSignature = currentSignature;
          stableCount = 0;
        }

        lastSnapshot = current;

        if (stableCount >= STABLE_THRESHOLD && current.answerText.length > 0) {
          break;
        }
      }

      await page.waitForTimeout(POLL_INTERVAL);
    }

    const elapsed = Date.now() - startTime;
    const truncated = elapsed >= timeoutMs && stableCount < STABLE_THRESHOLD && sawNewTurn;

    let sources: YuanbaoSourceEntry[] = [];
    if (sawNewTurn && lastSnapshot.hasSourcesButton) {
      try {
        sources = await extractSourcesFromLatestTurn(page);
      } catch {
        // Best-effort source extraction; answer should still be returned.
      }
    }

    if (sawNewTurn && sources.length === 0 && lastSnapshot.citationIds.length > 0) {
      try {
        sources = await extractSourcesFromCitationPopover(page);
      } catch {
        // Best-effort fallback.
      }
    }

    const formatted = sawNewTurn
      ? formatStructuredResponse(
          {
            ...lastSnapshot,
            answerText: normalizeBlockText(lastSnapshot.answerText),
          },
          sources,
        )
      : { text: '', markdown: '' };

    return {
      text: formatted.text,
      markdown: formatted.markdown,
      truncated,
      thinkingTime: Math.round(elapsed / 1000),
    };
  },
};
