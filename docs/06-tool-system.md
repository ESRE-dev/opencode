# Chapter 6: Tool System

> The 25+ built-in tools, how they're registered, how permissions govern execution, and how to understand the tool lifecycle.

---

## What Is a Tool?

In OpenCode, a **tool** is a capability that the LLM can invoke during a conversation. When you ask the AI to "fix the bug in `server.ts`", it doesn't just generate text — it calls tools to read the file, understand the code, make edits, run tests, and verify the fix.

Tools are the bridge between the AI's reasoning and your actual codebase. They're what make OpenCode an **agent** rather than a chatbot.

---

## How Tools Work

### Registration

Tools are defined in `packages/opencode/src/tool/` and registered in the tool registry (`tool.ts`). Each tool is a module that exports:

1. **A name** — The identifier the LLM sees (e.g., `"bash"`, `"read"`, `"edit"`)
2. **A description** — Human-readable explanation the LLM uses to decide when to call the tool
3. **A Zod schema** — Defines the parameters the tool accepts, validated at runtime
4. **An execute function** — The actual implementation that runs when the tool is called

Here's the conceptual shape of a tool definition:

```
{
  name: "read",
  description: "Read the contents of a file, optionally limiting to a line range",
  parameters: z.object({
    path: z.string().describe("Absolute path to the file"),
    start: z.number().optional().describe("Starting line number"),
    end: z.number().optional().describe("Ending line number"),
  }),
  execute: async ({ path, start, end }) => {
    // Read the file, return its contents
    const content = await Bun.file(path).text()
    // ... apply line range filtering ...
    return { content }
  },
}
```

### Conversion to AI SDK Format

Tools are converted into the Vercel AI SDK's tool format before being passed to `streamText()`. The AI SDK uses JSON Schema (derived from the Zod schemas) to tell the LLM what parameters each tool accepts. The LLM then generates structured JSON to invoke tools.

MCP tools follow the same path — the MCP module's `convertMcpTool()` function transforms external tool definitions into the same AI SDK format, so the LLM treats built-in and MCP tools identically.

---

## The Tool Catalog

### File Operations

| Tool          | Description                                     | Key Parameters         |
| ------------- | ----------------------------------------------- | ---------------------- |
| `read`        | Read file contents with optional line ranges    | `path`, `start`, `end` |
| `write`       | Create or overwrite a file                      | `path`, `content`      |
| `edit`        | Apply a targeted search/replace edit to a file  | `path`, `old`, `new`   |
| `multiedit`   | Apply multiple search/replace edits to one file | `path`, `edits[]`      |
| `apply_patch` | Apply a unified diff patch                      | `patch`                |

### Search & Navigation

| Tool         | Description                            | Key Parameters               |
| ------------ | -------------------------------------- | ---------------------------- |
| `grep`       | Search files with regex patterns       | `pattern`, `path`, `include` |
| `glob`       | Find files matching glob patterns      | `pattern`, `path`            |
| `ls`         | List directory contents                | `path`                       |
| `codesearch` | Semantic code search using tree-sitter | `query`, `path`              |

### Shell Execution

| Tool   | Description                    | Key Parameters       |
| ------ | ------------------------------ | -------------------- |
| `bash` | Execute shell commands via PTY | `command`, `timeout` |

The `bash` tool is one of the most powerful — and most dangerous — tools. It runs commands in a pseudo-terminal (`bun-pty`), which means it supports interactive programs, colored output, and proper signal handling. It's also why the permission system is so important.

### Web & External

| Tool        | Description                              | Key Parameters |
| ----------- | ---------------------------------------- | -------------- |
| `webfetch`  | Fetch a web page and convert to markdown | `url`          |
| `websearch` | Perform a web search                     | `query`        |

The `webfetch` tool uses `turndown` to convert HTML to Markdown, stripping out navigation, ads, and other noise so the LLM gets clean content.

### Agent Orchestration

| Tool   | Description                                | Key Parameters         |
| ------ | ------------------------------------------ | ---------------------- |
| `task` | Spawn a subagent to handle a subtask       | `description`, `agent` |
| `plan` | Create and manage multi-step plans         | `action`, `steps`      |
| `todo` | Manage a checklist for the current session | `action`, `item`       |

The `task` tool is how agents delegate work. When the primary agent encounters a complex problem, it can spawn a specialized subagent (like `explore` or `build`) to handle a portion of the work. The subagent runs in its own context with its own conversation history, and its result is returned to the primary agent.

### IDE & Code Intelligence

| Tool    | Description                         | Key Parameters               |
| ------- | ----------------------------------- | ---------------------------- |
| `lsp`   | Query Language Server Protocol      | `action`, `path`, `position` |
| `skill` | Discover and execute learned skills | `name`, `args`               |

