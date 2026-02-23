# douzhi-chat

> Chat with web AI agents (ChatGPT, Gemini, Claude, Grok, NotebookLM, Yuanbao, DeepSeek) from your terminal via browser automation.

**English** | [繁體中文](./README-zh.md)

douzhi-chat uses [Playwright](https://playwright.dev) to automate browser sessions with persisted login profiles. Login once, then send prompts — bundled with file context — from your CLI or AI coding agent.

## Use with OpenClaw

Paste this into your [OpenClaw](https://openclaw.ai) chat to install as a skill:

```
https://raw.githubusercontent.com/<your-github-user>/<your-repo>/main/skills/douzhi-chat/SKILL.md
```

## Quick Start

```bash
npx playwright install chromium  # one-time browser setup

# 1. Login to a provider (opens a browser window)
npx douzhi-chat@latest login chatgpt

# 2. Send a prompt
npx douzhi-chat@latest chat -p "Explain this error" --provider chatgpt --file "src/**/*.ts"

# 3. View session history
npx douzhi-chat@latest status
```

> [!TIP]
> Use `bunx` (bun.sh) instead of `npx` for faster startup.

## Commands

### `login <provider>`

Opens a headed browser for you to authenticate. The session persists across runs.

```bash
npx douzhi-chat@latest login chatgpt       # Login to ChatGPT
npx douzhi-chat@latest login gemini         # Login to Gemini
npx douzhi-chat@latest login claude         # Login to Claude
npx douzhi-chat@latest login grok           # Login to Grok
npx douzhi-chat@latest login notebooklm     # Login to NotebookLM
npx douzhi-chat@latest login yuanbao        # Login to Yuanbao
npx douzhi-chat@latest login deepseek       # Login to DeepSeek
npx douzhi-chat@latest login --status       # Check login status for all providers
```

### `chat`

Send a prompt to an AI provider via browser automation.

```bash
npx douzhi-chat@latest chat -p "Review this code for bugs" --provider chatgpt --file "src/**/*.ts"
npx douzhi-chat@latest chat -p "Debug this error" --file "logs/error.log"
npx douzhi-chat@latest chat -p "Explain this" --dry-run              # Preview bundle without sending
npx douzhi-chat@latest chat -p "Explain this" --copy                  # Copy bundle to clipboard
npx douzhi-chat@latest chat -p "Long task" --timeout 600000 --headed  # 10min timeout, visible browser
```

| Flag | Description |
|------|-------------|
| `-p, --prompt <text>` | **(required)** The prompt to send |
| `--provider <name>` | Provider: `chatgpt`, `gemini`, `claude`, `grok`, `notebooklm`, `yuanbao`, `deepseek` (default: config) |
| `--model <name>` | Model to select in the UI |
| `-f, --file <paths...>` | Files/globs to bundle as context |
| `--copy` | Copy bundle to clipboard instead of sending |
| `--dry-run` | Preview the bundle without sending |
| `--headed` | Show browser window during chat |
| `--timeout <ms>` | Response timeout in milliseconds (default: 300000) |

### `status`

List recent chat sessions.

```bash
npx douzhi-chat@latest status              # Last 24 hours
npx douzhi-chat@latest status --hours 72   # Last 3 days
```

### `sources`

Fetch citation pages and extract core article content (title + cleaned body), while filtering common ad/noise blocks.

```bash
npx douzhi-chat@latest sources --session <id>                   # Extract URLs from a saved response.md
npx douzhi-chat@latest sources --from-file ~/.douzhi-chat/sessions/<id>/response.md
npx douzhi-chat@latest sources --url https://example.com/a https://example.com/b
npx douzhi-chat@latest sources --session <id> --output sources.json
```

| Flag | Description |
|------|-------------|
| `--url <urls...>` | Citation URL list |
| `--from-file <path>` | Read URLs from text/markdown |
| `--session <id>` | Read URLs from a saved chat session response |
| `--concurrency <n>` | Concurrent fetches (default: `3`) |
| `--timeout <ms>` | Per URL timeout (default: `15000`) |
| `--max-chars <n>` | Max extracted chars per article (default: `8000`) |
| `--output <path>` | Write JSON output to file |

### `session <id>`

View details of a specific session.

```bash
npx douzhi-chat@latest session <id> --render   # Pretty-print the response
```

### `errors`

Query recorded runtime error samples for debugging and optimization replay.

```bash
npx douzhi-chat@latest errors --last 30
npx douzhi-chat@latest errors --module sources --error-type timeout
npx douzhi-chat@latest errors --provider yuanbao --since-hours 24 --json
```

### `config`

View or modify configuration.

```bash
npx douzhi-chat@latest config show
npx douzhi-chat@latest config set provider gemini
npx douzhi-chat@latest config set timeout 600000
npx douzhi-chat@latest config set headless false
```

### `skill`

Manage the agent integration skill (for Codex, Claude Code, etc).

```bash
npx douzhi-chat@latest skill install   # Install SKILL.md to ~/.codex/skills/
npx douzhi-chat@latest skill show      # Display SKILL.md content
```

### `notebooklm` (alias: `nb`)

Manage NotebookLM notebooks and sources via RPC API.

```bash
npx douzhi-chat@latest notebooklm list                              # List all notebooks
npx douzhi-chat@latest notebooklm create "Research Topic"            # Create a notebook
npx douzhi-chat@latest notebooklm delete <notebookId>                # Delete a notebook
npx douzhi-chat@latest notebooklm sources <notebookId>               # List sources in notebook
npx douzhi-chat@latest notebooklm add-url <notebookId> <url>         # Add URL source
npx douzhi-chat@latest notebooklm add-url <notebookId> <url> --wait  # Add URL and wait for processing
npx douzhi-chat@latest notebooklm add-file <notebookId> ./paper.pdf  # Upload file source
npx douzhi-chat@latest notebooklm add-text <id> "Title" "Content"    # Add pasted text source
npx douzhi-chat@latest notebooklm summarize <notebookId>             # AI summary + suggested topics

# Then chat with the notebook's sources:
npx douzhi-chat@latest chat -p "Summarize key points" --provider notebooklm
```

## File Bundling

The `--file` flag accepts globs. Files are assembled into a markdown bundle sent as the prompt:

```bash
npx douzhi-chat@latest chat -p "Review these" --file "src/**/*.ts" "!src/**/*.test.ts"
```

Security-sensitive files (`.env*`, `*.pem`, `*.key`, etc.) are automatically excluded.

## Data Layout

```
~/.douzhi-chat/
├── profiles/
│   ├── chatgpt/          # Playwright persistent browser profile
│   ├── gemini/
│   ├── claude/
│   ├── grok/
│   ├── notebooklm/       # NotebookLM browser profile (shared Google auth)
│   ├── yuanbao/
│   └── deepseek/
├── sessions/
│   └── <uuid>/
│       ├── meta.json     # Session metadata
│       ├── bundle.md     # Prompt bundle sent
│       └── response.md   # Captured response
├── errors/
│   └── errors.jsonl      # Unified runtime error samples for replay/optimization
└── config.json           # User configuration
```

## Agent Integration

douzhi-chat includes a `SKILL.md` for AI coding agents. Install it with:

```bash
npx douzhi-chat@latest skill install
```

This lets agents like Codex or Claude Code use douzhi-chat to query other models for cross-validation, code review, or debugging help.

## Supported Providers

| Provider | Status | URL |
|----------|--------|-----|
| ChatGPT | ✅ | chatgpt.com |
| Gemini | ✅ | gemini.google.com |
| Claude | ✅ | claude.ai |
| Grok | ✅ | grok.com |
| NotebookLM | ✅ | notebooklm.google.com |
| Yuanbao | ✅ | yuanbao.tencent.com |
| DeepSeek | ✅ | chat.deepseek.com |

## Development

```bash
bun install
bun run dev login chatgpt      # Run CLI in dev mode
bun run typecheck               # Type check
bun run lint                    # Lint
bun run test                    # Run tests
bun run build                   # Build for production
```

## Publishing

Releases are automated via GitHub Actions. Push a version tag to publish:

```bash
npm version patch   # or minor / major
git push --follow-tags
```

Requires `NPM_TOKEN` secret in the GitHub repository settings.

## License

MIT
