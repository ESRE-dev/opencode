# Chapter 8: Terminal UI (TUI)

> SolidJS rendered in the terminal via @opentui, the reactive rendering model, and how the TUI communicates with the backend.

---

## Overview

OpenCode's Terminal UI is one of its most distinctive features — a **full SolidJS application rendered directly in your terminal**. Not a web app served to a browser. Not an Electron wrapper. Actual SolidJS components, with reactive state, rendered as terminal escape codes via [@opentui](https://github.com/anomalyco/opentui).

This means the same reactive programming model used in the web app also powers the terminal experience — components, signals, effects, contexts, and all.

```
┌─────────────────────────────────────┐
│  SolidJS Component Tree             │
│  ┌─────────────────────────────┐    │
│  │  <App>                      │    │
│  │  ├── <Home>                 │    │
│  │  │   ├── <SessionList>      │    │
│  │  │   └── <StatusBar>        │    │
│  │  ├── <Session>              │    │
│  │  │   ├── <MessageList>      │    │
│  │  │   ├── <ToolCallCard>     │    │
│  │  │   └── <InputPrompt>      │    │
│  │  └── <Dialogs>              │    │
│  └─────────────────────────────┘    │
│              │                       │
│              ▼                       │
│  ┌─────────────────────────────┐    │
│  │  @opentui/solid renderer    │    │
│  │  SolidJS → Terminal codes   │    │
│  └─────────────────────────────┘    │
│              │                       │
│              ▼                       │
│  ┌─────────────────────────────┐    │
│  │  Terminal (stdout)           │    │
│  │  ANSI escape sequences       │    │
│  └─────────────────────────────┘    │
└─────────────────────────────────────┘
```

---

## @opentui: The Terminal Renderer

### What Is @opentui?

**@opentui** is a framework that lets you build terminal UIs using web UI frameworks like SolidJS. It provides:

1. **A custom renderer** — Instead of rendering to the DOM, it renders to a terminal grid of cells
2. **A layout engine** — Flexbox-like layout for positioning elements in the terminal
3. **An input system** — Keyboard and mouse event handling
4. **Reactive integration** — Works with SolidJS's reactive primitives (signals, effects, memos)

Think of it as the terminal equivalent of React Native — same programming model, different rendering target.

### Two Packages

| Package          | Purpose                                           |
| ---------------- | ------------------------------------------------- |
| `@opentui/core`  | Core rendering engine, layout, input handling     |
| `@opentui/solid` | SolidJS integration — renderer, hooks, Bun plugin |

The SolidJS integration (`@opentui/solid`) provides:

- `render()` — Mount a SolidJS component tree to the terminal
- `useKeyboard()` — React to keyboard input
- `useRenderer()` — Access the rendering context
- `useTerminalDimensions()` — Reactive terminal size

---

## Entry Point

The TUI starts from `packages/opencode/src/cli/cmd/tui/app.tsx`:

```
import { render, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"

// The root component
function App() {
  // Reactive terminal dimensions
  const [cols, rows] = useTerminalDimensions()

  // Keyboard input handling
  useKeyboard((key) => {
    // Handle global keybinds
  })

  return (
    <box width={cols()} height={rows()}>
      {/* Route to Home or Session view */}
    </box>
  )
}

// Mount to terminal
render(() => <App />)
```

Key observations:

1. **JSX in the terminal** — Components like `<box>`, `<text>`, and custom components render to terminal cells
2. **Reactive dimensions** — `useTerminalDimensions()` returns signals that update when the terminal is resized
3. **Keyboard-driven** — `useKeyboard()` provides a hook for handling keypresses reactively

### The Bun Plugin

For JSX to work in a Bun runtime targeting the terminal, the `@opentui/solid/bun-plugin` transforms JSX at compile time:

```
// What you write:
<box width={10} height={5}>
  <text>Hello</text>
</box>

// What the Bun plugin compiles to:
// SolidJS createComponent() calls targeting @opentui's renderer
```

This plugin is used both in development (`bun dev` with `--conditions=browser`) and in the production build (`Bun.build()` with the solid plugin).

---

## Component Architecture

### Layout Primitives

@opentui provides terminal-specific layout primitives:

| Element   | Purpose                                                        |
| --------- | -------------------------------------------------------------- |
| `<box>`   | A container element — supports width, height, padding, borders |
| `<text>`  | Text content — supports color, bold, italic, underline         |
| `<input>` | Text input field                                               |

These compose just like DOM elements in web SolidJS, but they render to terminal cells using ANSI escape codes.

### TUI Directory Structure

```
src/cli/cmd/tui/
├── app.tsx              # Root component, terminal setup
├── routes/
│   ├── home.tsx         # Session list, project overview
│   └── session.tsx      # Active conversation view
├── components/
│   ├── dialog.tsx       # Modal dialogs (permission, confirm)
│   ├── prompt.tsx       # User input prompt
│   ├── message.tsx      # Message rendering
│   ├── tool-call.tsx    # Tool call display cards
│   └── status.tsx       # Status bar
├── context/
│   ├── sdk.tsx          # SDK client context
│   ├── sync.tsx         # Event sync context
│   ├── theme.tsx        # Theme/colors context
│   └── keybinds.tsx     # Keybind configuration context
└── ...
```

