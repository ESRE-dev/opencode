# ESRE-dev/opencode Fork

## Overview

This is **ESRE-dev's fork** of [anomalyco/opencode](https://github.com/anomalyco/opencode).
We carry local improvements that upstream is slow to adopt. All local work
lives in isolated topic branches that are independently rebased onto the
upstream default branch, then merged into an ephemeral integration branch
for deployment.

## Remotes

| Name       | URL                                     | Role     |
| ---------- | --------------------------------------- | -------- |
| `origin`   | `git@github.com:ESRE-dev/opencode.git`  | Our fork |
| `upstream` | `git@github.com:anomalyco/opencode.git` | Upstream |

## Branch Topology

### `dev` — upstream mirror

Pure mirror of `upstream/dev`. **NEVER commit to this directly.**
After each fetch it is reset to `upstream/dev`:

```
git switch dev && git reset --hard upstream/dev
```

### `local/*` — topic branches

Each `local/*` branch carries one concern and is independently rebased
onto `dev`. One concern per branch — no cross-cutting changes.

### `local-dev` — ephemeral integration branch

Rebuilt from scratch every sync cycle. Start at `dev`, then merge each
`local/*` with `--no-ff`. This is the deployable ref. Never commit to it
directly — always rebuild.

### `meta` — fork tooling (this branch)

Orphan branch. Fork-specific documentation and scripts. **Never merges
into code branches.**

### `origin/dev-safe` — archive

Archive of previous integration work. Mine for features not yet extracted
to `local/*` branches. Use `git show origin/dev-safe:<path>` to inspect
files. **Superseded by the `local/*` approach — kept only as a safety
archive. Not part of the sync cycle.**

### `origin/pr/*` — upstream PR candidates

