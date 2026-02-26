import { stat } from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';
import fg from 'fast-glob';
import type { Page } from 'playwright';
import { type BrowserSession, launchBrowser } from '../browser/index.js';
import { loadConfig } from '../config.js';
import { getProvider } from '../providers/index.js';
import { createSession, saveBundle, saveResponse, updateSession } from '../session/index.js';
import { recordErrorEvent } from '../telemetry/errors.js';
import type { CapturedResponse, ChatOptions, ProviderName } from '../types.js';
import { buildBundle } from './bundle.js';
import {
  detectRiskOutcomeFromError,
  detectRiskOutcomeFromResponse,
  evaluateRiskGuard,
  type RiskOutcomeKind,
  recordRiskAttemptStart,
  recordRiskOutcome,
} from './risk-guard.js';

export interface ChatResult {
  sessionId: string;
  provider: ProviderName;
  response: string;
  truncated: boolean;
  durationMs: number;
}

const LOGIN_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const LOGIN_POLL_INTERVAL_MS = 2_000;
const HEADLESS_AUTH_RECHECK_TIMEOUT_MS = 20_000;
const HEADLESS_AUTH_RECHECK_INTERVAL_MS = 2_000;
const HUMAN_VERIFICATION_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const HUMAN_VERIFICATION_POLL_INTERVAL_MS = 2_000;

/**
 * Execute a chat interaction with a provider:
 * 1. Build the prompt bundle
 * 2. Launch the browser
 * 3. Attach files (if any)
 * 4. Submit the prompt
 * 5. Capture the response
 * 6. Save session
 */
