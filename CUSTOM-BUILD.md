# Custom Build

Local fork of OpenCode with sub-agent fixes, task timeout, configurable tool timeout, and prefill fix.

Based on [`anomalyco/opencode`](https://github.com/anomalyco/opencode) at commit `7da24ebf5` on the `dev` branch. This build fixes sub-agent hanging, nested TUI navigation, cancel UX, adds an LLM-controllable Task tool timeout, makes the global tool timeout configurable, and fixes assistant prefill for Copilot Claude models.

---

## Changes made

Six change sets are included. Three are custom, the other three come from upstream PRs.

---

### Task tool timeout (custom)

Prevents sub-agents from hanging indefinitely by adding a per-task deadline.

**`packages/opencode/src/tool/task.ts`** -- Added a `timeout` parameter to the Task tool zod schema. The `SessionPrompt.prompt()` call is wrapped with `abortAfterAny(timeout, ctx.abort)` from `@/util/abort`. On timeout, returns a structured error with `task_id` for resumption instead of hanging forever.

Default is 5 minutes (300,000ms). User cancellation still works normally -- the code distinguishes timeout from user-abort. Also handles `MessageAbortedError` so cancelled child agents return a clean error to the parent.

**`packages/opencode/src/tool/task.txt`** -- Added usage note #7 documenting the timeout behavior for the LLM.

**`packages/opencode/src/config/config.ts`** (~line 1169) -- Added `task_timeout` to the `experimental` config schema, following the `mcp_timeout` precedent. Lets users set a default timeout via `opencode.json`.

---

### Configurable global tool timeout (custom)

Makes the hardcoded 15-minute global tool timeout configurable and lets the Task tool extend it for long-running sub-agent sessions.

**`packages/opencode/src/tool/tool.ts`** -- Extracted timeout computation into an exported `timeout()` function. The `Tool.define` wrapper reads `config.experimental.tool_timeout` (with try/catch fallback for unit tests). For `id === "task"`, computes `Math.max(base, effective_task_timeout + 60s_grace)` so the Task tool's own timeout fires first and returns a clean error.

**`packages/opencode/src/project/bootstrap.ts`** -- Watchdog reads config each tick and uses `Math.max(tool_timeout, task_timeout + 60s)` as its cutoff. Falls back to 15min hardcoded default on error.

**`packages/opencode/src/config/config.ts`** (~line 1183) -- Added `tool_timeout` to the `experimental` config schema. Also fixed the pre-existing `task_timeout` description from "5 minutes" to "10 minutes" (matching the actual DEFAULT_TIMEOUT in task.ts).

**`packages/opencode/test/tool/timeout.test.ts`** -- 14 unit tests for the timeout computation.

---

### Prefill fix for Copilot Claude models (custom)

Fixes "This model does not support assistant message prefill" error when Copilot Claude models hit max agent steps.

**`packages/opencode/src/session/prompt.ts`** (lines 675-689) -- Changed the `isLastStep` prefill check from name heuristics (`model.id.includes("claude")`) to checking `model.api.npm` for the three SDKs that actually support prefill: `@ai-sdk/anthropic`, `@ai-sdk/google-vertex/anthropic`, and `@ai-sdk/amazon-bedrock` (for anthropic models only).

---

### Nested permission bubbling (PR #13719)

**`packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`** -- Added a `descendants()` memo that recursively collects all descendant session IDs, not just direct children. The `permissions()` and `questions()` memos now use `descendants()` so prompts from deeply nested sub-agents bubble up to the root session view.

---

### Nested TUI navigation (PR #15993)

**`packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`** -- Added a `subagents()` memo returning a flat ordered list of all Task tool calls across all messages. Rewrote `moveFirstChild()` and `moveChild()` to handle navigation across nested levels correctly.

The Task tool `onClick` handler is now conditional -- it only navigates when the task has a valid session. Dead imports from the Task component were removed.

---

### Cancel UX (PR #13924)

**`packages/opencode/src/cli/cmd/tui/routes/session/header.tsx`** -- Added a clickable Cancel button in the header bar. Uses `usePromptRef` context to access the prompt's interrupt method and shows the button when the session `isRunning`.

**`packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`** -- Fixed interrupt counting logic with proper timer management (`interruptTimeout` tracking). Added `parentSessionID` prop and exposed an `interrupt` getter on `PromptRef` so the header can trigger cancellation.

**`packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`** -- Passes `parentSessionID` prop to the Prompt component.

---

### Build script migration fix (custom)

**`packages/opencode/script/build.ts`** (line 54) -- The upstream build script bundles migration data as `{ sql, timestamp }` objects but drizzle-orm's `bun-sqlite` migrator maps `d.name` from each entry to populate the `name` column in `__drizzle_migrations`. Without it, the INSERT produces `values(?, ?, , ?)` (empty third placeholder) and the binary crashes on first launch. Fixed by adding the `name` field: `{ sql, timestamp, name }`.

---

## Build

### Prerequisites

Bun is required. Tested with v1.3.10.

```bash
npm install -g bun
```

---

### Work around ghostty-web

The monorepo's `packages/app` depends on `ghostty-web` from a private GitHub repo which fails with `SELF_SIGNED_CERT_IN_CHAIN`. Temporarily edit the root `package.json` workspaces to only include what's needed:

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

This replaces the default `"packages/*"` glob.

---

### Install dependencies

From the repo root:

```bash
bun install
```

---

### Compile the binary

First build (installs cross-platform native deps):

```bash
cd packages/opencode
bun run build -- --single
```

Subsequent rebuilds (skip slow native dep install):

```bash
cd packages/opencode
bun run build -- --single --skip-install
```

This produces a native binary at `packages/opencode/dist/opencode-darwin-arm64/bin/opencode`.

---

### Replace the installed binary

```bash
cp packages/opencode/dist/opencode-darwin-arm64/bin/opencode ~/.opencode/bin/opencode
```

---

### Sign the binary (required on macOS arm64)

Bun's compiler produces an unsigned Mach-O binary. macOS will SIGKILL (exit 137) any unsigned arm64 executable on launch. Ad-hoc signing fixes this:

```bash
codesign --force --sign - ~/.opencode/bin/opencode
```

Verify it works:

```bash
opencode --help
```

If you skip this step the binary will be killed immediately with no error message — the shell will just report `killed`.

---

### Restore workspace config

After building, revert the root `package.json` workspaces back to the original glob pattern so other tooling isn't affected.

---

## Use the production database

The dev channel build uses a separate database file (`opencode-dev.db`) by default, which means existing sessions from the official binary are invisible. To share the same database as the official build, set:

```bash
export OPENCODE_DISABLE_CHANNEL_DB=1
```

Add this to your shell profile (`~/.zshrc`, `~/.bashrc`, etc.) to make it permanent. Without this, the custom binary creates an empty `opencode-dev.db` and you will not see previous sessions.

---

## Configure the timeout

Add timeout settings to `opencode.json`:

```json
{
  "experimental": {
    "task_timeout": 600000,
    "tool_timeout": 900000
  }
}
```

- `task_timeout`: Default timeout for Task tool sub-agents in milliseconds (default: 600,000ms = 10 minutes). The LLM can also override this per-task via the `timeout` parameter on the Task tool schema.
- `tool_timeout`: Global timeout for all individual tool executions in milliseconds (default: 900,000ms = 15 minutes). The Task tool automatically gets extra headroom (task timeout + 60s grace) so its own timeout fires first.

The watchdog safety net also respects these values.

---

## Revert

Two options for going back to the official binary.

### Restore from backup

A backup was created during the initial replacement on Mar 6 2026.

```bash
cp ~/.opencode/bin/opencode.backup ~/.opencode/bin/opencode
```

### Reinstall from official source

```bash
rm ~/.opencode/bin/opencode
curl -fsSL https://opencode.ai/install | bash
```

Or grab a specific version from [the releases page](https://github.com/anomalyco/opencode/releases).

---

## Known issues

- PR #15993 changes skip `renderer.hasSelection` functionality because it requires an `@opentui/core` version newer than the 0.1.86 currently in deps.
- The workspace trimming workaround needs to be re-applied if `node_modules` is cleaned.
- The build produces a dev channel binary (version `0.0.0-dev-*`), not a release build. It uses a separate database file (`opencode-dev.db`) from the official binary (`opencode.db`).
- An official OpenCode update will overwrite the custom binary. Rebuild and reinstall after updating.
- The first build is slow (~1 min) because it downloads cross-platform native deps. Use `--skip-install` for subsequent builds.

---

## Related PRs

Upstream references for the cherry-picked changes:

- [PR #13719 -- Nested permission bubbling](https://github.com/sst/opencode/pull/13719)
- [PR #15993 -- Nested TUI navigation](https://github.com/sst/opencode/pull/15993)
- [PR #13924 -- Cancel UX](https://github.com/sst/opencode/pull/13924)
