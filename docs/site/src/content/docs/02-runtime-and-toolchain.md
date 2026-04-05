---
title: "Chapter 2 — Runtime & Toolchain"
---


> How Bun, TypeScript, and Turborepo form the foundation of OpenCode's development and build pipeline.

---

## Bun: The Universal Runtime

OpenCode is built entirely on **[Bun](https://bun.sh)** — not just as a package manager, but as the **runtime**, **bundler**, **test runner**, and **cross-compiler**. The project pins Bun **1.3.10** via the `packageManager` field in the root `package.json`:

```json
{
  "packageManager": "bun@1.3.10"
}
```

### Why Bun?

Bun isn't just "a faster Node.js" for OpenCode — it's load-bearing infrastructure. Here's what OpenCode uses that **only Bun provides**:

| Bun API       | Where it's used                          | Why it matters                                                                 |
| ------------- | ---------------------------------------- | ------------------------------------------------------------------------------ |
| `bun:sqlite`  | `packages/opencode/src/storage/db.ts`    | Native SQLite bindings — no external dependency, zero-overhead database access |
| `bun-pty`     | `packages/opencode/src/pty/`             | Pseudo-terminal support for interactive shell sessions                         |
| `Bun.serve()` | `packages/opencode/src/server/server.ts` | HTTP server with WebSocket upgrade support                                     |
| `Bun.file()`  | Throughout                               | Fast file I/O without `fs` imports                                             |
| `Bun.build()` | `packages/opencode/script/build.ts`      | Bundler + **cross-compiler** to standalone executables                         |
| `bun:test`    | `packages/opencode/test/`                | Built-in test runner with `describe`, `test`, `expect`                         |
| `Bun.spawn()` | Tool execution, MCP                      | Process spawning for bash tools and MCP servers                                |
| `Bun.$`       | Shell scripts                            | Tagged template shell execution                                                |

The `bunfig.toml` at the repo root configures Bun's behavior:

```toml
[install]
# Bun workspace and install configuration
```

And each package can override with its own `bunfig.toml` — for instance, `packages/opencode/bunfig.toml` configures the test preload:

```toml
[test]
preload = ["./test/preload.ts"]
```

### Bun as Cross-Compiler

One of the most powerful Bun features OpenCode leverages is `Bun.build()` with `compile: true`. This compiles the entire TypeScript application — including all dependencies — into a **standalone executable** that requires no runtime installation.

OpenCode targets **11 platforms** from a single build script:

| OS      | Architectures                                                     |
| ------- | ----------------------------------------------------------------- |
| Linux   | arm64, x64, x64-baseline, arm64-musl, x64-musl, x64-musl-baseline |
| macOS   | arm64, x64, x64-baseline                                          |
| Windows | x64, x64-baseline                                                 |

The "baseline" variants target older CPUs without AVX2 instructions. The "musl" variants produce statically-linked Linux binaries for Alpine and similar distros.

The build script (`packages/opencode/script/build.ts`) does several remarkable things:

1. **Fetches the model catalog** from `models.dev/api.json` and embeds it as a compile-time constant
2. **Reads SQL migration files** and embeds them via `define` so the binary contains its own schema migrations
3. **Compiles SolidJS JSX** for the TUI using a custom Bun plugin from `@opentui/solid/bun-plugin`
4. **Embeds tree-sitter parsers** for syntax highlighting in the terminal

---

## TypeScript: Dual Typechecking

OpenCode uses **TypeScript 5.8.2** for all source code, with a twist: it also employs **tsgo 7.0.0-dev** (the experimental native TypeScript compiler) for fast type checking.

### tsconfig.json

The root `tsconfig.json` sets baseline compiler options shared across all packages:

```json
{
  "compilerOptions": {
    "target": "esnext",
    "module": "esnext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "jsx": "preserve",
    "paths": {
      "@/*": ["./src/*"]
    }
  }
}
```

Key choices:

- **`"moduleResolution": "bundler"`** — because Bun resolves modules like a bundler, not like Node.js
- **`"jsx": "preserve"`** — JSX is compiled by Bun/Vite/SolidJS plugins, not tsc
- **Path aliases** — `@/` maps to `src/` in each package, giving clean imports like `import { Config } from "@/config/config"`

### tsgo for Speed

The `typecheck` script in Turborepo runs `tsgo --noEmit` (or `tsgo -b` for project references). tsgo is a **native Go port** of the TypeScript compiler that's dramatically faster than `tsc`. For a monorepo this large, this saves significant CI time.

---

## Monorepo: Workspaces + Turborepo

### Bun Workspaces

The monorepo uses Bun's built-in workspace support, declared in the root `package.json`:

```json
{
  "workspaces": {
    "packages": ["packages/*", "packages/console/*", "packages/sdk/js", "packages/slack"]
  }
}
```

This tells Bun to treat each matching directory as a separate package, linked via the `workspace:*` protocol. When one package depends on another (e.g., `@opencode-ai/app` depends on `@opencode-ai/sdk`), Bun symlinks them rather than downloading from npm.

### Version Catalog

Bun supports a **`catalog:`** protocol for centralizing dependency versions. Instead of duplicating version strings across 20 packages:

```json
{
  "workspaces": {
    "catalog": {
      "solid-js": "1.9.10",
      "zod": "4.1.8",
      "hono": "4.10.7",
      "drizzle-orm": "1.0.0-beta.16-ea816b6",
      "tailwindcss": "4.1.11",
      "vite": "7.1.4"
    }
  }
}
```

Individual packages reference these with `"solid-js": "catalog:"` — Bun resolves the actual version from the catalog. This is similar to Gradle's version catalogs or Cargo's workspace dependencies.

### Turborepo

**[Turborepo 2.8.13](https://turbo.build)** orchestrates task execution across the monorepo. The `turbo.json` config defines tasks and their dependency graph:

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "typecheck": {
      "dependsOn": ["^typecheck"]
    },
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "test": {
      "dependsOn": ["^build"]
    }
  }
}
```

When you run `bun turbo typecheck`, Turborepo:

1. **Resolves the dependency graph** — if `app` depends on `sdk`, `sdk` typechecks first
2. **Parallelizes** — independent packages typecheck simultaneously
3. **Caches** — if nothing changed in a package, it skips the task entirely
4. **Streams output** — interleaved logs from all packages

This is critical for a monorepo with 20+ packages — without Turborepo, a full typecheck or build would take minutes instead of seconds.

---

## The Package Map

Here's every package in the monorepo and what it does:

### Core

| Package                         | Path                        | Description                                                           |
| ------------------------------- | --------------------------- | --------------------------------------------------------------------- |
| `@opencode-ai/opencode`         | `packages/opencode`         | The core CLI + AI engine — agents, sessions, tools, providers, server |
| `@opencode-ai/app`              | `packages/app`              | SolidJS web application (browser UI)                                  |
| `@opencode-ai/desktop`          | `packages/desktop`          | Tauri desktop wrapper                                                 |
| `@opencode-ai/desktop-electron` | `packages/desktop-electron` | Electron desktop wrapper (alternative)                                |
| `@opencode-ai/ui`               | `packages/ui`               | Shared SolidJS component library                                      |

### SDK & Extensibility

| Package                   | Path                  | Description                                    |
| ------------------------- | --------------------- | ---------------------------------------------- |
| `@opencode-ai/sdk`        | `packages/sdk/js`     | TypeScript client SDK (generated from OpenAPI) |
| `@opencode-ai/plugin`     | `packages/plugin`     | Plugin authoring framework                     |
| `@opencode-ai/extensions` | `packages/extensions` | IDE extensions (Zed, VS Code)                  |

### Cloud & Console

| Package                     | Path                    | Description                                 |
| --------------------------- | ----------------------- | ------------------------------------------- |
| `@opencode-ai/console-app`  | `packages/console/app`  | SolidStart console web app (billing, teams) |
| `@opencode-ai/console-core` | `packages/console/core` | Console backend logic                       |
| `@opencode-ai/enterprise`   | `packages/enterprise`   | Enterprise/teams features                   |
| `@opencode-ai/identity`     | `packages/identity`     | Authentication workers                      |
| `@opencode-ai/function`     | `packages/function`     | Cloudflare Worker functions (API, webhooks) |
| `@opencode-ai/web`          | `packages/web`          | Marketing/docs website                      |
| `@opencode-ai/containers`   | `packages/containers`   | Docker container definitions                |

### Utilities

| Package                  | Path                 | Description                       |
| ------------------------ | -------------------- | --------------------------------- |
| `@opencode-ai/script`    | `packages/script`    | Shared build/release scripts      |
| `@opencode-ai/util`      | `packages/util`      | Shared utility functions          |
| `@opencode-ai/storybook` | `packages/storybook` | Component development environment |
| `@opencode-ai/slack`     | `packages/slack`     | Slack integration                 |

---

## Development Workflow

### Running in Dev Mode

```bash
# TUI (terminal UI) — runs the full CLI in dev mode
bun dev
# Equivalent to: bun run --cwd packages/opencode --conditions=browser src/index.ts