The `lsp` tool integrates with running language servers to provide diagnostics, symbol lookup, go-to-definition, and other IDE features. This gives the AI access to the same intelligence that powers your editor's autocomplete and error highlighting.

### User Interaction

| Tool       | Description                                     | Key Parameters        |
| ---------- | ----------------------------------------------- | --------------------- |
| `question` | Ask the user a question and wait for a response | `question`, `options` |

The `question` tool pauses the agent's execution and prompts the user for input. This is used when the agent needs clarification or wants to offer choices.

### Parallel Execution

| Tool    | Description                         | Key Parameters |
| ------- | ----------------------------------- | -------------- |
| `batch` | Run multiple tool calls in parallel | `calls[]`      |

The `batch` tool allows the LLM to request multiple independent operations at once. Instead of reading three files sequentially, it can batch them into a single tool call that executes in parallel.

---

## The Permission System

Every tool call must pass through the permission system before it can execute. This is non-negotiable — even in non-interactive mode, permissions are enforced.

### Permission Levels

| Level   | Behavior                                             |
| ------- | ---------------------------------------------------- |
| `allow` | Execute immediately with no user interaction         |
| `ask`   | Pause and prompt the user for approval               |
| `deny`  | Block execution entirely, return an error to the LLM |

### How Permissions Are Evaluated

When a tool call arrives, the permission system evaluates it against a set of rules:

```
Tool call: write({ path: "src/server/routes/auth.ts", content: "..." })
                │
                ▼
┌────────────────────────────────────┐
│ 1. Check agent-level permissions   │
│    Agent "build" defines:          │
│    - write: allow, glob: ["src/**"]│
│    - write: deny, glob: ["*.lock"] │
│                                    │
│ 2. Match path against globs        │
│    "src/server/routes/auth.ts"     │
│    matches "src/**" → allow        │
│                                    │
│ 3. Check user overrides            │
│    (project config, session prefs) │
│                                    │
│ 4. Apply result                    │
└──────────┬─────────────────────────┘
           │
           ▼
        ALLOWED → execute tool
```

### Rule Priority

Rules are evaluated in order, with more specific patterns taking precedence:

1. **User session overrides** — "Always allow" / "Always deny" decisions from the current session
2. **Project config** — Rules in `opencode.json`
3. **Agent defaults** — The permission set defined in the agent configuration

### Glob Patterns

Permissions use glob patterns to scope which files a tool can operate on:

```
# Allow writing anywhere in src/
{ tool: "write", allow: true, glob: ["src/**"] }

# But deny writing to test fixtures
{ tool: "write", deny: true, glob: ["src/test/fixtures/**"] }

# Ask before modifying config files
{ tool: "edit", ask: true, glob: ["*.config.*", "*.toml", "*.json"] }

# Allow bash everywhere (no glob = all paths)
{ tool: "bash", allow: true }
```

### The Ask Flow

When a permission evaluates to `ask`, the flow depends on the interface:

**TUI:** A dialog appears in the terminal asking the user to approve, deny, or always-allow the operation. The user can inspect what the tool wants to do before deciding.

**Web App:** A permission request is published via the event bus, rendered as a UI prompt. The user clicks to approve or deny.

**Non-interactive (CI/headless):** The `question` tool and `ask` permissions can be pre-configured to auto-allow or auto-deny via config, or the session can run with a permissive agent profile.

The permission decision is stored and can be remembered for the session ("Always allow `write` to `src/**`"), preventing repeated prompts for the same pattern.

---

## Tool Execution Lifecycle

Here's the complete lifecycle of a tool call, from LLM generation to result:

```
1. LLM generates a tool call
   { name: "bash", arguments: { command: "bun test" } }
           │
           ▼
2. AI SDK parses and validates against Zod schema
   - If invalid → error returned to LLM
           │
           ▼
3. Permission check
   - allow → continue
   - ask → pause, prompt user, wait for decision
   - deny → error returned to LLM
           │
           ▼
4. Pre-execution snapshot
   - For file-modifying tools, a snapshot of affected files is taken
   - Enables revert if the user wants to undo changes
           │
           ▼
5. Execute
   - Tool's execute() function runs
   - Results may stream (e.g., bash output)
           │
           ▼
6. Store result
   - Tool invocation stored as a Part (type: "tool-invocation")
   - Tool result stored as a Part (type: "tool-result")
   - Both persisted to SQLite
           │
           ▼
7. Publish events
   - Bus.publish(PartCreated, { ... })
   - UI updates in real-time
           │
           ▼
8. Return to LLM
   - Result is added to the conversation context
   - LLM decides whether to make another tool call or respond with text
```

