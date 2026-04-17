# Chapter 10: Desktop Application

> Tauri 2 (Rust) wrapping the web app, sidecar CLI, native integrations, and cross-platform builds.

---

## Overview

OpenCode's desktop application is a **native wrapper** around the web app, built with **[Tauri 2](https://v2.tauri.app)** — a Rust-based framework for building desktop applications with web frontends. Rather than shipping a full browser engine like Electron, Tauri uses the operating system's native webview, resulting in dramatically smaller binaries and lower memory usage.

The desktop app lives in `packages/desktop/` and reuses the web app (`packages/app`) as its frontend, adding native capabilities like system notifications, clipboard access, deep links, and automatic updates.

---

## Architecture

```
┌─────────────────────────────────────────────┐
│            Desktop Application               │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │        Native Shell (Tauri/Rust)       │  │
│  │                                        │  │
│  │  • Window management                   │  │
│  │  • System tray / menu bar              │  │
│  │  • Native notifications                │  │
│  │  • Clipboard access                    │  │
│  │  • Deep link handling                  │  │
│  │  • Auto-updater                        │  │
│  │  • Sidecar process management          │  │
│  │                                        │  │
│  │  ┌──────────────────────────────────┐  │  │
│  │  │     OS Webview (WebKit/WebView2) │  │  │
│  │  │                                  │  │  │
│  │  │   ┌──────────────────────────┐   │  │  │
│  │  │   │    Web App (SolidJS)     │   │  │  │
│  │  │   │    @opencode-ai/app      │   │  │  │
│  │  │   │                          │   │  │  │
│  │  │   │  Connects to local       │   │  │  │
│  │  │   │  opencode-cli server     │   │  │  │
│  │  │   └──────────────────────────┘   │  │  │
│  │  └──────────────────────────────────┘  │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │    Sidecar: opencode-cli binary        │  │
│  │    (Bun-compiled standalone)           │  │
│  │                                        │  │
│  │    Runs the HTTP server (Hono)         │  │
│  │    on localhost:4096                    │  │
│  └────────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

The desktop app has three layers:

1. **Rust shell** — Tauri manages the window, native APIs, and lifecycle
2. **Webview** — The OS-native web renderer (WebKit on macOS/Linux, WebView2 on Windows)
3. **Sidecar** — The `opencode-cli` binary runs as a child process, providing the full backend

---

## Why Tauri Over Electron?

OpenCode also has an Electron build (`packages/desktop-electron/`), but Tauri is the primary desktop target. Here's why:

| Property         | Tauri 2            | Electron                     |
| ---------------- | ------------------ | ---------------------------- |
| Binary size      | ~10-20 MB          | ~150+ MB                     |
| Memory usage     | ~50-100 MB         | ~200-400 MB                  |
| Renderer         | OS native webview  | Bundled Chromium             |
| Backend language | Rust               | Node.js                      |
| Security model   | Capability-based   | Full Node.js access          |
| Auto-update      | Built-in           | electron-updater             |
| IPC              | Type-safe (specta) | Manual serialization         |
| Startup time     | Fast               | Slower (Chromium cold start) |

Tauri's capability-based security model is a particularly good fit for OpenCode — the app only grants the webview access to specific native APIs, rather than giving it blanket access to the system.

---

## Project Structure

```
packages/desktop/
├── src/                    # Frontend entry (thin wrapper)
│   └── ...                 # Vite-built, imports @opencode-ai/app
├── src-tauri/              # Rust backend
│   ├── Cargo.toml          # Rust dependencies
│   ├── tauri.conf.json     # Tauri configuration
│   ├── capabilities/       # Security capabilities
│   ├── src/
│   │   ├── lib.rs          # Main Tauri application setup
│   │   └── ...             # Rust commands, event handlers
│   ├── icons/              # Platform-specific app icons
│   └── gen/                # Generated bindings (tauri-specta)
├── scripts/                # Build helper scripts
├── index.html              # HTML entry point
├── vite.config.ts          # Vite configuration
├── package.json            # Node dependencies
└── tsconfig.json           # TypeScript config
```

---

## Tauri Configuration

The `src-tauri/tauri.conf.json` file defines the desktop app's behavior:

```
{
  "productName": "OpenCode",
  "identifier": "ai.opencode.desktop",
  "build": {
    "devUrl": "http://localhost:5173",        // Vite dev server
    "frontendDist": "../dist"                  // Production build output
  },
  "app": {
    "windows": [
      {
        "title": "OpenCode",
        "width": 1200,
        "height": 800,
        "decorations": false,                  // Custom titlebar
        "transparent": false
      }
    ],
    "security": {
      "csp": "default-src 'self'; ..."        // Content Security Policy
    }
  },
  "bundle": {
    "active": true,
    "targets": ["deb", "rpm", "dmg", "nsis", "app"],
    "externalBin": ["opencode-cli"],          // Sidecar binary
    "icon": ["icons/icon.png", ...]
  }
}
```

Key configuration points:

- **`decorations: false`** — The app uses a custom titlebar for a modern look, handled by the `decorum` Tauri plugin
- **`externalBin: ["opencode-cli"]`** — The CLI binary is bundled as a sidecar, started and managed by the Rust backend
- **`targets`** — Build targets for each platform: `.deb` and `.rpm` for Linux, `.dmg` and `.app` for macOS, `.nsis` (installer) for Windows

---

## The Sidecar Pattern

The desktop app doesn't embed the OpenCode server directly — instead, it ships the **compiled CLI binary** as a "sidecar" that runs alongside the Tauri app:

```
Desktop app starts
       │
       ▼
