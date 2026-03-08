---
title: "Chapter 5: Agent & Session Architecture"
---


> How agents are defined, how sessions manage conversations, and how tool calls flow through the system.

---

## Overview

The agent and session system is the core execution engine of OpenCode. **Agents** are declarative configurations that define _what_ an AI assistant can do. **Sessions** are the runtime that drives _how_ conversations happen — managing message history, streaming LLM responses, executing tool calls, and persisting everything to SQLite.

Together, they form a loop:

```
User message → Session → Agent config → LLM call → Tool calls → Results → Next turn → ... → Final answer
```

This chapter walks through both systems in detail.

---

## Agents

### What Is an Agent?

An agent is a **configuration object** — not a running process. It defines:

| Property        | Purpose                                                                |
| --------------- | ---------------------------------------------------------------------- |
| `name`          | Human-readable identifier (`"build"`, `"explore"`, etc.)               |
| `mode`          | `"primary"` (main agent), `"subagent"` (called by primary), or `"all"` |
| `model`         | Which LLM to use, with optional per-provider overrides                 |
| `system`        | System prompt function — generates instructions for the LLM            |
| `permissions`   | What tools the agent can use (allow/ask/deny + glob patterns)          |
| `temperature`   | Creativity parameter (0 = deterministic, 1 = creative)                 |
| `maxTurns`      | Maximum tool-call rounds before stopping                               |
| `toolExclusion` | Tools explicitly excluded from this agent                              |

### Built-in Agents

OpenCode ships with several pre-configured agents:

| Agent        | Mode     | Purpose                                                                         |
| ------------ | -------- | ------------------------------------------------------------------------------- |
| `build`      | primary  | The default agent — full access to all tools, designed for general coding tasks |
| `explore`    | subagent | Read-only exploration — can read files and search but not modify anything       |
| `summary`    | subagent | Summarizes conversations or code for context                                    |
| `compaction` | subagent | Compresses long conversations to fit within context windows                     |
| `title`      | subagent | Generates short titles for sessions                                             |

### Agent Definition

Here's the shape of an agent definition in `agent/agent.ts`:

```
Agent.define({
  name: "build",
  mode: "primary",
  model: {
    default: "anthropic/claude-sonnet-4-20250514",
    // Per-provider overrides
    openai: "openai/o3",
    google: "google/gemini-2.5-pro",
  },
  permissions: [
    { tool: "bash", allow: true },
    { tool: "read", allow: true },
    { tool: "write", allow: true, glob: ["**/*"] },
    { tool: "edit", allow: true, glob: ["**/*"] },
    { tool: "grep", allow: true },
    { tool: "glob", allow: true },
    { tool: "ls", allow: true },
  ],
  temperature: 0,
  system: (context) => {
    // Generates the system prompt based on project context
    return `You are an AI coding assistant...`
  },
})
```

Key design decisions:

1. **Agents are declarative** — they don't contain execution logic. The session runtime interprets agent configs.
2. **Model selection is layered** — the agent defines defaults, but users can override in their config.
3. **Permissions are granular** — each tool can have different allow/ask/deny rules with file glob patterns.

### Custom Agents

Users can define custom agents in their `opencode.json` configuration:

```json
{
  "agent": {
    "review": {
      "model": "anthropic/claude-sonnet-4-20250514",
      "system": "You are a code reviewer. Focus on bugs, security issues, and performance.",
      "permissions": [
        { "tool": "read", "allow": true },
        { "tool": "grep", "allow": true },
        { "tool": "glob", "allow": true }
      ]
    }
  }
}
```

Custom agents are merged with the built-in registry and can be selected when starting a session.

---

## Sessions

### What Is a Session?

A session represents a **single conversation** between a user and an agent. It's the central runtime concept in OpenCode:

- Each session has a unique ID (ULID)
- Sessions are bound to a **project** (repository directory)
- Sessions are persisted to **SQLite** and can be resumed across restarts
- Sessions maintain full **message history** including tool calls and results

### Session Lifecycle

