import chalk from 'chalk';
import { Command } from 'commander';
import { crawlSources, loadUrlsFromFile, writeCrawlOutput } from '../core/sources.js';
import { getSession } from '../session/index.js';
import { recordErrorEvent } from '../telemetry/errors.js';

export function createSourcesCommand(): Command {
  return new Command('sources')
    .description('Fetch and extract core content from citation URLs')
    .option('--url <urls...>', 'Citation URL list')
    .option('--from-file <path>', 'Read URLs from a text/markdown file (e.g. response.md)')
    .option('--session <id>', 'Read URLs from a saved session response')
    .option('--concurrency <n>', 'Max concurrent fetches', '3')
    .option('--timeout <ms>', 'Per-URL timeout (ms)', '15000')
    .option('--max-chars <n>', 'Max content chars per article', '8000')
    .option('--output <path>', 'Write result JSON to file')
    .action(async (options) => {
      try {
        const urls = new Set<string>();

        for (const url of (options.url as string[] | undefined) ?? []) {
          if (url.trim()) urls.add(url.trim());
        }

        const fromFile = options.fromFile as string | undefined;
        if (fromFile) {
          for (const url of await loadUrlsFromFile(fromFile)) {
            urls.add(url);
          }
        }

        const sessionId = options.session as string | undefined;
        if (sessionId) {
          const session = await getSession(sessionId).catch(() => null);
          if (!session?.responsePath) {
            throw new Error(`Session not found or has no response: ${sessionId}`);
          }
          for (const url of await loadUrlsFromFile(session.responsePath)) {
            urls.add(url);
          }
        }

        const urlList = [...urls];
        if (urlList.length === 0) {
          throw new Error('No URLs found. Use --url, --from-file, or --session.');
        }

        const concurrency = Number.parseInt(options.concurrency as string, 10);
        const timeoutMs = Number.parseInt(options.timeout as string, 10);
        const maxChars = Number.parseInt(options.maxChars as string, 10);

        console.log(chalk.blue(`Extracting ${urlList.length} source URL(s)...`));

        const output = await crawlSources(urlList, {
          concurrency: Number.isFinite(concurrency) && concurrency > 0 ? concurrency : 3,
          timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000,
          maxChars: Number.isFinite(maxChars) && maxChars > 0 ? maxChars : 8000,
        });

        if (options.output) {
          await writeCrawlOutput(options.output as string, output);
          console.log(chalk.green(`✓ Saved extraction result: ${options.output}`));
        }

        console.log(JSON.stringify(output, null, 2));
      } catch (error) {
        await recordErrorEvent(
          {
            module: 'sources',
            stage: 'command_handler',
            message: error instanceof Error ? error.message : String(error),
            metadata: {
              hasSession: Boolean(options.session),
              hasFromFile: Boolean(options.fromFile),
              urlCount: ((options.url as string[] | undefined) ?? []).length,
            },
          },
          error,
        );
        throw error;
      }
    });
}
