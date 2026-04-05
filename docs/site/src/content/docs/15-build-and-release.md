---
title: "Chapter 15: Build & Release Pipeline"
---


> Cross-compilation to 11 targets, the publish script, CI/CD workflows, and the artifact pipeline.

---

## Overview

OpenCode's build and release pipeline is one of the most sophisticated parts of the project. It takes a TypeScript monorepo and produces:

- **Standalone CLI binaries** for 11 platform/architecture combinations
- **Desktop applications** for 5 platform targets (Tauri + Electron)
- **npm packages** for the CLI, SDK, and plugin
- **Docker images** for containerized usage
- **AUR packages** for Arch Linux
- **IDE extensions** for Zed and VS Code

All of this is orchestrated by a set of Bun scripts in the `script/` directory and GitHub Actions workflows in `.github/workflows/`.

---

## CLI Build: From TypeScript to Standalone Binary

The CLI build is the centerpiece of the release pipeline. It uses **Bun's compile feature** (`Bun.build()` with `compile: true`) to produce self-contained executables that require no runtime installation.

### Build Script

The build script lives at `packages/opencode/script/build.ts`. Here's what it does:

```
Step 1: Fetch model catalog
        │
        ▼
Step 2: Read SQL migrations
        │
        ▼
Step 3: Compile for each target
        │
        ▼
Step 4: Package artifacts
        │
        ▼
Step 5: Upload to GitHub release
```

### Step 1: Fetch Model Catalog

Before building, the script fetches the latest model catalog from `models.dev/api.json`:

```
const models = await fetch("https://models.dev/api.json").then(r => r.json())
```

This catalog contains metadata about every LLM model — capabilities, token limits, pricing — and is embedded into the binary as a compile-time constant. This means the CLI can display model information and validate model selections without making network requests at runtime.

### Step 2: Read SQL Migrations

The script reads all SQL migration files from `packages/opencode/migration/` and serializes them:

```
migration/
├── 20260127222353_familiar_lady_ursula/
│   └── migration.sql
├── 20260201143022_next_migration/
│   └── migration.sql
└── ...

→ Serialized to JSON string → Embedded via define
```

This is injected as a build-time constant via Bun's `define` option:

```
define: {
  "OPENCODE_MIGRATIONS": JSON.stringify(migrations),
  "OPENCODE_VERSION": JSON.stringify(version),
  "OPENCODE_CHANNEL": JSON.stringify(channel),
}
```

At runtime, the binary reads `OPENCODE_MIGRATIONS` and applies any pending migrations to the user's SQLite database. No external migration files need to be shipped.

### Step 3: Cross-Compilation

Bun supports cross-compilation — building a binary for a different platform from the one you're running on. OpenCode targets **11 platforms**:

| OS      | Architecture          | Variant       | Target String                 |
| ------- | --------------------- | ------------- | ----------------------------- |
| Linux   | ARM64                 | glibc         | `bun-linux-arm64`             |
| Linux   | x64                   | glibc         | `bun-linux-x64`               |
| Linux   | x64                   | glibc (old)   | `bun-linux-x64-baseline`      |
| Linux   | ARM64                 | musl (Alpine) | `bun-linux-arm64-musl`        |
| Linux   | x64                   | musl (Alpine) | `bun-linux-x64-musl`          |
| Linux   | x64                   | musl (old)    | `bun-linux-x64-musl-baseline` |
| macOS   | ARM64 (Apple Silicon) | —             | `bun-darwin-arm64`            |
| macOS   | x64 (Intel)           | —             | `bun-darwin-x64`              |
| macOS   | x64 (old Intel)       | —             | `bun-darwin-x64-baseline`     |
| Windows | x64                   | —             | `bun-windows-x64`             |
| Windows | x64 (old)             | —             | `bun-windows-x64-baseline`    |

