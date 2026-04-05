# Chapter 11: HTTP Server & API

> Hono-powered API, OpenAPI generation, SSE streaming, and the event bus that ties everything together.

---

## Overview

OpenCode's HTTP server is the communication backbone — it's how the web app, desktop app, SDK, and external tools interact with the core engine. The server is built on **[Hono](https://hono.dev)** (v4.10.7), a lightweight, high-performance web framework that runs natively on Bun.

The server exposes:

- **REST API** — CRUD operations for sessions, messages, projects, config, etc.
- **SSE endpoint** — Real-time event streaming via Server-Sent Events
- **WebSocket support** — For persistent bidirectional connections
- **OpenAPI spec** — Auto-generated API documentation from route definitions

All of this runs on `Bun.serve()`, Bun's native HTTP server, which provides excellent performance with zero external dependencies.

---

## Server Architecture

### Entry Point

The server is initialized in `packages/opencode/src/server/server.ts`:

```
Bun.serve({
  port: 4096,             // Default port
  fetch: app.fetch,       // Hono app handles all requests
  websocket: { ... },     // WebSocket upgrade handler
})
```

The Hono `app` is the central router — all HTTP requests flow through its middleware stack before reaching route handlers.

### Middleware Stack

Requests pass through several layers before reaching a route:

```
Incoming HTTP request
        │
        ▼
┌───────────────────┐
│ CORS middleware    │  Allow localhost, Tauri, opencode.ai origins
└───────┬───────────┘
        │
        ▼
┌───────────────────┐
│ Auth middleware    │  Optional basic auth for remote access
└───────┬───────────┘
        │
        ▼
┌───────────────────┐
│ Instance binding   │  Associates request with a project instance
└───────┬───────────┘
        │
        ▼
┌───────────────────┐
│ Route handler      │  The actual endpoint logic
└───────────────────┘
```

### CORS Configuration

The server allows requests from several origins:

| Origin                    | Context                           |
| ------------------------- | --------------------------------- |
| `http://localhost:*`      | Local web app development         |
| `tauri://localhost`       | Tauri desktop app (macOS)         |
| `http://tauri.localhost`  | Tauri desktop app (Linux/Windows) |
| `https://app.opencode.ai` | Production web app                |
| `https://*.opencode.ai`   | Staging/preview deployments       |

This ensures the web app and desktop app can communicate with the local server while preventing unauthorized access from random websites.

---

## Route Organization

Routes are organized into modules under `packages/opencode/src/server/routes/`:

```
server/
├── server.ts           # Server setup, middleware, app creation
└── routes/
    ├── session.ts       # Session CRUD, message creation
    ├── project.ts       # Project discovery and management
    ├── config.ts        # Configuration read/write
    ├── provider.ts      # Provider listing and status
    ├── pty.ts           # Pseudo-terminal management
    ├── mcp.ts           # MCP server management
    ├── file.ts          # File operations
    ├── permission.ts    # Permission rules management
    ├── question.ts      # User question/answer flow
    ├── global.ts        # Global settings
    ├── experimental.ts  # Experimental features
    └── tui.ts           # TUI-specific endpoints
```

Plus top-level routes mounted directly on the app:

| Endpoint   | Purpose                                   |
| ---------- | ----------------------------------------- |
| `/agent`   | Agent listing and configuration           |
| `/skill`   | Skill discovery and execution             |
| `/lsp`     | Language Server Protocol operations       |
| `/event`   | SSE event stream (the real-time backbone) |
| `/log`     | Log streaming                             |
| `/auth`    | Authentication management                 |
| `/vcs`     | Version control operations (git)          |
| `/command` | Command execution                         |
| `/path`    | File path resolution and navigation       |

---

## Route Definition Pattern

OpenCode routes follow a consistent pattern using Hono's router with OpenAPI integration:

### Basic Route

```
app.get("/session", (c) => {
  const sessions = db
    .select()
    .from(session)
    .where(eq(session.project_id, projectId))
    .all()
  return c.json(sessions)
})
```

### OpenAPI-Annotated Route

For routes that are part of the public API (and thus appear in the SDK), OpenCode uses `hono-openapi` with `describeRoute()`:

```
import { describeRoute } from "hono-openapi"
import { validator } from "@hono/zod-validator"

app.post(
  "/session/:id/message",
  describeRoute({
    description: "Send a message in a session",
    responses: {
      200: {
        description: "Message created",
        content: {
          "application/json": {
            schema: MessageSchema,
          },
        },
      },
    },
  }),
  validator("json", MessageInputSchema),
  async (c) => {
    const input = c.req.valid("json")
    const id = c.req.param("id")
    // ... create message, start streaming
    return c.json(message)
  }
)
```

This pattern gives you:

1. **Runtime validation** — The Zod schema validates request bodies before the handler runs
2. **OpenAPI generation** — The route description and schemas are collected into an OpenAPI spec
3. **SDK generation** — The OpenAPI spec feeds into `@hey-api/openapi-ts` to generate the TypeScript SDK

### Validation with Zod

Request validation uses `@hono/zod-validator` with **Zod 4.1.8**:

```
import z from "zod"

const CreateSession = z.object({
  agent_id: z.string(),
  title: z.string().optional(),
})

app.post(
  "/session",
  validator("json", CreateSession),
  (c) => {
    const body = c.req.valid("json")
    // body is typed as { agent_id: string, title?: string }
  }
)
```

If validation fails, the validator returns a 400 response with error details — the handler never runs.

---

## The SSE Event Endpoint

The `/event` endpoint is the real-time backbone of OpenCode. It uses **Server-Sent Events** (SSE) to push events from the backend to connected clients.

### How It Works

```
Client (Web App, TUI, SDK)
        │
        │  GET /event
        │  Accept: text/event-stream
        ▼
┌────────────────────┐
│  Hono SSE handler  │
│  streamSSE()       │
│                    │
│  Bus.subscribeAll  │ ← Subscribe to ALL events on the instance bus
│    │               │
│    ▼               │
│  For each event:   │
│    stream.write({  │
│      event: type,  │
│      data: JSON    │
│    })              │
└────────────────────┘
```

### Implementation

```
import { streamSSE } from "hono/streaming"

app.get("/event", (c) => {
  return streamSSE(c, async (stream) => {
    const unsub = Bus.subscribeAll((event) => {
      stream.writeSSE({
        event: event.type,
        data: JSON.stringify(event.properties),
      })
    })

    // Keep the connection alive
    stream.onAbort(() => {
      unsub()
    })
  })
})
```

### Event Format

Events arrive at the client as standard SSE messages:

```
event: session.created
data: {"id":"01HX...","project_id":"01HX...","agent_id":"build"}

event: part.created
data: {"session_id":"01HX...","message_id":"01HX...","type":"text","content":"I'll start by..."}

event: tool.invocation
data: {"session_id":"01HX...","tool":"read","args":{"path":"src/auth.ts"}}

event: part.created
data: {"session_id":"01HX...","type":"tool-result","result":"...file contents..."}
```

### Client-Side Consumption

The SDK and web app consume the SSE stream using the standard `EventSource` API (or a compatible library):

```
const events = new EventSource("http://localhost:4096/event")

events.addEventListener("part.created", (e) => {
  const part = JSON.parse(e.data)
  // Update the UI with the new part
})

events.addEventListener("session.updated", (e) => {
  const session = JSON.parse(e.data)
  // Refresh session metadata
})
```

### Why SSE Over WebSocket?

SSE was chosen over WebSocket for the primary event stream because:

1. **Unidirectional** — Events flow server→client; client→server uses REST. This matches the architecture perfectly.
2. **Auto-reconnect** — The `EventSource` API automatically reconnects on disconnection.
3. **Simpler** — No handshake protocol, no ping/pong, no frame encoding.
4. **HTTP-native** — Works through proxies, load balancers, and firewalls without special configuration.
5. **Debugging** — SSE is plain text over HTTP — you can `curl` the endpoint and read events.

WebSocket support exists for cases that need bidirectional communication (like the PTY terminal), but SSE handles the vast majority of real-time needs.

---

## Key API Endpoints

### Session Management

| Method | Path                       | Description                           |
| ------ | -------------------------- | ------------------------------------- |
| GET    | `/session`                 | List sessions for the current project |
| POST   | `/session`                 | Create a new session                  |
| GET    | `/session/:id`             | Get session details                   |
| DELETE | `/session/:id`             | Delete a session                      |
| POST   | `/session/:id/message`     | Send a message (starts LLM streaming) |
| POST   | `/session/:id/abort`       | Abort the current streaming response  |
| POST   | `/session/:id/retry`       | Retry the last exchange               |
| POST   | `/session/:id/revert/:mid` | Revert to a specific message          |
| GET    | `/session/:id/share`       | Generate a shareable session link     |
| POST   | `/session/:id/compact`     | Manually trigger compaction           |

### Project & Config

| Method | Path        | Description                  |
| ------ | ----------- | ---------------------------- |
| GET    | `/project`  | Get current project info     |
| GET    | `/config`   | Get current configuration    |
| PUT    | `/config`   | Update configuration         |
| GET    | `/provider` | List available LLM providers |

### Tools & Permissions

| Method | Path            | Description                        |
| ------ | --------------- | ---------------------------------- |
| GET    | `/agent`        | List available agents              |
| GET    | `/permission`   | List active permission rules       |
| POST   | `/permission`   | Create or update a permission rule |
| POST   | `/question/:id` | Answer a pending user question     |

### MCP & Extensions

| Method | Path           | Description                 |
| ------ | -------------- | --------------------------- |
| GET    | `/mcp`         | List configured MCP servers |
| POST   | `/mcp/restart` | Restart an MCP server       |
| GET    | `/skill`       | List discovered skills      |

### File & VCS

| Method | Path    | Description                        |
| ------ | ------- | ---------------------------------- |
| GET    | `/file` | Read file contents                 |
| GET    | `/vcs`  | Get VCS (git) status and diff info |
| GET    | `/path` | Resolve and navigate file paths    |

### PTY (Pseudo-Terminal)

| Method | Path       | Description              |
| ------ | ---------- | ------------------------ |
| POST   | `/pty`     | Create a new PTY session |
| GET    | `/pty/:id` | Get PTY session info     |
| DELETE | `/pty/:id` | Destroy a PTY session    |

PTY sessions use WebSocket for bidirectional terminal I/O — this is one of the few places where WebSocket is used instead of SSE.

---

## OpenAPI Specification

The server auto-generates an OpenAPI 3.x specification from route definitions:

```
GET /openapi.json → Full OpenAPI spec
```

This spec is used to:

1. **Generate the TypeScript SDK** (`packages/sdk/js`) via `@hey-api/openapi-ts`
2. **Power the API docs** at `packages/docs`
3. **Validate API contracts** during development

The generation flow:

```
Route definitions (describeRoute + Zod schemas)
        │
        ▼
hono-openapi collects all route metadata
        │
        ▼
OpenAPI 3.x JSON spec generated
        │
        ▼
@hey-api/openapi-ts generates TypeScript client
        │
        ▼
packages/sdk/js exports typed client functions
```

This means adding a new API endpoint automatically updates the SDK — no manual client code needed.

---

## Proxy Fallback

For routes that the local server doesn't handle, it proxies to the remote `app.opencode.ai`:

```
app.all("*", async (c) => {
  // Forward unmatched requests to the remote app
  const url = new URL(c.req.url)
  url.host = "app.opencode.ai"
  return fetch(url.toString(), {
    method: c.req.method,
    headers: c.req.header(),
    body: c.req.raw.body,
  })
})
```

This allows the local server to serve the web app's static assets from the remote CDN while handling API calls locally. It simplifies deployment — the user doesn't need to run a separate web server for the UI.

---

## Server Startup Flow

When OpenCode starts (either via `opencode` TUI or `opencode serve`), the server bootstrap:

```
1. Load configuration
   ├── Read opencode.json
   ├── Read global config (~/.config/opencode/)
   └── Merge with env vars and defaults
         │
         ▼
2. Initialize storage
   ├── Open/create SQLite database
   ├── Run pending migrations
   └── Set up WAL mode
         │
         ▼
3. Initialize project
   ├── Detect project root (git, package.json, etc.)
   ├── Load project-specific config
   └── Initialize file watchers
         │
         ▼
4. Start MCP servers
   ├── Read MCP config
   ├── Spawn configured server processes
   └── Discover available tools
         │
         ▼
5. Create Hono app
   ├── Mount middleware (CORS, auth)
   ├── Mount route modules
   └── Mount SSE endpoint
         │
         ▼
6. Start Bun.serve()
   ├── Listen on port 4096
   ├── Log URL
   └── Optionally open browser (opencode web)
         │
         ▼
7. Publish ServerStarted event
   └── UI and clients can now connect
```

### Port Selection

The default port is 4096, but if it's in use, the server will try incrementally higher ports. The actual port is communicated to clients via the SDK configuration or service discovery (`bonjour-service` for mDNS).

---

## Connection Between Server and Bus

The HTTP server is the bridge between the internal event bus and external clients:

```
Internal modules                    External clients
(session, tools, etc.)              (Web App, Desktop, SDK)
        │                                    │
        │ Bus.publish(event)                 │ HTTP GET /event
        ▼                                    ▼
┌──────────────┐               ┌──────────────────┐
│  Event Bus   │──────────────▶│  SSE Stream      │
│  (instance)  │ subscribeAll  │  streamSSE()     │
└──────────────┘               └──────────────────┘
        │                                    │
        │ Also goes to:                      │
        ▼                                    │
┌──────────────┐                             │
│  Global Bus  │  For cross-instance         │
│  (process)   │  routing in control-plane   │
└──────────────┘                             │
                                             │
REST API  ◀──────────────────────────────────┘
POST /session/:id/message     Client actions flow
PUT /config                   back through REST
POST /permission
```

This separation of concerns means:

- **Read path** (server→client): Event Bus → SSE → UI updates
- **Write path** (client→server): REST POST → Handler → Business logic → Event Bus → SSE → UI updates

Every mutation goes through REST, triggers backend logic, which publishes events, which flow to all connected clients. This ensures consistency — all UIs see the same state at the same time.

---

## Authentication

### Local Mode (Default)

By default, the server runs locally and doesn't require authentication. It binds to `localhost` and only accepts connections from the same machine.

### Remote Access

When the server needs to be accessed remotely (e.g., running on a dev server), basic auth can be enabled:

```json
{
  "server": {
    "auth": {
      "type": "basic",
      "username": "admin",
      "password": "..."
    }
  }
}
```

### Tauri Desktop

The Tauri desktop app starts the opencode CLI as a sidecar process and connects to its local server. The connection is authenticated via a shared secret generated at startup.

---

## Error Handling

The server uses Hono's error handling middleware to ensure consistent error responses:

```
{
  "error": {
    "code": "SESSION_NOT_FOUND",
    "message": "Session 01HX... does not exist"
  }
}
```

Errors from Zod validation, database operations, and business logic are all normalized to this format. The SDK client deserializes these into typed error objects.

---

## Key Takeaways

1. **Hono is lightweight and fast** — It adds minimal overhead on top of `Bun.serve()`, giving native-speed HTTP handling with a clean API.

2. **SSE is the real-time backbone** — The `/event` endpoint bridges the internal event bus to external clients, enabling all UIs to update in real-time.

3. **OpenAPI drives the SDK** — Route definitions with Zod schemas automatically generate the API spec, which generates the TypeScript SDK. No manual client code.

4. **REST for writes, SSE for reads** — Mutations go through REST endpoints; state changes flow back via the event stream. Clean separation of concerns.

5. **Authentication is optional** — Local use requires no auth; remote access can be protected with basic auth.

6. **The proxy fallback** enables serving the web app from the remote CDN while handling API calls locally — a single server for everything.

---

**Next:** [Chapter 12: Event Bus System →](./12-event-bus.md) — The three-layer pub/sub architecture that enables real-time reactivity.

**Previous:** [Chapter 10: Desktop Application](./10-desktop-application.md)