### Snapshot & Revert

File-modifying tools (`write`, `edit`, `multiedit`, `apply_patch`) trigger the snapshot system before execution. The snapshot captures the state of affected files so the user can **revert** changes if something goes wrong.

Revert rolls back to the snapshot, restoring files to their pre-tool-call state. This is especially valuable when the AI makes a mistake — you can undo without manually tracking what changed.

### Streaming Tool Output

Some tools produce output incrementally. The `bash` tool, for example, streams stdout/stderr in real-time through the PTY. This streaming output is published via the event bus so the UI can display command output as it happens, rather than waiting for the command to finish.

---

## Tool Composition Patterns

### Task Delegation

The `task` tool enables a **multi-agent** pattern. The primary agent can delegate work to subagents:

```
Primary Agent (build)
    │
    ├── task("Explore the auth module and summarize its architecture")
    │       └── Subagent (explore) runs with read-only tools
    │           Returns: summary text
    │
    ├── task("Fix the failing test in auth.test.ts")
    │       └── Subagent (build) runs with full tool access
    │           Returns: description of changes made
    │
    └── Synthesizes results from both subagents
```

Each subagent gets its own conversation context and tool permissions, preventing one task from interfering with another.

### Batch Parallelism

The `batch` tool allows the LLM to express independent operations:

```
batch({
  calls: [
    { tool: "read", args: { path: "src/auth/login.ts" } },
    { tool: "read", args: { path: "src/auth/session.ts" } },
    { tool: "read", args: { path: "src/auth/token.ts" } },
  ]
})
```

These execute in parallel, reducing the total time compared to three sequential tool calls.

### Plan + Todo

For complex tasks, the LLM can use `plan` to create a structured approach and `todo` to track progress:

```
1. plan({ action: "create", steps: [
     "Read the current auth implementation",
     "Identify the session timeout bug",
     "Fix the bug in session.ts",
     "Add a regression test",
     "Run tests to verify",
   ]})

2. todo({ action: "add", item: "Read auth implementation" })
3. ... execute tools ...
4. todo({ action: "complete", item: "Read auth implementation" })
5. todo({ action: "add", item: "Fix session timeout" })
6. ... and so on ...
```

This gives the AI (and the user) a clear picture of progress through a complex task.

---

## MCP Tools

Tools from **Model Context Protocol** servers are integrated seamlessly. When an MCP server is configured in `opencode.json`:

```json
{
  "mcp": {
    "servers": {
      "github": {
        "command": "npx",
        "args": ["@modelcontextprotocol/server-github"]
      }
    }
  }
}
```

OpenCode:

1. Starts the MCP server process (or connects to an HTTP endpoint)
2. Discovers available tools via the MCP protocol
3. Converts each MCP tool definition into the AI SDK tool format using `convertMcpTool()`
4. Makes them available alongside built-in tools

The LLM doesn't know or care whether a tool is built-in or from MCP — they all look the same. MCP tools go through the same permission system as built-in tools.

When the MCP server's tool list changes (it publishes a `ToolListChangedNotification`), OpenCode updates the available tools and notifies the UI via the event bus.

---

## Extending with Custom Tools

While OpenCode's tool system is internally defined, there are several extension points:

1. **MCP servers** — The primary way to add custom tools. Write an MCP server in any language, configure it in `opencode.json`, and your tools are available to the AI.

2. **Plugins** — The plugin system (`packages/plugin`) can register additional tools. Built-in plugins like `copilot.ts` and `codex.ts` demonstrate this pattern.

3. **Skills** — The skill system allows the AI to learn and execute reusable patterns, effectively creating new "meta-tools" from combinations of existing ones.

---

## Key Takeaways

1. **Tools are the AI's hands** — They transform the LLM from a text generator into an agent that can read, write, search, execute, and navigate your codebase.

2. **Every tool has a Zod schema** — Parameters are validated at runtime, preventing malformed tool calls from reaching execution.

3. **Permissions are mandatory** — Every tool call goes through allow/ask/deny evaluation with glob pattern matching. This is the safety net for an AI that can run shell commands and edit files.

4. **Snapshots enable revert** — File-modifying tools capture state before execution, allowing users to undo changes.

5. **MCP tools are first-class** — External tool servers integrate seamlessly, sharing the same permission and execution lifecycle as built-in tools.

6. **Composition patterns** — Task delegation, batch parallelism, and plan+todo enable the AI to tackle complex, multi-step problems effectively.

---

**Next:** [Chapter 7: Database & Storage →](./07-database-and-storage.md) — SQLite, Drizzle ORM, event-sourced messages, and migration strategies.

**Previous:** [Chapter 5: Agents & Sessions →](./05-agents-and-sessions.md)