**What are "baseline" variants?** These target older CPUs that lack AVX2 instructions. Some servers and older consumer hardware don't support AVX2, so the baseline variant ensures compatibility at a slight performance cost.

**What are "musl" variants?** These are statically linked against musl libc instead of glibc, making them compatible with Alpine Linux and other musl-based distributions commonly used in Docker containers.

### The Bun.build() Call

For each target, the build script calls:

```
await Bun.build({
  entrypoints: ["src/index.ts"],
  outdir: "./dist",
  target: target,        // e.g., "bun-linux-arm64"
  compile: true,         // Produce a standalone binary
  minify: true,
  sourcemap: "none",
  plugins: [
    solidPlugin(),       // @opentui/solid/bun-plugin — compile TUI JSX
  ],
  conditions: ["browser"],  // SolidJS reactive runtime
  define: {
    "OPENCODE_VERSION": JSON.stringify(version),
    "OPENCODE_MIGRATIONS": JSON.stringify(migrations),
    "OPENCODE_CHANNEL": JSON.stringify(channel),
    "OPENCODE_LIBC": JSON.stringify(libc),
  },
  // Embed tree-sitter parser worker for syntax highlighting
})
```

Key options:

- **`compile: true`** — This is the magic flag. Bun bundles all dependencies, the Bun runtime itself, and the application code into a single self-contained binary.
- **`plugins: [solidPlugin()]`** — The SolidJS Bun plugin transforms JSX into SolidJS render calls targeting @opentui's terminal renderer.
- **`conditions: ["browser"]`** — Tells Bun to resolve SolidJS's "browser" export condition, selecting the reactive (non-SSR) runtime.
- **`define`** — Injects compile-time constants. These replace references to the identifier in source code with the literal value.

### Step 4: Package Artifacts

After compilation, each binary is packaged:

| OS      | Package Format | Contents                    |
| ------- | -------------- | --------------------------- |
| Linux   | `.tar.gz`      | Binary + optional man pages |
| macOS   | `.zip`         | Binary                      |
| Windows | `.zip`         | Binary (`.exe`)             |

### Step 5: Upload to Release

Artifacts are uploaded to the GitHub release draft created by the version script.

---

## Desktop Build

The desktop build is even more complex because it involves **two build systems** — Bun for the frontend + sidecar, and Rust/Cargo for the Tauri shell.

### Tauri Build Pipeline

```
1. Build the sidecar CLI binary
   └── Bun.build() for the target platform
   └── Place in src-tauri/ with Tauri naming convention

2. Build the frontend
   └── vite build → produces dist/

3. Build the Tauri shell
   └── cargo build --release
   └── Links against OS webview
   └── Bundles frontend + sidecar

4. Package for distribution
   └── macOS: .dmg, .app
   └── Windows: .nsis installer
   └── Linux: .deb, .rpm
```

### Build Matrix (CI)

The CI builds for 5 platform targets:

| Target                | Runner         | Artifact       |
| --------------------- | -------------- | -------------- |
| macOS (Intel)         | macos-13       | `.dmg`, `.app` |
| macOS (Apple Silicon) | macos-14       | `.dmg`, `.app` |
| Windows x64           | windows-latest | `.nsis`        |
| Linux x64             | ubuntu-22.04   | `.deb`, `.rpm` |
| Linux ARM64           | ubuntu-22.04   | `.deb`, `.rpm` |

### Apple Code Signing

macOS builds require code signing and notarization:

```
Build .app bundle
       │
       ▼
Sign with Developer ID certificate
(APPLE_CERTIFICATE, APPLE_CERTIFICATE_PASSWORD)
       │
       ▼
Submit to Apple Notarization Service
(APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID)
       │
       ▼
Apple scans binary for malware (async)
       │
       ▼
Staple notarization ticket to .app
       │
       ▼
Create .dmg disk image
```

This is handled automatically in CI via secrets stored in the GitHub repository.

### Electron Build (Alternative)