```
┌─────────────────┐
│  Session.create  │  ← User starts a new conversation
│  (agent, title)  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Session.chat    │  ← User sends a message
│  (message text)  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Build context   │  ← System prompt + message history + tool defs
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  streamText()    │  ← Call LLM via Vercel AI SDK
└────────┬────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌────────┐ ┌──────────┐
│ Text   │ │ Tool     │
│ chunks │ │ calls    │
└───┬────┘ └────┬─────┘
    │           │
    ▼           ▼
┌────────┐ ┌──────────────┐
│ Store  │ │ Permission   │
│ as     │ │ check        │
│ parts  │ └──────┬───────┘
└───┬────┘        │
    │        ┌────┴────┐
    │        ▼         ▼
    │     ┌──────┐  ┌──────┐
    │     │Allow │  │ Ask  │ → Prompt user
    │     └──┬───┘  └──┬───┘
    │        │         │
    │        ▼         ▼
    │     ┌───────────────┐
    │     │ Execute tool   │
    │     │ Store result   │
    │     │ as part        │
    │     └───────┬───────┘
    │             │
    ▼             ▼
┌─────────────────────┐
│ Publish events      │  ← Bus.publish(PartCreated, ...)
│ via Event Bus       │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ More tool calls?    │
│ Yes → loop back     │
│ No  → session idle  │
└─────────────────────┘
```

### The LLM Streaming Loop (`session/llm.ts`)

The `llm.ts` module is where the rubber meets the road. It wraps the Vercel AI SDK's `streamText()` with OpenCode-specific logic:

```
function stream(session, agent, messages) {
  // 1. Resolve the provider and model from agent config
  const model = resolveModel(agent)

  // 2. Build the system prompt
  const system = agent.system(context)

  // 3. Collect tool definitions (built-in + MCP)
  const tools = collectTools(agent)

  // 4. Call streamText with everything
  const result = streamText({
    model,
    system,
    messages,
    tools,
    maxSteps: agent.maxTurns,
    onStepFinish: (step) => {
      // Store parts, publish events
    },
  })

  // 5. Process the stream
  for await (const chunk of result.fullStream) {
    // Handle text deltas, tool calls, tool results
    // Store each as a Part in the database
    // Publish granular events via the Bus
  }
}
```

Key behaviors:

1. **Multi-step execution** — `maxSteps` allows the LLM to make multiple tool calls in sequence without user intervention
2. **Streaming** — Text and tool calls arrive as chunks and are stored/published incrementally
3. **Provider transforms** — Some providers need special handling (different tool call formats, etc.)
4. **Error recovery** — Transient errors trigger retries; persistent errors are surfaced to the user

---

## Messages and Parts

### The Data Model

Messages follow an **event-sourced** pattern — rather than storing a single blob of text, each message is decomposed into **parts**:

```
Session
  └── Message (role: "user")
  │     └── Part (type: "text", content: "Fix the login bug")
  │
  └── Message (role: "assistant")
        ├── Part (type: "text", content: "I'll look at the auth module...")
        ├── Part (type: "step-start")
        ├── Part (type: "tool-invocation", tool: "read", args: {path: "src/auth.ts"})
        ├── Part (type: "tool-result", result: "... file contents ...")
        ├── Part (type: "tool-invocation", tool: "edit", args: {path: "src/auth.ts", ...})
        ├── Part (type: "tool-result", result: "Edit applied successfully")
        └── Part (type: "text", content: "I've fixed the bug by...")
```

### Part Types

| Type              | Description                                     |
| ----------------- | ----------------------------------------------- |
| `text`            | A text chunk from user or assistant             |
| `tool-invocation` | A tool call request with tool name + arguments  |
| `tool-result`     | The output of a tool execution                  |
| `reasoning`       | Chain-of-thought tokens (for models like o1/o3) |
| `file`            | A file attachment                               |
| `step-start`      | Marks the beginning of a new inference step     |

### Why Parts?

This granular model enables:

1. **Incremental rendering** — The TUI and web app can display each part as it arrives, without waiting for the full response
2. **Event-driven updates** — Each part triggers a `PartCreated` event on the bus, enabling real-time UI updates
3. **Selective replay** — You can reconstruct the conversation at any point by replaying parts in order
4. **Efficient storage** — Parts are individually addressable for compaction, retry, and revert operations

