---
title: "Chapter 9: Web Application"
---


> The SolidJS + Vite browser app, its component architecture, and real-time synchronization via SSE.

---

## Overview

The web application (`packages/app`) is OpenCode's browser-based interface. It provides the same conversational AI experience as the TUI but in a full graphical environment with richer rendering — syntax-highlighted code blocks, file diffs, virtualized message lists, drag-and-drop, and a terminal emulator.

It's built on:

| Technology       | Version   | Role                                     |
| ---------------- | --------- | ---------------------------------------- |
| SolidJS          | 1.9.10    | Reactive UI framework                    |
| Vite             | 7.1.4     | Dev server and build tool                |
| TailwindCSS      | 4.1.11    | Utility-first styling                    |
| @solidjs/router  | 0.15.4    | Client-side routing                      |
| @kobalte/core    | 0.13.11   | Headless accessible UI primitives        |
| virtua           | 0.42.3    | Virtualized lists for large sessions     |
| marked + shiki   | 17 / 3.x  | Markdown rendering + syntax highlighting |
| ghostty-web      | —         | In-browser terminal emulator             |
| @opencode-ai/sdk | workspace | TypeScript SDK for API communication     |
| @opencode-ai/ui  | workspace | Shared component library                 |

---

## Project Structure

```
packages/app/
├── src/
│   ├── entry.tsx              # Application entry point
│   ├── app.tsx                # Root component, providers, layout
│   ├── routes/                # Page-level route components
│   │   ├── home.tsx           # Session list / landing page
│   │   ├── session.tsx        # Active conversation view
│   │   └── ...
│   ├── components/            # Reusable UI components
│   │   ├── message.tsx        # Message rendering
│   │   ├── input.tsx          # User input area
│   │   ├── sidebar.tsx        # Navigation sidebar
│   │   ├── tool-call.tsx      # Tool invocation display
│   │   ├── diff.tsx           # File diff viewer
│   │   ├── terminal.tsx       # Embedded terminal (ghostty-web)
│   │   ├── dialog.tsx         # Modal dialogs
│   │   └── ...
│   ├── contexts/              # SolidJS context providers
│   │   ├── sdk.tsx            # SDK client context
│   │   ├── sync.tsx           # SSE synchronization context
│   │   ├── theme.tsx          # Theme (light/dark) context
│   │   └── ...
│   ├── lib/                   # Utilities and helpers
│   └── styles/                # Global styles, Tailwind config
├── public/                    # Static assets
├── index.html                 # HTML shell
├── vite.config.ts             # Vite configuration
├── playwright.config.ts       # E2E test config
└── package.json
```

---

## Entry Point and Bootstrapping

The application starts at `src/entry.tsx`, which mounts the SolidJS app into the DOM:

```
// Conceptual flow
import { render } from "solid-js/web"
import { Router } from "@solidjs/router"
import App from "./app"

render(
  () => (
    <Router>
      <App />
    </Router>
  ),
  document.getElementById("root")
)
```

The `App` component sets up the provider hierarchy:

```
<ThemeProvider>
  <SDKProvider>
    <SyncProvider>
      <Layout>
        <Routes />
      </Layout>
    </SyncProvider>
  </SDKProvider>
</ThemeProvider>
```

Each provider layer adds a capability:

| Provider        | What It Provides                                           |
| --------------- | ---------------------------------------------------------- |
| `ThemeProvider` | Light/dark mode, color scheme, stored in localStorage      |
| `SDKProvider`   | The initialized `@opencode-ai/sdk` client instance         |
| `SyncProvider`  | SSE connection for real-time events, reactive state stores |

---

## Vite Configuration

The `vite.config.ts` configures the build pipeline:

```typescript
import { defineConfig } from "vite"
import solid from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"

export default defineConfig({
  plugins: [solid(), tailwindcss()],
  resolve: {
    alias: {
      "@": "./src",
    },
  },
  server: {
    proxy: {
      "/api": "http://localhost:4096",
    },
  },
})
```

Key aspects:

- **`vite-plugin-solid`** — Compiles SolidJS JSX (which is different from React JSX — it compiles to fine-grained reactive DOM operations, not virtual DOM diffing)
- **`@tailwindcss/vite`** — TailwindCSS 4.x as a Vite plugin (no PostCSS config needed)
- **Proxy** — In dev mode, API requests are proxied to the OpenCode server on port 4096
- **Path alias** — `@/` maps to `src/` for clean imports

---

## Communication with the Backend

