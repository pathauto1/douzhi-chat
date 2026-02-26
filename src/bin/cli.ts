#!/usr/bin/env node

import chalk from 'chalk';
import { Command } from 'commander';
import { createChatCommand } from '../cli/chat.js';
import { createConfigCommand } from '../cli/config.js';
import { createErrorsCommand } from '../cli/errors.js';
import { createLoginCommand } from '../cli/login.js';
import { createNotebookLMCommand } from '../cli/notebooklm.js';
import { createSkillCommand } from '../cli/skill.js';
import { createSourcesCommand } from '../cli/sources.js';
import { createSessionCommand, createStatusCommand } from '../cli/status.js';
import { recordErrorEvent } from '../telemetry/errors.js';

const program = new Command();

program
  .name('douzhi-chat')
  .description(
    'Chat with web AI agents (ChatGPT, Gemini, Claude, Grok, NotebookLM, Yuanbao, DeepSeek, Doubao) via browser automation',
  )
  .version('0.4.2');

program.addCommand(createLoginCommand());
program.addCommand(createChatCommand());
program.addCommand(createStatusCommand());
program.addCommand(createSessionCommand());
program.addCommand(createErrorsCommand());
program.addCommand(createConfigCommand());
program.addCommand(createSkillCommand());
program.addCommand(createNotebookLMCommand());
program.addCommand(createSourcesCommand());

program.parseAsync(process.argv).catch(async (error) => {
  await recordErrorEvent(
    {
      module: 'cli',
      stage: 'parse',
      message: error instanceof Error ? error.message : String(error),
      metadata: {
        argv: process.argv.slice(2),
      },
    },
    error,
  );
  console.error(chalk.red(error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
