# Chapter 17: Testing Patterns

> Bun's native test runner, the isolation preload, Playwright E2E, and the no-mocks philosophy.

---

## Overview

OpenCode's testing philosophy is simple: **test the real thing**. No mocks, no stubs, no duplicating logic into test files. Tests run actual code against actual databases in isolated temporary directories, and the results reflect what will happen in production.

The testing stack is built on:

| Tool       | Version | Purpose                                        |
| ---------- | ------- | ---------------------------------------------- |
| `bun:test` | 1.3.10  | Built-in test runner (unit + integration)      |
| Playwright | 1.57.0  | Browser-based end-to-end tests                 |
| Happy DOM  | —       | Lightweight DOM simulation for component tests |

There are **~85 test files** in `packages/opencode/test/` alone, covering every major module from tool execution to provider transforms to session compaction.

---

## The No-Mocks Philosophy

This is the most important testing principle in OpenCode:

> **Avoid mocks as much as possible. Test actual implementation, do not duplicate logic into tests.**

Why? Because mocks test your assumptions about the code, not the code itself. If you mock the database, you're testing that your mock behaves like SQLite — not that your queries work. If you mock the file system, you're testing that your mock returns the right strings — not that your file operations are correct.

OpenCode achieves this through:

1. **Real SQLite databases** — Each test gets its own database file in a temp directory
2. **Real file operations** — Tests create actual files in temp directories and operate on them
3. **Real tool execution** — The `bash` tool actually runs commands; the `read` tool actually reads files
4. **Real event bus** — Events are published and subscribed to through the actual bus implementation
5. **Isolated instances** — The `Instance.provide()` pattern gives each test its own scoped context

The only things NOT tested against real implementations are external LLM providers (for cost and determinism reasons) — but even there, the tests exercise the actual provider module code, just with recorded or controlled responses.

---

## Test Runner: `bun:test`

OpenCode uses Bun's built-in test runner, which provides `describe`, `test`, `expect`, `beforeAll`, `afterAll`, and other familiar testing primitives:

```typescript
import { describe, test, expect, beforeAll } from "bun:test"

describe("session", () => {
  test("creates a session with the correct agent", async () => {
    await Instance.provide({ directory: tmpdir() }, async () => {
      const session = await Session.create({ agent: "build" })
      expect(session.agent_id).toBe("build")
      expect(session.id).toBeTruthy()
    })
  })
})
```

### Running Tests