The web app communicates with the OpenCode server through two channels:

### 1. REST API (via SDK)

The `@opencode-ai/sdk` package provides a typed client for all API operations:

```
// Using the SDK client
const sdk = useSDK()

// Create a session
const session = await sdk.session.create({ agent: "build" })

// Send a message
await sdk.session.chat(session.id, { content: "Fix the login bug" })

// List sessions
const sessions = await sdk.session.list({ project: projectId })

// Get session messages
const messages = await sdk.session.messages(session.id)
```

The SDK is generated from the server's OpenAPI specification, so it's always in sync with the API.

### 2. SSE (Server-Sent Events)

Real-time updates flow through the `/event` SSE endpoint. The `SyncProvider` establishes and manages this connection:

```
Server (Hono)                     Web App (SolidJS)
     │                                  │
     │  GET /event                      │
     │  Accept: text/event-stream       │
     │◄─────────────────────────────────│
     │                                  │
     │  event: session.updated          │
     │  data: {"id":"...","title":"..."}│
     │─────────────────────────────────►│
     │                                  │  → Update reactive store
     │  event: part.created             │
     │  data: {"type":"text",...}        │
     │─────────────────────────────────►│
     │                                  │  → Append to message display
     │  event: tool.result              │
     │  data: {"toolCallId":"...",...}   │
     │─────────────────────────────────►│
     │                                  │  → Update tool call card
     │  ...                             │
```

The SSE connection provides:

- **Automatic reconnection** — If the connection drops, the client reconnects with exponential backoff
- **Event filtering** — The client can filter by event type to avoid processing irrelevant events
- **State reconciliation** — On reconnect, the client fetches the current state to catch up on missed events

### Why SSE Instead of WebSockets?

SSE is a deliberate choice:

1. **Unidirectional** — Events only flow server → client; the client uses REST for commands. This matches the event-driven architecture perfectly.
2. **HTTP/2 compatible** — SSE works naturally with HTTP/2 multiplexing
3. **Simpler** — No handshake protocol, no ping/pong, no frame parsing
4. **Proxy-friendly** — SSE works through standard HTTP proxies and load balancers
5. **Auto-reconnect** — The `EventSource` API handles reconnection natively

---

## Reactive State Management

The web app uses SolidJS's fine-grained reactivity for state management — no external state library like Redux or Zustand is needed.

### Signals and Stores

SolidJS provides two primitives:

- **Signals** — Simple reactive values (`createSignal`)
- **Stores** — Reactive objects/arrays with nested tracking (`createStore`)

The `SyncProvider` maintains reactive stores for key data:

```
// Conceptual — simplified from actual implementation
const [sessions, setSessions] = createStore<Record<string, Session>>({})
const [messages, setMessages] = createStore<Record<string, Message[]>>({})

// SSE events update the stores
eventSource.addEventListener("session.updated", (e) => {
  const data = JSON.parse(e.data)
  setSessions(data.id, data)
  // Every component reading sessions[id] automatically re-renders
})

eventSource.addEventListener("part.created", (e) => {
  const data = JSON.parse(e.data)
  setMessages(data.sessionId, (msgs) => [...msgs, data])
  // Message list automatically updates
})
```

### Fine-Grained Reactivity in Practice

SolidJS doesn't use a virtual DOM. When a part arrives via SSE:

1. The store is updated at the exact path that changed
2. Only the specific DOM elements that read that path are updated
3. No diffing, no reconciliation, no unnecessary re-renders

For a streaming AI conversation where hundreds of text chunks arrive per second, this is critical — React or Vue would need to diff the entire message list on every chunk, while SolidJS surgically updates just the text node that changed.

---

## Component Architecture

### Message Rendering

Messages are the core visual unit. Each message is rendered based on its role and parts:

```
<Message role="assistant">
  ├── <TextPart>           ← Rendered markdown with syntax highlighting
  ├── <ToolCallCard>       ← Expandable card showing tool name, args, result
  │     ├── <DiffView>     ← For file-modifying tools
  │     └── <Terminal>      ← For bash tool output
  ├── <TextPart>           ← More text from the assistant
  └── <ReasoningBlock>     ← Collapsible chain-of-thought (for o1/o3)
</Message>
```

### Markdown Rendering

Assistant text is rendered as Markdown using `marked` with `shiki` for syntax highlighting:

```
User text → marked (parse to AST) → marked-shiki (highlight code blocks) → HTML → DOM
```

The `@opencode-ai/ui` package provides the shared markdown renderer that's used by both the web app and the storybook. It supports:

- Fenced code blocks with language detection
- Inline code
- Tables, lists, blockquotes
- Math rendering via KaTeX
- Streaming-safe rendering (handles incomplete markdown during streaming)

### Diff Rendering

When the AI edits a file, the web app renders a rich diff view:

- **Side-by-side** or **inline** diff display
- Syntax highlighting on both sides
- Line numbers and change markers
- Powered by `@pierre/diffs` and the `diff` package

### Virtualized Lists

For sessions with hundreds of messages, rendering everything at once would be slow. The web app uses **`virtua`** for virtualized scrolling:

```
<VirtualList items={messages}>
  {(message) => <Message {...message} />}
</VirtualList>
```

`virtua` only renders the messages that are currently visible (plus a small buffer), recycling DOM elements as the user scrolls. This keeps the app responsive even with very long conversations.

### Terminal Emulator

The web app includes an in-browser terminal emulator via `ghostty-web`:

```
<Terminal sessionId={session.id} />
```

This renders bash tool output with full ANSI color support, cursor positioning, and scrollback. It connects to the server's PTY system to provide an authentic terminal experience.

---

## Shared UI Components (`packages/ui`)

The `packages/ui` package contains components shared between the web app and the storybook:

| Component | Purpose                                     |
| --------- | ------------------------------------------- |
| Icons     | SVG icon library                            |
| Theme     | Color tokens, dark/light mode utilities     |
| Markdown  | Streaming-safe markdown renderer            |
| Diff      | Rich diff display component                 |
| Motion    | Animation utilities (via `motion` library)  |
| DOMPurify | HTML sanitization for rendered markdown     |
| morphdom  | Efficient DOM patching for markdown updates |

### Why morphdom?

When the AI streams markdown, each new chunk means re-rendering the entire markdown block. Instead of replacing the DOM wholesale (which would lose scroll position, break selection, and cause flicker), the app uses `morphdom` to diff the old and new HTML and apply minimal DOM patches:

```
Old HTML: <p>I'll fix the <code>auth</code> module by</p>
New HTML: <p>I'll fix the <code>auth</code> module by changing the token</p>

morphdom patches: append " changing the token" text node to <p>
```

This provides smooth, flicker-free streaming for markdown content.

---

## Routing

The web app uses `@solidjs/router` for client-side routing:

```
/                     → Home (session list)
/session/:id          → Active session view
/settings             → Configuration
```

Routes are defined as SolidJS components, and navigation is handled reactively — switching sessions doesn't reload the page.

### Route-Level Code Splitting

Vite automatically code-splits at route boundaries, so the initial page load only includes the code needed for the current route. Session-specific code (message rendering, diff views, terminal) is loaded lazily when the user navigates to a session.

---

## Styling with TailwindCSS 4

The web app uses **TailwindCSS 4.1.11** via the Vite plugin. TailwindCSS 4 is a significant departure from v3:

- **No `tailwind.config.js`** — Configuration is done in CSS with `@theme` directives
- **CSS-first** — The engine is built on CSS custom properties and layers
- **Vite-native** — The `@tailwindcss/vite` plugin handles everything, no PostCSS needed
- **Faster** — The new engine is significantly faster for both dev and production builds

### Theming

The app supports light and dark modes via CSS custom properties. The `ThemeProvider` context manages the current theme and persists the user's preference to `localStorage`.

Theme tokens flow from `@opencode-ai/ui` to ensure consistency between the web app and the storybook.

---

## Headless Components with Kobalte

For complex interactive components (dropdowns, dialogs, tooltips, command palettes), the web app uses **@kobalte/core** — a headless component library for SolidJS:

```
// Conceptual usage
import { Dialog } from "@kobalte/core/dialog"

<Dialog.Root>
  <Dialog.Trigger>Open</Dialog.Trigger>
  <Dialog.Portal>
    <Dialog.Overlay />
    <Dialog.Content>
      <Dialog.Title>Confirm Action</Dialog.Title>
      <Dialog.Description>Are you sure?</Dialog.Description>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
```

Kobalte provides:

- **Accessibility** — Full ARIA support, keyboard navigation, focus management
- **Unstyled** — Just behavior and accessibility, styled with Tailwind
- **SolidJS-native** — Built for SolidJS's reactivity model, not a React port

---

## Drag and Drop

The web app supports drag-and-drop interactions via `@thisbeyond/solid-dnd`:

