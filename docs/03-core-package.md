# Chapter 3: The Core Package

> Deep dive into `packages/opencode` — the brain of the system: agents, sessions, tools, providers, and storage.

The `packages/opencode` package is where everything happens. It's the CLI, the server, the agent runtime, the TUI — all in one. This chapter maps out its internal architecture so you can navigate, modify, and extend it with confidence.

---

## Entry Point

The application starts at `src/index.ts`, which uses **yargs 18** to define a CLI with subcommands:

```
opencode              → launches TUI (default)
opencode run          → run a prompt non-interactively
opencode serve        → start the HTTP server only
opencode agent        → agent management
opencode mcp          → MCP server mode
opencode auth         → authentication management
opencode upgrade      → self-update
opencode web          → open the web UI
opencode pr           → pull request workflows
opencode session      → session management
opencode db           → database operations
```

When you run `bun dev` from the repo root, it executes:

```bash
bun run --cwd packages/opencode --conditions=browser src/index.ts
```

The `--conditions=browser` flag is important — it tells Bun to resolve SolidJS imports for the browser/JSX condition, which is required for the TUI's SolidJS components to compile correctly.

---

## Directory Map

Here's how `src/` is organized, grouped by responsibility:

```
src/
├── index.ts                  # CLI entry point (yargs)
│
├── ─── Agent Runtime ───
├── agent/                    # Agent definitions and orchestration
│   └── agent.ts              # Agent registry, model config, permissions
├── session/                  # Conversation lifecycle
│   ├── session.sql.ts        # Drizzle schema for sessions
│   ├── llm.ts                # LLM streaming (streamText wrapper)
│   ├── compaction.ts         # Context window compaction
│   └── ...
├── tool/                     # Built-in tool implementations
│   └── tool.ts               # Tool registry and base types
├── permission/               # Tool execution permissions
├── skill/                    # Skill discovery and execution
│
├── ─── LLM Integration ───
├── provider/                 # LLM provider adapters
│   └── provider.ts           # Provider registry, model resolution
│
├── ─── Server & API ───
├── server/                   # HTTP server
│   ├── server.ts             # Hono app setup, middleware
│   └── routes/               # Route modules
│
├── ─── User Interfaces ───
├── cli/                      # CLI command implementations
│   └── cmd/
│       ├── run.ts            # Non-interactive execution
│       ├── tui/              # Terminal UI (SolidJS + @opentui)
│       │   └── app.tsx       # TUI root component
│       └── ...
│
├── ─── Data Layer ───
├── storage/                  # Database initialization
│   └── db.ts                 # bun:sqlite + Drizzle setup
├── config/                   # Configuration loading (TOML/JSON)
├── project/                  # Project/git repository management
│
├── ─── Communication ───
├── bus/                      # Event bus (pub/sub)
│   ├── bus-event.ts          # Event type definitions
│   ├── index.ts              # Instance-scoped bus
│   └── global.ts             # Cross-instance global bus
├── mcp/                      # Model Context Protocol client
├── acp/                      # Agent Client Protocol client
│
├── ─── Infrastructure ───
├── plugin/                   # Plugin loading (Copilot, Codex)
├── pty/                      # Pseudo-terminal (bun-pty)
├── shell/                    # Shell execution
├── lsp/                      # Language Server Protocol
├── snapshot/                 # File snapshot/diff tracking
├── worktree/                 # Git worktree management
├── auth/                     # Authentication
├── env/                      # Environment variables
├── flag/                     # Feature flags
├── format/                   # Code formatting
├── share/                    # Session sharing
├── scheduler/                # Task scheduling
├── question/                 # User confirmation flows
├── ide/                      # IDE integration hooks
├── patch/                    # Diff/patch utilities
├── installation/             # Installation metadata
└── control-plane/            # Workspace routing, SSE adaptors
```

That's 30+ modules. Let's walk through the important ones.

---

## The Instance Pattern

Before diving into individual modules, you need to understand the **Instance pattern** — OpenCode's dependency injection mechanism.

Rather than global singletons or constructor injection, OpenCode uses a **context-scoped provider** pattern. When the application starts (or when a test runs), it creates an "instance" that holds the project directory, database connection, configuration, and event bus:

```typescript
// Conceptual — not exact API
Instance.provide({ directory: "/path/to/project" }, async () => {
  // Everything inside this callback has access to the instance context
  // Modules call Instance.current() to get the active instance
  const bus = Bus.use()
  const db = Storage.use()
  // ...
})
```

