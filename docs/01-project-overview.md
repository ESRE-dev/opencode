# Chapter 1: Project Overview

> What OpenCode is, how the monorepo is structured, and how all the pieces fit together.

---

## What Is OpenCode?

OpenCode is an **AI-powered development tool** — think of it as an intelligent coding assistant that lives in your terminal, your browser, or a native desktop app. It connects to 20+ LLM providers (Anthropic, OpenAI, Google, etc.), gives the AI access to powerful tools (file editing, shell execution, code search, LSP), and manages the entire conversation lifecycle with features like session compaction, retry, revert, and permission controls.

It's not just a chatbot wrapper. OpenCode is a **full agent system** — the AI can plan, execute multi-step tasks, spawn sub-agents, and interact with your codebase through a rich set of tools, all governed by a configurable permission model.

---

## The Monorepo at a Glance

OpenCode is organized as a **Bun workspace monorepo** orchestrated by **Turborepo**. Here's what lives at the root:

```
opencode/
├── packages/           # All application packages
│   ├── opencode/       # 🧠 The core — CLI, server, agents, tools, DB
│   ├── app/            # 🌐 SolidJS web application
│   ├── desktop/        # 🖥️ Tauri desktop app (wraps web app)
│   ├── desktop-electron/ # Alternative Electron desktop build
│   ├── ui/             # 🎨 Shared SolidJS component library
│   ├── sdk/js/         # 📦 TypeScript SDK (generated from OpenAPI)
│   ├── plugin/         # 🔌 Plugin system + built-in plugins
│   ├── docs/           # 📝 API documentation (Mintlify)
│   ├── extensions/     # IDE extensions (Zed, VS Code)
│   ├── storybook/      # 📚 Component stories
│   ├── console/        # 💼 Cloud console (SolidStart)
│   ├── enterprise/     # 🏢 Teams/enterprise features
│   ├── identity/       # 🔑 Auth/identity service
│   ├── function/       # ⚡ Cloudflare Worker functions
│   ├── web/            # 🌍 Marketing/docs site (Astro)
│   ├── containers/     # 🐳 Docker container definitions
│   ├── slack/          # 💬 Slack integration
│   └── util/           # 🔧 Shared utilities
├── infra/              # ☁️ SST infrastructure definitions
├── script/             # 🛠️ Build, publish, and release scripts
├── sdks/               # Additional SDK packages (VS Code)
├── specs/              # Specifications
├── nix/                # ❄️ Nix package definitions
├── github/             # GitHub-specific tooling
├── patches/            # Dependency patches
├── package.json        # Root workspace config + dependency catalog
├── turbo.json          # Turborepo task pipeline
├── sst.config.ts       # SST infrastructure entry point
├── bunfig.toml         # Bun configuration
└── tsconfig.json       # Root TypeScript config
```

---

## How the Pieces Fit Together

OpenCode follows a **client-server architecture** where a single backend engine powers multiple frontend interfaces:

### The Backend (`packages/opencode`)

This is the heart of OpenCode. It's a Bun application that runs as:

1. **A CLI** — Parse commands with yargs, execute them directly
2. **An HTTP server** — Hono-powered API on port 4096
3. **A TUI host** — Renders a SolidJS terminal UI via @opentui

The backend manages everything: agent orchestration, LLM streaming, tool execution, session persistence, file watching, and permission enforcement. It exposes all of this through a well-defined REST + SSE API.

### The Frontend Interfaces

Three different UIs connect to the same backend:

| Interface       | Package                        | Framework                | How It Connects                                             |
| --------------- | ------------------------------ | ------------------------ | ----------------------------------------------------------- |
| **Terminal UI** | `packages/opencode` (embedded) | SolidJS + @opentui       | In-process — runs in the same Bun process                   |
| **Web App**     | `packages/app`                 | SolidJS + Vite           | HTTP — connects via REST API + SSE events                   |
| **Desktop App** | `packages/desktop`             | Tauri 2 (Rust) + Web App | HTTP — bundles a sidecar CLI binary, connects to its server |

All three use the same **TypeScript SDK** (`packages/sdk/js`) to communicate with the backend, ensuring a consistent API surface.

### The Data Flow

Here's how a typical interaction flows through the system:

```
User types a message
        │
        ▼
   ┌─────────┐
   │   UI    │  (TUI, Web, or Desktop)
   └────┬────┘
        │ SDK client call
        ▼
   ┌─────────┐
   │  Hono   │  HTTP Server
   │  Server │  POST /session/:id/message
   └────┬────┘
        │
        ▼
   ┌─────────┐
   │ Session │  Creates message, selects agent
   │ Manager │
   └────┬────┘
        │
        ▼
   ┌─────────┐
   │  Agent  │  Builds system prompt, configures tools
   └────┬────┘
        │
        ▼
   ┌──────────┐
   │ AI SDK   │  streamText() → LLM Provider
   │ Provider │  (Anthropic, OpenAI, etc.)
   └────┬─────┘
        │ streaming response
        ▼
   ┌──────────┐
   │  Tools   │  AI requests tool calls
   │  System  │  (bash, edit, read, grep...)
   └────┬─────┘
        │ results
        ▼
   ┌──────────┐
   │  Event   │  Bus.publish(MessageUpdated, ...)
   │   Bus    │
   └────┬─────┘
        │ SSE stream
        ▼
   ┌─────────┐
   │   UI    │  Reactively updates display
   └─────────┘
```

### The Cloud Layer

For the hosted product (opencode.ai), additional packages handle:

- **Console** (`packages/console`) — SolidStart app for account management, billing, API key management
- **Identity** (`packages/identity`) — OAuth via @openauthjs/openauth (GitHub + Google)
- **Function** (`packages/function`) — Cloudflare Workers for webhooks, Discord bots, analytics
- **Enterprise** (`packages/enterprise`) — Teams features at opncd.ai
- **Infrastructure** (`infra/`) — SST definitions deploying to Cloudflare (Workers, R2, KV, Durable Objects)

---

## Package Dependency Graph

Understanding which packages depend on which helps navigate the codebase:

```
@opencode-ai/opencode (core)
    ├── @opencode-ai/sdk        # Generated API client
    ├── @opencode-ai/plugin     # Plugin system
    ├── @opencode-ai/ui         # Shared components
    ├── ai (Vercel AI SDK)      # LLM abstraction
    ├── hono                    # HTTP server
    ├── drizzle-orm             # Database ORM
    ├── solid-js + @opentui     # Terminal UI
    └── zod                     # Validation

@opencode-ai/app (web)
    ├── @opencode-ai/sdk        # API client
    ├── @opencode-ai/ui         # Shared components
    ├── solid-js                # UI framework
    ├── @solidjs/router         # Client routing
    └── vite                    # Build tool

@opencode-ai/desktop (desktop)
    ├── @opencode-ai/app        # Reuses web app
    ├── tauri                   # Native shell (Rust)
    └── opencode-cli (sidecar)  # Bundled CLI binary
```

---

## Key Design Decisions

Several architectural decisions shape the entire project:

### 1. Bun as Runtime and Package Manager

OpenCode chose Bun over Node.js for its speed, native SQLite bindings (`bun:sqlite`), built-in TypeScript support, and the ability to **compile to standalone executables** (`bun build --compile`). This means the CLI ships as a single binary — no runtime installation required.

### 2. SolidJS Everywhere

Rather than using different UI frameworks for different targets, OpenCode uses SolidJS for both the web app AND the terminal UI (via @opentui). This means the same reactive programming model and component patterns apply whether you're rendering to a browser DOM or terminal escape codes.

### 3. Vercel AI SDK as the Abstraction Layer

Instead of writing custom integrations for each LLM provider, OpenCode uses the Vercel AI SDK (`ai` package v5) as a unified abstraction. Each provider ships its own `@ai-sdk/*` adapter, and the core code only interacts with the `LanguageModelV2` protocol. This makes adding new providers trivial.

### 4. Event-Driven Architecture

The event bus system is central to OpenCode's real-time nature. Every state change (new message, tool execution, permission request, etc.) is published as a typed event. The SSE endpoint subscribes to these events and streams them to connected clients. This decouples the core engine from any specific UI.

### 5. Co-located SQL Schemas

Rather than keeping all database schemas in one directory, OpenCode co-locates `.sql.ts` files with their modules (e.g., `session/session.sql.ts`). This keeps related code together and makes it easy to understand a module's data model.

### 6. Permission-First Tool Execution

Every tool call goes through a permission system that can `allow`, `ask` (prompt the user), or `deny` execution based on configurable rules with glob patterns. This is critical for an AI agent that executes shell commands and modifies files.

---

## Next Steps

Now that you have the big picture, the following chapters dive deep into each layer:

- **[Chapter 2: Runtime & Toolchain →](./02-runtime-and-toolchain.md)** — Understanding Bun, TypeScript, and the build system
- **[Chapter 3: The Core Package →](./03-core-package.md)** — Exploring the engine that powers everything
