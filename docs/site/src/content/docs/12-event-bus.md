---
title: "Chapter 12: Event Bus System"
---


> The three-layer pub/sub architecture that enables real-time reactivity across all interfaces.

---

## Overview

The event bus is OpenCode's **nervous system** — it's how the backend engine communicates state changes to every connected interface in real-time. When the LLM generates a text chunk, when a tool finishes executing, when a permission is requested — all of these become typed events that flow through the bus to the TUI, web app, desktop app, and any SDK client.

The bus has three layers:

```
┌──────────────────────────────────────────────────┐
│  Layer 1: Bus Event Definitions                   │
│  BusEvent.define("session.created", zodSchema)    │
│  Typed, validated, registered in a global map     │
└──────────────────────┬───────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────┐
│  Layer 2: Instance Bus (per-project)              │
│  Bus.publish() / Bus.subscribe()                  │
│  Scoped to one project instance                   │
│  Also forwards to Global Bus                      │
└──────────────────────┬───────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────┐
│  Layer 3: Global Bus (cross-instance)             │
│  Node.js EventEmitter                             │
│  Routes events across project instances           │
│  Powers the SSE endpoint                          │
└──────────────────────────────────────────────────┘
```

---

## Layer 1: Event Definitions (`bus/bus-event.ts`)

Every event in OpenCode is defined with a **name** and a **Zod schema**:

```
const SessionCreated = BusEvent.define(
  "session.created",
  z.object({
    id: z.string(),
    project_id: z.string(),
    agent_id: z.string(),
  })
)
```

### How `BusEvent.define()` Works

1. Takes an event type string and a Zod schema
2. Registers the event in a global type → schema map
3. Returns an event definition object that can be used for publishing and subscribing

### Global Registry

All event definitions are collected into a global registry:

```
Event Registry:
  "session.created"       → z.object({ id, project_id, agent_id })
  "session.updated"       → z.object({ id, title, ... })
  "message.created"       → z.object({ session_id, message_id, role })
  "part.created"          → z.object({ session_id, message_id, type, ... })
  "tool.invocation"       → z.object({ session_id, tool, args, ... })
  "tool.result"           → z.object({ session_id, tool_call_id, result })
  "permission.requested"  → z.object({ session_id, tool, path, ... })
  "mcp.tool.changed"      → z.object({ server, tools })
  "instance.disposed"     → z.object({})
  ... and more
```

The `payloads()` function generates a **Zod discriminated union** of all registered events. This is used to type the `/event` SSE endpoint in the OpenAPI spec — clients know exactly what shapes to expect.

### Type Safety

The event definition carries its Zod schema as a TypeScript generic, which means:

```
// Publishing is type-checked
Bus.publish(SessionCreated, {
  id: "01HX...",
  project_id: "01HX...",
  agent_id: "build",
})

// This would be a compile error:
Bus.publish(SessionCreated, {
  id: "01HX...",
  // Missing required fields → TypeScript error
})

// Subscribing is type-checked
Bus.subscribe(SessionCreated, (event) => {
  // event.properties is typed as { id: string, project_id: string, agent_id: string }
  console.log(event.properties.id) // ✓ typed
  console.log(event.properties.foo) // ✗ compile error
})
```

This end-to-end type safety means event producers and consumers can never go out of sync — the compiler catches mismatches.

---

## Layer 2: Instance Bus (`bus/index.ts`)

The Instance Bus is **scoped to a single project instance**. Each `Instance.provide()` call creates a fresh subscription map, ensuring that events from one project don't leak into another.

### API

| Method                    | Description                                                |
| ------------------------- | ---------------------------------------------------------- |
| `Bus.publish(def, props)` | Publish an event to type-specific + wildcard listeners     |
| `Bus.subscribe(def, cb)`  | Subscribe to a specific event type                         |
| `Bus.once(def, cb)`       | Subscribe, auto-unsubscribe when callback returns `"done"` |
| `Bus.subscribeAll(cb)`    | Subscribe to ALL events (wildcard)                         |

