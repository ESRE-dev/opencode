---
description: Build, sign, and install the custom opencode binary from source
---

Build a local dev binary of opencode from source code in this repo, sign it for macOS, and install it.

## Prerequisites

- Bun must be installed (tested with v1.3.10+)
- macOS arm64 (Apple Silicon)

## Steps

### 1. Workspace trimming

The monorepo's `packages/app` depends on `ghostty-web` from a private GitHub repo which fails with `SELF_SIGNED_CERT_IN_CHAIN`. Before building, check if the root `package.json` workspaces are already trimmed. If not, temporarily edit to only include what's needed:

```json
"workspaces": {
    "packages": [
      "packages/opencode",
      "packages/plugin",
      "packages/script",
      "packages/sdk/js",
      "packages/util"
    ]
}
```

### 2. Install dependencies

From the repo root:

```bash
bun install
```

### 3. Compile the binary

From `packages/opencode`:

First build (installs cross-platform native deps):

```bash
bun run build -- --single
```

Subsequent rebuilds (skip slow native dep install):

```bash
bun run build -- --single --skip-install
```

Output: `packages/opencode/dist/opencode-darwin-arm64/bin/opencode`

### 4. Install the binary

```bash
cp packages/opencode/dist/opencode-darwin-arm64/bin/opencode ~/.opencode/bin/opencode
```

### 5. Sign the binary (REQUIRED on macOS arm64)

Bun's compiler produces an unsigned Mach-O binary. macOS will SIGKILL (exit 137) any unsigned arm64 executable on launch — the shell just reports `Killed: 9` with no other error. This step is NOT optional.

```bash
xattr -d com.apple.provenance ~/.opencode/bin/opencode 2>/dev/null; codesign --force --sign - ~/.opencode/bin/opencode
```

### 6. Verify

```bash
opencode --help
```

If this prints the help text, the build succeeded. If it prints `Killed: 9` or exits 137, the signing step was missed — go back to step 5.

### 7. Restore workspace config

Revert the root `package.json` workspaces back to the original glob if it was trimmed in step 1.

## Troubleshooting

- `Killed: 9` / exit 137 → Binary is unsigned. Run step 5.
- `SELF_SIGNED_CERT_IN_CHAIN` during `bun install` → Workspace not trimmed. Run step 1.
- Empty sessions after build → Dev channel uses a separate DB (`opencode-dev.db`). Set `export OPENCODE_DISABLE_CHANNEL_DB=1` in your shell profile.

## Key facts

- The build script at `packages/opencode/script/build.ts` line 54 includes a custom fix: migration entries need a `name` field or the binary crashes on first launch with an empty SQL placeholder.
- The `--skip-install` flag saves ~1 min on rebuilds by skipping cross-platform native dep download.
- Ad-hoc signing (`codesign --force --sign -`) is sufficient; no Apple Developer certificate needed.