### Database Schema

The session-related tables in `session/session.sql.ts`:

```
session
  ├── id: text (PK, ULID)
  ├── project_id: text
  ├── agent_id: text
  ├── title: text
  ├── created_at: integer (unix timestamp)
  └── updated_at: integer

message
  ├── id: text (PK, ULID)
  ├── session_id: text (FK → session)
  ├── role: text ("user" | "assistant" | "system")
  ├── created_at: integer
  └── metadata: text (JSON)

part
  ├── id: text (PK, ULID)
  ├── message_id: text (FK → message)
  ├── type: text
  ├── content: text (JSON, varies by type)
  ├── index: integer (ordering within message)
  └── created_at: integer
```

---

## Compaction

### The Problem

LLMs have finite context windows. A long coding session can easily exceed 100k tokens — more than most models support. Even for models with large context windows, performance degrades and costs increase with longer prompts.

### The Solution

OpenCode's **compaction** system automatically summarizes conversations when they approach the context limit:

```
Before compaction (120k tokens):
┌─────────────────────────────────────┐
│ System prompt                        │
│ Message 1: "Fix the login bug"       │
│ Message 2: [30 tool calls, results]  │
│ Message 3: "Now add tests"           │
│ Message 4: [20 tool calls, results]  │
│ Message 5: "One more thing..."       │
│ ... (too long for context window)    │
└─────────────────────────────────────┘

After compaction (~10k tokens):
┌─────────────────────────────────────┐
│ System prompt                        │
│ [Summary]: "Previously, I fixed the  │
│  login bug in auth.ts by changing    │
│  the token validation logic. Then I  │
│  added 5 tests for the auth module.  │
│  All tests pass."                    │
│ Message 5: "One more thing..."       │
└─────────────────────────────────────┘
```

### How It Works

1. **Token counting** — Before each LLM call, the session estimates the total token count
2. **Threshold check** — If the count exceeds ~80% of the model's context window, compaction triggers
3. **Summary generation** — The `compaction` subagent is invoked with the full message history and asked to produce a concise summary
4. **History replacement** — The original messages are replaced with the summary, preserving the most recent messages
5. **Continuation** — The conversation continues seamlessly with the compressed context

The compaction agent is specifically tuned for this task — it receives instructions to preserve key details like file paths, decisions made, and current state.

---

## Task Spawning (Subagents)

### The `task` Tool

The primary agent can spawn **subagents** using the `task` tool. This is how complex workflows are decomposed:

```
Primary agent (build):
  "I need to explore the codebase first"
       │
       ▼ task tool call
  ┌─────────────────────┐
  │ Subagent (explore)   │
  │ "Find all files      │
  │  related to auth"    │
  │                      │
  │ → read, grep, glob   │
  │ → returns findings   │
  └──────────┬──────────┘
             │ result
             ▼
  Primary agent continues:
  "Based on the exploration, I'll now..."
```

### Subagent Properties

Subagents differ from primary agents in several ways:

| Property    | Primary Agent              | Subagent                     |
| ----------- | -------------------------- | ---------------------------- |
| Mode        | `"primary"`                | `"subagent"`                 |
| Permissions | Full tool access           | Restricted (e.g., read-only) |
| Context     | Full session history       | Only the task description    |
| Persistence | Messages stored in session | Results returned to primary  |
| Visibility  | UI shows full interaction  | UI shows as a tool call      |

This decomposition pattern provides:

1. **Safety** — The explore subagent can't modify files, even if the primary agent has write access
2. **Focus** — Each subagent has a clear, scoped task
3. **Efficiency** — Subagents use smaller context windows since they don't carry the full history
4. **Parallelism** — Multiple subagents can run concurrently via the `batch` tool

---

## Retry and Revert

### Retry

When the LLM produces an unsatisfactory response, the user can **retry**:

1. The last assistant message is discarded
2. The last user message is re-sent to the LLM
3. The LLM generates a fresh response (potentially different due to temperature or different sampling)

This is useful when the model misunderstands the request or produces a flawed solution.