Tauri Rust backend launches
       │
       ├──► Spawns opencode-cli sidecar process
       │       └── CLI starts HTTP server on localhost:4096
       │
       ├──► Opens webview window
       │       └── Web app loads
       │           └── Connects to localhost:4096
       │               ├── REST API calls
       │               └── SSE event stream
       │
       └──► Monitors sidecar health
```

### Why a Sidecar?

1. **Reuse** — The CLI binary is the same one distributed for terminal use. No code duplication.
2. **Isolation** — The server runs in its own process with its own memory space. A crash in the server doesn't take down the UI.
3. **Updates** — The sidecar can be updated independently of the desktop shell.
4. **Architecture match** — The CLI is compiled by Bun for the target platform. Tauri's sidecar mechanism handles platform-specific binary naming (`opencode-cli-x86_64-apple-darwin`, etc.).

### Sidecar Lifecycle

The Rust backend manages the sidecar's lifecycle:

1. **Start** — On app launch, the sidecar is spawned with appropriate arguments
2. **Health check** — The Rust backend polls the server until it responds
3. **Port discovery** — The server's port is communicated to the webview
4. **Restart** — If the sidecar crashes, the Rust backend can restart it
5. **Shutdown** — On app close, the sidecar is gracefully terminated

---

## Rust Backend

The Rust side (`src-tauri/`) handles native integrations that the webview can't access directly.

### Cargo.toml Dependencies

```
[dependencies]
tauri = { version = "2.9.5", features = [...] }
tauri-plugin-clipboard-manager = "2"
tauri-plugin-deep-link = "2"
tauri-plugin-dialog = "2"
tauri-plugin-http = "2"
tauri-plugin-notification = "2"
tauri-plugin-opener = "2"
tauri-plugin-os = "2"
tauri-plugin-process = "2"
tauri-plugin-shell = "2"
tauri-plugin-single-instance = "2"
tauri-plugin-store = "2"
tauri-plugin-updater = "2"
tauri-plugin-window-state = "2"
tauri-specta = "2"
decorum = "0.5"                               # Custom window decoration
```

### Tauri Plugins

| Plugin            | Purpose                                       |
| ----------------- | --------------------------------------------- |
| `clipboard`       | Read/write system clipboard                   |
| `deep-link`       | Handle `opencode://` URL scheme               |
| `dialog`          | Native file picker, message dialogs           |
| `http`            | HTTP client from Rust (bypasses CORS)         |
| `notification`    | System notifications for long-running tasks   |
| `opener`          | Open files/URLs with system default app       |
| `os`              | Query OS info (platform, version, arch)       |
| `process`         | Process management (exit, restart)            |
| `shell`           | Spawn child processes (sidecar management)    |
| `single-instance` | Prevent multiple app instances                |
| `store`           | Persistent key-value storage (preferences)    |
| `updater`         | OTA auto-update from GitHub releases          |
| `window-state`    | Remember window size/position across sessions |
| `decorum`         | Custom window titlebar and decoration         |

### Type-Safe IPC with tauri-specta

OpenCode uses `tauri-specta` to generate TypeScript bindings from Rust command definitions. This means:

1. Rust commands are defined with typed parameters and return values
2. `tauri-specta` generates TypeScript functions that call these commands
3. The web app imports these generated functions for type-safe IPC

```
// Rust side (src-tauri/src/lib.rs)
#[tauri::command]
#[specta::specta]
fn get_sidecar_port() -> u16 {
    4096
}

// Generated TypeScript (src-tauri/gen/)
export function getSidecarPort(): Promise<number> {
    return invoke("get_sidecar_port")
}

// Web app usage
import { getSidecarPort } from "../gen/bindings"
const port = await getSidecarPort()
```

This eliminates an entire class of IPC bugs — parameter mismatches, wrong return types, and missing commands are caught at compile time.

---

## Platform-Specific Handling

### macOS

- Uses **WebKit** (WKWebView) as the webview renderer
- Custom titlebar with `decorum` for native-feeling window controls
- App bundle (`.app`) and disk image (`.dmg`) distribution
- Code signing and notarization via Apple Developer certificates
- Dependencies: `objc2`, `objc2-web-kit` for Objective-C bridge

### Windows

- Uses **WebView2** (Chromium-based, ships with Windows 10+)
- NSIS installer for distribution
- Dependencies: `windows-sys` for Win32 API access

### Linux

- Uses **WebKitGTK** as the webview renderer
- `.deb` (Debian/Ubuntu) and `.rpm` (Fedora/RHEL) packages
- Dependencies: `gtk`, `webkit2gtk`

---

## Frontend Integration

