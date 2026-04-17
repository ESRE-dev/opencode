# Chapter 7: Database & Storage

> SQLite via Bun's native bindings, Drizzle ORM schemas, migrations, and the event-sourced message/part model.

---

## Overview

OpenCode stores all its persistent state — sessions, messages, tool outputs, permissions, project metadata — in a single **SQLite** database file. The database layer is built on three pillars:

1. **`bun:sqlite`** — Bun's native SQLite binding (no native addons, no FFI overhead)
2. **Drizzle ORM** — Type-safe query builder and schema definition
3. **Co-located schemas** — Each module defines its own `*.sql.ts` file alongside its logic

This combination gives OpenCode a zero-dependency, zero-setup database that compiles directly into the standalone binary.

---

## Database Location

The database file lives at a platform-appropriate location following XDG base directory conventions:

| Platform | Default Path                          |
| -------- | ------------------------------------- |
| Linux    | `~/.local/share/opencode/opencode.db` |
| macOS    | `~/.local/share/opencode/opencode.db` |
| Windows  | `%LOCALAPPDATA%/opencode/opencode.db` |

The path can be overridden via configuration, but the default ensures the database survives application updates (since it's outside the install directory).

---

## Database Initialization

The database is initialized in `packages/opencode/src/storage/db.ts`:

```typescript
import { Database as BunDatabase } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"

// Create the raw SQLite connection
const sqlite = new BunDatabase(path)

// Enable WAL mode for concurrent reads
sqlite.exec("PRAGMA journal_mode = WAL")

// Wrap with Drizzle ORM
const db = drizzle(sqlite)
```

### Why `bun:sqlite`?

Bun embeds SQLite directly in its runtime — there's no native addon to compile, no `node-gyp` headaches, and no FFI bridge. The `bun:sqlite` module provides:

- **Synchronous API** — SQLite operations are inherently synchronous, and Bun doesn't pretend otherwise
- **Prepared statements** — Cached and reused for performance
- **WAL mode** — Write-Ahead Logging enables concurrent readers with a single writer
- **Zero overhead** — Direct memory access to SQLite's C library

When OpenCode is compiled to a standalone binary via `Bun.build({ compile: true })`, SQLite comes along for free — it's part of the Bun runtime embedded in the binary.

---

## Schema Definition Pattern

OpenCode uses **co-located schemas** — each module defines its database tables in a `*.sql.ts` file that lives alongside the module's logic:

```
src/
├── session/
│   ├── session.sql.ts       # Session, message, and part tables
│   ├── session.ts           # Session business logic
│   └── llm.ts               # LLM streaming logic
├── project/
│   ├── project.sql.ts       # Project table
│   └── project.ts           # Project logic
├── permission/
│   ├── permission.sql.ts    # Permission rules table
│   └── permission.ts        # Permission logic
├── control-plane/
│   └── workspace.sql.ts     # Workspace table
└── ...
```

This co-location keeps the data model close to the code that uses it — when you're working on sessions, the schema is right there in the same directory.

### Schema Conventions

All schemas follow the project's style guide:

```typescript
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"

const session = sqliteTable("session", {
  // snake_case field names so column names don't need redefinition
  id: text().primaryKey(),
  project_id: text().notNull(),
  agent_id: text().notNull(),
  title: text(),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
})
```

Key conventions:

- **`snake_case` field names** — This matches the SQL column name, avoiding the need to pass a string override (e.g., `text("project_id")` is unnecessary when the field is already `project_id`)
- **`text()` for IDs** — ULIDs (Universally Unique Lexicographically Sortable Identifiers) stored as text
- **`integer()` for timestamps** — Unix millisecond timestamps, not ISO strings
- **JSON columns** — Complex types stored as JSON text with Drizzle's `$type<T>()` for TypeScript typing

---

## Core Tables

### Session Table

The session table is the top-level container for conversations:

```typescript
const session = sqliteTable("session", {
  id: text().primaryKey(), // ULID
  project_id: text().notNull(), // Which project this session belongs to
  agent_id: text().notNull(), // Which agent is running
  title: text(), // AI-generated title
  parent_id: text(), // For sub-sessions (task tool)
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
})
```

Sessions are scoped to a project — each project directory has its own set of sessions. The `parent_id` field enables hierarchical sessions when the `task` tool spawns a sub-agent.

### Message Table

Messages represent individual turns in a conversation:

```typescript
const message = sqliteTable("message", {
  id: text().primaryKey(), // ULID
  session_id: text().notNull(), // Parent session
  role: text().notNull(), // "user" | "assistant" | "system"
  created_at: integer().notNull(),
})
```

Messages are lightweight — the actual content lives in the **parts** table.

### Part Table

Parts are the atomic units of content — the event-sourced building blocks of a message:

```typescript
const part = sqliteTable("part", {
  id: text().primaryKey(), // ULID
  message_id: text().notNull(), // Parent message
  session_id: text().notNull(), // Denormalized for query efficiency
  type: text().notNull(), // Part type discriminator
  data: text().notNull(), // JSON-encoded part data
  index: integer().notNull(), // Ordering within the message
  created_at: integer().notNull(),
})
```

Part types include:

| Type              | Description                     | Data Shape                       |
| ----------------- | ------------------------------- | -------------------------------- |
| `text`            | Text content from the assistant | `{ text: string }`               |
| `tool-invocation` | A tool call request             | `{ toolName, args, toolCallId }` |
| `tool-result`     | Output from a tool execution    | `{ toolCallId, result }`         |
| `reasoning`       | Chain-of-thought tokens         | `{ text: string }`               |
| `file`            | File attachment                 | `{ path, content }`              |
| `step-start`      | Marks a new inference step      | `{ messageId }`                  |

### Why Event-Sourced Parts?

The part model is designed for **streaming**. As the LLM generates a response:

1. Each text chunk arrives and is stored as a part immediately
2. Each tool call is stored as a part when it's emitted
3. Each tool result is stored as a part when execution completes

This means:

- **Incremental rendering** — UIs can display content as it arrives, one part at a time
- **Partial recovery** — If a stream is interrupted, the parts received so far are preserved
- **Audit trail** — Every tool call and its result is individually recorded
- **Compaction** — The compaction system can summarize old parts without losing the event history

### Todo Table

The todo table persists AI-managed task lists within sessions:

```typescript
const todo = sqliteTable("todo", {
  id: text().primaryKey(),
  session_id: text().notNull(),
  content: text().notNull(),
  status: text().notNull(), // "pending" | "in_progress" | "done"
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
})
```

### Permission Table

Stores user-granted permissions for tool execution:

```typescript
const permission = sqliteTable("permission", {
  id: text().primaryKey(),
  session_id: text(), // null = global permission
  tool: text().notNull(), // Tool name
  glob: text(), // File pattern
  action: text().notNull(), // "allow" | "deny"
  created_at: integer().notNull(),
})
```

### Project Table

Tracks known project directories:

```typescript
const project = sqliteTable("project", {
  id: text().primaryKey(),
  path: text().notNull().unique(),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
})
```

### Workspace Table

For the control-plane multi-project management:

```typescript
const workspace = sqliteTable("workspace", {
  id: text().primaryKey(),
  name: text().notNull(),
  directory: text().notNull(),
  created_at: integer().notNull(),
})
```

---

## Timestamps Pattern

OpenCode uses a reusable timestamp pattern across all tables:

```typescript
// Conceptual helper — creates created_at + updated_at columns
const timestamps = {
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
}
```

All timestamps are **Unix milliseconds** stored as integers. This is more compact than ISO strings, simpler to compare, and avoids timezone ambiguity.

---

## Querying with Drizzle

Drizzle ORM provides a type-safe query builder that maps directly to SQL. Here are common patterns used throughout OpenCode:

### Basic Select

```typescript
const sessions = db
  .select()
  .from(session)
  .where(eq(session.project_id, projectId))
  .orderBy(desc(session.updated_at))
  .all()
```

### Join Queries

```typescript
const messages = db
  .select()
  .from(message)
  .leftJoin(part, eq(part.message_id, message.id))
  .where(eq(message.session_id, sessionId))
  .orderBy(asc(message.created_at))
  .all()
```

### Insert

```typescript
db.insert(session)
  .values({
    id: ulid(),
    project_id: projectId,
    agent_id: agentId,
    created_at: Date.now(),
    updated_at: Date.now(),
  })
  .run()
```

### Update

```typescript
db.update(session).set({ title, updated_at: Date.now() }).where(eq(session.id, sessionId)).run()
```

### Transaction

```typescript
db.transaction((tx) => {
  tx.insert(message).values(msg).run()
  for (const p of parts) {
    tx.insert(part).values(p).run()
  }
})
```

Drizzle's key advantage is that **queries are fully typed** — the return type of a select query reflects the exact columns selected, and the TypeScript compiler catches column name typos, missing required fields, and type mismatches at build time.

---

## Migrations

Database migrations live in `packages/opencode/migration/`:

```
migration/
├── 20260127222353_familiar_lady_ursula/
│   ├── migration.sql
│   └── snapshot.json
├── 20260201143022_next_migration/
│   ├── migration.sql
│   └── snapshot.json
└── ...
```

### How Migrations Are Generated

Drizzle Kit generates migrations by diffing the current schema definitions against the previous snapshot:

```bash
cd packages/opencode
bunx drizzle-kit generate
```

This reads `drizzle.config.ts`:

```typescript
import { defineConfig } from "drizzle-kit"

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/**/*.sql.ts", // Find all co-located schema files
  out: "./migration", // Output directory
})
```

The `schema: "./src/**/*.sql.ts"` glob pattern is what makes co-located schemas work — Drizzle Kit scans the entire `src/` tree for any file ending in `.sql.ts` and combines them into a unified schema.

### How Migrations Are Applied

Migrations are **embedded into the binary** at compile time. The build script reads all migration SQL files and injects them as a string constant:

```typescript
// In build.ts
const migrations = await readMigrations("./migration")
// Passed to Bun.build() as a define:
define: {
  "OPENCODE_MIGRATIONS": JSON.stringify(migrations),
}
```

At startup, the application runs any pending migrations:

```typescript
// Conceptual
const pending = migrations.filter((m) => !applied.includes(m.name))
for (const migration of pending) {
  db.exec(migration.sql)
  markApplied(migration.name)
}
```

This approach means:

- **No migration files to ship** — they're baked into the binary
- **Automatic upgrades** — when a user updates OpenCode, new migrations run on first launch
- **No migration tooling needed** — users never run `drizzle-kit migrate`

### JSON Migration

OpenCode historically stored data in JSON flat files. The `json-migration.ts` module handles migrating from the old JSON format to SQLite — it reads the old files, transforms the data, and inserts it into the new schema. This is a one-time migration that runs automatically.

---

## Database Access Patterns

### The Storage Module

The `storage/` module provides centralized database access:

```typescript
// Access the database for the current instance
const db = Storage.use()
```

This uses the Instance pattern — each project instance has its own database connection. In tests, each test gets an isolated database in a temporary directory.

### Synchronous by Design

Unlike most ORMs that return promises, `bun:sqlite` operations are synchronous. This is intentional:

- SQLite is an embedded database — there's no network round-trip
- Synchronous operations are faster (no event loop overhead)
- The code is simpler — no `await` chains for database queries

Drizzle's `bun-sqlite` driver preserves this synchronous nature — methods like `.all()`, `.get()`, and `.run()` return values directly, not promises.

### WAL Mode

The database is configured with `PRAGMA journal_mode = WAL` (Write-Ahead Logging). This enables:

- **Concurrent reads** — Multiple readers don't block each other
- **Non-blocking writes** — Readers aren't blocked by a writer
- **Crash recovery** — The WAL provides automatic recovery after unexpected shutdowns

This is important because OpenCode's server may handle multiple HTTP requests simultaneously, and the event bus may publish events while queries are in progress.

---

## Indexing Strategy

Tables include indexes for common query patterns:

```typescript
const part = sqliteTable(
  "part",
  {
    id: text().primaryKey(),
    message_id: text().notNull(),
    session_id: text().notNull(),
    // ...
  },
  (table) => [index("part_message_id_idx").on(table.message_id), index("part_session_id_idx").on(table.session_id)],
)
```

Key indexed columns:

| Table        | Indexed Column | Query Pattern                            |
| ------------ | -------------- | ---------------------------------------- |
| `message`    | `session_id`   | Get all messages for a session           |
| `part`       | `message_id`   | Get all parts for a message              |
| `part`       | `session_id`   | Get all parts for a session (compaction) |
| `session`    | `project_id`   | List sessions for a project              |
| `permission` | `session_id`   | Get permissions for a session            |

The denormalized `session_id` on the `part` table is intentional — it avoids a join through `message` when loading all parts for a session, which is a common operation during compaction and session export.

---

## Data Lifecycle

### Creation Flow

```
User sends message
       │
       ▼
Insert into `session` (if new)
       │
       ▼
Insert into `message` (role: "user")
       │
       ▼
Insert `text` part (user's input)
       │
       ▼
LLM streams response
       │
       ├──► Insert `text` parts (as chunks arrive)
       ├──► Insert `tool-invocation` parts
       ├──► Execute tools
       ├──► Insert `tool-result` parts
       │
       ▼
Insert into `message` (role: "assistant")
       │
       ▼
Loop until done
```

### Compaction

When a session's context grows too large:

```
Full message history
       │
       ▼
Summary agent compresses to a summary
       │
       ▼
Old messages/parts are retained (not deleted)
       │
       ▼
New summary message replaces them in the active context
       │
       ▼
Session continues with compressed context
```

The original messages are kept for the audit trail — compaction only affects what's sent to the LLM.

### Session Sharing

Sessions can be exported and shared:

1. All messages and parts are serialized to JSON
2. File snapshots are included (diffs applied during the session)
3. The bundle is uploaded to R2 storage
4. A share URL is generated

### Deletion

Sessions can be deleted, which cascades through messages, parts, todos, and permissions via the application logic (not SQL cascades).

---

## Testing the Database Layer

Tests use the Instance pattern to get isolated databases:

```typescript
import { describe, test, expect } from "bun:test"

describe("session", () => {
  test("creates a session", async () => {
    await Instance.provide({ directory: tmpdir() }, async () => {
      // Each test gets its own SQLite database
      const db = Storage.use()

      // Test actual database operations
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
    })
  })
})
```

The test preload (`test/preload.ts`) ensures:

- Temp directories are created for each test run
- XDG paths point to the temp directory
- Databases are cleaned up after tests complete
- No test can accidentally use the real user database

---

## Key Takeaways

1. **SQLite is embedded** — No external database server, no setup, no connection strings. The database is a file that ships with the application.

2. **`bun:sqlite` is native** — No FFI, no native addons. SQLite is part of the Bun runtime and compiles into the standalone binary.

3. **Drizzle ORM provides type safety** — Schemas are TypeScript, queries are type-checked, and the compiler catches mistakes at build time.

4. **Co-located schemas** keep the data model close to the code that uses it — `session/session.sql.ts` lives next to `session/session.ts`.

5. **The part model is event-sourced** — Messages are composed of granular, immutable parts that enable streaming, recovery, and auditing.

6. **Migrations are embedded** — SQL migration files are compiled into the binary, so schema upgrades happen automatically on launch.

7. **Synchronous is intentional** — SQLite is local, so synchronous operations are both simpler and faster than async wrappers.

---

**Next:** [Chapter 8: Terminal UI →](./08-terminal-ui.md)

**Previous:** [Chapter 6: Tool System](./06-tool-system.md)