The Electron build follows a similar pattern but uses `electron-builder` instead of Tauri:

```
1. Build the frontend (same vite build)
2. Package with electron-builder
   └── macOS: .dmg
   └── Windows: .nsis
   └── Linux: .deb, .rpm, .AppImage
```

---

## Publish Script

The master publish script (`script/publish.ts`) orchestrates the entire release:

```
1. Version bump
   └── Updates package.json across all packages
   └── Creates git tag

2. Build SDK
   └── Runs packages/sdk/js/script/build.ts
   └── Generates TypeScript client from OpenAPI spec

3. Publish npm packages
   ├── @opencode-ai/cli (platform-specific binaries)
   │   ├── @opencode-ai/cli-linux-arm64
   │   ├── @opencode-ai/cli-linux-x64
   │   ├── @opencode-ai/cli-darwin-arm64
   │   ├── @opencode-ai/cli-darwin-x64
   │   ├── @opencode-ai/cli-win32-x64
   │   └── @opencode-ai/cli (meta-package with optionalDependencies)
   ├── @opencode-ai/sdk
   └── @opencode-ai/plugin

4. Build Docker images
   └── Push to GitHub Container Registry (ghcr.io)

5. Update AUR package
   └── Update PKGBUILD with new version and hashes

6. Update Zed extension
   └── Sync to Zed extension registry

7. Finalize GitHub release
   └── Remove draft flag
   └── Attach all artifacts
```

### npm Platform Packages

The CLI is published to npm as **platform-specific packages** with a meta-package:

```
@opencode-ai/cli (meta-package)
├── optionalDependencies:
│   ├── @opencode-ai/cli-linux-arm64
│   ├── @opencode-ai/cli-linux-x64
│   ├── @opencode-ai/cli-linux-x64-baseline
│   ├── @opencode-ai/cli-darwin-arm64
│   ├── @opencode-ai/cli-darwin-x64
│   └── @opencode-ai/cli-win32-x64
└── postinstall: selects correct binary for platform
```