# Web app — starts Vite dev server
bun dev:web
# Equivalent to: bun --cwd packages/app dev

# Desktop — starts Tauri dev with hot reload
bun dev:desktop
# Equivalent to: bun --cwd packages/desktop tauri dev

# Storybook — component explorer
bun dev:storybook
```

The `--conditions=browser` flag on the TUI dev command is significant — it tells Bun to resolve the "browser" export condition in `package.json` exports, which is how SolidJS selects its reactive (non-SSR) runtime.

### Type Checking

```bash
# Check all packages (uses tsgo for speed)
bun turbo typecheck
```

### Building

```bash
# Build the CLI binary for your current platform
cd packages/opencode
bun run script/build.ts

# Build the SDK
cd packages/sdk/js
bun run script/build.ts
```

### Formatting

The project uses **Prettier** with a minimal config:

```json
{
  "semi": false,
  "printWidth": 120
}
```

No semicolons. 120-character lines. That's it.

---

## Key Takeaways

1. **Bun is everything** — runtime, bundler, test runner, package manager, cross-compiler, and SQLite driver. Understanding Bun is prerequisite to understanding OpenCode.

2. **The monorepo is workspace-driven** — packages reference each other via `workspace:*`, and Turborepo handles the dependency graph for builds and checks.

3. **TypeScript is strict** — `strict: true`, Zod for runtime validation, path aliases for clean imports, and dual typechecking with tsc + tsgo.

4. **The build produces standalone binaries** — `Bun.build({ compile: true })` creates single-file executables that bundle everything, including SQLite migrations and tree-sitter parsers.

5. **Version management is centralized** — the catalog protocol ensures all packages use the same versions of shared dependencies.

---

**Next:** [Chapter 3 — The Core Package →](/03-core-package/)