The frontend is built with **Vite**, configured in `vite.config.ts`:

```typescript
import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

export default defineConfig({
  plugins: [solid()],
  // In dev, Vite serves at localhost:5173
  // Tauri's devUrl points here
  server: {
    port: 5173,
  },
  build: {
    outDir: "dist",
    // Production build consumed by Tauri
  },
})
```

The desktop frontend is essentially the same `@opencode-ai/app` web application, potentially with desktop-specific overrides:

- **Window controls** — Custom minimize/maximize/close buttons (since `decorations: false`)
- **Deep link handling** — Responds to `opencode://` URLs
- **File drag-and-drop** — Native file drop support
- **System menu** — Application menu bar on macOS

---

## Auto-Update System

The desktop app supports **over-the-air updates** via the Tauri updater plugin:

```
App checks for updates
       │
       ▼
Queries GitHub Releases API
       │
       ▼
Compares current version with latest release
       │
       ├── No update → done
       │
       └── Update available
            │
            ▼
       Downloads platform-specific artifact
       (.dmg / .nsis / .deb / .AppImage)
            │
            ▼
       Verifies signature
            │
            ▼
       Installs update
            │
            ▼
       Restarts app
```

Updates include both the Tauri shell and the sidecar CLI binary, ensuring the desktop app stays in sync with the latest features and bug fixes.

---

## Build Pipeline

Building the desktop app is the most complex part of the release pipeline. The CI/CD workflow (`publish.yml`) builds for **5 platform targets**:

| Target                | OS      | Architecture | Artifact          |
| --------------------- | ------- | ------------ | ----------------- |
| macOS (Intel)         | darwin  | x86_64       | `.dmg`, `.app`    |
| macOS (Apple Silicon) | darwin  | aarch64      | `.dmg`, `.app`    |
| Windows               | windows | x86_64       | `.nsis` installer |
| Linux (x86)           | linux   | x86_64       | `.deb`, `.rpm`    |
| Linux (ARM)           | linux   | aarch64      | `.deb`, `.rpm`    |

### Build Steps

1. **Build the sidecar CLI** — `Bun.build()` compiles the CLI for the target platform
2. **Place sidecar in `src-tauri/`** — Named according to Tauri's convention (`opencode-cli-{triple}`)
3. **Build the frontend** — `vite build` produces the web app bundle
4. **Build the Tauri app** — `tauri build` compiles the Rust backend, bundles everything into platform packages
5. **Code sign** — macOS builds are signed with Apple certificates; Windows builds can be signed with a certificate
6. **Upload artifacts** — Platform packages are attached to the GitHub release

### Apple Code Signing

macOS builds require code signing and notarization for users to run the app without security warnings:

```
Build .app bundle
       │
       ▼
Sign with Developer ID certificate
       │
       ▼
Submit to Apple notarization service
       │
       ▼
Apple scans for malware
       │
       ▼
Staple notarization ticket to .app
       │
       ▼
Package as .dmg
```

This is handled automatically in CI via environment variables containing the signing certificates and Apple credentials.

---

## Development Workflow

### Running in Dev Mode

```bash
# From the repo root
bun dev:desktop
# Equivalent to: bun --cwd packages/desktop tauri dev
```

This starts:

1. **Vite dev server** at `localhost:5173` with hot module replacement
2. **Tauri dev window** pointing to the Vite server
3. **Sidecar** (the opencode CLI) runs separately

Changes to the web app are reflected instantly via HMR. Changes to the Rust backend trigger a recompilation (a few seconds).

### Building for Production

```bash
cd packages/desktop
bun run tauri build
```

This produces platform-specific packages in `src-tauri/target/release/bundle/`.

---

## The Electron Alternative

OpenCode also ships an Electron build at `packages/desktop-electron/`. This exists as a fallback for platforms or environments where Tauri's webview doesn't work well. The Electron build uses `electron-builder` for packaging and follows a similar sidecar pattern.

The CI/CD pipeline builds both Tauri and Electron variants, but Tauri is the recommended and primary distribution.

---

## Key Takeaways

1. **Tauri 2 provides the native shell** — Rust backend, OS webview, capability-based security. Much smaller and lighter than Electron.

2. **The sidecar pattern reuses the CLI** — The same compiled binary that runs in the terminal also powers the desktop app. No code duplication.

3. **Type-safe IPC via tauri-specta** — Rust commands automatically generate TypeScript bindings, eliminating IPC type mismatches.

4. **Cross-platform from one codebase** — 5 build targets (macOS x2, Windows, Linux x2) from the same source, with platform-specific handling for webview engines, code signing, and packaging.

5. **Auto-updates built in** — The Tauri updater plugin checks GitHub releases and applies updates seamlessly.

6. **The web app is the UI** — `@opencode-ai/app` renders identically in the browser and the desktop, with desktop-specific enhancements for window controls and native APIs.

---

**Next:** [Chapter 11: HTTP Server & API →](./11-http-server-and-api.md) — Hono-powered API, OpenAPI generation, and the SSE event stream.

**Previous:** [Chapter 9: Web Application](./09-web-application.md)
