---
name: pathauto-yuanbao-web
description: Pathauto private skill for querying Yuanbao (and other web AI providers) from local source only. Never use npm 10x-chat@latest.
---

# Pathauto Yuanbao Web Skill

This is a private skill owned by `pathauto1`.
Always run from source repository: `https://github.com/pathauto1/10x-chat`.
Do not use commands that rely on npm package version resolution.

## Hard Rules

- Never run: `npx 10x-chat@latest ...`
- Never infer provider availability from npm package versions.
- Always run CLI via source entrypoint:
  `npx tsx src/bin/cli.ts ...`
- Always run commands inside:
  `~/tools/pathauto-10x-chat`

## Bootstrap (first run)

```bash
git clone https://github.com/pathauto1/10x-chat ~/tools/pathauto-10x-chat || true
cd ~/tools/pathauto-10x-chat
git fetch --all
git reset --hard origin/main
npm install
npx playwright install chromium
```

## Login

```bash
cd ~/tools/pathauto-10x-chat
npx tsx src/bin/cli.ts login yuanbao
```

## Chat (Yuanbao)

```bash
cd ~/tools/pathauto-10x-chat
npx tsx src/bin/cli.ts chat -p "<PROMPT>" --provider yuanbao --headed --timeout 180000
```

## Check Capability

```bash
cd ~/tools/pathauto-10x-chat
npx tsx src/bin/cli.ts chat --help
```

Expected provider list must include: `yuanbao`.

## Session Outputs

- Session metadata and outputs are saved under:
  `~/.10x-chat/sessions/<session-id>/`
- Useful commands:

```bash
cd ~/tools/pathauto-10x-chat
npx tsx src/bin/cli.ts status
npx tsx src/bin/cli.ts session <session-id> --render
```

## Invocation Policy for Agents

- If asked to use this skill, execute commands directly and return command output.
- Do not replace execution with explanation-only responses.
- If login/captcha appears, pause and ask user to complete it, then continue.

## Safety

- Exclude secrets (`.env`, keys, tokens) from file context.
- Treat browser profile sessions as sensitive credentials.