### Publishing Flow

When `Bus.publish()` is called:

```
Bus.publish(SessionCreated, { id: "01HX...", ... })
        │
        ▼
1. Look up subscribers for "session.created"
   → Call each with the event payload
        │
        ▼
2. Look up wildcard subscribers ("*")
   → Call each with the event payload
        │
        ▼
3. Forward to Global Bus
   → GlobalBus.emit("event", { directory, payload })
```

Step 3 is critical — it's how the per-instance bus connects to the cross-instance Global Bus, which in turn feeds the SSE endpoint.

### Subscribing

```
// Subscribe to a specific event type
const unsub = Bus.subscribe(PartCreated, (event) => {
  console.log("New part:", event.properties.type)
})

// Later, unsubscribe
unsub()
```

The subscribe function returns an **unsubscribe function** — a clean pattern that avoids the need to track listener references manually.

### Wildcard Subscription

The wildcard subscription receives every event published on the instance:

```
const unsub = Bus.subscribeAll((event) => {
  // event.type tells you which event it is
  // event.properties contains the typed payload
  switch (event.type) {
    case "session.created":
      // ...
    case "part.created":
      // ...
  }
})
```

This is used by the SSE endpoint — it subscribes to all events and forwards them to connected clients.

### Once Pattern

The `once()` method auto-unsubscribes when the callback returns `"done"`:

```
Bus.once(PermissionResolved, (event) => {
  if (event.properties.tool_call_id === myCallId) {
    // Got the answer, unsubscribe
    resolve(event.properties.decision)
    return "done"
  }
  // Not our event, keep listening
})
```

This is useful for request-response patterns — publish a request event, then wait for the matching response.

### Instance Cleanup

When an instance is disposed (e.g., when a project is closed or a test finishes), the bus:

1. Publishes an `InstanceDisposed` event to all wildcard subscribers
2. Clears all subscription maps
3. Removes the reference to the Global Bus forwarding

This ensures no memory leaks and no stale event listeners.

---

## Layer 3: Global Bus (`bus/global.ts`)

The Global Bus is a **process-wide** event emitter that routes events across project instances.

### Implementation

It's built on Node.js's `EventEmitter` (available in Bun) with a single event channel:

```
// Simplified from actual code
import { EventEmitter } from "events"

const emitter = new EventEmitter()

// Forward from instance bus
function emit(directory: string, payload: BusPayload) {
  emitter.emit("event", { directory, payload })
}

// Subscribe to all instances
function subscribe(cb: (event: { directory: string, payload: BusPayload }) => void) {
  emitter.on("event", cb)
  return () => emitter.off("event", cb)
}
```

### Why a Global Bus?

The Global Bus exists for the **control-plane** — OpenCode's multi-project management system. When you have multiple project directories open:

```
Instance A (~/project-1)
    │
    ├── Bus publishes SessionCreated
    │       └── Forwards to Global Bus
    │
Instance B (~/project-2)
    │
    ├── Bus publishes PartCreated
    │       └── Forwards to Global Bus
    │
Global Bus
    │
    ├── SSE endpoint subscribes
    │   └── Routes events to the correct client
    │       based on the `directory` field
    │
    └── Control-plane workspace manager
        └── Tracks all active project instances
```

Each event on the Global Bus carries a `directory` field that identifies which project instance produced it. This allows the SSE endpoint and workspace manager to route events correctly.

---

## How the Bus Powers Real-Time UIs

Here's the complete flow from a backend action to a UI update:

### Backend → Bus → SSE → UI

