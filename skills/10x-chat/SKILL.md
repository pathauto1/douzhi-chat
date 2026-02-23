---
name: 10x-chat
description: Chat with web AI agents (ChatGPT, Gemini, Claude, Grok, NotebookLM, Yuanbao) via browser automation. Use when stuck, need cross-validation, or want a second-model review.
---

# 10x-chat — AI Agent Skill

Use 10x-chat to send prompts to web-based AI agents (ChatGPT, Gemini, Claude, Grok, NotebookLM, Yuanbao) via automated browser sessions. The browser uses a persisted Chrome profile, so the user only needs to login once.

## When to use

- **Stuck on a bug**: ask another model for a fresh perspective.
- **Code review**: send PR diff to GPT / Claude / Gemini for cross-review.
- **Cross-validation**: compare answers from multiple models.
- **Knowledge gaps**: leverage a model with different training data / reasoning.

## Commands

Default to running from source (not npm `@latest`) so Yuanbao is available.

```bash
# Bootstrap from source (run once, then pull updates when needed)
git clone https://github.com/pathauto1/10x-chat ~/tools/10x-chat-yuanbao || true
cd ~/tools/10x-chat-yuanbao
git pull
npm install
npx playwright install chromium

# Login (one-time per provider — opens browser for user to authenticate)
npx tsx src/bin/cli.ts login chatgpt
npx tsx src/bin/cli.ts login gemini
npx tsx src/bin/cli.ts login claude
npx tsx src/bin/cli.ts login grok
npx tsx src/bin/cli.ts login notebooklm
npx tsx src/bin/cli.ts login yuanbao

# Chat with a single provider
npx tsx src/bin/cli.ts chat -p "Review this code for bugs" --provider chatgpt --file "src/**/*.ts"

# Multi-provider fan-out (coming v0.2)
# npx tsx src/bin/cli.ts chat -p "Review this PR" --providers chatgpt,gemini,claude --file "src/**"

# Dry run (preview the prompt bundle without sending)
npx tsx src/bin/cli.ts chat --dry-run -p "Debug this error" --file src/

# Copy bundle to clipboard (manual paste fallback)
npx tsx src/bin/cli.ts chat --copy -p "Explain this" --file "src/**"

# Check recent sessions
npx tsx src/bin/cli.ts status

# View a session's response
npx tsx src/bin/cli.ts session <id> --render

# NotebookLM — manage notebooks & sources
npx tsx src/bin/cli.ts notebooklm list                       # List notebooks
npx tsx src/bin/cli.ts notebooklm create "My Research"       # Create notebook
npx tsx src/bin/cli.ts notebooklm add-url <id> https://...   # Add URL source
npx tsx src/bin/cli.ts notebooklm add-file <id> ./paper.pdf  # Upload file source
npx tsx src/bin/cli.ts notebooklm sources <id>               # List sources
npx tsx src/bin/cli.ts notebooklm summarize <id>             # AI summary
npx tsx src/bin/cli.ts chat -p "Summarize" --provider notebooklm  # Chat with NotebookLM
```

## Tips

- **Run from source**: Use `npx tsx src/bin/cli.ts ...` under `~/tools/10x-chat-yuanbao` instead of npm `@latest`.
- **Login first**: Run `npx tsx src/bin/cli.ts login <provider>` once per provider. The session persists.
- **Keep file sets small**: fewer files + a focused prompt = better answers.
- **Don't send secrets**: exclude `.env`, key files, auth tokens from `--file` patterns.
- **Use `--dry-run`** to preview what will be sent before committing to a run.
- **Timeouts**: Default is 5 minutes. Use `--timeout <ms>` for long-thinking models.
- **NotebookLM**: Add sources first (`notebooklm add-url`/`add-file`), then chat with `--provider notebooklm`.

## Safety

- Never include credentials, API keys, or tokens in the bundled files.
- The tool opens a real browser with real login state — treat it like your own browser session.