### Revert

**Revert** is more powerful — it rolls back the session to a previous point:

1. The user selects a message to revert to
2. All messages after that point are removed from the session
3. **File changes are undone** — the snapshot system restores files to their state before the reverted messages
4. The session continues from the reverted point

The snapshot system (covered in [Chapter 7](/07-database-and-storage/)) tracks file states at each message boundary, making this possible without version control.

---

## System Prompt Construction

The system prompt is not a static string — it's **dynamically generated** based on the current context:

```
System prompt components:
┌────────────────────────────────┐
│ 1. Base instructions           │ ← Agent-specific behavior rules
│ 2. Project context             │ ← Repository info, language, framework
│ 3. Tool descriptions           │ ← Available tools and their usage
│ 4. Permission rules            │ ← What the agent is allowed to do
│ 5. User preferences            │ ← From config (coding style, etc.)
│ 6. Active MCP tools            │ ← External tools from MCP servers
│ 7. Skill context               │ ← Learned skills relevant to the task
│ 8. Session state               │ ← Todos, plan, current progress
└────────────────────────────────┘
```

This dynamic construction ensures the LLM always has relevant context without wasting tokens on irrelevant information.

---

## Session Events

Every state change in a session emits events via the Bus:

| Event                  | When                                   |
| ---------------------- | -------------------------------------- |
| `session.created`      | New session started                    |
| `session.updated`      | Session metadata changed (title, etc.) |
| `message.created`      | New message added                      |
| `message.updated`      | Message content changed                |
| `part.created`         | New part added to a message            |
| `part.updated`         | Part content updated (streaming text)  |
| `tool.invocation`      | Tool call initiated                    |
| `tool.result`          | Tool call completed                    |
| `permission.requested` | User approval needed for a tool call   |
| `session.compacted`    | Compaction completed                   |

These events are the bridge between the backend engine and the UI layer — the TUI, web app, and desktop app all subscribe to these events to render conversations in real-time.

---

## Putting It All Together

Here's a complete flow for a user asking OpenCode to fix a bug:

```
1. User creates session → Session.create("build")
   → session.created event
   → UI shows new empty session

2. User sends "Fix the login bug in auth.ts"
   → message.created event (role: user)
   → UI shows user message

3. Session builds context:
   - System prompt with project info
   - Tool definitions (bash, read, write, edit, grep, ...)
   - Permission rules from agent config

4. streamText() called with full context
   → LLM starts streaming

5. LLM emits text: "I'll start by reading the auth module..."
   → part.created event (type: text)
   → UI renders text incrementally

6. LLM requests tool call: read("src/auth.ts")
   → part.created event (type: tool-invocation)
   → Permission check: allow ✓
   → Tool executes, reads file
   → part.created event (type: tool-result)
   → UI shows file contents in tool call card

7. LLM emits text: "I see the issue. The token check is..."
   → part.created events
   → UI renders explanation

8. LLM requests tool call: edit("src/auth.ts", ...)
   → Permission check: allow ✓
   → Snapshot taken before edit
   → Tool executes, modifies file
   → part.created event (type: tool-result)
   → UI shows diff

9. LLM emits text: "I've fixed the bug by..."
   → part.created events
   → UI renders final explanation

10. Stream completes
    → session.updated event
    → UI shows session as idle
```

Every step is observable, every artifact is persisted, and every change is revertible. That's the agent-session architecture in action.

---

## Key Takeaways

- **Agents are config, sessions are runtime** — agents define capabilities, sessions execute conversations
- **Parts are atomic** — the event-sourced message model enables streaming, replay, and incremental rendering
- **Compaction is automatic** — long conversations are transparently summarized to fit context windows
- **Subagents provide isolation** — the `task` tool spawns focused, permission-restricted subagents
- **Everything is observable** — typed events flow through the bus, enabling real-time UIs
- **Everything is revertible** — the snapshot + part model allows rolling back to any point

---

**Next:** [Chapter 6: Tool System →](/06-tool-system/) — The 25+ built-in tools and how permissions govern execution.

**Previous:** [Chapter 4: LLM Provider System](/04-llm-providers/)