This pattern is critical for:

1. **Testing** — Each test gets its own isolated instance with its own temp directory and database
2. **Multi-project** — The control-plane can manage multiple project instances simultaneously
3. **Cleanup** — When an instance is disposed, all its resources (DB connections, event subscriptions, MCP processes) are cleaned up

You'll see `Instance.provide()` in test preloads, the CLI entry point, and the server bootstrap.

---

## Agent Module (`agent/`)

Agents are the heart of OpenCode. An agent is a configuration object that defines:

- **Name** — A human-readable identifier (e.g., `"build"`, `"explore"`, `"summary"`)
- **Model** — Which LLM to use, with optional overrides per provider
- **Mode** — `"primary"` (runs as the main agent), `"subagent"` (called by primary), or `"all"`
- **Permissions** — What tools the agent can use, with allow/ask/deny rules and glob patterns
- **System prompt** — Instructions for the agent's behavior
- **Temperature** — Creativity parameter
- **Max turns** — How many tool-call rounds before stopping

Here's a simplified view of what an agent definition looks like:

```typescript
{
  name: "build",
  mode: "primary",
  model: {
    default: "anthropic/claude-sonnet-4-20250514",
    // Provider-specific overrides
    openai: "openai/o3",
  },
  permissions: [
    { tool: "bash", allow: true },
    { tool: "write", allow: true, glob: ["src/**"] },
    { tool: "read", allow: true },
    { tool: "edit", allow: true, glob: ["src/**"] },
  ],
  temperature: 0,
}
```

The agent module doesn't execute anything — it's purely declarative. The **session** module takes an agent definition and drives the actual conversation loop.

---

## Session Module (`session/`)

A **session** is a single conversation between the user and an agent. Sessions are persisted to SQLite and can be resumed, replayed, compacted, or shared.

### Lifecycle

```
User sends message
       │
       ▼
┌─────────────┐
│ Session.chat │ ← Creates a new message, appends to history
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  llm.ts     │ ← Calls streamText() with full message history
│  streamText  │   + system prompt + tool definitions
└──────┬──────┘
       │
       ▼
┌─────────────────────────────────┐
│ Streaming response              │
│  ├── Text chunks → stored as   │
│  │   message parts              │
│  ├── Tool calls → executed,    │
│  │   results appended           │
│  └── Done → check if more      │
│      tool calls needed          │
└──────┬──────────────────────────┘
       │
       ▼ (loop until no more tool calls or max turns)
┌──────────────┐
│ Final answer │
└──────────────┘
```

### Message & Part Model

Messages are stored in an **event-sourced** style:

- **Session** → has many **Messages**
- **Message** → has many **Parts**

Parts are the atomic units — a part can be:

- `text` — A chunk of text from the assistant
- `tool-invocation` — A tool call request with arguments
- `tool-result` — The output of a tool execution
- `reasoning` — Chain-of-thought tokens (for models that support it)
- `file` — A file attachment
- `step-start` — Marks the beginning of a new inference step

This granular model allows the TUI and web app to render streaming responses incrementally — each part is published via the event bus as soon as it arrives.

### Compaction

As conversations grow, they can exceed the model's context window. The **compaction** system handles this:

1. A dedicated `compaction` subagent summarizes the conversation so far
2. The summary replaces the full message history
3. The session continues with the compressed context

This happens automatically when the token count approaches the model's limit.

### Retry & Revert

Sessions support two recovery mechanisms:

- **Retry** — Re-sends the last user message, discarding the failed assistant response
- **Revert** — Rolls back to a previous message, undoing file changes via snapshots

---

## Tool Module (`tool/`)

OpenCode ships 25+ built-in tools. Each tool is a self-contained module that:

1. Defines a **Zod schema** for its parameters
2. Implements an **execute** function
3. Declares its **permission requirements**

### Tool Registry

Tools are registered in `tool/tool.ts` and exposed to the LLM as function definitions. The Vercel AI SDK's `streamText()` accepts these tool definitions and the model can call them during generation.

### Built-in Tools

