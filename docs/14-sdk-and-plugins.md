# Chapter 14: SDK & Plugin System

> The TypeScript SDK, plugin architecture, and how to extend OpenCode with custom providers and tools.

---

## Overview

OpenCode is designed to be **extensible at every layer**. Two packages enable this:

1. **`@opencode-ai/sdk`** (`packages/sdk/js`) — A TypeScript client generated from the server's OpenAPI spec, providing type-safe access to every API endpoint
2. **`@opencode-ai/plugin`** (`packages/plugin`) — A lightweight framework for authoring plugins that add providers, tools, or behaviors to OpenCode

Together, they form the extension surface — the SDK lets you build on top of OpenCode, and the plugin system lets you build into it.

---

## The TypeScript SDK

### What It Is

The SDK is a **generated TypeScript client** that mirrors the OpenCode server's API. Every REST endpoint, request body, response type, and error case is represented as typed functions and interfaces.

It lives at `packages/sdk/js` and is published as `@opencode-ai/sdk` on npm.

### How It's Generated

The SDK follows an automated pipeline:

```
Route definitions (Hono + hono-openapi + Zod schemas)
        │
        ▼
Server generates OpenAPI 3.x spec at /openapi.json
        │
        ▼
@hey-api/openapi-ts reads the spec
        │
        ▼
Generates TypeScript client code:
  - Function for each endpoint
  - Request/response types
  - Error types
  - Client configuration
        │
        ▼
packages/sdk/js/src/ contains the generated code
        │
        ▼
Build script bundles and publishes to npm
```

### Regenerating the SDK

When API routes change, the SDK must be regenerated:

```bash
./packages/sdk/js/script/build.ts
```

This script:

1. Starts a temporary OpenCode server to extract the OpenAPI spec
2. Runs `@hey-api/openapi-ts` to generate the client
3. Bundles the output for distribution

### SDK Structure

The generated SDK exports several modules:

```
@opencode-ai/sdk
├── client        # Client factory and configuration
├── server        # Server-side utilities
├── v2/           # V2 API client (latest)
│   ├── client    # V2 client functions
│   └── server    # V2 server utilities
└── types         # Shared type definitions
```

### Using the SDK

#### Creating a Client

```
import { createClient } from "@opencode-ai/sdk"

const client = createClient({
  baseURL: "http://localhost:4096",
  // Optional auth for remote servers
  headers: {
    Authorization: "Basic ...",
  },
})
```

#### Session Operations

```
// List sessions for the current project
const sessions = await client.session.list()

// Create a new session
const session = await client.session.create({
  agent_id: "build",
})

// Send a message (starts LLM streaming)
await client.session.chat(session.id, {
  content: "Fix the login bug in auth.ts",
})

// Get session messages with all parts
const messages = await client.session.messages(session.id)

// Retry the last exchange
await client.session.retry(session.id)

// Revert to a specific message
await client.session.revert(session.id, messageId)

// Share a session
const url = await client.session.share(session.id)
```

#### Real-Time Events

```
// Subscribe to the SSE event stream
const events = new EventSource(`${baseURL}/event`)

events.addEventListener("part.created", (e) => {
  const part = JSON.parse(e.data)
  console.log(`[${part.type}]`, part.content)
})

events.addEventListener("session.updated", (e) => {
  const session = JSON.parse(e.data)
  console.log("Session updated:", session.title)
})
```

#### Configuration

```
// Read current config
const config = await client.config.get()

// Update config
await client.config.update({
  provider: {
    anthropic: { apiKey: "sk-ant-..." },
  },
})
```

#### Provider & Agent Info

```
// List available providers and their status
const providers = await client.provider.list()

// List available agents
const agents = await client.agent.list()
```

### Where the SDK Is Used

The SDK is consumed by every OpenCode interface:

| Consumer                | Context                                       |
| ----------------------- | --------------------------------------------- |
| `packages/app`          | Web app — all API calls + SSE subscription    |
| `packages/opencode` TUI | Terminal UI — in-process API calls            |
| `packages/desktop`      | Desktop app (via the web app)                 |
| `packages/plugin`       | Plugins — interact with the OpenCode runtime  |
| External consumers      | Third-party integrations, scripts, automation |

### Type Safety End-to-End

The SDK generation pipeline ensures **type safety from database to client**:

```
Drizzle schema (TypeScript)
  → Zod validation schemas (TypeScript)
    → Hono route with describeRoute (TypeScript)
      → OpenAPI spec (JSON)
        → Generated SDK (TypeScript)
          → Client code (TypeScript)
```

If a field is added to a database table, the Zod schema is updated, the route handler reflects it, the OpenAPI spec includes it, and the SDK exposes it — all automatically, all type-checked at every step.

---

## The Plugin System

### What It Is

