- To regenerate the JavaScript SDK, run `./packages/sdk/js/script/build.ts`.
- To build a local dev binary and sign it for macOS, see `CUSTOM-BUILD.md` in the repo root. After copying the binary to `~/.opencode/bin/opencode`, you MUST ad-hoc sign it or macOS will SIGKILL it on launch (exit 137, `Killed: 9`): `xattr -d com.apple.provenance ~/.opencode/bin/opencode 2>/dev/null; codesign --force --sign - ~/.opencode/bin/opencode`
- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.
- The default branch in this repo is `dev`.
- Local `main` ref may not exist; use `dev` or `origin/dev` for diffs.
- Prefer automation: execute requested actions without confirmation unless blocked by missing info or safety/irreversibility.

## Style Guide

### General Principles

- Keep things in one function unless composable or reusable
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Prefer single word variable names where possible
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity
- Prefer functional array methods (flatMap, filter, map) over for loops; use type guards on filter to maintain type inference downstream

### Naming

Prefer single word names for variables and functions. Only use multiple words if necessary.

### Naming Enforcement (Read This)

THIS RULE IS MANDATORY FOR AGENT WRITTEN CODE.

- Use single word names by default for new locals, params, and helper functions.
- Multi-word names are allowed only when a single word would be unclear or ambiguous.
- Do not introduce new camelCase compounds when a short single-word alternative is clear.
- Before finishing edits, review touched lines and shorten newly introduced identifiers where possible.
- Good short names to prefer: `pid`, `cfg`, `err`, `opts`, `dir`, `root`, `child`, `state`, `timeout`.
- Examples to avoid unless truly required: `inputPID`, `existingClient`, `connectTimeout`, `workerPath`.

```ts
// Good
const foo = 1
function journal(dir: string) {}

// Bad
const fooBar = 1
function prepareJournal(dir: string) {}
```

Reduce total variable count by inlining when a value is only used once.

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### Control Flow

Avoid `else` statements. Prefer early returns.

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
function foo() {
  if (condition) return 1
  else return 2
}
```

### Schema Definitions (Drizzle)

Use snake_case for field names so column names don't need to be redefined as strings.

```ts
// Good
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})

