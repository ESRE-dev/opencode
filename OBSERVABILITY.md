# OpenCode (local fork)

Local clone of [opencode-ai/opencode](https://github.com/anomalyco/opencode)
for development, debugging, and investigating sub-agent issues.

## Custom Setup

This repo has project-level OpenCode configuration in `.opencode/` that
supplements the global config from `~/.config/opencode/`.

### Project config (`.opencode/opencode.jsonc`)

Minimal -- disables unused tools (`github-triage`, `github-pr-search`).
Provider and model settings are inherited from the global config.

### Global config (applied via `~/.config/opencode/`)

The global setup is managed in `~/Code/local-setup` and symlinked in.
It provides:

| Component | Location | Purpose |
|---|---|---|
| Config | `~/.config/opencode/opencode.json` | Permissions, instructions, MCP servers |
| Plugins | `~/.config/opencode/plugins/` | Auto-loaded JS plugins (see below) |
| Dependencies | `~/.config/opencode/package.json` | OTel SDK + plugin SDK packages |
| Shell strategy | `~/.config/opencode/plugin/shell-strategy/` | Non-interactive shell instructions |

## Observability / Tracing

Every OpenCode session (including work in this repo) is traced to a local
Jaeger instance. This was set up specifically to debug sub-agent shell
command hangs.

### Architecture

```
OpenCode session (this repo or any project)
  |
  |  jaeger-tracer.js plugin hooks
  v
@opentelemetry/sdk-trace-base (v2)
  |
  |  OTLP HTTP -> localhost:4318
  v
Jaeger v2 container (~100MB RAM)
  |
  v
http://localhost:16686  (Jaeger UI)
```

### What is traced

| Span type | Hook | Key attributes |
|---|---|---|
| `session` | `session.created` / auto on first activity | `gen_ai.conversation.id`, `opencode.project` |
| `tool: <name>` | `tool.execute.before/after` | tool name, input args, output, error status |
| `llm: <model>` | `message.updated` | model, provider, input/output/cache/reasoning tokens, duration |

### Viewing traces

1. Ensure Jaeger is running: `cd ~/jaeger && docker compose up -d`
2. Open http://localhost:16686
3. Select service: `opencode`
4. Find traces -- each one is a session with child spans

### Plugins

**jaeger-tracer.js** -- OTLP trace exporter using OpenTelemetry v2 SDK.
Uses `createRequire()` to resolve `@opentelemetry/*` from
`~/.config/opencode/node_modules/` (required because `plugins/` dir is
symlinked from `~/Code/local-setup/dotfiles/`). Debug log at
`~/.config/opencode/jaeger-tracer-debug.log`.

**bell.js** -- Plays system sound on `session.idle`.

**shell-strategy** (instruction file, not a plugin) -- Injected via
`opencode.json` `instructions` array. Provides rules for non-interactive
shell usage to prevent commands from hanging (no editors, no pagers,
always use `-y`/`--force` flags).

## Related Directories

| Path | What |
|------|------|
| `~/jaeger/` | Jaeger docker-compose + README |
| `~/Code/local-setup/` | Dotfiles repo that manages global OpenCode config |
| `~/.config/opencode/` | Runtime config directory (symlinks + installed deps) |
