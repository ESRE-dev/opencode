# OpenCode — Tech Stack & Architecture Guide

> A tutorial-style deep dive into the technologies, patterns, and architecture that power OpenCode — an AI-powered development tool.

OpenCode is a sophisticated, polyglot monorepo that ships a **CLI with a terminal UI**, a **web application**, a **desktop application**, and a **cloud console** — all backed by a unified **AI agent system** that integrates with 20+ LLM providers.

---

## 📖 Table of Contents

### Getting Started

1. **[Project Overview](./01-project-overview.md)** — What OpenCode is, how the monorepo is structured, and how the pieces fit together.

### Core Concepts

2. **[Runtime & Toolchain](./02-runtime-and-toolchain.md)** — Bun, TypeScript, Turborepo, and the build pipeline that compiles to standalone binaries.

3. **[The Core Package](./03-core-package.md)** — Deep dive into `packages/opencode` — the brain of the system: agents, sessions, tools, providers, and storage.

4. **[LLM Provider System](./04-llm-providers.md)** — How OpenCode abstracts 20+ AI providers through the Vercel AI SDK, with model routing, streaming, and provider-specific transforms.

5. **[Agent & Session Architecture](./05-agents-and-sessions.md)** — How agents are defined, how sessions manage conversations, and how tool calls flow through the system.

6. **[Tool System](./06-tool-system.md)** — The 25+ built-in tools (bash, read, write, edit, grep, LSP, etc.), how they're registered, and how permissions govern execution.

7. **[Database & Storage](./07-database-and-storage.md)** — SQLite via Bun's native bindings, Drizzle ORM schemas, migrations, and the event-sourced message/part model.

### User Interfaces

8. **[Terminal UI (TUI)](./08-terminal-ui.md)** — SolidJS rendered in the terminal via @opentui, the reactive rendering model, and how the TUI communicates with the backend.

9. **[Web Application](./09-web-application.md)** — The SolidJS + Vite browser app, its component architecture, and real-time synchronization via SSE.

10. **[Desktop Application](./10-desktop-application.md)** — Tauri 2 (Rust) wrapping the web app, sidecar CLI, native integrations, and cross-platform builds.

### Server & Communication

11. **[HTTP Server & API](./11-http-server-and-api.md)** — Hono-powered API, OpenAPI generation, SSE streaming, and the event bus that ties everything together.

12. **[Event Bus System](./12-event-bus.md)** — The three-layer pub/sub architecture that enables real-time reactivity across all interfaces.

### Extensibility

13. **[MCP & ACP Protocols](./13-mcp-and-acp.md)** — Model Context Protocol for external tool servers, Agent Client Protocol for agent interop, and OAuth flows.

14. **[SDK & Plugin System](./14-sdk-and-plugins.md)** — The TypeScript SDK, plugin architecture, and how to extend OpenCode with custom providers and tools.

### Infrastructure

15. **[Build & Release Pipeline](./15-build-and-release.md)** — Cross-compilation to 11 targets, the publish script, CI/CD workflows, and the artifact pipeline.

16. **[Cloud Infrastructure](./16-cloud-infrastructure.md)** — SST on Cloudflare, Workers, Durable Objects, R2 storage, PlanetScale, Stripe billing, and the console.

17. **[Testing Patterns](./17-testing-patterns.md)** — Bun's native test runner, the isolation preload, Playwright E2E, and the no-mocks philosophy.

---

## 🗺️ Architecture at a Glance