Source branches for open upstream PRs (e.g. `origin/pr/session-watchdog`
→ PR #20104). **Do not delete while PRs are open.** These are simpler,
upstreamable versions of features that may also exist in richer form as
`local/*` branches. `rebase-branches.sh` auto-discovers and rebases any
local `pr/*` branches alongside the manifest.

> **Note:** `local/session-watchdog` is a PR-only branch
> (`origin/pr/session-watchdog`). It is **not** in `.local-branches`
> and is **not** merged into `local-dev`. The richer
> `local/intelligent-session-watchdog` supersedes it for local use.

## The Sync Cycle

Two scripts automate the cycle. Both live on the `meta` branch and are
accessible from the maintenance worktree (`../opencode-maintain/`).

### Prerequisites

```bash
# Enable rerere for automatic conflict memory
git config rerere.enabled true
git config rerere.autoupdate true

# Create maintenance worktree (one-time setup)
git worktree add ../opencode-maintain meta
```

### Step 1: Rebase branches

```bash
../opencode-maintain/scripts/rebase-branches.sh
```

This script:

- Fetches `upstream`
- Reads `.local-branches` manifest + auto-discovers local `pr/*` branches
- Creates local tracking branches from `origin/*` when needed
- Skips branches already on `upstream/dev` or checked out in worktrees
- Uses a temp worktree — **never touches your active checkouts**
- Leverages `git rerere` to auto-resolve previously seen conflicts
- On unresolvable conflict: stops with exact recovery instructions

Use `--dry-run` to preview without changes.

### Step 2: Rebuild local-dev

```bash
../opencode-maintain/scripts/rebuild-local-dev.sh
```

This script:

- Verifies all manifest branches exist and are rebased onto `upstream/dev`
- Hard-resets `local-dev` to `upstream/dev`
- Merges each `.local-branches` entry with `--no-ff` in listed order
- Uses a temp worktree — **never touches your active checkouts**
- On merge conflict: aborts, resets `local-dev`, exits with diagnosis

Use `--dry-run` to preview the merge order.

### Step 3: Push (optional)

```bash
git push origin local-dev --force-with-lease
git push origin dev --force-with-lease
```

### Legacy

`scripts/sync.sh` is the original monolithic script. It is **deprecated**
— it switches branches on your active worktree and lacks conflict
recovery. Kept for reference only.

## Current local/\* Branches

_As of 2026-04-17._

Branches are listed in merge order (same as `.local-branches` manifest).

| Branch                               | Commits | In local-dev | Purpose                                                                      |
| ------------------------------------ | ------- | ------------ | ---------------------------------------------------------------------------- |
| `local/compaction-agent-identity`    | 3       | ✅           | Preserve agent identity across compaction + prevent tool-call hallucinations |
| `local/subagent-hardening`           | 1       | ✅           | Subagent error handling, permissions, question denial, webfetch fixes        |
| `local/compaction-todo`              | 1       | ✅           | Inject TODO state into compaction summarizer prompt                          |
| `local/cancel-propagation`           | 1       | ✅           | Cancel/teardown correctness, abort-safe processing                           |
| `local/build-command`                | 1       | ✅           | /build slash command for binary compile and sign                             |
| `local/tool-timeout`                 | 1       | ✅           | Configurable timeout protection for all tool executions                      |
| `local/provider-fallback`            | 2       | ✅           | Automatic model fallback on transient errors + Copilot/cross-provider fixes  |
| `local/tui-navigation`               | 1       | ✅           | Multi-level keyboard nav through agent tree, interrupt UX                    |
| `local/intelligent-session-watchdog` | 6       | ✅           | Full watchdog package: stuck tools, idle detection, cancel targeting         |
| `local/skill-preamble`               | 3       | ✅           | Skill preamble frontmatter and auto-load with Effect service pattern         |
| `local/docs`                         | 1       | ✅           | 17-chapter tech stack guide, Starlight site, research notes                  |
| `local/misc`                         | 1       | ✅           | gitignore, TodoReadTool, OPENCODE_SESSION_ID env var                         |

### PR-only branches (not in local-dev)

| Branch                      | Purpose                                     | Status       |
| --------------------------- | ------------------------------------------- | ------------ |
| `pr/session-watchdog`       | Simple watchdog (superseded by intelligent) | PR candidate |
| `pr/cancel-propagation`     | Upstreamable cancel fixes                   | PR candidate |
| `pr/provider-fallback`      | Upstreamable provider fallback              | PR candidate |
| `pr/tool-timeout`           | Upstreamable tool timeout                   | PR candidate |
| `pr/tui-cancel-ux`          | TUI cancel UX improvements                  | PR candidate |
| `pr/tool-hardening`         | Tool execution hardening                    | PR candidate |
| `pr/abort-safe-stream`      | Abort-safe stream processing                | PR candidate |
| `pr/agent-compaction`       | Agent compaction improvements               | PR candidate |
| `pr/cancel-correctness`     | Cancel correctness fixes                    | PR candidate |
| `pr/permission-specificity` | Permission specificity improvements         | PR candidate |
| `pr/retry-backoff`          | Retry backoff logic                         | PR candidate |
| `pr/symlink-sandboxing`     | Symlink sandboxing                          | PR candidate |

## Recipes

### Creating a new topic branch

```
git switch -C local/<name> dev
# make changes, commit
# add to .local-branches manifest on meta
# rebuild local-dev
```

### Dropping a topic

Remove from `.local-branches`, delete the branch, rebuild `local-dev`.

### Porting features from dev-safe

The codebase has diverged enough that cherry-pick won't work. Instead:

```
git show origin/dev-safe:<path>
```

Inspect the file, then manually port the semantic changes to the current
code.

## Commit Message Format

Use `<scope>: <short description>` with a why-focused body.

- 4-space indented bullets
- Section labels: ADD, FIX, UPDATE, REMOVE, etc.

Example:

```
watchdog: detect stuck tool executions

    ADD: periodic liveness check for running tool calls
    FIX: session cleanup on idle timeout
```