Tests **cannot** be run from the repo root (there's a guard: `do-not-run-tests-from-root`). You must run them from the package directory:

```bash
# Correct — run from the package directory
cd packages/opencode
bun test

# Also correct — run a specific test file
cd packages/opencode
bun test test/tool/bash.test.ts

# WRONG — this will fail with an error
cd opencode  # repo root
bun test     # "do not run tests from root"
```

This guard prevents accidentally running tests from the wrong working directory, which would cause path resolution issues and potential interference with the real user environment.

### Test Configuration

The `bunfig.toml` in `packages/opencode` configures the test preload:

```toml
[test]
preload = ["./test/preload.ts"]
```

This ensures the preload script runs before every test file, setting up the isolated environment.

---

## The Test Preload (`test/preload.ts`)

The preload script is the foundation of OpenCode's test isolation. It runs before every test file and creates a completely isolated environment:

### What It Does

```
test/preload.ts
       │
       ├── 1. Create a temp directory
       │      └── /tmp/opencode-test-XXXXX/
       │
       ├── 2. Set XDG environment variables
       │      ├── XDG_DATA_HOME   → temp/data
       │      ├── XDG_CACHE_HOME  → temp/cache
       │      ├── XDG_CONFIG_HOME → temp/config
       │      └── HOME            → temp/home
       │
       ├── 3. Clear ALL provider API key env vars
       │      ├── ANTHROPIC_API_KEY = ""
       │      ├── OPENAI_API_KEY   = ""
       │      ├── GOOGLE_API_KEY   = ""
       │      └── ... (every known provider key)
       │
       ├── 4. Write cache version file
       │      └── Prevents cache-clearing logic from running
       │
       ├── 5. Initialize logger (debug mode, no printing)
       │      └── Logs are captured but not printed to stdout
       │
       └── 6. Register teardown
              ├── Close SQLite database connections
              ├── Force garbage collection
              └── Remove temp directory (with retry for EBUSY)
```

### Why Clear API Keys?

The preload clears all provider API key environment variables. This prevents tests from accidentally calling real LLM APIs (which would cost money and be non-deterministic). If a test needs to use a real provider, it must explicitly configure one — this is a safety net, not a limitation.

### Teardown and EBUSY

The teardown includes retry logic for removing the temp directory:

```
Close SQLite database
       │
       ▼
Force GC (Bun.gc(true))
       │
       ▼
Attempt to remove temp directory
       │
       ├── Success → done
       │
       └── EBUSY error (file still locked)
              │
              ▼
           Wait 100ms
              │
              ▼
           Retry removal (up to 3 times)
```

The `EBUSY` handling is necessary because SQLite's WAL mode can hold file locks briefly after the database is closed. This is especially common on Windows where file locking is stricter.

---

## Test Patterns

### Instance.provide() for Isolation

Every test that touches the database, file system, or event bus wraps its logic in `Instance.provide()`:

```typescript
test("creates and reads a session", async () => {
  await Instance.provide({ directory: tmpdir() }, async () => {
    // This code has its own:
    // - SQLite database
    // - Event bus
    // - Project context
    // - File system scope

    const session = await Session.create({ agent: "build" })
    const loaded = await Session.get(session.id)
    expect(loaded.id).toBe(session.id)
  })
})
```

Each `Instance.provide()` call creates a completely isolated context. Two tests running in parallel won't interfere with each other because they have separate databases and bus instances.

### tmpdir() for File System Tests

The `tmpdir()` helper creates a temporary directory, optionally initialized as a git repository:

```typescript
import { tmpdir } from "../helpers"

test("reads a file", async () => {
  const dir = tmpdir({ git: true })
  // dir is a fresh directory with `git init` already run

  // Create a test file
  await Bun.write(`${dir}/hello.txt`, "world")

  await Instance.provide({ directory: dir }, async () => {
    const result = await tools.read.execute({ path: `${dir}/hello.txt` })
    expect(result.content).toBe("world")
  })
})
```

The `{ git: true }` option is important — many tools and features depend on being in a git repository (for diff tracking, snapshot, worktree, etc.).

### Testing Tool Execution

Tool tests exercise the actual tool implementation:

```typescript
describe("bash tool", () => {
  test("executes a command and returns output", async () => {
    await Instance.provide({ directory: tmpdir() }, async () => {
      const result = await tools.bash.execute({
        command: "echo 'hello world'",
      })
      expect(result.stdout).toContain("hello world")
      expect(result.exitCode).toBe(0)
    })
  })

  test("returns non-zero exit code on failure", async () => {
    await Instance.provide({ directory: tmpdir() }, async () => {
      const result = await tools.bash.execute({
        command: "exit 1",
      })
      expect(result.exitCode).toBe(1)
    })
  })
})
```

These tests actually run shell commands — no mocking the PTY or faking output.

### Testing File Operations

```typescript
describe("edit tool", () => {
  test("applies a search/replace edit", async () => {
    const dir = tmpdir()
    const path = `${dir}/test.ts`
    await Bun.write(path, 'const x = "old"')

    await Instance.provide({ directory: dir }, async () => {
      const result = await tools.edit.execute({
        path,
        old: '"old"',
        new: '"new"',
      })
      expect(result.success).toBe(true)

      // Verify the actual file was changed
      const content = await Bun.file(path).text()
      expect(content).toBe('const x = "new"')
    })
  })
})
```

### Testing Permissions

```typescript
describe("permissions", () => {
  test("blocks denied tool calls", async () => {
    await Instance.provide({ directory: tmpdir() }, async () => {
      // Configure a deny rule
      await Permission.create({
        tool: "write",
        glob: ["*.lock"],
        action: "deny",
      })

      // Attempt to write to a lock file
      const result = await tools.write.execute({
        path: "package.lock",
        content: "malicious",
      })
      expect(result.denied).toBe(true)
    })
  })
})
```

### Testing Database Operations

```typescript
describe("storage", () => {
  test("runs migrations and creates tables", async () => {
    await Instance.provide({ directory: tmpdir() }, async () => {
      const db = Storage.use()

      // Insert and query — testing real SQLite
      db.insert(session)
        .values({
          id: ulid(),
          project_id: "test",
          agent_id: "build",
          created_at: Date.now(),
          updated_at: Date.now(),
        })
        .run()

      const result = db.select().from(session).all()
      expect(result).toHaveLength(1)
      expect(result[0].agent_id).toBe("build")
    })
  })
})
```

### Testing Provider Transforms

Provider tests verify that request/response transforms work correctly without calling real APIs:

```typescript
describe("anthropic transform", () => {
  test("adds cache control to system prompt", () => {
    const input = { system: "You are a helpful assistant" }
    const output = anthropicTransform(input)
    expect(output.system).toHaveProperty("cache_control")
  })

  test("normalizes tool call format", () => {
    const raw = {
      /* raw anthropic tool call format */
    }
    const normalized = normalizeToolCall(raw)
    expect(normalized).toMatchObject({
      name: "read",
      args: { path: "test.ts" },
    })
  })
})
```

### Testing Session Compaction

```typescript
describe("compaction", () => {
  test("compresses long conversations", async () => {
    await Instance.provide({ directory: tmpdir() }, async () => {
      const session = await Session.create({ agent: "build" })

      // Create many messages to exceed context window
      for (let i = 0; i < 50; i++) {
        await Session.addMessage(session.id, {
          role: "user",
          content: `Message ${i} with lots of context...`,
        })
      }

      const before = await Session.messages(session.id)
      expect(before.length).toBe(50)

      // Trigger compaction
      await Session.compact(session.id)

      const after = await Session.messages(session.id)
      expect(after.length).toBeLessThan(before.length)
      // The compacted messages include a summary
    })
  })
})
```

---

## Test Coverage by Module

The test suite covers every major module:

| Module        | Test Files | What's Tested                                            |
| ------------- | ---------- | -------------------------------------------------------- |
| `tool/`       | ~15        | bash, grep, edit, read, write, apply_patch, webfetch, ls |
| `session/`    | ~10        | Compaction, retry, revert, structured output, messages   |
| `provider/`   | ~8         | Transforms, copilot, gitlab, bedrock, model resolution   |
| `config/`     | ~3         | Config loading, merging, validation                      |
| `permission/` | ~3         | Allow/ask/deny evaluation, glob matching                 |
| `mcp/`        | ~4         | Tool conversion, client lifecycle, OAuth                 |
| `acp/`        | ~3         | Agent protocol, session management                       |
| `storage/`    | ~3         | DB init, migrations, queries                             |
| `snapshot/`   | ~2         | File state capture, diff tracking                        |
| `server/`     | ~5         | Route handlers, SSE endpoint, auth                       |
| `cli/`        | ~3         | Command parsing, TUI initialization                      |
| `scheduler/`  | ~2         | Task scheduling, concurrency                             |
| `skill/`      | ~2         | Skill discovery, execution                               |
| `plugin/`     | ~3         | Plugin loading, copilot, codex                           |
| `bus/`        | ~2         | Event publishing, subscription, global bus               |
| `lsp/`        | ~2         | Diagnostics, symbol lookup                               |
| `util/`       | ~5         | Encoding, paths, patterns, formatting                    |

---

## E2E Tests (Playwright)

End-to-end tests live in `packages/app/e2e/` and test the web application in a real browser:

### Setup

```typescript
// playwright.config.ts
import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./e2e",
  webServer: {
    command: "bun dev",
    port: 5173,
    reuseExistingServer: true,
  },
  use: {
    baseURL: "http://localhost:5173",
  },
  timeout: 30000,
})
```

### Running E2E Tests

```bash
cd packages/app

# Seed test data first
bun run seed-e2e.ts

# Run tests
bun run test:e2e:local
```

The `seed-e2e.ts` script prepares the test environment:

1. Creates test sessions with known data
2. Populates messages and tool call results
3. Sets up configuration for deterministic behavior

### What E2E Tests Cover

| Test Area         | What's Verified                                              |
| ----------------- | ------------------------------------------------------------ |
| Session creation  | Create a new session, verify it appears in the list          |
| Message sending   | Send a message, verify it renders correctly                  |
| Tool call display | Verify tool calls are rendered with correct args and results |
| Navigation        | Switch between sessions, verify state preservation           |
| Streaming         | Verify text streams incrementally (not all at once)          |
| Responsive layout | Verify the app adapts to different viewport sizes            |

### CI Configuration

E2E tests run in CI on both Linux and Windows:

```yaml
# From .github/workflows/test.yml
e2e:
  needs: [unit]
  strategy:
    matrix:
      os: [ubuntu-latest, windows-latest]
  timeout-minutes: 30
  steps:
    - uses: actions/setup-node@v4
    - run: npx playwright install --with-deps
    - run: bun run test:e2e:local
```

The `needs: [unit]` dependency ensures unit tests pass before spending CI time on the slower E2E suite.

---

## Component Tests (Happy DOM)

The web app's SolidJS components are tested with `bun:test` using Happy DOM as a lightweight DOM implementation:

### Setup

```typescript
// packages/app/happydom.ts
import { GlobalRegistrator } from "@happy-dom/global-registrator"

GlobalRegistrator.register()
```

This registers Happy DOM globals (`window`, `document`, `HTMLElement`, etc.) so SolidJS components can render without a browser.

### Running Component Tests

```bash
cd packages/app
bun test
# Runs: bun test --preload ./happydom.ts ./src
```

### What Component Tests Cover

```typescript
import { describe, test, expect } from "bun:test"
import { render, screen } from "@solidjs/testing-library"

describe("MessageComponent", () => {
  test("renders user message text", () => {
    render(() => (
      <Message role="user" parts={[{ type: "text", content: "Hello" }]} />
    ))
    expect(screen.getByText("Hello")).toBeTruthy()
  })

  test("renders assistant message with markdown", () => {
    render(() => (
      <Message
        role="assistant"
        parts={[{ type: "text", content: "**bold** text" }]}
      />
    ))
    expect(screen.getByText("bold")).toBeTruthy()
  })
})
```

These tests verify component rendering and interaction without the overhead of a real browser.

---

## CI/CD Testing Pipeline

The testing pipeline in GitHub Actions runs in stages:

```
Push to branch / PR
        │
        ▼
┌─────────────────────────────┐
│  Stage 1: Unit Tests         │
│  Matrix: Linux + Windows     │
│  Runner: 4 vCPU              │
│                              │
│  cd packages/opencode        │
│  bun test                    │
│                              │
│  cd packages/app             │
│  bun test                    │
└─────────────┬───────────────┘
              │ must pass
              ▼
┌─────────────────────────────┐
│  Stage 2: E2E Tests          │
│  Matrix: Linux + Windows     │
│  Timeout: 30 minutes         │
│                              │
│  Install Playwright          │
│  Seed test data              │
│  Run browser tests           │
└─────────────┬───────────────┘
              │ must pass
              ▼
┌─────────────────────────────┐
│  Stage 3: Required Check     │
│  Gate job — all must pass    │
│  before merge is allowed     │
└─────────────────────────────┘
```

### Type Checking

Type checking runs as a separate workflow:

```bash
bun turbo typecheck
# Uses tsgo --noEmit for speed
```

This verifies all packages compile without type errors, catching issues that tests might miss.

---

## Writing New Tests

### Guidelines

When adding tests to OpenCode, follow these patterns:

1. **Use `Instance.provide()` for isolation** — Every test that touches state should wrap in an instance
2. **Use `tmpdir()` for file system tests** — Always work in temp directories
3. **Test the real thing** — Import and call actual functions, don't mock
4. **Don't duplicate logic** — If you need to verify a calculation, call the function — don't reimplement it in the test
5. **Use `tmpdir({ git: true })` when needed** — Many features depend on being in a git repo
6. **Clean up is automatic** — The preload teardown handles temp directory cleanup
7. **Run from the package directory** — `cd packages/opencode && bun test`, never from root

### Template for a New Test

```typescript
import { describe, test, expect } from "bun:test"
// Import from src/ — the preload ensures the environment is ready

describe("my feature", () => {
  test("does the thing", async () => {
    await Instance.provide({ directory: tmpdir({ git: true }) }, async () => {
      // Arrange — set up state
      const file = `${Instance.current().directory}/test.ts`
      await Bun.write(file, "const x = 1")

      // Act — call the real implementation
      const result = await myFeature(file)

      // Assert — verify the outcome
      expect(result).toBe("expected value")

      // Verify side effects on the real file system
      const content = await Bun.file(file).text()
      expect(content).toContain("expected content")
    })
  })
})
```

### Common Pitfalls

| Pitfall                           | Solution                                                  |
| --------------------------------- | --------------------------------------------------------- |
| Running tests from repo root      | Always `cd packages/opencode` first                       |
| Tests interfering with each other | Use `Instance.provide()` for isolation                    |
| Tests calling real LLM APIs       | The preload clears all API keys — this is by design       |
| EBUSY on cleanup (Windows)        | The preload handles this with retries                     |
| Tests depending on order          | Each test should be fully independent                     |
| Mocking when not needed           | Use real implementations — create temp files/dirs instead |

---

## Testing the Database

Database tests are particularly straightforward because each test gets a fresh SQLite database:

```typescript
describe("migration", () => {
  test("applies all migrations without error", async () => {
    await Instance.provide({ directory: tmpdir() }, async () => {
      const db = Storage.use()
      // If we got here without throwing, all migrations applied successfully

      // Verify tables exist
      const tables = db.all("SELECT name FROM sqlite_master WHERE type='table'")
      expect(tables.map((t) => t.name)).toContain("session")
      expect(tables.map((t) => t.name)).toContain("message")
      expect(tables.map((t) => t.name)).toContain("part")
    })
  })
})
```

No need to set up a test database, run migrations manually, or clean up afterwards. The `Instance.provide()` pattern handles everything.

---

## Performance Considerations

### Parallel Execution

Bun's test runner executes test files in parallel by default. Because each test uses isolated instances with separate databases and temp directories, parallel execution is safe and significantly faster than serial.

### Fast SQLite Operations

SQLite operations are synchronous via `bun:sqlite`, so tests don't pay the overhead of async database operations. A typical unit test completes in milliseconds.

### Minimal Preload Overhead

The preload script does minimal work — creating a temp directory, setting environment variables, and registering a teardown hook. It adds negligible overhead to each test file.

---

## Key Takeaways

1. **No mocks** — Tests run against real implementations: real SQLite databases, real file systems, real tool execution. Mocks test your assumptions; real implementations test your code.

2. **Instance isolation** — `Instance.provide()` gives each test its own scoped context with separate database, bus, and state. Tests never interfere with each other.

3. **The preload is essential** — `test/preload.ts` creates isolated environments, clears API keys, and handles cleanup. Every test file benefits from it automatically.

4. **Tests run from package directories** — Never from the repo root. This prevents path resolution issues and accidental interference with real user data.

5. **E2E tests complement unit tests** — Unit tests verify individual modules in isolation; Playwright E2E tests verify the web app works end-to-end in a real browser.

6. **CI runs everything** — Unit tests on Linux + Windows, E2E tests with Playwright, type checking with tsgo. All must pass before merge.

7. **Testing is fast** — Bun's native test runner, synchronous SQLite, parallel execution, and minimal preload overhead keep the test suite quick.

---

**Previous:** [Chapter 16: Cloud Infrastructure](./16-cloud-infrastructure.md)

**Back to:** [Table of Contents →](./README.md)