export async function runChat(options: ChatOptions): Promise<ChatResult> {
  let stage = 'init';
  const config = await loadConfig();
  const providerName = options.provider ?? config.defaultProvider;
  const provider = getProvider(providerName);
  const timeoutMs = options.timeoutMs ?? config.defaultTimeoutMs;
  const headless = options.headed === true ? false : config.headless;
  const runMode = headless ? 'headless' : 'headed';
  let activeHeadless = headless;

  stage = 'risk_guard_precheck';
  const riskDecision = await evaluateRiskGuard({
    provider: providerName,
    mode: runMode,
    prompt: options.prompt,
  });
  if (!riskDecision.allowed) {
    const waitSeconds = riskDecision.waitMs ? Math.ceil(riskDecision.waitMs / 1000) : null;
    const waitHint = waitSeconds ? ` Retry in ~${waitSeconds}s.` : '';
    const reasonHint = riskDecision.message ? ` Reason: ${riskDecision.message}` : '';
    const blockedMessage =
      `Risk guard blocked this ${provider.config.displayName} request to reduce platform risk.${waitHint}${reasonHint}`.trim();

    await recordErrorEvent({
      module: 'chat',
      stage,
      provider: providerName,
      message: blockedMessage,
      metadata: {
        mode: runMode,
        waitMs: riskDecision.waitMs,
      },
    });
    throw new Error(blockedMessage);
  }

  // Build the bundle
  const bundle = await buildBundle({
    prompt: options.prompt,
    files: options.file,
  });

  // Create session
  const session = await createSession(providerName, options.prompt, options.model);
  await saveBundle(session.id, bundle);

  stage = 'risk_guard_attempt_start';
  try {
    await recordRiskAttemptStart({
      provider: providerName,
      mode: runMode,
      prompt: options.prompt,
    });
  } catch (riskError) {
    await recordErrorEvent(
      {
        module: 'chat',
        stage,
        provider: providerName,
        sessionId: session.id,
        message: riskError instanceof Error ? riskError.message : String(riskError),
      },
      riskError,
    );
  }

  console.log(chalk.dim(`Session: ${session.id}`));
  console.log(chalk.blue(`Provider: ${provider.config.displayName}`));

  // Launch browser — if this fails, mark session as failed
  let browser: BrowserSession | null = null;
  try {
    stage = 'launch_browser';
    await updateSession(session.id, { status: 'running' });
    browser = await launchBrowser({
      provider: providerName,
      headless: activeHeadless,
      url: provider.config.url,
    });
  } catch (error) {
    await updateSession(session.id, { status: 'failed' });
    await recordErrorEvent(
      {
        module: 'chat',
        stage,
        provider: providerName,
        sessionId: session.id,
        message: error instanceof Error ? error.message : String(error),
        metadata: { headless },
      },
      error,
    );
    throw error;
  }

  const startTime = Date.now();

  try {
    if (!browser) {
      throw new Error('Browser session was not initialized');
    }

    // Check login
    stage = 'check_login';
    let loggedIn = await provider.actions.isLoggedIn(browser.page);

    if (!loggedIn && provider.config.autoHeadedLoginFallback) {
      if (headless) {
        // Some providers are slow to hydrate auth state in headless mode.
        // Recheck before forcing a visible login flow.
        loggedIn = await recheckLoginHeadless(
          browser.page,
          provider.actions.isLoggedIn,
          HEADLESS_AUTH_RECHECK_TIMEOUT_MS,
        );

        if (!loggedIn && isHeadlessAccessBlocked(providerName, browser.page.url())) {
          console.log(
            chalk.yellow(
              `${provider.config.displayName} blocked headless access. Switching to headed mode...`,
            ),
          );

          await browser.close();
          browser = null;

          stage = 'relaunch_headed_due_headless_block';
          activeHeadless = false;
          browser = await launchBrowser({
            provider: providerName,
            headless: false,
            url: provider.config.url,
          });

          stage = 'check_login_after_headed_block_fallback';
          loggedIn = await provider.actions.isLoggedIn(browser.page);
        }
      }

      if (!loggedIn && activeHeadless) {
        console.log(
          chalk.yellow(
            `Login required for ${provider.config.displayName}. Switching to headed mode for authentication...`,
          ),
        );

        await browser.close();
        browser = null;

        stage = 'launch_headed_for_login';
        activeHeadless = false;
        browser = await launchBrowser({
          provider: providerName,
          headless: false,
          url: provider.config.loginUrl,
        });

        console.log(
          chalk.dim(
            `Complete login in the browser window (up to ${Math.round(LOGIN_WAIT_TIMEOUT_MS / 60000)} minutes)...`,
          ),
        );

        stage = 'wait_login_headed';
        loggedIn = await waitForLogin(
          browser.page,
          provider.actions.isLoggedIn,
          LOGIN_WAIT_TIMEOUT_MS,
        );
        if (!loggedIn) {
          throw new Error(
            `Login timed out for ${provider.config.displayName}. Run: douzhi-chat login ${providerName}`,
          );
        }

        console.log(chalk.green(`✓ Logged in to ${provider.config.displayName}`));

        await browser.close();
        browser = null;

        stage = 'relaunch_headless_post_login';
        activeHeadless = true;
        browser = await launchBrowser({
          provider: providerName,
          headless: true,
          url: provider.config.url,
        });

        stage = 'check_login_after_relaunch';
        loggedIn = await provider.actions.isLoggedIn(browser.page);
      } else if (!loggedIn) {
        console.log(
          chalk.yellow(
            `Not logged in to ${provider.config.displayName}. Please login in the browser window...`,
          ),
        );
        stage = 'wait_login_headed_existing';
        loggedIn = await waitForLogin(
          browser.page,
          provider.actions.isLoggedIn,
          LOGIN_WAIT_TIMEOUT_MS,
        );
      }
    }

    if (!loggedIn) {
      throw new Error(
        `Not logged in to ${provider.config.displayName}. Run: douzhi-chat login ${providerName}`,
      );
    }

    // Submit prompt
    console.log(chalk.dim('Submitting prompt...'));

    // Attach files if provided
    if (options.attach && options.attach.length > 0) {
      stage = 'attach_files';
      if (!provider.actions.attachFiles) {
        console.warn(
          chalk.yellow(
            `⚠ Provider '${providerName}' does not support file attachments. --attach will be ignored.`,
          ),
        );
      } else {
        const resolvedPaths = await resolveAttachPaths(options.attach);
        if (resolvedPaths.length > 0) {
          console.log(chalk.dim(`Attaching ${resolvedPaths.length} file(s)...`));
          await provider.actions.attachFiles(browser.page, resolvedPaths);
        }
      }
    }

    let captured: CapturedResponse | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      ({ browser, activeHeadless } = await resolveHumanVerificationIfNeeded({
        browser,
        providerName,
        providerDisplayName: provider.config.displayName,
        isLoggedIn: provider.actions.isLoggedIn,
        activeHeadless,
      }));

      const captureTimeoutMs =
        attempt === 0 && activeHeadless && providerName === 'doubao'
          ? Math.min(timeoutMs, 25_000)
          : timeoutMs;

      try {
        stage = 'submit_prompt';
        await provider.actions.submitPrompt(browser.page, bundle);

        console.log(chalk.dim('Waiting for response...'));
        stage = 'capture_response';
        captured = await provider.actions.captureResponse(browser.page, {
          timeoutMs: captureTimeoutMs,
          onChunk: (chunk) => process.stdout.write(chalk.dim(chunk)),
        });
        break;
      } catch (error) {
        const needsHumanVerification =
          browser &&
          (isHumanVerificationError(error) ||
            (await isHumanVerificationVisible(browser.page, providerName)));
        if (needsHumanVerification) {
          ({ browser, activeHeadless } = await resolveHumanVerificationIfNeeded({
            browser,
            providerName,
            providerDisplayName: provider.config.displayName,
            isLoggedIn: provider.actions.isLoggedIn,
            activeHeadless,
          }));
          continue;
        }

        const message = error instanceof Error ? error.message.toLowerCase() : String(error);
        const isTimeoutError = message.includes('timeout') || message.includes('timed out');
        const canRetryHeaded =
          activeHeadless &&
          providerName === 'doubao' &&
          browser &&
          (isHeadlessAccessBlocked(providerName, browser.page.url()) || isTimeoutError);
        if (attempt === 0 && canRetryHeaded) {
          console.log(
            chalk.yellow(
              `${provider.config.displayName} blocked headless access during chat. Retrying in headed mode...`,
            ),
          );

          await browser.close();
          browser = null;

          stage = 'relaunch_headed_retry_after_block';
          activeHeadless = false;
          browser = await launchBrowser({
            provider: providerName,
            headless: false,
            url: provider.config.url,
          });

          stage = 'check_login_after_retry_relaunch';
          let relaunchLoggedIn = await provider.actions.isLoggedIn(browser.page);
          if (!relaunchLoggedIn) {
            console.log(
              chalk.yellow(
                `Not logged in to ${provider.config.displayName}. Please login in the browser window...`,
              ),
            );
            stage = 'wait_login_after_retry_relaunch';
            relaunchLoggedIn = await waitForLogin(
              browser.page,
              provider.actions.isLoggedIn,
              LOGIN_WAIT_TIMEOUT_MS,
            );
          }

          if (!relaunchLoggedIn) {
            throw new Error(
              `Not logged in to ${provider.config.displayName}. Run: douzhi-chat login ${providerName}`,
            );
          }
          continue;
        }

        throw error;
      }
    }

    if (!captured) {
      throw new Error(`Failed to capture ${provider.config.displayName} response`);
    }

    const durationMs = Date.now() - startTime;
    const riskOutcome: RiskOutcomeKind = captured.truncated
      ? 'timeout'
      : detectRiskOutcomeFromResponse(captured.text);

    await safelyRecordRiskOutcome({
      provider: providerName,
      sessionId: session.id,
      kind: riskOutcome,
      message: riskOutcome === 'success' ? undefined : captured.text.slice(0, 500),
    });

    // Save response
    stage = 'save_response';
    await saveResponse(session.id, captured.text);
    await updateSession(session.id, {
      status: captured.truncated ? 'timeout' : 'completed',
      durationMs,
    });

    return {
      sessionId: session.id,
      provider: providerName,
      response: captured.text,
      truncated: captured.truncated,
      durationMs,
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    await safelyRecordRiskOutcome({
      provider: providerName,
      sessionId: session.id,
      kind: detectRiskOutcomeFromError(error),
      message: error instanceof Error ? error.message : String(error),
    });

    // Distinguish timeout from other failures
    const isTimeout = error instanceof Error && error.message.toLowerCase().includes('timeout');
    await updateSession(session.id, {
      status: isTimeout ? 'timeout' : 'failed',
      durationMs,
    });
    await recordErrorEvent(
      {
        module: 'chat',
        stage,
        provider: providerName,
        sessionId: session.id,
        durationMs,
        message: error instanceof Error ? error.message : String(error),
        metadata: { headless, activeHeadless },
      },
      error,
    );
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

async function safelyRecordRiskOutcome(params: {
  provider: ProviderName;
  sessionId?: string;
  kind: RiskOutcomeKind;
  message?: string;
}): Promise<void> {
  const { provider, sessionId, kind, message } = params;
  try {
    await recordRiskOutcome({
      provider,
      kind,
      message,
    });
  } catch (error) {
    await recordErrorEvent(
      {
        module: 'chat',
        stage: 'risk_guard_record_outcome',
        provider,
        sessionId,
        message: error instanceof Error ? error.message : String(error),
      },
      error,
    );
  }
}

async function resolveHumanVerificationIfNeeded(params: {
  browser: BrowserSession;
  providerName: ProviderName;
  providerDisplayName: string;
  isLoggedIn: (page: Page) => Promise<boolean>;
  activeHeadless: boolean;
}): Promise<{ browser: BrowserSession; activeHeadless: boolean }> {
  const { providerName, providerDisplayName, isLoggedIn } = params;
  let { browser, activeHeadless } = params;

  const needsVerification = await isHumanVerificationVisible(browser.page, providerName);
  if (!needsVerification) return { browser, activeHeadless };

  if (activeHeadless) {
    console.log(
      chalk.yellow(
        `${providerDisplayName} requires human verification. Switching to headed mode...`,
      ),
    );
    await browser.close();
    const providerUrl = getProvider(providerName).config.url;
    browser = await launchBrowser({
      provider: providerName,
      headless: false,
      url: providerUrl,
    });
    activeHeadless = false;
  }

  console.log(
    chalk.yellow(
      `Human verification detected for ${providerDisplayName}. Please complete verification in the browser window...`,
    ),
  );

  const cleared = await waitForHumanVerificationClear(
    browser.page,
    providerName,
    HUMAN_VERIFICATION_WAIT_TIMEOUT_MS,
  );
  if (!cleared) {
    throw new Error(
      `Human verification timed out for ${providerDisplayName}. Please retry after completing captcha.`,
    );
  }

  let loggedIn = await isLoggedIn(browser.page);
  if (!loggedIn) {
    console.log(
      chalk.yellow(`Verification passed. Please complete login for ${providerDisplayName}...`),
    );
    loggedIn = await waitForLogin(browser.page, isLoggedIn, LOGIN_WAIT_TIMEOUT_MS);
  }

  if (!loggedIn) {
    throw new Error(
      `Not logged in to ${providerDisplayName}. Run: douzhi-chat login ${providerName}`,
    );
  }

  console.log(chalk.green(`✓ Verification completed for ${providerDisplayName}`));
  return { browser, activeHeadless };
}

async function waitForLogin(
  page: Page,
  isLoggedIn: (page: Page) => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await isLoggedIn(page)) return true;
    await page.waitForTimeout(LOGIN_POLL_INTERVAL_MS);
  }

  return false;
}