The plugin system (`packages/plugin`) provides a framework for extending OpenCode's capabilities. Plugins can:

- Add custom LLM providers
- Register additional tools
- Hook into the agent lifecycle
- Integrate with external services

### Plugin Package

The `@opencode-ai/plugin` package is intentionally lightweight:

```
packages/plugin/
├── src/
│   ├── index.ts       # Plugin exports
│   └── tool.ts        # Tool definition helpers
├── package.json
└── tsconfig.json
```

Dependencies are minimal — just `@opencode-ai/sdk` and `zod`. This keeps plugins small and avoids pulling in the entire OpenCode core.

### Built-in Plugins

OpenCode ships with two built-in plugins that demonstrate the plugin patterns:

#### GitHub Copilot Plugin (`plugin/copilot.ts`)

The Copilot plugin integrates GitHub Copilot as an LLM provider:

```
What it does:
1. Discovers Copilot OAuth tokens from VS Code settings or gh CLI
2. Refreshes tokens (Copilot tokens expire frequently)
3. Routes requests through api.githubcopilot.com
4. Maps Copilot model names to underlying models
5. Wraps as @ai-sdk/openai-compatible provider
```

Key challenges this plugin solves:

| Challenge          | Solution                                        |
| ------------------ | ----------------------------------------------- |
| Token discovery    | Scans multiple locations (VS Code, gh CLI, env) |
| Token expiry       | Background refresh with retry logic             |
| Custom headers     | Injects Copilot-specific auth headers           |
| Model name mapping | Translates "copilot-gpt-4" → actual model name  |
| Rate limiting      | Handles 429 responses with backoff              |

#### OpenAI Codex Plugin (`plugin/codex.ts`)

The Codex plugin integrates with the OpenAI Codex API, handling its unique authentication and endpoint requirements.

### Plugin Loading

Plugins are loaded during the bootstrap phase:

```
Server starts
       │
       ▼
Load configuration
       │
       ▼
Discover configured plugins
       │
       ├── Built-in plugins (copilot, codex)
       └── User-configured plugins (from opencode.json)
              │
              ▼
       Initialize each plugin
              │
              ├── Register providers
              ├── Register tools
              └── Set up lifecycle hooks
              │
              ▼
       Plugins active
```

### How Plugins Add Providers

A plugin can register a new LLM provider by providing a factory function that returns a Vercel AI SDK `LanguageModelV2` instance:

```
// Conceptual plugin provider registration
plugin.registerProvider({
  id: "my-provider",
  name: "My Custom LLM",
  create: (config) => {
    return createOpenAICompatible({
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      headers: {
        "X-Custom-Header": "value",
      },
    })
  },
})
```

Once registered, the provider is available like any built-in provider:

```bash
opencode --model my-provider/model-name
```

Or in config:

```json
{
  "agent": {
    "build": {
      "model": "my-provider/model-name"
    }
  }
}
```

### How Plugins Add Tools

Plugins can also register custom tools. The `tool.ts` module provides helpers for defining tools with Zod schemas:

```
// Conceptual tool registration
import { z } from "zod"

plugin.registerTool({
  name: "my-tool",
  description: "Does something useful",
  parameters: z.object({
    input: z.string().describe("The input to process"),
  }),
  execute: async ({ input }) => {
    // Custom logic
    return { result: "processed: " + input }
  },
})
```

Plugin-registered tools go through the same pipeline as built-in tools:

1. Converted to AI SDK tool format
2. Subject to permission checks
3. Results stored as Parts in the session
4. Events published via the Bus

---

## Extension Points Beyond Plugins

### MCP Servers (Primary Extension Mechanism)

For most use cases, **MCP servers** are the recommended way to extend OpenCode with custom tools. They don't require writing a plugin — just configure an MCP server in `opencode.json`:

```json
{
  "mcp": {
    "servers": {
      "my-tools": {
        "command": "npx",
        "args": ["my-mcp-server"]
      }
    }
  }
}
```

MCP servers can be written in any language and provide tools via the standard MCP protocol. See [Chapter 13: MCP & ACP Protocols](./13-mcp-and-acp.md) for details.

### When to Use Plugins vs MCP

| Use Case                    | Recommended Approach |
| --------------------------- | -------------------- |
| Add custom tools            | MCP server           |
| Add a new LLM provider      | Plugin               |
| Integrate with an auth flow | Plugin               |
| Add external data sources   | MCP server           |
| Modify agent behavior       | Plugin               |
| Quick prototyping           | MCP server           |
| Deep runtime integration    | Plugin               |

The general rule: **MCP for tools, plugins for providers and lifecycle hooks**.

### Custom Agents

Users can define custom agents in their configuration without any plugin code:

```json
{
  "agent": {
    "reviewer": {
      "model": "anthropic/claude-sonnet-4-20250514",
      "system": "You are a code reviewer focused on security and performance.",
      "permissions": [
        { "tool": "read", "allow": true },
        { "tool": "grep", "allow": true },
        { "tool": "glob", "allow": true },
        { "tool": "lsp", "allow": true }
      ],
      "temperature": 0
    },
    "writer": {
      "model": "anthropic/claude-sonnet-4-20250514",
      "system": "You are a documentation writer. Create clear, concise docs.",
      "permissions": [
        { "tool": "read", "allow": true },
        { "tool": "write", "allow": true },
        { "tool": "grep", "allow": true }
      ]
    }
  }
}
```

Custom agents are first-class — they appear in the agent picker and can be selected when starting sessions.

### Skills

The **skill system** is another extension mechanism that doesn't require code. Skills are learned patterns that the AI can discover and execute:

```
Skill: "Run the test suite"
Steps:
  1. bash("bun test --bail")
  2. If tests fail, read the failing test file
  3. Analyze the error and suggest a fix
```

Skills are discovered from the project context and made available through the `skill` tool. They act as reusable "recipes" that the AI can invoke for common tasks.

---

## IDE Extensions

OpenCode also ships IDE extensions that integrate with development environments:

### Zed Extension (`packages/extensions/zed/`)

The Zed extension integrates OpenCode directly into the Zed editor, providing:

- Inline AI assistance
- Code actions powered by OpenCode's agent system
- Session management from the editor

The extension is published to the Zed extension registry and kept in sync via the `sync-zed.ts` script.

### VS Code Extension (`sdks/vscode/`)

The VS Code extension provides similar integration for VS Code users, published to the VS Code marketplace via the `publish-vscode.yml` workflow.

---

## Building on the SDK

### Automation Scripts

The SDK enables writing automation scripts that use OpenCode's AI capabilities:

```
// Example: Automated code review script
import { createClient } from "@opencode-ai/sdk"

const client = createClient({ baseURL: "http://localhost:4096" })

// Create a review session
const session = await client.session.create({ agent_id: "review" })

// Send the review prompt
await client.session.chat(session.id, {
  content: "Review the changes in the last commit for security issues",
})

// Wait for completion, then get results
// (In practice, you'd subscribe to SSE events)
const messages = await client.session.messages(session.id)
const review = messages.filter(m => m.role === "assistant").pop()
console.log("Review:", review)
```

### CI/CD Integration

The SDK can power CI/CD workflows:

```
// Example: PR review bot
const session = await client.session.create({ agent_id: "build" })
await client.session.chat(session.id, {
  content: `Review PR #${prNumber}: ${prTitle}\n\nChanges:\n${diff}`,
})
```

OpenCode already uses this pattern — the `opencode.yml` GitHub workflow runs the OpenCode agent on issues and pull requests.

### Custom Dashboards

The SDK + SSE events enable building custom dashboards:

```
// Monitor all active sessions
const events = new EventSource("http://localhost:4096/event")

events.addEventListener("session.created", updateDashboard)
events.addEventListener("session.updated", updateDashboard)
events.addEventListener("tool.invocation", logToolUse)
events.addEventListener("tool.result", logToolResult)
```

---

## SDK Versioning

The SDK is versioned alongside the CLI. When a new OpenCode release ships:

1. The publish script updates the SDK's `package.json` version
2. The SDK is rebuilt from the latest OpenAPI spec
3. Both CLI and SDK are published to npm together

This ensures version compatibility — an SDK version always matches its corresponding server version.

---

## Key Takeaways

1. **The SDK is generated, not handwritten** — `@hey-api/openapi-ts` generates the TypeScript client from the OpenAPI spec, ensuring it's always in sync with the server.

2. **Type safety is end-to-end** — From Drizzle schemas through Zod validation to OpenAPI to the generated SDK, types flow unbroken through the entire stack.

3. **Plugins are for providers and lifecycle** — When you need to add a custom LLM provider or hook into the agent runtime, write a plugin.

4. **MCP is for tools** — When you need to add custom tools, write an MCP server. It's simpler, language-agnostic, and follows a standard protocol.

5. **Custom agents need no code** — Configuration in `opencode.json` is sufficient for defining new agents with custom system prompts, models, and permissions.

6. **The SDK enables automation** — Scripts, CI/CD bots, dashboards, and custom integrations can all be built on the typed SDK client.

7. **IDE extensions are first-class** — Zed and VS Code extensions bring OpenCode's capabilities directly into editors.

---

**Next:** [Chapter 15: Build & Release Pipeline →](./15-build-and-release.md) — Cross-compilation, the publish script, and CI/CD workflows.

**Previous:** [Chapter 13: MCP & ACP Protocols](./13-mcp-and-acp.md)