| Tool          | What it does                                              |
| ------------- | --------------------------------------------------------- |
| `bash`        | Executes shell commands via PTY                           |
| `read`        | Reads file contents with line ranges                      |
| `write`       | Creates or overwrites files                               |
| `edit`        | Applies targeted edits to files (search/replace)          |
| `multiedit`   | Multiple edits to a single file in one call               |
| `apply_patch` | Applies unified diff patches                              |
| `grep`        | Searches files with regex                                 |
| `glob`        | Finds files by pattern                                    |
| `ls`          | Lists directory contents                                  |
| `codesearch`  | Semantic code search using tree-sitter                    |
| `webfetch`    | Fetches web pages and converts to markdown                |
| `websearch`   | Performs web searches                                     |
| `task`        | Spawns a subagent to handle a subtask                     |
| `plan`        | Creates and manages multi-step plans                      |
| `todo`        | Manages a todo list for the current session               |
| `lsp`         | Queries Language Server Protocol for diagnostics, symbols |
| `question`    | Asks the user a question and waits for a response         |
| `skill`       | Discovers and executes learned skills                     |
| `batch`       | Runs multiple tool calls in parallel                      |

### Permission Model

Every tool call goes through the permission system before execution:

```
Tool call arrives
       │
       ▼
┌─────────────────┐
│ Check permission │
│ rules for this   │
│ tool + file path │
└────────┬────────┘
         │
    ┌────┼────┐
    ▼    ▼    ▼
  allow  ask  deny
    │    │    │
    │    │    └──→ Block execution
    │    │
    │    └──→ Prompt user for approval
    │
    └──→ Execute immediately
```

Permissions are configured per-agent and can include glob patterns:

```typescript
// Allow bash everywhere
{ tool: "bash", allow: true }

// Allow write only in src/
{ tool: "write", allow: true, glob: ["src/**"] }

// Ask before editing config files
{ tool: "edit", ask: true, glob: ["*.config.*"] }
```

---

## Provider Module (`provider/`)

The provider module is the adapter layer between OpenCode's agent system and the 20+ LLM providers. It's covered in detail in [Chapter 4: LLM Provider System](./04-llm-providers.md), but here's the quick summary:

- Each provider has an adapter that creates a Vercel AI SDK `LanguageModelV2` instance
- `provider.ts` maintains a registry that maps provider IDs to their factory functions
- Provider-specific transforms handle differences in tool call formats, streaming behavior, and error handling
- The model to use is resolved from the agent config → user config → defaults

---

## Config Module (`config/`)

Configuration is loaded from multiple sources, merged in priority order:

1. **Built-in defaults** — Hardcoded in the application
2. **Global config** — `~/.config/opencode/config.toml` (or JSON)
3. **Project config** — `opencode.json` in the project root
4. **Environment variables** — Override specific settings
5. **CLI flags** — Highest priority

The config module uses **Zod schemas** to validate and type the configuration. Key config sections include:

- `provider` — API keys, base URLs, model aliases
- `model` — Default model selection per agent
- `mcp` — MCP server definitions
- `permission` — Global permission overrides
- `tui` — Terminal UI preferences (theme, keybinds)

---

## Storage Module (`storage/`)

The storage layer initializes SQLite via Bun's native `bun:sqlite` binding and wraps it with Drizzle ORM:

```typescript
import { Database as BunDatabase } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"

const sqlite = new BunDatabase(path)
const db = drizzle(sqlite)
```

The database lives at `~/.local/share/opencode/opencode.db` by default (following XDG base directory conventions).

Schema files (`*.sql.ts`) are co-located with their modules — `session/session.sql.ts` defines the session and message tables, `project/project.sql.ts` defines the project table, and so on. This co-location keeps the data model close to the code that uses it.

See [Chapter 7: Database & Storage](./07-database-and-storage.md) for the full schema walkthrough.

---

## Bus Module (`bus/`)

The event bus is the nervous system of OpenCode. It enables real-time reactivity across all interfaces:

```
Backend module publishes event
       │
       ▼
┌──────────────────┐
│ Instance Bus     │ ← Per-project-instance subscribers
│  publish()       │
└───────┬──────────┘
        │
        ▼
┌──────────────────┐
│ Global Bus       │ ← Cross-instance routing
│  EventEmitter    │
└───────┬──────────┘
        │
        ▼
┌──────────────────┐
│ SSE endpoint     │ ← Pushes to connected clients
│  /event          │
└──────────────────┘
```

Events are defined with Zod schemas for type safety:

```typescript
const MessageCreated = BusEvent.define(
  "message.created",
  z.object({
    sessionId: z.string(),
    messageId: z.string(),
  }),
)

// Publishing
Bus.publish(MessageCreated, { sessionId: "...", messageId: "..." })

// Subscribing (typed!)
Bus.subscribe(MessageCreated, (event) => {
  // event.properties is typed as { sessionId: string, messageId: string }
})
```

