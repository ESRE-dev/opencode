# Chapter 13: MCP & ACP Protocols

> Model Context Protocol for external tool servers, Agent Client Protocol for agent interop, and OAuth flows.

---

## Overview

OpenCode doesn't just provide built-in tools — it's designed to be a **platform** for AI tooling through two open protocols:

1. **MCP (Model Context Protocol)** — Connect to external tool servers that expose capabilities like database access, API integrations, or custom code analysis
2. **ACP (Agent Client Protocol)** — Interoperate with external AI agents, allowing OpenCode to delegate tasks to specialized agents or be controlled by other systems

Both protocols extend OpenCode's capabilities without modifying its core — new tools, new resources, and new agents can be added purely through configuration.

---

## Model Context Protocol (MCP)

### What Is MCP?

The **[Model Context Protocol](https://modelcontextprotocol.io)** is an open standard for connecting AI applications to external tool servers. Think of it as a "USB for AI tools" — any MCP-compatible server can plug into any MCP-compatible client.

OpenCode implements a full **MCP client** using `@modelcontextprotocol/sdk` (v1.25.2). This means it can connect to any MCP server and make its tools available to the AI agent, alongside the 25+ built-in tools.

### How MCP Tools Work in OpenCode

```
User configures MCP server in opencode.json
        │
        ▼
┌───────────────────────┐
│ OpenCode starts        │
│ MCP client connects    │
│ to configured servers  │
└───────────┬───────────┘
            │
            ▼
┌───────────────────────┐
│ Tool discovery         │
│ Client calls           │
│ tools/list on server   │
└───────────┬───────────┘
            │
            ▼
┌───────────────────────┐
│ convertMcpTool()       │
│ MCP tools → AI SDK     │
│ tool format            │
└───────────┬───────────┘
            │
            ▼
┌───────────────────────┐
│ Tools available to LLM │
│ alongside built-in     │
│ tools (transparent)    │
└───────────────────────┘
```

The key insight: **the LLM doesn't know the difference between built-in tools and MCP tools**. They all appear in the same tool list with the same format. This is possible because `convertMcpTool()` transforms MCP tool definitions into the Vercel AI SDK's `Tool` type.

---

## Configuring MCP Servers

MCP servers are configured in `opencode.json` under the `mcp` section:

### Local Process (stdio transport)

```json
{
  "mcp": {
    "servers": {
      "github": {
        "command": "npx",
        "args": ["@modelcontextprotocol/server-github"],
        "env": {
          "GITHUB_TOKEN": "ghp_..."
        }
      },
      "postgres": {
        "command": "npx",
        "args": ["@modelcontextprotocol/server-postgres"],
        "env": {
          "DATABASE_URL": "postgresql://..."
        }
      },
      "custom": {
        "command": "/path/to/my-tool-server",
        "args": ["--port", "0"]
      }
    }
  }
}
```

For stdio-based servers, OpenCode:

1. Spawns the server process using `Bun.spawn()`
2. Communicates over stdin/stdout using `StdioClientTransport`
3. Monitors the process health
4. Restarts it if it crashes

### Remote HTTP Server

```json
{
  "mcp": {
    "servers": {
      "remote-tools": {
        "url": "https://tools.example.com/mcp",
        "transport": "streamable-http"
      }
    }
  }
}
```

### Remote SSE Server

```json
{
  "mcp": {
    "servers": {
      "sse-tools": {
        "url": "https://tools.example.com/sse",
        "transport": "sse"
      }
    }
  }
}
```

### Disabling a Server

```json
{
  "mcp": {
    "servers": {
      "github": {
        "command": "npx",
        "args": ["@modelcontextprotocol/server-github"],
        "enabled": false
      }
    }
  }
}
```

Setting `enabled: false` prevents the server from starting without removing its configuration.

---

## Transport Layer

The MCP module supports three transport mechanisms:

| Transport           | Class                           | Use Case                      |
| ------------------- | ------------------------------- | ----------------------------- |
| **stdio**           | `StdioClientTransport`          | Local processes (most common) |
| **Streamable HTTP** | `StreamableHTTPClientTransport` | Remote HTTP servers           |
| **SSE**             | `SSEClientTransport`            | Remote SSE-based servers      |

### stdio Transport (Default)

The most common transport for local tool servers:

```
OpenCode (client)          MCP Server (child process)
      │                          │
      │  spawn process           │
      │─────────────────────────►│
      │                          │
      │  JSON-RPC over stdin     │
      │─────────────────────────►│
      │                          │
      │  JSON-RPC over stdout    │
      │◄─────────────────────────│
      │                          │
      │  (stderr → logs)         │
      │◄ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │
```

OpenCode spawns the server as a child process, sends JSON-RPC messages over stdin, and reads responses from stdout. The server's stderr is captured for logging.

### HTTP/SSE Transports

For remote servers, communication happens over HTTP:

```
OpenCode (client)          Remote MCP Server
      │                          │
      │  POST /mcp (JSON-RPC)    │
      │─────────────────────────►│
      │                          │
      │  200 OK (JSON-RPC)       │
      │◄─────────────────────────│
      │                          │
      │  GET /mcp (SSE stream)   │
      │◄ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │  (for server-initiated messages)
```

---

## MCP OAuth Flow

Remote MCP servers may require authentication. OpenCode implements a full **OAuth 2.1** flow for this:

### The Flow

```
1. Client connects to remote MCP server
        │
        ▼
2. Server responds with 401 + OAuth metadata
   (authorization endpoint, token endpoint, etc.)
        │
        ▼
3. McpOAuthProvider starts OAuth flow
   - Generates PKCE challenge
   - Creates authorization URL
        │
        ▼
4. McpOAuthCallback starts local HTTP server
   (temporary callback server on random port)
        │
        ▼
5. Opens browser to authorization URL
   User authenticates with the MCP server's auth provider
        │
        ▼
6. Browser redirects to local callback
   Callback server receives authorization code
        │
        ▼
7. Exchange code for tokens
   McpOAuthProvider calls token endpoint
        │
        ▼
8. Store tokens
   Credentials saved per-server
        │
        ▼
9. Reconnect to MCP server with access token
   Tools are now available
```

### Implementation Components

| Module                  | Purpose                                        |
| ----------------------- | ---------------------------------------------- |
| `mcp/auth.ts`           | OAuth configuration and credential management  |
| `mcp/oauth-provider.ts` | Implements the `OAuthClientProvider` interface |
| `mcp/oauth-callback.ts` | Temporary HTTP server for OAuth redirects      |

### Credential Storage

OAuth tokens are stored per-server in the user's data directory:

```
~/.local/share/opencode/
└── mcp/
    └── credentials/
        ├── remote-tools.json    # { accessToken, refreshToken, expiresAt }
        └── another-server.json
```

Token refresh happens automatically when the access token expires.

---

## Tool Discovery

When an MCP server connects, OpenCode discovers its available tools:

```
client.listTools()
    │
    ▼
Server responds with tool list:
[
  {
    name: "query_database",
    description: "Execute a SQL query against the connected database",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "SQL query to execute" },
        params: { type: "array", description: "Query parameters" }
      },
      required: ["query"]
    }
  },
  {
    name: "list_tables",
    description: "List all tables in the database",
    inputSchema: { type: "object", properties: {} }
  }
]
```

### convertMcpTool()

Each MCP tool is converted to the Vercel AI SDK format:

```
MCP tool definition               AI SDK tool definition
─────────────────────              ─────────────────────
name: "query_database"     →      name: "mcp_servername_query_database"
description: "..."         →      description: "..."
inputSchema: { JSON Schema } →    parameters: Zod schema (from JSON Schema)
                           →      execute: async (args) => {
                                    return client.callTool("query_database", args)
                                  }
```

Key transformations:

1. **Namespacing** — MCP tool names are prefixed with the server name to avoid collisions with built-in tools
2. **Schema conversion** — JSON Schema is converted to a format compatible with the AI SDK (using `jsonSchema()`)
3. **Execute wrapper** — The execute function delegates to the MCP client's `callTool()` method
4. **Permission integration** — MCP tools go through the same permission system as built-in tools

### Dynamic Tool Updates

MCP servers can add, remove, or modify tools at runtime. When a server sends a `ToolListChangedNotification`:

```
MCP Server                     OpenCode
    │                              │
    │  notifications/tools/list_changed
    │─────────────────────────────►│
    │                              │
    │                              ├── Re-fetch tool list
    │                              ├── Update tool registry
    │                              ├── Bus.publish(McpToolsChanged)
    │                              └── UI updates tool list
```

This allows MCP servers to dynamically expose tools based on context — for example, a database server might expose different tools depending on the schema it discovers.

---

## Prompts and Resources

MCP provides more than just tools. OpenCode also supports:

### Prompts

MCP prompts are pre-defined prompt templates:

```
client.listPrompts()
→ [{ name: "review-code", description: "Review code for best practices" }]

client.getPrompt("review-code", { file: "src/auth.ts" })
→ { messages: [{ role: "user", content: "Please review this code..." }] }
```

Prompts allow MCP servers to provide domain-specific instructions to the LLM.

### Resources

MCP resources are data sources the LLM can access:

```
client.listResources()
→ [{ uri: "db://schema", name: "Database Schema" }]

client.readResource("db://schema")
→ { contents: [{ text: "CREATE TABLE users (...)" }] }
```

Resources give the LLM access to contextual information without tool calls.

---

## MCP Server Status

OpenCode tracks the status of each configured MCP server:

| Status                      | Meaning                                     |
| --------------------------- | ------------------------------------------- |
| `connected`                 | Server is running and tools are available   |
| `disabled`                  | Server is configured but `enabled: false`   |
| `failed`                    | Server crashed or failed to start           |
| `needs_auth`                | Remote server requires OAuth authentication |
| `needs_client_registration` | Server requires dynamic client registration |
| `connecting`                | Server is starting up                       |

Status changes are published via the event bus, so the UI can display connection indicators for each MCP server.

---

## MCP Lifecycle Management

Each MCP server has a managed lifecycle:

```
Configured in opencode.json
        │
        ▼
┌───────────────────┐
│ Server starting    │  Spawn process (stdio) or connect (HTTP)
└───────┬───────────┘
        │
        ▼
┌───────────────────┐
│ Initialize         │  MCP handshake, capability negotiation
└───────┬───────────┘
        │
        ▼
┌───────────────────┐
│ Discover tools     │  tools/list → register in tool registry
└───────┬───────────┘
        │
        ▼
┌───────────────────┐
│ Running            │  Handle tool calls, notifications
│                    │  Monitor for tool list changes
└───────┬───────────┘
        │ (on instance dispose or server crash)
        ▼
┌───────────────────┐
│ Cleanup            │  Kill process tree, close connections
└───────────────────┘
```

On instance disposal (when OpenCode shuts down or a project instance is closed), all MCP server processes are terminated and their process trees are cleaned up. This prevents orphaned processes.

---

## Agent Client Protocol (ACP)

### What Is ACP?

The **Agent Client Protocol** (`@agentclientprotocol/sdk` v0.14.1) is a newer protocol for AI agent interoperability. While MCP focuses on tools and resources, ACP focuses on **agent-to-agent communication**:

- An ACP **server** exposes agents that can be invoked
- An ACP **client** can discover and invoke remote agents

OpenCode implements both sides — it can act as an ACP client (invoking remote agents) and can expose its own agents via ACP.

### ACP vs MCP

| Aspect      | MCP                             | ACP                            |
| ----------- | ------------------------------- | ------------------------------ |
| Focus       | Tools, prompts, resources       | Agent invocation and sessions  |
| Abstraction | Function-level (call a tool)    | Agent-level (run a session)    |
| State       | Stateless tool calls            | Stateful agent sessions        |
| Direction   | Client discovers server's tools | Client invokes server's agents |
| Use case    | "Give me a database query tool" | "Let this agent explore code"  |

### ACP Implementation

The ACP module lives in `packages/opencode/src/acp/`:

```
acp/
├── types.ts       # TypeScript types for ACP protocol
├── agent.ts       # ACP agent definitions and registration
├── session.ts     # ACP session management
└── adaptors/      # Transport adaptors (SSE, etc.)
```

### ACP Session Flow

```
External system                  OpenCode (ACP server)
      │                                │
      │  POST /acp/agent               │
      │  { agent: "build", prompt: "..." }
      │───────────────────────────────►│
      │                                │
      │                                ├── Create session
      │                                ├── Run agent with prompt
      │                                ├── Stream events via SSE
      │                                │
      │  SSE: session events           │
      │◄───────────────────────────────│
      │  (text chunks, tool calls,     │
      │   results, completion)         │
      │                                │
      │  POST /acp/session/:id/message │
      │  { content: "follow up" }      │
      │───────────────────────────────►│
      │                                │
      │  ... more events ...           │
```

### ACP as Client

OpenCode can also invoke agents on remote ACP servers, treating them as specialized subagents:

```
OpenCode agent                    Remote ACP Server
      │                                │
      │  task tool: "Let the review    │
      │  agent check this code"        │
      │                                │
      │  ACP invoke                    │
      │───────────────────────────────►│
      │                                │
      │  Agent runs remotely           │
      │  (own tools, own context)      │
      │                                │
      │  Result returned               │
      │◄───────────────────────────────│
      │                                │
      │  Primary agent continues       │
      │  with remote result            │
```

This enables distributed agent workflows — for example, a security-focused agent running on a specialized server could review code before the build agent makes changes.

---

## MCP + ACP Together

MCP and ACP are complementary:

```
┌─────────────────────────────────────────────┐
│              OpenCode                        │
│                                              │
│  Built-in tools (25+)                        │
│       +                                      │
│  MCP tools (external servers)                │
│       +                                      │
│  ACP agents (external agents)                │
│       =                                      │
│  Unified tool + agent registry               │
│                                              │
│  The LLM sees everything as capabilities     │
│  it can invoke — tools and agents alike       │
└─────────────────────────────────────────────┘
```

### Example Configuration

```json
{
  "mcp": {
    "servers": {
      "database": {
        "command": "npx",
        "args": ["@mcp/server-postgres"],
        "env": { "DATABASE_URL": "..." }
      },
      "github": {
        "command": "npx",
        "args": ["@mcp/server-github"],
        "env": { "GITHUB_TOKEN": "..." }
      },
      "remote-analysis": {
        "url": "https://analysis.example.com/mcp",
        "transport": "streamable-http"
      }
    }
  },
  "acp": {
    "agents": {
      "security-reviewer": {
        "url": "https://security.example.com/acp"
      }
    }
  }
}
```

With this configuration, the AI agent has access to:

- 25+ built-in tools (bash, read, write, edit, grep, ...)
- Database tools (query, list tables, describe schema) from MCP
- GitHub tools (create PR, list issues, etc.) from MCP
- Remote analysis tools from the HTTP MCP server
- A security review agent via ACP

All discoverable, all permission-controlled, all transparent to the LLM.

---

## Error Handling and Resilience

### MCP Server Crashes

When a stdio-based MCP server crashes:

1. The transport detects the process exit
2. Server status changes to `failed`
3. A `McpStatusChanged` event is published
4. The UI shows the server as disconnected
5. Users can restart via `/mcp/restart` endpoint or UI action

### Connection Failures

For HTTP-based servers:

1. Connection errors are caught and logged
2. Retry with exponential backoff
3. After max retries, status changes to `failed`
4. OAuth token refresh is attempted if the error is 401

### Tool Call Failures

When an MCP tool call fails:

1. The error is caught by the execute wrapper
2. A descriptive error message is returned to the LLM
3. The LLM can decide to retry, try a different approach, or report the error
4. The tool call is still recorded as a part (with the error as the result)

---

## Key Takeaways

1. **MCP extends OpenCode's tool system** — Any MCP-compatible tool server becomes a seamless extension, transparent to the LLM.

2. **Three transports** — stdio for local processes, HTTP and SSE for remote servers. Most users will use stdio with `npx`.

3. **OAuth for remote servers** — Full OAuth 2.1 flow with PKCE, browser-based auth, token storage, and automatic refresh.

4. **Dynamic tool discovery** — MCP servers can add and remove tools at runtime, and OpenCode adapts automatically.

5. **ACP enables agent interop** — Remote agents can be invoked as subagents, enabling distributed AI workflows.

6. **Same permission model** — MCP and ACP tools go through the same allow/ask/deny permission system as built-in tools.

7. **Resilient** — Server crashes, connection failures, and auth expirations are handled gracefully with status tracking and automatic recovery.

---

**Next:** [Chapter 14: SDK & Plugin System →](./14-sdk-and-plugins.md) — The TypeScript SDK, plugin architecture, and how to extend OpenCode.

**Previous:** [Chapter 12: Event Bus System](./12-event-bus.md)
