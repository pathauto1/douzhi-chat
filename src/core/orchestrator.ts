import { stat } from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';
import fg from 'fast-glob';
import { launchBrowser } from '../browser/index.js';
import { loadConfig } from '../config.js';
import { getProvider } from '../providers/index.js';
import { createSession, saveBundle, saveResponse, updateSession } from '../session/index.js';
import type { ChatOptions, ProviderName } from '../types.js';
import { buildBundle } from './bundle.js';

export interface ChatResult {
  sessionId: string;
  provider: ProviderName;
  response: string;
  truncated: boolean;
  durationMs: number;
}

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
  const config = await loadConfig();
  const providerName = options.provider ?? config.defaultProvider;
  const provider = getProvider(providerName);
  const timeoutMs = options.timeoutMs ?? config.defaultTimeoutMs;
  const headless = options.headed === true ? false : config.headless;

  // Build the bundle
  const bundle = await buildBundle({
    prompt: options.prompt,
    files: options.file,
  });

  // Create session
  const session = await createSession(providerName, options.prompt, options.model);
  await saveBundle(session.id, bundle);

  console.log(chalk.dim(`Session: ${session.id}`));
  console.log(chalk.blue(`Provider: ${provider.config.displayName}`));

  // Launch browser — if this fails, mark session as failed
  let browser: Awaited<ReturnType<typeof launchBrowser>>;
  try {
    await updateSession(session.id, { status: 'running' });
    browser = await launchBrowser({
      provider: providerName,
      headless,
      url: provider.config.url,
    });
  } catch (error) {
    await updateSession(session.id, { status: 'failed' });
    throw error;
  }

  const startTime = Date.now();

  try {
    // Check login
    const loggedIn = await provider.actions.isLoggedIn(browser.page);
    if (!loggedIn) {
      throw new Error(
        `Not logged in to ${provider.config.displayName}. Run: 10x-chat login ${providerName}`,
      );
    }

    // Submit prompt
    console.log(chalk.dim('Submitting prompt...'));

    // Attach files if provided
    if (options.attach && options.attach.length > 0) {
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

    await provider.actions.submitPrompt(browser.page, bundle);

    // Capture response
    console.log(chalk.dim('Waiting for response...'));
    const captured = await provider.actions.captureResponse(browser.page, {
      timeoutMs,
      onChunk: (chunk) => process.stdout.write(chalk.dim(chunk)),
    });

    const durationMs = Date.now() - startTime;

    // Save response
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
    // Distinguish timeout from other failures
    const isTimeout = error instanceof Error && error.message.toLowerCase().includes('timeout');
    await updateSession(session.id, {
      status: isTimeout ? 'timeout' : 'failed',
      durationMs,
    });
    throw error;
  } finally {
    await browser.close();
  }
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