async function recheckLoginHeadless(
  page: Page,
  isLoggedIn: (page: Page) => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let hasReloaded = false;

  while (Date.now() < deadline) {
    if (await isLoggedIn(page)) return true;

    if (!hasReloaded && Date.now() + HEADLESS_AUTH_RECHECK_INTERVAL_MS >= deadline) {
      break;
    }

    await page.waitForTimeout(HEADLESS_AUTH_RECHECK_INTERVAL_MS);

    if (!hasReloaded) {
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      hasReloaded = true;
    }
  }

  return false;
}

function isHeadlessAccessBlocked(provider: ProviderName, url: string): boolean {
  const normalized = url.toLowerCase();

  if (provider === 'doubao') {
    return normalized.includes('/security/doubao-region-ban');
  }

  return false;
}

async function waitForHumanVerificationClear(
  page: Page,
  providerName: ProviderName,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isHumanVerificationVisible(page, providerName))) return true;
    await page.waitForTimeout(HUMAN_VERIFICATION_POLL_INTERVAL_MS);
  }
  return false;
}

function isHumanVerificationError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes('captcha') ||
    message.includes('验证码') ||
    message.includes('人机验证') ||
    message.includes('verify') ||
    message.includes('security check') ||
    message.includes('behavior check')
  );
}

