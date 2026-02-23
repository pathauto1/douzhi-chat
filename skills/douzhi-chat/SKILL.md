---
name: douzhi-chat
description: Private web-AI execution skill for Douzhi. Source-first workflow, Yuanbao-ready.
---

# Douzhi AI Web Skill

This skill is maintained by Douzhi and is intended for private use.
Run from your own source checkout and execute real browser automation tasks.

## Hard Rules

- Do not use any published npm package variant for this tool.
- Execute commands from source via: `npx tsx src/bin/cli.ts ...`
- Use local workspace directory: `~/tools/douzhi-chat`
- If login or captcha appears, pause and wait for user confirmation before continuing.

## Bootstrap (First Run)

```bash
# Replace <YOUR_REPO_URL> with your own repository URL
git clone <YOUR_REPO_URL> ~/tools/douzhi-chat || true
cd ~/tools/douzhi-chat
git fetch --all
git reset --hard origin/main
npm install
npx playwright install chromium
```

## Login (Yuanbao)

```bash
cd ~/tools/douzhi-chat
npx tsx src/bin/cli.ts login yuanbao
```

## Chat (Yuanbao)

```bash
cd ~/tools/douzhi-chat
npx tsx src/bin/cli.ts chat -p "<PROMPT>" --provider yuanbao --headed --timeout 180000
```

## Sanity Check

```bash
cd ~/tools/douzhi-chat
npx tsx src/bin/cli.ts chat --help
```

Provider list must include `yuanbao`.

## Session Inspection

```bash
cd ~/tools/douzhi-chat
npx tsx src/bin/cli.ts status
npx tsx src/bin/cli.ts session <session-id> --render
```

## Agent Execution Policy

- Execute commands directly when asked.
- Return command output, not theory-only replies.
- If environment dependencies are missing, install them and continue.