// Bad
const table = sqliteTable("session", {
  id: text("id").primaryKey(),
  projectID: text("project_id").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

## Testing

- Avoid mocks as much as possible
- Test actual implementation, do not duplicate logic into tests
- Tests cannot run from repo root (guard: `do-not-run-tests-from-root`); run from package dirs like `packages/opencode`.

<!-- BEGIN BEADS INTEGRATION -->

## Issue Tracking with bd (beads)

**IMPORTANT**: This project uses **bd (beads)** for ALL issue tracking. Do NOT use markdown TODOs, task lists, or other tracking methods.

### Why bd?

- Dependency-aware: blocking deps, parent-child hierarchy, provenance links
- Git-friendly: Dolt-powered version control with native sync
- Agent-optimized: JSON output, ready work detection, swarm coordination
- Prevents duplicate tracking systems and confusion

### Issue Types

- `bug` - Something broken
- `feature` - New functionality
- `task` - Work item (tests, docs, refactoring)
- `epic` - A goal/theme decomposed into child issues (NOT a single task)
- `chore` - Maintenance (dependencies, tooling)

### Issue Statuses

- `open` - Not started
- `in_progress` - Actively being worked on
- `blocked` - Waiting on a dependency
- `deferred` - Postponed
- `closed` - Done

### Priorities

- `0` - Critical (security, data loss, broken builds)
- `1` - High (major features, important bugs)
- `2` - Medium (default, nice-to-have)
- `3` - Low (polish, optimization)
- `4` - Backlog (future ideas)

### Creating Issues

```bash
# Simple issue
bd create "Fix the bug" --description="Details" -t bug -p 1 --json

# Issue with labels
bd create "Add feature" -d "Details" -t feature -p 2 -l "permissions,subagent" --json

# Issue discovered while working on another issue (provenance link)
bd create "Found a related bug" -d "Details" -p 1 --deps discovered-from:<source-id> --json
```

### Epics and Child Issues

An epic is a large body of work decomposed into child issues. Children are linked via the `parent-child` dependency type.

```bash
# Create an epic
bd create "Auth system overhaul" -t epic -p 1 --json

# Create children under the epic (auto-numbered: epic-id.1, epic-id.2, ...)
bd create "Design login UI" -t task -p 1 --parent <epic-id> --json
bd create "Backend validation" -t bug -p 0 --parent <epic-id> --json
bd create "Integration tests" -t task -p 2 --parent <epic-id> --json

# Add existing issue as child of epic retroactively
bd dep add <issue-id> <epic-id> --type parent-child

# List children of an epic
bd children <epic-id> --json

# Check epic completion (all epics)
bd epic status --json

# Auto-close epics where all children are done
bd epic close-eligible
```

**Key rules for epics:**

- Children are parallel by default; add `blocks` deps between them for ordering
- `bd ready` respects parent-child blocking: children of a blocked epic don't surface
- `discovered-from` is NOT epic membership; use `--parent` or `parent-child` dep

### Dependencies

bd has 10 dependency types. Use the right one for the relationship.

**Blocking types** (affect `bd ready` — blocked issues won't appear as ready):

| Type           | Meaning                                 | Example                            |
| -------------- | --------------------------------------- | ---------------------------------- |
| `blocks`       | B cannot start until A closes           | `bd dep add B A` (default)         |
| `parent-child` | Children blocked when parent is blocked | `bd create ... --parent <epic-id>` |
| `until`        | B waits for a time/condition on A       | Deferred work                      |

**Non-blocking types** (graph annotations, do NOT affect `bd ready`):

| Type              | Meaning                            |
| ----------------- | ---------------------------------- |
| `discovered-from` | Found during work on another issue |
| `caused-by`       | Root cause link                    |
| `related`         | Informational link                 |
| `tracks`          | Tracks progress of another issue   |
| `validates`       | Test/verification link             |
| `supersedes`      | Replaces another issue             |
| `relates-to`      | Bidirectional relation             |

```bash
# Add a blocking dependency (A blocks B)
bd dep add <blocked-id> <blocker-id>
bd dep add <blocked-id> <blocker-id> --type blocks  # same thing, explicit

# Add a non-blocking link
bd dep add <issue-id> <source-id> --type discovered-from
bd dep add <issue-id> <cause-id> --type caused-by

# List dependencies of an issue
bd dep list <issue-id> --json
bd dep list <issue-id> --direction=up --json  # what depends on this issue

# View dependency tree
bd dep tree <issue-id>
bd dep tree <epic-id> --direction=up  # show what the epic blocks

# Detect cycles
bd dep cycles
```

### Swarm (Parallel Work on Epics)

`bd swarm` coordinates parallel agent work on an epic's child DAG.

```bash
# Validate epic structure before swarming
bd swarm validate <epic-id> --json

# Create a swarm from an epic
bd swarm create <epic-id> --json

# Check swarm status (completed/active/ready/blocked children)
bd swarm status <epic-id> --json

# List all swarms
bd swarm list --json
```

### Reading Issues

```bash
# Show issue details
bd show <issue-id> --json

# List all open issues
bd list --json

# Check for ready (unblocked) work
bd ready --json

# Search issues by text
bd search "permission" --json
```

### Updating and Closing

```bash
# Claim an issue (assigns to you)
bd update <id> --claim --json

# Update priority
bd update <id> --priority 1 --json

# Close an issue
bd close <id> --reason "Completed" --json

# Reopen
bd reopen <id> --json
```

### Workflow for AI Agents

1. **Check ready work**: `bd ready --json` shows unblocked issues
2. **Claim your task**: `bd update <id> --claim --json`
3. **Work on it**: Implement, test, document
4. **Discover new work?** Create linked child or provenance issue:
   - Child of current epic: `bd create "Sub-task" -d "..." -p 1 --parent <epic-id> --json`
   - Found during work: `bd create "Found bug" -d "..." -p 1 --deps discovered-from:<source-id> --json`
5. **Add blocking deps** if one issue must finish before another: `bd dep add <blocked> <blocker>`
6. **Complete**: `bd close <id> --reason "Done" --json`
7. **Check epic status**: `bd epic status --json`

### Auto-Sync

bd automatically syncs via Dolt:

- Each write auto-commits to Dolt history
- Use `bd dolt push`/`bd dolt pull` for remote sync
- Use `bd sync` to sync both directions

### Important Rules

- Use bd for ALL task tracking
- Always use `--json` flag for programmatic/agent use
- Use `--parent` to group issues under epics (creates `parent-child` dep)
- Use `discovered-from` only for provenance, NOT for epic membership
- Use `blocks` deps to order work within an epic
- Check `bd ready --json` before asking "what should I work on?"
- Do NOT create markdown TODO lists for project tracking
- Do NOT use external issue trackers
- Do NOT duplicate tracking systems

<!-- END BEADS INTEGRATION -->

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd sync
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**

- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds

<!-- END BEADS INTEGRATION -->