async function isHumanVerificationVisible(
  page: Page,
  providerName: ProviderName,
): Promise<boolean> {
  const url = page.url().toLowerCase();
  if (url.includes('captcha') || url.includes('verify') || url.includes('/security/')) {
    return true;
  }
  if (providerName === 'doubao' && url.includes('/security/doubao-region-ban')) {
    return true;
  }

  const selectors = [
    'text=验证码',
    'text=人机验证',
    'text=请完成验证',
    'text=安全验证',
    'text=行为验证',
    'text=拖动滑块',
    'text=点击验证',
    'text=verify you are human',
    'text=security check',
    'iframe[src*="captcha"]',
    '[class*="captcha"]',
    '[id*="captcha"]',
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count().catch(() => 0)) === 0) continue;
    if (await locator.isVisible().catch(() => false)) return true;
  }

  return false;
}

/**
 * Resolve --attach paths (supports globs) to absolute file paths.
 * Validates that all resolved paths exist and are files.
 */
async function resolveAttachPaths(patterns: string[]): Promise<string[]> {
  const resolved: string[] = [];

  for (const pattern of patterns) {
    // Check if it's a glob or a literal path
    if (/[*?{}[\]]/.test(pattern)) {
      const matches = await fg(pattern, { absolute: true, onlyFiles: true });
      if (matches.length === 0) {
        throw new Error(`No files matched attachment pattern: ${pattern}`);
      }
      resolved.push(...matches);
    } else {
      const abs = path.resolve(pattern);
      try {
        const s = await stat(abs);
        if (s.isFile()) {
          resolved.push(abs);
        } else {
          console.warn(chalk.yellow(`Skipping directory: ${pattern}`));
        }
      } catch {
        throw new Error(`Attachment not found: ${pattern}`);
      }
    }
  }

  // Deduplicate in case overlapping globs resolved the same file
  return [...new Set(resolved)];
}