- Drag files into the chat input to attach them
- Reorder items in plan/todo views
- Drag sessions between groups

---

## Testing

### Unit Tests

Component tests run with `bun:test` using `@happy-dom/global-registrator` for DOM simulation:

```bash
cd packages/app
bun test
# Runs: bun test --preload ./happydom.ts ./src
```

The `happydom.ts` preload registers Happy DOM as the global DOM implementation, allowing SolidJS components to render in a test environment without a browser.

### E2E Tests

End-to-end tests use **Playwright 1.57.0**:

```bash
cd packages/app
bun run test:e2e:local
```

The E2E setup:

1. `seed-e2e.ts` prepares test data (sessions, messages, etc.)
2. Playwright launches a browser
3. Tests navigate the actual web app and assert on rendered output
4. Tests cover session creation, message sending, tool call rendering, and navigation

---

## Build and Deployment

### Development

```bash
# From repo root
bun dev:web

# Or directly
cd packages/app
bun dev
```

This starts Vite's dev server with hot module replacement (HMR). SolidJS's HMR preserves component state during edits, making the development cycle extremely fast.

### Production Build

```bash
cd packages/app
bun run build
```

Vite produces:

- **Static HTML/JS/CSS** — No server-side rendering for the main app
- **Code-split chunks** — Route-based splitting for optimal loading
- **Hashed filenames** — For long-term caching
- **Minified** — Terser for JS, Lightning CSS for CSS

### Deployment

The built web app is deployed as a **Cloudflare Static Site** via SST:

```typescript
// In infra/app.ts
new sst.cloudflare.StaticSite("WebApp", {
  path: "packages/app",
  build: {
    command: "bun run build",
    output: "dist",
  },
  domain: `app.${domain}`,
})
```

It's served from Cloudflare's global CDN, with the API server running as a separate Cloudflare Worker.

---

## How It Connects to the Backend

Here's the full picture of how the web app connects to the OpenCode server:

```
┌─────────────────────────────────────────────┐
│                  Web App                      │
│  ┌───────────┐  ┌──────────┐  ┌───────────┐ │
│  │ SDKClient │  │ SSE      │  │ Components│ │
│  │ (REST)    │  │ (events) │  │ (SolidJS) │ │
│  └─────┬─────┘  └────┬─────┘  └─────┬─────┘ │
│        │             │              │         │
│        │ commands     │ updates      │ reads   │
│        │             │              │         │
│        │         ┌───▼──────────────▼───┐    │
│        │         │   Reactive Stores     │    │
│        │         │   (sessions, msgs)    │    │
│        │         └──────────────────────┘    │
└────────┼──────────────┼──────────────────────┘
         │              │
         ▼              ▼
┌─────────────────────────────────────────────┐
│              OpenCode Server (Hono)           │
│  POST /session/:id/message                   │
│  GET /session/:id/messages                   │
│  GET /event (SSE stream)                     │
│  ...                                         │
└─────────────────────────────────────────────┘
```

1. **User action** → SDK client sends REST request → Server processes → Event Bus publishes
2. **Event Bus** → SSE stream → SyncProvider → Reactive store update → Component re-render
3. **Components** read from reactive stores — never directly from the server

This unidirectional flow ensures consistency: the server is the single source of truth, the SSE stream keeps the client in sync, and SolidJS's reactivity handles efficient DOM updates.

---

## Key Takeaways

1. **SolidJS is not React** — It compiles to direct DOM operations with fine-grained reactivity. No virtual DOM, no diffing, no unnecessary re-renders. This matters immensely for streaming AI responses.

2. **SSE is the real-time backbone** — The `/event` endpoint streams typed events that update reactive stores, keeping the UI in sync with the server.

3. **The SDK is the API boundary** — All server communication goes through the generated TypeScript SDK, ensuring type safety end-to-end.

4. **Virtualization handles scale** — `virtua` ensures the app stays responsive even with very long conversations.

5. **morphdom handles streaming markdown** — Instead of re-rendering the entire markdown block on each chunk, morphdom applies minimal DOM patches for smooth streaming.

6. **The web app is a static site** — No SSR needed. It's deployed to Cloudflare's CDN and connects to the API server at a separate endpoint.

7. **Shared components via @opencode-ai/ui** — The web app, storybook, and desktop app share a common component library for consistency.

---

**Next:** [Chapter 10: Desktop Application →](/10-desktop-application/) — Tauri 2 wrapping the web app with native integrations.

**Previous:** [Chapter 8: Terminal UI](/08-terminal-ui/)
