# Skill auto-load v2 — smarter triggers + progressive disclosure

Status: locked design, 2026-06-10 (cycle opencode-k4t follow-on)
Builds on: skill-preamble v1 (alwaysApply/globs/classify + 3-trigger lifecycle in session/prompt.ts)

## Motivation

v1 injects the FULL SKILL.md content for every auto skill, unconditioned, every
session — and again after every compaction. Token cost scales linearly with the
skill library; the trigger vocabulary is binary (always-on or file glob); the
model's judgment is bypassed entirely on the auto path. v2 keeps the v1
machinery and adds three orthogonal improvements, all backward compatible.

## 1. Progressive disclosure (`inject` frontmatter)

New optional frontmatter field on SKILL.md:

```yaml
inject: full | preamble
```

Default: **`full` when `alwaysApply: true`** (preserves v1 behavior for
existing always-on skills), **`preamble` otherwise**.

- `full` — v1 behavior: synthetic completed `skill` tool-part containing the
  whole `<skill_content>` payload.
- `preamble` — a stub payload only:

  ```
  <skill_preamble name="NAME">
  NAME: DESCRIPTION
  This is an availability notice only — the skill tool has NOT been
  called for "NAME" and its full instructions are NOT in context.
  Call the skill tool with name "NAME" to load them when relevant;
  that call will return the full content (it has not happened yet).
  </skill_preamble>
  ```

  No skill body, no file listing. The model upgrades on demand via the
  EXISTING skill tool.

  Anti-illusion rule (added after live testing): because the stub is
  delivered as a synthetic *completed `skill` tool-call*, a model can
  conclude it already called the tool and "got only a preamble back",
  and will then refuse to call it again (observed live: Haiku fell back
  to `read` on the SKILL.md). Therefore (a) the stub text must state
  explicitly that the tool has NOT been called, and (b) the synthetic
  part's `input` is `{ name, preamble: true }` — deliberately
  distinguishable from a real call's `{ name }`.

### Loaded-level tracking

`SkillState.loaded` changes from `Set<string>` to `Map<string, "preamble" | "full">`.

- `inject()` skips a skill whose recorded level is `"full"` or equal to the
  requested level; a `preamble → full` upgrade is allowed.
- The skill tool's idempotency guard (tool/skill.ts) short-circuits ONLY when
  the level is `"full"`. A model call for a preamble-loaded skill proceeds,
  returns full content, and records `"full"`.
- `ctx.extra.loadedSkills` (session/tools.ts) carries the Map; both producers
  and the consumer adjust.

## 2. Trigger phrases + marker files (frontmatter)

```yaml
triggers: ["rebase", "AccessDenied"]   # conversation signals
markers: ["pyproject.toml", "uv.lock"] # project shape
```

- `triggers` — case-insensitive substring match against (a) the current user
  prompt text at step 1, (b) tool output text mid-turn (see §3).
- `markers` — existence check against the instance file listing: a marker
  matches if any listed path equals it OR has it as basename. Cheaper and more
  precise than v1's whole-worktree glob scan for the "project type" use case.

### classify v2

```ts
classify(skill, signals: { files: string[]; text?: string }): "auto" | "on-demand"
```

auto if: `alwaysApply` || any glob matches `files` (v1) || any marker present
in `files` || any trigger is a case-insensitive substring of `text`.
Step-1 passes the joined text parts of the last user message as `text`;
post-compaction re-injection passes the same; the file-touch path is unchanged
(globs vs a single path).

## 3. Tool-output triggers (`onToolOutput`)

Generalizes v1's `onFileTool`: after ANY tool completes, scan its output text
(first 16 KB) for unloaded skills' trigger phrases; matches inject at the
skill's payload level, parented to the in-flight assistant message (same
placement as v1 glob injection). The `skill` tool itself is excluded to avoid
feedback loops. This enables error-reactive loading (bash fails with
"AccessDenied" → aws-iam-debug preamble appears).

Plumbing: a new optional `onToolOutput(tool: string, output: string)` callback
on `SessionTools.resolve` input, invoked in the execute wrapper after a
successful tool result, alongside the existing pre-execution `onFileTool`.

## Non-goals (deliberately out)

- Semantic/embedding matching and LLM-router selection (cost/nondeterminism;
  revisit if the trigger vocabulary proves insufficient).
- Eviction/relevance decay; compaction-aware partial re-injection (v1's
  clear-and-reload stays; preamble-level skills make it cheap).
- Cache-anchor batching of mid-turn injections (accepted v1 behavior).

## Compatibility

All three fields optional; absent fields reproduce v1 semantics exactly
(alwaysApply → full injection at step 1; globs → file-list/file-touch).
Existing SKILL.md files need no changes.
