import type { Page } from 'playwright';
import type { CapturedResponse, ProviderActions, ProviderConfig } from '../types.js';

export const YUANBAO_CONFIG: ProviderConfig = {
  name: 'yuanbao',
  displayName: 'Yuanbao',
  url: 'https://yuanbao.tencent.com/',
  loginUrl: 'https://yuanbao.tencent.com/',
  autoHeadedLoginFallback: true,
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
  url: string;
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
      if (source.url) lines.push(`   ${source.url}`);
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
  const parseDrawerSources = async (): Promise<YuanbaoSourceEntry[]> => {
    const drawer = page.locator(SELECTORS.sourcesDrawer).first();
    const visible = await drawer
      .waitFor({ state: 'visible', timeout: 1_500 })
      .then(() => true)
      .catch(() => false);
    if (!visible) return [];

    const sources = await drawer.evaluate((root) => {
      const items = Array.from(
        root.querySelectorAll('.agent-dialogue-references__item .hyc-common-markdown__ref_card'),
      );
      return items
        .map((card) => {
          const url = (card.getAttribute('data-url') ?? '')
            .trim()
            .replace(/\u00a0/g, ' ')
            .replace(/\r/g, '')
            .replace(/[ \t]+/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
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
          return { index, source, title, summary, url };
        })
        .filter((item) => item.index || item.source || item.title || item.summary || item.url);
    });

    return sources.map((source) => ({
      index: normalizeBlockText(source.index),
      source: normalizeBlockText(source.source),
      title: normalizeBlockText(source.title),
      summary: normalizeBlockText(source.summary),
      url: normalizeBlockText(source.url),
    }));
  };

  const closeDrawer = async (): Promise<void> => {
    const closeBtn = page.locator(`${SELECTORS.sourcesDrawer} button`).first();
    if ((await closeBtn.count()) > 0) {
      await closeBtn.click().catch(() => {});
    }
    await page.keyboard.press('Escape').catch(() => {});
  };

  const clickSourcesByDom = async (): Promise<boolean> => {
    return page
      .evaluate(() => {
        const bubbles = Array.from(document.querySelectorAll('.agent-chat__bubble--ai'));
        const latestBubble = bubbles[bubbles.length - 1] as HTMLElement | undefined;
        if (!latestBubble) return false;

        latestBubble.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
        const rect = latestBubble.getBoundingClientRect();
        latestBubble.dispatchEvent(
          new MouseEvent('mousemove', {
            bubbles: true,
            clientX: Math.max(rect.left + 14, 8),
            clientY: Math.max(rect.top + 14, 8),
          }),
        );
        latestBubble.dispatchEvent(
          new MouseEvent('mouseover', {
            bubbles: true,
            clientX: Math.max(rect.left + 14, 8),
            clientY: Math.max(rect.top + 14, 8),
          }),
        );

        const norm = (text: string) =>
          text
            .replace(/\u00a0/g, ' ')
            .replace(/\r/g, '')
            .replace(/[ \t]+/g, ' ')
            .trim();
        const isSourceLabel = (text: string) =>
          text === 'Sources' || text === '参考来源' || text === '引用来源';

        const nodes = Array.from(
          latestBubble.querySelectorAll('.agent-chat__toolbar__right, button, div, span, a'),
        ) as HTMLElement[];
        const target = nodes.find((node) => isSourceLabel(norm(node.textContent ?? '')));
        if (!target) return false;

        const clickable =
          (target.closest(
            'button, a, [role="button"], .agent-chat__toolbar__right',
          ) as HTMLElement | null) ?? target;
        clickable.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        clickable.click();
        return true;
      })
      .catch(() => false);
  };

  const latestBubble = page.locator(SELECTORS.aiBubble).last();

  for (let attempt = 0; attempt < 3; attempt++) {
    await page
      .evaluate(() => {
        const bubbles = Array.from(document.querySelectorAll('.agent-chat__bubble--ai'));
        const latest = bubbles[bubbles.length - 1] as HTMLElement | undefined;
        if (!latest) return;
        latest.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
        const rect = latest.getBoundingClientRect();
        latest.dispatchEvent(
          new MouseEvent('mousemove', {
            bubbles: true,
            clientX: Math.max(rect.left + 14, 8),
            clientY: Math.max(rect.top + 14, 8),
          }),
        );
        latest.dispatchEvent(
          new MouseEvent('mouseover', {
            bubbles: true,
            clientX: Math.max(rect.left + 14, 8),
            clientY: Math.max(rect.top + 14, 8),
          }),
        );
      })
      .catch(() => {});
    await page.waitForTimeout(120);

    let clicked = false;
    const sourcesButton = latestBubble
      .locator(SELECTORS.sourcesToolbarButton)
      .filter({ hasText: /sources|参考来源|引用来源/i })
      .first();
    if ((await sourcesButton.count()) > 0) {
      clicked = await sourcesButton
        .click({ timeout: 2_500 })
        .then(() => true)
        .catch(async () => {
          return sourcesButton
            .click({ timeout: 1_500, force: true })
            .then(() => true)
            .catch(() => false);
        });
    }

    if (!clicked) {
      clicked = await clickSourcesByDom();
    }

    if (!clicked) continue;

    await page.waitForTimeout(220);
    const sources = await parseDrawerSources().catch(() => []);
    await closeDrawer();
    if (sources.length > 0) return sources;
  }

  return [];
}

async function extractSourcesFromCitationPopover(
  page: Page,
  preferredCitationIds: string[] = [],
): Promise<YuanbaoSourceEntry[]> {
  const latestBubble = page.locator(SELECTORS.aiBubble).last();
  const collectTriggerMeta = async (): Promise<
    Array<{ num: string; source: string; sourceType: string; idxList: string }>
  > => {
    const read = async (
      scope: 'latest' | 'global',
    ): Promise<Array<{ num: string; source: string; sourceType: string; idxList: string }>> => {
      if (scope === 'latest') {
        return latestBubble.evaluate((root) => {
          const normalize = (text: string): string =>
            text
              .replace(/\u00a0/g, ' ')
              .replace(/\r/g, '')
              .replace(/[ \t]+/g, ' ')
              .replace(/\n{3,}/g, '\n\n')
              .trim();

          const triggers = Array.from(
            root.querySelectorAll('.hyc-common-markdown__ref-list__trigger'),
          ) as HTMLElement[];
          const dedup = new Map<
            string,
            { num: string; source: string; sourceType: string; idxList: string }
          >();

          for (const trigger of triggers) {
            const num = normalize(trigger.getAttribute('data-num') ?? trigger.textContent ?? '');
            const source = normalize(trigger.getAttribute('data-web-site-name') ?? '');
            const sourceType = normalize(trigger.getAttribute('data-source-type') ?? '');
            const idxList = normalize(trigger.getAttribute('data-idx-list') ?? '');
            const key = num || `${source}|${idxList}`;
            if (!dedup.has(key)) {
              dedup.set(key, { num, source, sourceType, idxList });
            }
          }

          return Array.from(dedup.values());
        });
      }

      return page.evaluate(() => {
        const normalize = (text: string): string =>
          text
            .replace(/\u00a0/g, ' ')
            .replace(/\r/g, '')
            .replace(/[ \t]+/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();

        const triggers = Array.from(
          document.querySelectorAll('.hyc-common-markdown__ref-list__trigger'),
        ) as HTMLElement[];
        const dedup = new Map<
          string,
          { num: string; source: string; sourceType: string; idxList: string }
        >();

        for (const trigger of triggers) {
          const num = normalize(trigger.getAttribute('data-num') ?? trigger.textContent ?? '');
          const source = normalize(trigger.getAttribute('data-web-site-name') ?? '');
          const sourceType = normalize(trigger.getAttribute('data-source-type') ?? '');
          const idxList = normalize(trigger.getAttribute('data-idx-list') ?? '');
          const key = num || `${source}|${idxList}`;
          if (!dedup.has(key)) {
            dedup.set(key, { num, source, sourceType, idxList });
          }
        }

        return Array.from(dedup.values());
      });
    };

    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      await page
        .evaluate(() => {
          const bubbles = Array.from(document.querySelectorAll('.agent-chat__bubble--ai'));
          const latest = bubbles[bubbles.length - 1] as HTMLElement | undefined;
          if (!latest) return;
          latest.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
          const rect = latest.getBoundingClientRect();
          latest.dispatchEvent(
            new MouseEvent('mousemove', {
              bubbles: true,
              clientX: Math.max(rect.left + 12, 8),
              clientY: Math.max(rect.top + 12, 8),
            }),
          );
          latest.dispatchEvent(
            new MouseEvent('mouseover', {
              bubbles: true,
              clientX: Math.max(rect.left + 12, 8),
              clientY: Math.max(rect.top + 12, 8),
            }),
          );
        })
        .catch(() => {});

      const latest = await read('latest').catch(() => []);
      if (latest.length > 0) return latest;
      const global = await read('global').catch(() => []);
      if (global.length > 0) return global;
      await page.waitForTimeout(180);
    }

    return [];
  };

  const triggerMeta = await collectTriggerMeta();

  const preferredSet = new Set(preferredCitationIds.filter((id) => /^\d+$/.test(id)));
  if (triggerMeta.length === 0 && preferredSet.size === 0) {
    return [];
  }

  const targets =
    preferredSet.size > 0 ? triggerMeta.filter((meta) => preferredSet.has(meta.num)) : triggerMeta;
  const fallbackTargets =
    preferredSet.size > 0
      ? Array.from(preferredSet).map((num) => ({ num, source: '', sourceType: '', idxList: '' }))
      : [];
  const runTargets = (
    targets.length > 0 ? targets : triggerMeta.length > 0 ? triggerMeta : fallbackTargets
  ).slice(0, 20);

  const readVisibleCards = async (): Promise<YuanbaoSourceEntry[]> => {
    const cards = await page.evaluate(() => {
      const normalize = (text: string): string =>
        text
          .replace(/\u00a0/g, ' ')
          .replace(/\r/g, '')
          .replace(/[ \t]+/g, ' ')
          .replace(/\n{3,}/g, '\n\n')
          .trim();

      const nodes = Array.from(document.querySelectorAll('.hyc-common-markdown__ref_card')).filter(
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

      return nodes
        .map((card) => {
          const index = normalize(
            card.getAttribute('data-idx') ??
              card.querySelector('.hyc-common-markdown__ref_card-foot__idx')?.textContent ??
              '',
          );
          const source = normalize(
            card.querySelector(
              '.hyc-common-markdown__ref_card-foot__txt, .hyc-common-markdown__ref_card-foot__source_txt',
            )?.textContent ?? '',
          );
          const title = normalize(card.querySelector('h4')?.textContent ?? '');
          const summary = normalize(card.querySelector('p')?.textContent ?? '');
          const url = normalize(card.getAttribute('data-url') ?? '');
          return { index, source, title, summary, url };
        })
        .filter((item) => item.index || item.source || item.title || item.summary || item.url);
    });

    return cards.map((card) => ({
      index: normalizeBlockText(card.index),
      source: normalizeBlockText(card.source),
      title: normalizeBlockText(card.title),
      summary: normalizeBlockText(card.summary),
      url: normalizeBlockText(card.url),
    }));
  };

  const dedup = new Map<string, YuanbaoSourceEntry>();
  const upsert = (source: YuanbaoSourceEntry) => {
    const key = source.url || `${source.index}|${source.source}|${source.title}`;
    const current = dedup.get(key);
    if (!current) {
      dedup.set(key, source);
      return;
    }
    const currentScore = Number(Boolean(current.url)) + Number(Boolean(current.summary));
    const nextScore = Number(Boolean(source.url)) + Number(Boolean(source.summary));
    if (nextScore > currentScore) {
      dedup.set(key, source);
    }
  };

  for (const target of runTargets) {
    let captured = false;

    if (target.num) {
      const candidates = [
        latestBubble.locator(`.hyc-common-markdown__ref-list__trigger[data-num="${target.num}"]`),
        page.locator(`.hyc-common-markdown__ref-list__trigger[data-num="${target.num}"]`),
      ];

      for (const triggersForNum of candidates) {
        const triggerCount = await triggersForNum.count();
        const clickAttempts = Math.min(triggerCount, 3);

        for (let i = 0; i < clickAttempts; i++) {
          const trigger = triggersForNum.nth(i);
          await trigger.click({ timeout: 2_500 }).catch(async () => {
            await trigger.click({ timeout: 1_500, force: true }).catch(() => {});
          });
          await page.waitForTimeout(240);

          const cards = await readVisibleCards().catch(() => []);
          if (cards.length > 0) {
            for (const card of cards) {
              upsert({
                ...card,
                index: card.index || target.num,
                source: card.source || target.source,
              });
            }
            captured = true;
            break;
          }

          await page.keyboard.press('Escape').catch(() => {});
          await page.waitForTimeout(80);
        }

        if (captured) break;
      }
    }

    if (!captured) {
      upsert({
        index: target.num,
        source: target.source,
        title: '',
        summary: '',
        url: '',
      });
    }

    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(80);
  }

  return Array.from(dedup.values());
}

async function extractSourcesFromConversationDetail(
  page: Page,
  preferredCitationIds: string[] = [],
): Promise<YuanbaoSourceEntry[]> {
  const sources = await page.evaluate(
    async ({ preferredIds }) => {
      const normalize = (text: string): string =>
        text
          .replace(/\u00a0/g, ' ')
          .replace(/\r/g, '')
          .replace(/[ \t]+/g, ' ')
          .replace(/\n{3,}/g, '\n\n')
          .trim();

      const getChatContext = (): { agentId: string; conversationId: string } => {
        const segments = location.pathname.split('/').filter(Boolean);
        const chatIndex = segments.indexOf('chat');
        if (chatIndex >= 0) {
          return {
            agentId: segments[chatIndex + 1] ?? '',
            conversationId: segments[chatIndex + 2] ?? '',
          };
        }
        if (segments[0] === 'chat') {
          return {
            agentId: segments[1] ?? '',
            conversationId: segments[2] ?? '',
          };
        }
        return { agentId: '', conversationId: '' };
      };

      const { agentId, conversationId } = getChatContext();
      if (!agentId || !conversationId) return [];

      const response = await fetch('/api/user/agent/conversation/v1/detail', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          offset: 0,
          limit: 20,
          agentId,
        }),
      }).catch(() => null);

      if (!response || !response.ok) return [];

      const json = await response.json().catch(() => null);
      if (!json) return [];

      const preferredSet = new Set(
        preferredIds.map((id) => normalize(String(id))).filter((id) => /^\d+$/.test(id)),
      );

      const out: Array<{
        index: string;
        source: string;
        title: string;
        summary: string;
        url: string;
      }> = [];

      const convs = Array.isArray(json?.convs) ? json.convs : [];
      for (const conv of convs) {
        const speeches = Array.isArray(conv?.speechesV2) ? conv.speechesV2 : [];
        for (const speech of speeches) {
          const content = Array.isArray(speech?.content) ? speech.content : [];
          for (const block of content) {
            const docs = Array.isArray(block?.docs) ? block.docs : [];
            for (const doc of docs) {
              const index = normalize(String(doc?.index ?? doc?.idx ?? doc?.id ?? ''));
              if (preferredSet.size > 0 && index && !preferredSet.has(index)) {
                continue;
              }
              const source = normalize(
                String(
                  doc?.web_site_name ??
                    doc?.webSiteName ??
                    doc?.source_name ??
                    doc?.sourceName ??
                    doc?.source ??
                    '',
                ),
              );
              const title = normalize(String(doc?.title ?? doc?.docTitle ?? ''));
              const summary = normalize(String(doc?.quote ?? doc?.summary ?? doc?.desc ?? ''));
              const url = normalize(
                String(doc?.web_url ?? doc?.url ?? doc?.href ?? doc?.link ?? ''),
              );

              if (!index && !source && !title && !summary && !url) continue;
              out.push({ index, source, title, summary, url });
            }
          }
        }
      }

      const dedup = new Map<
        string,
        { index: string; source: string; title: string; summary: string; url: string }
      >();
      for (const item of out) {
        const key = item.url || `${item.index}|${item.source}|${item.title}`;
        if (!dedup.has(key)) {
          dedup.set(key, item);
          continue;
        }
        const current = dedup.get(key);
        if (!current) continue;
        const currentScore =
          Number(Boolean(current.url)) +
          Number(Boolean(current.summary)) +
          Number(Boolean(current.title));
        const nextScore =
          Number(Boolean(item.url)) + Number(Boolean(item.summary)) + Number(Boolean(item.title));
        if (nextScore > currentScore) {
          dedup.set(key, item);
        }
      }

      return Array.from(dedup.values());
    },
    { preferredIds: preferredCitationIds },
  );

  return sources.map((source) => ({
    index: normalizeBlockText(source.index),
    source: normalizeBlockText(source.source),
    title: normalizeBlockText(source.title),
    summary: normalizeBlockText(source.summary),
    url: normalizeBlockText(source.url),
  }));
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

  const alreadyManualAndEnabled = await searchToggle
    .evaluate((el) => {
      const selfClass = (el as HTMLElement).className ?? '';
      const parentClass = (el.parentElement as HTMLElement | null)?.className ?? '';
      const text = (el.textContent ?? '').toLowerCase();
      const enabled = /checked|active|selected/i.test(`${selfClass} ${parentClass}`);
      const manual = /manual|手动/.test(text);
      return enabled && manual;
    })
    .catch(() => false);

  if (alreadyManualAndEnabled) {
    return;
  }

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
    const POLL_INTERVAL = 700;

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
    if (sawNewTurn) {
      for (let attempt = 0; attempt < 3 && sources.length === 0; attempt++) {
        try {
          sources = await extractSourcesFromConversationDetail(page, lastSnapshot.citationIds);
        } catch {
          // Best-effort: detail API can lag or return partial payload.
        }
        if (sources.length === 0) {
          await page.waitForTimeout(600);
        }
      }
    }

    if (sawNewTurn && lastSnapshot.hasSourcesButton) {
      for (let attempt = 0; attempt < 2 && sources.length === 0; attempt++) {
        try {
          sources = await extractSourcesFromLatestTurn(page);
        } catch {
          // Best-effort source extraction; answer should still be returned.
        }
        if (sources.length === 0) {
          await page.waitForTimeout(600);
        }
      }
    }

    if (sawNewTurn && sources.length === 0 && lastSnapshot.citationIds.length > 0) {
      for (let attempt = 0; attempt < 3 && sources.length === 0; attempt++) {
        try {
          sources = await extractSourcesFromCitationPopover(page, lastSnapshot.citationIds);
        } catch {
          // Best-effort fallback.
        }
        if (sources.length === 0) {
          await page.waitForTimeout(700);
        }
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
