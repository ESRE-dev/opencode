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
files.

### `origin/pr/*` and `origin/feature/*` — upstream PR sources

Source branches for open upstream PRs (e.g. `origin/pr/session-watchdog`
→ PR #20104). **Do not delete while PRs are open.**

## The Sync Cycle

Run `scripts/sync.sh` or execute manually:

1.  **Fetch upstream**

    git fetch upstream

2.  **Reset dev**

    git switch dev && git reset --hard upstream/dev

3.  **Rebase each topic branch**

        git switch local/<name> && git rebase dev

    Fix conflicts per-topic. Each branch should apply cleanly against the
    latest upstream.

4.  **Rebuild local-dev**

        git switch -C local-dev dev
        git merge --no-ff local/<name> -m "integrate: local/<name>"

    Repeat the merge for every `local/*` branch.

5.  **Push (optional)**

        git push origin dev --force-with-lease

    Syncs the fork's `dev` ref with upstream.

## Current local/\* Branches

_As of 2026-04-05._

| Branch                            | Commits | Purpose                                                                      |
| --------------------------------- | ------- | ---------------------------------------------------------------------------- |
| `local/build-command`             | 1       | /build slash command for binary compile and sign                             |
| `local/cancel-propagation`        | 1       | Cancel/teardown correctness, abort-safe processing                           |
| `local/compaction-agent-identity` | 3       | Preserve agent identity across compaction + prevent tool-call hallucinations |
| `local/compaction-todo`           | 1       | Inject TODO state into compaction summarizer prompt                          |
| `local/docs`                      | 1       | 17-chapter tech stack guide, Starlight site, research notes                  |
| `local/misc`                      | 1       | gitignore, TodoReadTool, OPENCODE_SESSION_ID env var                         |
| `local/provider-fallback`         | 2       | Automatic model fallback on transient errors + Copilot/cross-provider fixes  |
| `local/session-watchdog`          | 2       | Watchdog for stuck tools/sessions + idle detection + cancel targeting        |
| `local/subagent-hardening`        | 1       | Subagent error handling, permissions, question denial, webfetch fixes        |
| `local/tool-timeout`              | 1       | Configurable timeout protection for all tool executions                      |
| `local/tui-navigation`            | 1       | Multi-level keyboard nav through agent tree, interrupt UX                    |

## Recipes

### Creating a new topic branch

```
git switch -C local/<name> dev
# make changes, commit
# then rebuild local-dev (see sync cycle step 4)
```

### Dropping a topic

Delete the `local/*` branch, then rebuild `local-dev` without it.

### Porting features from dev-safe

The codebase has diverged enough that cherry-pick won't work. Instead:

```
git show origin/dev-safe:<path>
```

Inspect the file, then manually port the semantic changes to the current
code.

### Upstream PRs

Branches on origin that serve as PR heads (e.g.
`origin/pr/session-watchdog` → PR #20104). Keep these until upstream
merges or closes the PRs.

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