### Routing

The TUI has a simple client-side router — it tracks which "page" is active and renders the appropriate view:

- **Home** — Lists sessions, allows creating new ones, shows project info
- **Session** — The main conversation view with message history, streaming output, and input prompt

Routing is managed via SolidJS signals — no URL-based router needed in a terminal.

---

## Reactive Rendering Model

### SolidJS Signals in the Terminal

The TUI uses the same reactive model as a SolidJS web app:

```
// A signal for the current session
const [session, setSession] = createSignal(null)

// A derived computation
const title = createMemo(() =>
  session()?.title ?? "New Session"
)

// A component that re-renders when session changes
function SessionHeader() {
  return (
    <box>
      <text bold>{title()}</text>
    </box>
  )
}
```

When `setSession()` is called, only the components that read `session()` or its derived values re-render — SolidJS's fine-grained reactivity applies equally in the terminal as in the browser.

### Effects for Side Effects

```
// React to session changes
createEffect(() => {
  const s = session()
  if (s) {
    // Subscribe to events for this session
    bus.subscribe(PartCreated, (event) => {
      if (event.sessionId === s.id) {
        // Update message list
      }
    })
  }
})
```

### Context Providers

The TUI wraps the component tree in context providers, just like a web app:

```
<ThemeProvider>
  <SDKProvider>
    <SyncProvider>
      <KeybindProvider>
        <App />
      </KeybindProvider>
    </SyncProvider>
  </SDKProvider>
</ThemeProvider>
```

| Context    | Purpose                                                 |
| ---------- | ------------------------------------------------------- |
| `Theme`    | Colors, styles, visual configuration                    |
| `SDK`      | The TypeScript SDK client for API calls                 |
| `Sync`     | Event bus subscription management, real-time state sync |
| `Keybinds` | Keyboard shortcut configuration (customizable)          |

---

## Communication with the Backend

### In-Process Communication

Unlike the web app (which connects over HTTP), the TUI runs **in the same Bun process** as the backend server. This means:

1. The TUI can use the SDK client which makes HTTP calls to `localhost:4096`
2. Events from the bus are available directly in-process
3. There's no network latency between the UI and the engine

### SDK Client

The TUI uses the same `@opencode-ai/sdk` as the web app:

```
// In the SDK context provider
const client = createClient({ baseURL: "http://localhost:4096" })

// API calls
const sessions = await client.session.list()
const session = await client.session.create({ agent: "build" })
await client.session.chat(session.id, { message: "Fix the bug" })
```

This deliberate choice — using HTTP even in-process — means:

- The TUI exercises the same code paths as external clients
- API changes are caught by the TUI immediately
- The TUI could theoretically connect to a remote server

### Event Streaming

The TUI subscribes to the SSE event stream for real-time updates:

```
// Conceptual — the sync context handles this
const events = client.subscribe("/event")

for await (const event of events) {
  switch (event.type) {
    case "part.created":
      // Update message display
      break
    case "session.updated":
      // Update session metadata
      break
    case "permission.requested":
      // Show permission dialog
      break
  }
}
```

This enables the TUI to show:

- **Streaming text** as the LLM generates it
- **Tool call progress** as tools execute
- **Permission prompts** when the agent needs approval
- **Session state changes** (title generation, compaction, etc.)

---

## Keyboard Input

### Global Keybinds

The TUI is entirely keyboard-driven. Global keybinds work from any view:

| Key      | Action                   |
| -------- | ------------------------ |
| `q`      | Quit                     |
| `Ctrl+c` | Cancel current operation |
| `/`      | Focus search/filter      |
| `n`      | New session              |
| `Escape` | Close dialog / go back   |

### Context-Specific Keybinds

Different views have their own keybinds:

**Home view:**
| Key | Action |
| ------- | ---------------- |
| `Enter` | Open session |
| `d` | Delete session |
| `↑/↓` | Navigate list |

**Session view:**
| Key | Action |
| --------- | ----------------------------- |
| `Enter` | Send message |
| `Ctrl+r` | Retry last message |
| `Ctrl+z` | Revert last change |
| `y/n` | Approve/deny permission |
| `a` | Always allow this pattern |

### Keybind Configuration

Users can customize keybinds in their config:

```json
{
  "tui": {
    "keybinds": {
      "quit": "Ctrl+q",
      "newSession": "Ctrl+n",
      "retry": "Ctrl+r"
    }
  }
}
```

The keybind context resolves configured keybinds and provides them to the `useKeyboard()` hook.

---

## Rendering Details

### ANSI Escape Codes