See [Chapter 12: Event Bus System](./12-event-bus.md) for the complete architecture.

---

## MCP Module (`mcp/`)

The **Model Context Protocol** module is a full MCP client implementation that allows OpenCode to connect to external tool servers. This enables:

- Using tools from any MCP-compatible server
- Connecting to remote servers with OAuth authentication
- Dynamic tool discovery at runtime

MCP tools are transparently converted to Vercel AI SDK tool definitions, so the LLM can use them alongside built-in tools without knowing the difference.

See [Chapter 13: MCP & ACP Protocols](./13-mcp-and-acp.md) for the full implementation details.

---

## CLI Module (`cli/`)

The CLI module contains the command implementations and the TUI:

```
cli/
├── cmd/
│   ├── run.ts          # opencode run <prompt>
│   ├── serve.ts        # opencode serve
│   ├── agent.ts        # opencode agent
│   ├── auth.ts         # opencode auth
│   ├── acp.ts          # opencode acp
│   ├── tui/            # Terminal UI
│   │   ├── app.tsx     # Root SolidJS component
│   │   └── ...         # Routes, components, contexts
│   └── ...
└── ...
```

The TUI is the default command — when you type `opencode` with no arguments, it launches a full terminal user interface built with SolidJS and `@opentui/solid`. The TUI is covered in depth in [Chapter 8: Terminal UI](./08-terminal-ui.md).

---

## Project Module (`project/`)

The project module manages the relationship between OpenCode and the repositories it operates on:

- **Detection** — Identifies the project root by looking for `.git`, `package.json`, etc.
- **VCS integration** — Git operations (status, diff, branch, worktree)
- **Instance binding** — Each project directory gets its own instance with isolated state

---

## Build Process

The core package is built into **standalone executables** using `Bun.build()` with `compile: true`. The build script (`script/build.ts`) produces binaries for 11 platform targets:

| OS      | Architectures                                                     |
| ------- | ----------------------------------------------------------------- |
| Linux   | arm64, x64, x64-baseline, arm64-musl, x64-musl, x64-musl-baseline |
| macOS   | arm64, x64, x64-baseline                                          |
| Windows | x64, x64-baseline                                                 |

The build process:

1. Fetches the latest model catalog from `models.dev/api.json`
2. Reads SQL migration files and embeds them as string constants
3. Compiles SolidJS JSX via `@opentui/solid/bun-plugin` (for the TUI)
4. Bundles everything into a single standalone binary with `Bun.build({ compile: true })`
5. Packages binaries as `.tar.gz` (Linux/macOS) or `.zip` (Windows)

The result is a **zero-dependency binary** — users don't need Node, Bun, or any runtime installed.

---

## How the Pieces Connect

Here's how a typical user interaction flows through the core package:

```
1. User types a message in the TUI
       │
2. TUI calls SDK client → POST /session/:id/message
       │
3. Server route handler creates a message in SQLite
       │
4. Session.chat() is invoked with the agent config
       │
5. llm.ts calls streamText() with the provider adapter
       │
6. LLM streams back text + tool calls
       │
7. Each chunk → stored as a Part → published via Bus
       │
8. Bus event → SSE stream → TUI updates reactively
       │
9. Tool calls → permission check → execute → result stored
       │
10. Results sent back to LLM for next turn
       │
11. Loop until done → final answer displayed
```

Every step in this flow is observable — the event bus publishes granular events at each stage, enabling all three UIs (TUI, web, desktop) to render the same conversation in real-time.

---

## Key Takeaways

- The core package is a **single Bun application** that serves as CLI, server, agent runtime, and TUI
- The **Instance pattern** provides scoped dependency injection and clean resource management
- **Agents** are declarative configurations; **sessions** drive the execution loop
- **Tools** are self-contained modules with Zod schemas and permission requirements
- The **event bus** is the glue — it enables real-time reactivity across all interfaces
- The **provider module** abstracts 20+ LLM providers behind the Vercel AI SDK
- Everything compiles to a **standalone binary** — no runtime dependencies for end users

---

**Next:** [Chapter 4: LLM Provider System](./04-llm-providers.md) — How OpenCode abstracts 20+ AI providers through the Vercel AI SDK.

**Previous:** [Chapter 2: Runtime & Toolchain](./02-runtime-and-toolchain.md)