```
1. Tool executes (e.g., bash tool finishes)
        │
        ▼
2. Session module stores the result as a Part
        │
        ▼
3. Session module publishes:
   Bus.publish(PartCreated, {
     session_id: "01HX...",
     message_id: "01HX...",
     type: "tool-result",
     content: "Tests passed (5/5)",
   })
        │
        ▼
4. Instance Bus calls all subscribers:
   ├── TUI subscriber → updates terminal display
   ├── Wildcard subscriber (SSE) → forwards to SSE stream
   └── Global Bus → available for control-plane
        │
        ▼
5. SSE endpoint writes:
   event: part.created
   data: {"session_id":"01HX...","type":"tool-result","content":"Tests passed (5/5)"}
        │
        ▼
6. Web App's SyncProvider receives SSE event
        │
        ▼
7. Reactive store is updated:
   setMessages(sessionId, (msgs) => [...msgs, newPart])
        │
        ▼
8. SolidJS reactivity triggers DOM update
   → The tool call card shows "Tests passed (5/5)"
```

This entire flow happens in **milliseconds** — from tool completion to UI update.

### Permission Request Flow

A more complex example — the permission system uses the bus for bidirectional communication:

```
1. Tool call arrives, permission = "ask"
        │
        ▼
2. Permission module publishes:
   Bus.publish(PermissionRequested, {
     session_id, tool: "bash", command: "rm -rf node_modules",
     request_id: "req_01HX..."
   })
        │
        ▼
3. SSE → Web App shows permission dialog
   OR
   TUI shows permission prompt
        │
        ▼
4. User clicks "Allow" (or presses 'y')
        │
        ▼
5. Client sends REST: POST /permission { request_id, decision: "allow" }
        │
        ▼
6. Server handler publishes:
   Bus.publish(PermissionResolved, {
     request_id: "req_01HX...", decision: "allow"
   })
        │
        ▼
7. Permission module (waiting via Bus.once) receives resolution
        │
        ▼
8. Tool executes
```

The bus enables this **request-response-via-events** pattern without either side needing to know about the other directly.

---

## Event Catalog

Here are the key events published throughout OpenCode:

### Session Events

| Event             | Published When              |
| ----------------- | --------------------------- |
| `session.created` | New session started         |
| `session.updated` | Session metadata changed    |
| `session.deleted` | Session removed             |
| `session.idle`    | Session finished processing |
| `session.active`  | Session started processing  |
| `session.compact` | Compaction completed        |

### Message & Part Events

| Event             | Published When                        |
| ----------------- | ------------------------------------- |
| `message.created` | New message added to a session        |
| `message.updated` | Message content or metadata changed   |
| `part.created`    | New part added to a message           |
| `part.updated`    | Part content updated (streaming text) |

### Tool Events

| Event             | Published When      |
| ----------------- | ------------------- |
| `tool.invocation` | Tool call started   |
| `tool.result`     | Tool call completed |

### Permission Events

| Event                  | Published When                       |
| ---------------------- | ------------------------------------ |
| `permission.requested` | Tool call needs user approval        |
| `permission.resolved`  | User responded to permission request |

### Provider & MCP Events

| Event              | Published When                       |
| ------------------ | ------------------------------------ |
| `provider.status`  | Provider availability changed        |
| `mcp.tool.changed` | MCP server's tool list updated       |
| `mcp.status`       | MCP server connection status changed |

### System Events

| Event               | Published When                    |
| ------------------- | --------------------------------- |
| `instance.disposed` | Project instance is shutting down |
| `server.started`    | HTTP server is ready              |
| `config.changed`    | Configuration was updated         |

---

## Design Principles

### 1. Type-Safe from Definition to Consumption

Events are defined with Zod schemas, published with type-checked payloads, and consumed with typed callbacks. The compiler ensures consistency across the entire pipeline.

### 2. Instance Isolation