@opentui translates the SolidJS component tree into ANSI escape codes that terminals understand:

```
┌──────────────────────────────────────────┐
│ Component tree                            │
│ <box border="single">                     │
│   <text color="blue" bold>Title</text>    │
│ </box>                                    │
│                                           │
│           ▼ renders to                    │
│                                           │
│ ANSI output:                              │
│ \e[34;1m┌──────┐\e[0m                    │
│ \e[34;1m│Title │\e[0m                    │
│ \e[34;1m└──────┘\e[0m                    │
└──────────────────────────────────────────┘
```

### Syntax Highlighting

The TUI includes syntax highlighting for code blocks, powered by **tree-sitter** (via `web-tree-sitter`). When the LLM outputs a code block in its response:

1. The language is detected from the code fence
2. Tree-sitter parses the code into an AST
3. Syntax nodes are mapped to terminal colors
4. The highlighted code is rendered in the terminal

The tree-sitter parser worker is embedded in the binary at build time, so syntax highlighting works without any external dependencies.

### Diff Rendering

Tool calls that modify files render inline diffs in the TUI using `@pierre/diffs`:

```
┌─ edit src/auth.ts ──────────────────────┐
│  10 │   const token = getToken()         │
│  11 │ - if (token.valid) {               │
│  11 │ + if (token.valid && !expired()) { │
│  12 │     return true                    │
└──────────────────────────────────────────┘
```

Additions are highlighted in green, deletions in red — standard diff coloring that works in any terminal.

### Terminal Resize

When the terminal is resized, `useTerminalDimensions()` fires updated signals, causing the layout to recompute:

```
const [cols, rows] = useTerminalDimensions()

// This re-renders automatically when the terminal resizes
return (
  <box width={cols()} height={rows()}>
    <box width={Math.min(cols() - 4, 120)}>
      {/* Content constrained to max width */}
    </box>
  </box>
)
```

This makes the TUI responsive — it adapts to whatever terminal size is available.

---

## TUI vs Web App

| Feature          | TUI                       | Web App                      |
| ---------------- | ------------------------- | ---------------------------- |
| Framework        | SolidJS + @opentui        | SolidJS + Vite               |
| Rendering target | Terminal (ANSI)           | Browser (DOM)                |
| Communication    | In-process HTTP + Bus     | HTTP + SSE                   |
| Input            | Keyboard only             | Keyboard + mouse             |
| Styling          | ANSI colors + box drawing | TailwindCSS                  |
| Syntax highlight | tree-sitter (embedded)    | Shiki                        |
| Launch           | `opencode` (default)      | `opencode web` or standalone |
| Package          | `packages/opencode`       | `packages/app`               |

Despite these differences, both UIs:

- Use the same SDK client
- Subscribe to the same events
- Render the same conversations
- Support the same workflows

The shared SDK and event model mean that features added to the backend are immediately available in both interfaces.

---

## Build Considerations

### Development

```bash
# Run TUI in dev mode
bun dev
# Equivalent to: bun run --cwd packages/opencode --conditions=browser src/index.ts
```

The `--conditions=browser` flag is essential — SolidJS uses conditional exports to select between server-side rendering (SSR) and client-side rendering. The TUI needs the client-side (reactive) runtime, same as a browser app.

### Production Build

When building the standalone binary, the TUI is compiled in:

```
Bun.build({
  entrypoints: ["src/index.ts"],
  compile: true,
  plugins: [
    solidPlugin()  // from @opentui/solid/bun-plugin
  ],
  conditions: ["browser"],
  // ...
})
```

The solid plugin transforms JSX into SolidJS-compatible render calls targeting @opentui's terminal renderer. The result is a single binary that includes the full TUI — no separate installation needed.

### Embedded Assets

The binary embeds:

- **Tree-sitter parser worker** — For syntax highlighting
- **Tree-sitter language grammars** — For supported languages
- **Theme definitions** — Color schemes for the TUI

These are bundled at build time using Bun's asset embedding, so the TUI works immediately after download.

---

## Key Takeaways

1. **SolidJS in the terminal** — The TUI uses the same reactive framework as the web app, rendered to ANSI escape codes via @opentui.

2. **Fine-grained reactivity** — SolidJS signals and effects power the terminal UI just like they power the web UI. Only changed parts re-render.

3. **In-process communication** — The TUI runs in the same Bun process as the backend, but still uses the SDK client (over localhost HTTP) for API calls.

4. **Keyboard-driven** — Everything is navigable via keyboard shortcuts, which are configurable.

5. **Embedded in the binary** — The TUI, including syntax highlighting via tree-sitter, ships inside the standalone executable.

6. **Same data model** — Both TUI and web app use the same SDK, subscribe to the same events, and render the same conversations. A session started in the TUI can be viewed in the web app and vice versa.

---

**Next:** [Chapter 9: Web Application →](./09-web-application.md)

**Previous:** [Chapter 7: Database & Storage](./07-database-and-storage.md)