```
┌─────────────────────────────────────────────────────────────────┐
│                        User Interfaces                          │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────────────────┐ │
│  │  TUI     │  │  Web App     │  │  Desktop (Tauri)          │ │
│  │ SolidJS  │  │  SolidJS     │  │  Rust + Web App           │ │
│  │ @opentui │  │  Vite        │  │  Sidecar CLI              │ │
│  └────┬─────┘  └──────┬───────┘  └─────────────┬─────────────┘ │
│       │               │                        │                │
│       │         ┌─────▼────────────────────────▼──┐             │
│       │         │     @opencode-ai/sdk (TS)       │             │
│       │         └─────┬───────────────────────────┘             │
│       │               │                                         │
├───────▼───────────────▼─────────────────────────────────────────┤
│                     HTTP Server (Hono)                           │
│  REST API │ SSE /event │ WebSocket │ OpenAPI                    │
├─────────────────────────────────────────────────────────────────┤
│                      Event Bus (pub/sub)                        │
│  Instance Bus ──► Global Bus ──► SSE Stream                     │
├─────────────────────────────────────────────────────────────────┤
│                        Core Engine                              │
│  ┌─────────┐  ┌──────────┐  ┌──────────┐  ┌────────────────┐  │
│  │ Agents  │  │ Sessions │  │  Tools   │  │  Permissions   │  │
│  │ build   │  │ messages │  │  25+     │  │  allow/ask/deny│  │
│  │ explore │  │ parts    │  │  bash    │  │  glob patterns │  │
│  │ summary │  │ compact  │  │  read    │  │                │  │
│  │ custom  │  │ retry    │  │  write   │  │                │  │
│  └────┬────┘  └────┬─────┘  │  edit    │  └────────────────┘  │
│       │            │        │  grep    │                       │
│       ▼            ▼        │  lsp ... │                       │
│  ┌─────────────────────┐    └──────────┘                       │
│  │ Vercel AI SDK 5.x   │                                       │
│  │ streamText()        │                                       │
│  │ generateObject()    │                                       │
│  └────────┬────────────┘                                       │
│           │                                                     │
│  ┌────────▼────────────────────────────────────────────────┐   │
│  │              Provider Adapters (20+)                     │   │
│  │  Anthropic │ OpenAI │ Google │ Azure │ Bedrock │ xAI    │   │
│  │  Mistral │ Groq │ Cohere │ OpenRouter │ Copilot │ ...   │   │
│  └─────────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌─────────┐  ┌──────────┐  ┌───────────┐  │
│  │ SQLite + ORM │  │  MCP    │  │   ACP    │  │  Plugins  │  │
│  │ Drizzle      │  │  Client │  │  Client  │  │  Copilot  │  │
│  │ bun:sqlite   │  │  OAuth  │  │  Agent   │  │  Codex    │  │
│  └──────────────┘  └─────────┘  └──────────┘  └───────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🧰 Key Technologies at a Glance

| Layer          | Technology                | Version       |
| -------------- | ------------------------- | ------------- |
| Runtime        | Bun                       | 1.3.10        |
| Language       | TypeScript                | 5.8.2         |
| Fast Typecheck | tsgo (native preview)     | 7.0.0-dev     |
| Monorepo       | Turborepo                 | 2.8.13        |
| AI SDK         | Vercel AI SDK             | 5.0.124       |
| HTTP Server    | Hono                      | 4.10.7        |
| Database       | SQLite (bun:sqlite)       | —             |
| ORM            | Drizzle ORM               | 1.0.0-beta.16 |
| Validation     | Zod                       | 4.1.8         |
| UI Framework   | SolidJS                   | 1.9.10        |
| TUI Rendering  | @opentui/solid            | 0.1.86        |
| Web Build      | Vite                      | 7.1.4         |
| CSS            | TailwindCSS               | 4.1.11        |
| Desktop        | Tauri                     | 2.9.5         |
| CLI Parsing    | yargs                     | 18.0.0        |
| MCP            | @modelcontextprotocol/sdk | 1.25.2        |
| Deploy         | SST + Cloudflare          | 3.18.10       |
| Testing        | bun:test + Playwright     | —             |

---

## 🚀 Quick Start for Contributors

```bash
# Clone and install
git clone https://github.com/anomalyco/opencode.git
cd opencode
bun install

# Run the CLI in dev mode
bun dev

# Run the web app in dev mode
bun dev:web

# Run the desktop app in dev mode
bun dev:desktop

# Run tests (from a package directory, NOT root)
cd packages/opencode
bun test

# Type check everything
bun turbo typecheck
```

---

## 📝 About This Guide

This documentation is a **tutorial-style introduction** to the OpenCode tech stack — designed for new contributors, curious developers, and anyone who wants to understand how a modern AI-native development tool is built. Each chapter builds on the previous one, starting from the high-level architecture and progressively diving deeper into each subsystem.

The guide is meant to complement the existing [API documentation](../packages/docs/) and [CONTRIBUTING.md](../CONTRIBUTING.md) — it focuses on **concepts and architecture** rather than API references.
