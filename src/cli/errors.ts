import { writeFile } from 'node:fs/promises';
import chalk from 'chalk';
import { Command } from 'commander';
import { type ErrorModule, listErrorEvents, recordErrorEvent } from '../telemetry/errors.js';

const MODULES: ErrorModule[] = ['chat', 'provider', 'sources', 'login', 'status', 'cli', 'unknown'];

export function createErrorsCommand(): Command {
  return new Command('errors')
    .description('Query recorded runtime error samples')
    .option('--last <n>', 'Show the most recent N events', '20')
    .option('--module <name>', `Filter by module (${MODULES.join(', ')})`)
    .option('--provider <name>', 'Filter by provider')
    .option('--error-type <name>', 'Filter by classified error type')
    .option('--stage <text>', 'Filter by stage contains text')
    .option('--since-hours <n>', 'Only include events from last N hours')
    .option('--json', 'Print JSON instead of table')
    .option('--output <path>', 'Save JSON result to file')
    .action(async (options) => {
      try {
        const last = Number.parseInt(options.last as string, 10);
        const sinceHours = options.sinceHours
          ? Number.parseFloat(options.sinceHours as string)
          : undefined;

        const moduleFilterRaw = options.module as string | undefined;
        if (moduleFilterRaw && !MODULES.includes(moduleFilterRaw as ErrorModule)) {
          throw new Error(`Invalid module '${moduleFilterRaw}'. Available: ${MODULES.join(', ')}`);
        }

        const events = await listErrorEvents({
          last: Number.isFinite(last) && last > 0 ? last : 20,
          module: moduleFilterRaw as ErrorModule | undefined,
          provider: (options.provider as string | undefined) ?? undefined,
          errorType: (options.errorType as string | undefined) ?? undefined,
          stageIncludes: (options.stage as string | undefined) ?? undefined,
          sinceHours:
            sinceHours !== undefined && Number.isFinite(sinceHours) && sinceHours > 0
              ? sinceHours
              : undefined,
        });

        if (options.output) {
          await writeFile(
            options.output as string,
            `${JSON.stringify(events, null, 2)}\n`,
            'utf-8',
          );
          console.log(chalk.green(`✓ Saved ${events.length} event(s): ${options.output}`));
        }

        if (events.length === 0) {
          console.log(chalk.dim('No matching error events.'));
          return;
        }

        if (options.json) {
          console.log(JSON.stringify(events, null, 2));
          return;
        }

        console.log(chalk.bold(`Error Events (${events.length})\n`));
        for (const event of events) {
          const head = [
            event.timestamp,
            event.module,
            event.errorType,
            event.provider ? `provider=${event.provider}` : undefined,
            event.stage ? `stage=${event.stage}` : undefined,
          ]
            .filter(Boolean)
            .join(' | ');

          console.log(chalk.cyan(head));
          console.log(`  ${event.message}`);
          if (event.url) console.log(chalk.dim(`  url: ${event.url}`));
          if (event.sessionId) console.log(chalk.dim(`  session: ${event.sessionId}`));
          if (event.durationMs !== undefined)
            console.log(chalk.dim(`  durationMs: ${event.durationMs}`));
          console.log('');
        }
      } catch (error) {
        await recordErrorEvent(
          {
            module: 'cli',
            stage: 'errors_command',
            message: error instanceof Error ? error.message : String(error),
            metadata: {
              argv: process.argv.slice(2),
            },
          },
          error,
        );
        throw error;
      }
    });
}