When a user runs `npm install -g @opencode-ai/cli`, npm downloads only the binary for their platform (via `optionalDependencies` — npm skips packages that don't match the current OS/arch).

The `packages/opencode/script/publish.ts` script handles:

1. Creating a `package.json` for each platform package
2. Copying the compiled binary into the package
3. Running `npm publish` for each package
4. Publishing the meta-package last

---

## CI/CD Workflows

### `test.yml` — Testing

Triggered on PRs and pushes to `dev`:

```
Jobs:
├── unit-tests
│   ├── matrix: [linux, windows]
│   ├── runner: Blacksmith 4vcpu (linux) / windows-latest
│   └── command: bun turbo test
│
├── e2e-tests (depends on unit)
│   ├── matrix: [linux, windows]
│   ├── uses: Playwright
│   └── timeout: 30 minutes
│
└── required-check (gate job)
    └── Ensures both pass before merge
```

### `typecheck.yml` — Type Checking

```
Jobs:
└── typecheck
    └── command: bun turbo typecheck
    └── Uses tsgo (native TypeScript) for speed
```

### `publish.yml` — Full Release Pipeline

Triggered by push to `ci`, `dev`, `beta`, or `snapshot-*` branches, or manual dispatch:

```
Jobs:
├── version
│   └── Compute version, create GitHub release draft
│
├── build-cli (depends on version)
│   └── Build standalone binaries for all 11 targets
│   └── Upload as release artifacts
│
├── build-tauri (depends on version)
│   ├── matrix: 5 platform targets
│   ├── Apple code signing (macOS)
│   ├── Rust caching (Cargo)
│   └── Upload .dmg/.nsis/.deb/.rpm
│
├── build-electron (depends on version)
│   ├── matrix: 5 platform targets
│   └── Upload artifacts
│
└── publish (depends on all builds)
    ├── Download all artifacts
    ├── Publish npm packages (CLI, SDK, plugin)
    ├── Build + push Docker images (GHCR)
    ├── Update AUR package
    └── Finalize GitHub release (remove draft)
```

### `deploy.yml` — Infrastructure Deployment

```
Triggered: push to dev or production branches

Jobs:
└── deploy
    └── command: bun sst deploy --stage={branch}
    └── Deploys to Cloudflare (Workers, Static Sites, etc.)
```

### Other Workflows

| Workflow                    | Purpose                              |
| --------------------------- | ------------------------------------ |
| `beta.yml`                  | Beta channel releases                |
| `containers.yml`            | Docker container builds (standalone) |
| `sign-cli.yml`              | Code signing for CLI binaries        |
| `publish-vscode.yml`        | VS Code extension publishing         |
| `publish-github-action.yml` | GitHub Action publishing             |
| `sync-zed-extension.yml`    | Zed extension registry sync          |
| `generate.yml`              | Code generation (SDK, schemas)       |
| `review.yml`                | Automated code review                |
| `opencode.yml`              | Runs OpenCode AI on issues/PRs       |
| `triage.yml`                | Issue triage automation              |
| `stale-issues.yml`          | Stale issue management               |
| `close-stale-prs.yml`       | Stale PR management                  |
| `docs-update.yml`           | Documentation updates                |
| `docs-locale-sync.yml`      | README translation sync              |
| `stats.yml`                 | Repository statistics generation     |
| `nix-eval.yml`              | Nix package validation               |
| `nix-hashes.yml`            | Nix hash updates for new releases    |

---

## Version Management

### Versioning Script

The `script/version.ts` script computes the next version:

```
# Bump types:
major  → 1.0.0 → 2.0.0
minor  → 1.0.0 → 1.1.0
patch  → 1.0.0 → 1.0.1
```

It also handles:

- Creating a GitHub release draft with the computed version
- Generating a changelog from commits since the last release
- Setting output variables for downstream CI jobs

### Channels

OpenCode supports multiple release channels:

| Channel    | Branch       | npm Tag    | Purpose             |
| ---------- | ------------ | ---------- | ------------------- |
| `stable`   | `ci` / `dev` | `latest`   | Production releases |
| `beta`     | `beta`       | `beta`     | Pre-release testing |
| `snapshot` | `snapshot-*` | `snapshot` | Development builds  |

The channel is embedded in the binary via `OPENCODE_CHANNEL` and affects:

- Auto-update behavior (beta users get beta updates)
- Telemetry and error reporting
- Feature flag defaults

---

## SDK Build

The TypeScript SDK (`packages/sdk/js`) is generated from the server's OpenAPI specification:

```
1. Server routes (Hono + hono-openapi)
       │
       ▼
2. OpenAPI spec generated (GET /openapi.json)
       │
       ▼
3. @hey-api/openapi-ts generates TypeScript client
       │
       ▼
4. packages/sdk/js/script/build.ts bundles the output
       │
       ▼
5. Published to npm as @opencode-ai/sdk
```

The SDK build is triggered by `./packages/sdk/js/script/build.ts` and produces:

- `client.ts` — The API client with typed methods for every endpoint
- `server.ts` — Server-side types (for middleware)
- `v2/` — Version 2 client/server (for API versioning)

---

## Docker Build

Docker images are built from `packages/opencode/Dockerfile` and pushed to GitHub Container Registry:

```
FROM oven/bun:latest

# Copy the pre-built binary
COPY opencode-cli /usr/local/bin/opencode

# Set up runtime environment
ENV OPENCODE_HEADLESS=1

ENTRYPOINT ["opencode"]
```

The Docker image ships the compiled binary (not source code), keeping the image small and fast to start.

---

## Nix Package

OpenCode provides Nix support via `flake.nix` at the repo root. The Nix package:

- Builds from source using Nix's reproducible build system
- Pins all dependencies via `flake.lock`
- Supports NixOS and nix-darwin
- Hash updates are automated via `nix-hashes.yml` workflow

---

## Release Scripts Directory

The `script/` directory at the repo root contains all release orchestration:

| Script            | Purpose                                    |
| ----------------- | ------------------------------------------ |
| `version.ts`      | Compute next version, create release draft |
| `publish.ts`      | Master publish — npm, Docker, AUR, Zed     |
| `beta.ts`         | Beta channel release management            |
| `changelog.ts`    | Generate changelog from git history        |
| `stats.ts`        | Repository statistics generation           |
| `generate.ts`     | Code generation tasks                      |
| `format.ts`       | Code formatting                            |
| `sync-zed.ts`     | Sync Zed extension to registry             |
| `duplicate-pr.ts` | Detect duplicate pull requests             |
| `release/`        | Release finalization helpers               |

All scripts are written in TypeScript and run with Bun (`#!/usr/bin/env bun`).

---

## The Complete Release Flow

Here's the end-to-end flow for a production release:

```
1. Developer merges PR to dev
         │
         ▼
2. CI triggers publish.yml
         │
         ▼
3. version.ts computes 1.2.20 → 1.2.21
   Creates GitHub release draft
         │
         ▼
4. build-cli job (parallel for all 11 targets)
   ├── Bun.build({ compile: true, target: "linux-x64" })
   ├── Bun.build({ compile: true, target: "darwin-arm64" })
   └── ... (9 more)
   Each uploads artifact to release
         │
         ▼
5. build-tauri job (parallel for 5 platforms)
   ├── Build sidecar CLI for target
   ├── vite build frontend
   ├── cargo build --release (Rust)
   ├── Package (.dmg, .nsis, .deb)
   └── Code sign (macOS)
   Each uploads artifact to release
         │
         ▼
6. build-electron job (parallel for 5 platforms)
   └── Similar to Tauri but with electron-builder
         │
         ▼
7. publish job (after all builds complete)
   ├── Download all artifacts
   ├── Publish @opencode-ai/cli-* to npm
   ├── Publish @opencode-ai/sdk to npm
   ├── Publish @opencode-ai/plugin to npm
   ├── Build + push Docker image to ghcr.io
   ├── Update AUR PKGBUILD
   ├── Sync Zed extension
   └── Finalize GitHub release (undraft)
         │
         ▼
8. deploy.yml triggers
   └── bun sst deploy --stage=production
   └── Deploys web app, API, console to Cloudflare
         │
         ▼
9. Release is live!
   ├── Users: brew upgrade opencode / npm update -g @opencode-ai/cli
   ├── Desktop: auto-update notification
   ├── Docker: docker pull ghcr.io/anomalyco/opencode
   └── Web: app.opencode.ai updated
```

---

## Key Takeaways

1. **Bun compiles to standalone binaries** — `Bun.build({ compile: true })` is the foundation. No runtime needed for end users.

2. **11 platform targets** cover every major OS, architecture, and libc variant — including musl for Alpine Docker images and baseline for older CPUs.

3. **The build embeds everything** — Model catalog, SQL migrations, tree-sitter parsers, and TUI components are all compile-time constants baked into the binary.

4. **npm platform packages** use `optionalDependencies` — Users only download the binary for their platform.

5. **Desktop builds are the most complex** — They combine Bun (sidecar), Vite (frontend), and Cargo (Tauri shell) builds with platform-specific signing.

6. **The publish script is the orchestrator** — `script/publish.ts` coordinates npm publishing, Docker image building, AUR updates, and release finalization.

7. **Multiple release channels** — Stable, beta, and snapshot channels allow safe progressive rollouts.

---

**Next:** [Chapter 16: Cloud Infrastructure →](/16-cloud-infrastructure/)

**Previous:** [Chapter 14: SDK & Plugin System](/14-sdk-and-plugins/)