Per-project event buses prevent cross-talk between projects. A session event from project A never reaches a subscriber in project B (unless they're using the Global Bus).

### 3. Decoupled Producers and Consumers

The session module doesn't know about the TUI. The TUI doesn't know about the web app. They communicate exclusively through events. This decoupling means you can add new consumers (a new UI, a logging system, a metrics pipeline) without modifying producers.

### 4. Fire-and-Forget Publishing

`Bus.publish()` is synchronous and doesn't wait for subscribers to finish. Publishers don't block on consumer processing. If a subscriber throws an error, it doesn't affect other subscribers or the publisher.

### 5. Clean Lifecycle

Every subscription returns an unsubscribe function. Instance disposal cleans up all subscriptions. No manual tracking, no memory leaks, no zombie listeners.

---

## Bus vs. Direct Communication

Why use an event bus instead of direct function calls?

| Approach         | Direct Calls                  | Event Bus                               |
| ---------------- | ----------------------------- | --------------------------------------- |
| Coupling         | Producer knows about consumer | Decoupled — no direct reference         |
| Adding consumers | Modify producer code          | Just subscribe — producer unchanged     |
| Real-time UI     | Need explicit push mechanism  | SSE endpoint subscribes to bus          |
| Testing          | Must mock consumers           | Can subscribe in tests to verify events |
| Multi-instance   | Complex routing logic         | Global bus routes automatically         |
| Performance      | Direct call overhead          | Event dispatch overhead (minimal)       |

For a system like OpenCode — where the same state changes need to reach a terminal, a browser, and a desktop app simultaneously — the event bus is the natural architecture.

---

## Relationship to Other Systems

```
┌─────────────────────────────────────────────────────────┐
│                    Event Bus                             │
│                                                         │
│  Producers:                    Consumers:                │
│  ┌──────────┐                  ┌──────────────────┐     │
│  │ Session  │──publish──────►  │ TUI (in-process) │     │
│  │ module   │                  └──────────────────┘     │
│  └──────────┘                  ┌──────────────────┐     │
│  ┌──────────┐                  │ SSE endpoint     │     │
│  │ Tool     │──publish──────►  │ → Web App        │     │
│  │ executor │                  │ → Desktop App    │     │
│  └──────────┘                  │ → SDK clients    │     │
│  ┌──────────┐                  └──────────────────┘     │
│  │ MCP      │──publish──────►  ┌──────────────────┐     │
│  │ client   │                  │ Control-plane    │     │
│  └──────────┘                  │ workspace mgr    │     │
│  ┌──────────┐                  └──────────────────┘     │
│  │ Permis-  │──publish──────►  ┌──────────────────┐     │
│  │ sion sys │                  │ Test assertions  │     │
│  └──────────┘                  └──────────────────┘     │
│  ┌──────────┐                                           │
│  │ Config   │──publish──────►  (any future consumer)    │
│  │ module   │                                           │
│  └──────────┘                                           │
└─────────────────────────────────────────────────────────┘
```

---

## Key Takeaways

1. **Three layers** — Event definitions (typed schemas), Instance Bus (per-project), Global Bus (cross-project). Each layer adds a capability.

2. **Type-safe end-to-end** — Zod schemas at definition, TypeScript generics at publish/subscribe, OpenAPI schema at the SSE endpoint. The compiler catches mismatches everywhere.

3. **Instance isolation** — Events are scoped to project instances by default. The Global Bus is opt-in for cross-instance routing.

4. **Decoupled architecture** — Producers and consumers never reference each other directly. New consumers can be added without modifying any producer.

5. **Powers all real-time UIs** — The SSE endpoint is just a wildcard subscriber that forwards events to HTTP clients. The TUI subscribes directly in-process. Same events, different transports.

6. **Request-response via events** — The permission system demonstrates that the bus can handle bidirectional flows, not just notifications.

---

**Next:** [Chapter 13: MCP & ACP Protocols →](/13-mcp-and-acp/) — Model Context Protocol for external tools and Agent Client Protocol for agent interop.

**Previous:** [Chapter 11: HTTP Server & API](/11-http-server-and-api/)
