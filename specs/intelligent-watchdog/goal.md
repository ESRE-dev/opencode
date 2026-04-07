# Goal: Intelligent Agent Watchdog

## Overview

OpenCode sessions can stall silently — a hung LLM stream, a stuck tool, or a child session that never returns. Today, there is no production-ready mechanism to detect or recover from these stalls. The existing `local/session-watchdog` branch (not merged into `local-dev`) uses a blunt timer that checks an in-memory status map and cancels sessions after a fixed timeout. It has no understanding of what the session is actually doing, cannot distinguish a stuck stream from a slow-but-progressing tool, and loses all state on process restart.

This goal defines an **intelligent watchdog** — an LLM agent that is spawned when a timeout tripwire fires, introspects the stuck session via database queries and activity signals, makes a judgment call (healthy or stuck), and takes targeted action. The watchdog runs as a regular child session (reusing the existing `task` tool infrastructure), uses a fast/cheap model, and delivers a diagnostic report back to the parent session so the parent LLM can make an informed decision about how to proceed.

The design replaces dumb timers with informed judgment: timeouts become tripwires that spawn an investigator, not kill switches.

## User Stories

- As a developer using OpenCode, I want stuck sessions to be detected and recovered automatically, so that I don't lose work or have to manually kill and restart sessions.
- As a developer running long multi-agent workflows, I want the system to distinguish between "slow but making progress" and "truly stuck," so that legitimate long-running tasks are not killed prematurely.
- As a developer whose child session stalled, I want the parent session to receive a diagnostic report explaining what happened, so that the parent agent can make an intelligent decision (retry, skip, try a different approach) rather than just seeing a generic abort error.
- As an operator, I want to configure timeout thresholds per tool type and choose the watchdog's model, so that I can tune the system for my specific models and workflows.

## Behaviors

### Timeout Tripwires

Timeouts are configured per tool type with sensible defaults. When a timeout fires, it does NOT kill the tool or task — it spawns a watchdog agent to investigate.

- Each tool type has a configurable timeout threshold. When a tool's execution exceeds this threshold, a watchdog is spawned for that specific tool invocation.
- The `task` tool (child sessions) has its own timeout that spawns a watchdog scoped to the child session.
- Layer 1 stalls (hung LLM streams) will be detected by inserting a side-effect idle timer into the processor's stream pipeline (which currently has no idle detection whatsoever). A `Stream.tap` callback resets the timer on every semantic event from the AI SDK. When no event arrives within the configured idle duration, the timer fires and spawns a watchdog. Slow-but-streaming models (reasoning models emitting reasoning deltas) continually reset the timer and do not trigger false alarms. (Note: Effect v4's `Stream` module does not include `Stream.timeoutFail` or `Stream.timeoutOrElse` — the side-effect timer approach uses the same `setTimeout`-based pattern as tool timeout tripwires.)
- Sensible defaults must be identified from the existing per-tool timeout locations in the codebase. The current known defaults are: `bash` 2 minutes (built-in), LLM stream idle has no existing default (new). The `task` tool currently has no timeout on `upstream/dev` — a 4-hour default (`DEFAULT_TIMEOUT = 14_400_000`) will be added as part of this implementation (ported from `local/tool-timeout`).
- Timeouts are configurable via the `experimental` config section, per tool type.

### Watchdog Agent

The watchdog is a regular child session that reuses the existing session infrastructure (`Session.create` + `SessionPrompt.prompt`). It is defined as a dedicated agent with restricted permissions and a diagnostic system prompt.

- The watchdog is spawned as a child of the **parent session** of the stuck session (not a child of the stuck session itself). This ensures it can outlive the stuck session and report results to the parent.
- The watchdog uses a fast, cheap model (e.g., Claude Haiku) configurable by the user.
- The watchdog's system prompt is pre-loaded with all relevant context injected from the code side:
  - Which session is stuck (session ID, parent session ID)
  - What triggered the watchdog (tool name, timeout duration, how long it's been running)
  - A snapshot of the stuck session's current DB state (latest message, latest parts, timing data)
  - The session tree (parent-child relationships)
  - Available actions the watchdog can take
  - The activity signal inventory and how to interpret each signal
- The watchdog has access to read-only tools for DB introspection and activity monitoring. It can query the database to examine messages, parts, tool states, and timing fields.
- The watchdog's impact radius is strictly limited to the stuck session and its parent — the system prompt must be specific enough that the watchdog cannot interfere with unrelated sessions.
- Multiple watchdogs can run simultaneously (one per stuck tool/task). Each is scoped to its own stuck session.

### Introspection

The watchdog examines the stuck session using database queries and activity signals to determine if the session is healthy or stuck.

- The watchdog queries the database for:
  - The latest assistant message's `data.time.completed` and `data.finish` fields (is the message still in-flight?)
  - Tool part states: any `running` tools with old `state.time.start`?
  - `MAX(time_created) FROM part WHERE session_id = ?` (when was the last new part created?)
  - Unmatched lifecycle pairs: `step-start` without `step-finish`, `ToolStateRunning` without completion
  - The session tree via `SessionTable.parent_id`
- The watchdog uses the activity signal inventory to assess health:
  - `message.part.delta` bus events (per-token, finest granularity, not persisted)
  - Bash `ctx.metadata()` output chunks (per stdout chunk, persisted as part updates)
  - `message.part.updated` SyncEvents (part lifecycle boundaries)
  - `MAX(time_created) FROM part` (new part creation in DB)
  - `SessionTable.time_updated` (coarsest — once per user prompt turn)
- The watchdog distinguishes between failure modes:
  - **Hung LLM stream**: `step-start` without `step-finish`, `time.completed = NULL`, no new parts
  - **Stuck tool**: `ToolPart` in `running` state with old `state.time.start`, no part updates
  - **Parent blocked on stuck child**: Parent has `task` tool in `running` state, child shows stall pattern
  - **Infinite empty-response loop**: Multiple recent assistant messages with `finish` set but minimal content

### Actions

If the watchdog determines the session is healthy (slow but progressing), it exits with no action.

If the session is stuck, the watchdog takes one of these targeted actions:

- **Cancel with diagnostic report**: The watchdog calls `SessionPrompt.cancel(stuckSessionId)` on the stuck child session. The `childText()` function in `tool/task.ts` (to be created as part of this implementation — it does not exist on `upstream/dev`) extracts a diagnostic string and returns it to the parent. The `childText()` function includes the watchdog's actual diagnostic report (what it found, why it concluded the session is stuck, what it recommends) instead of a generic abort message. The parent LLM sees this as the tool result and can make an informed decision.
- **Re-prompt the child session**: The watchdog sends a nudge message into the stuck child session to attempt to unstick it. After re-prompting, the watchdog polls `MAX(time_created) FROM part WHERE session_id = ?` every 2 seconds for up to 10 seconds (5 polls total). If `max_created` advances between any two polls, progress is confirmed and the watchdog exits. If not, it falls back to cancel-with-diagnostic.

### Diagnostic Report Delivery

The diagnostic report flows from the watchdog to the parent session through the existing child-to-parent result transport mechanism.

- For stuck `task` tools: The `task` tool's `execute()` function returns structured strings for all failure modes (timeout, abort, error). When the watchdog cancels a stuck child, `childText()` (to be created) extracts the result. The `childText()` function embeds the watchdog's diagnostic report, meaning the parent LLM receives a rich explanation as the tool result — no new transport mechanism needed.
- For stuck LLM streams (Layer 1): The side-effect idle timer (to be added to the processor pipeline) triggers the watchdog spawn. The watchdog's findings determine whether to retry the LLM call or halt with a diagnostic error. The result flows through the existing retry/halt/cleanup pipeline in `processor.ts`.

## Edge Cases & Invariants

### Invariants (always true)

- A watchdog never interferes with sessions other than the stuck session it was spawned for and that session's parent.
- A watchdog never modifies the database of any session other than its own watchdog session (its own messages and parts).
- Multiple watchdogs running simultaneously do not interfere with each other.
- A healthy session (slow but making progress) is never killed by the watchdog — the watchdog observes activity signals and exits with no action if progress is detected.
- The parent session always receives actionable information (diagnostic report or normal result) when a child session is cancelled by the watchdog — never a bare "aborted" error with no context.

### Idempotent Operations

- Spawning a watchdog for an already-recovered session (the tool/task completed between timeout and watchdog introspection) results in the watchdog observing a healthy state and exiting with no action.
- Cancelling an already-completed session is a no-op (existing `SessionPrompt.cancel` handles this gracefully).

### Round-trip Guarantees

- The watchdog's diagnostic report survives the full transport chain: watchdog session → `childText()` extraction → `task` tool `execute()` return → AI SDK `tool-result` event → parent `ToolPart.state.output` in DB → parent LLM context window.

### Preservation (must not change)

- The existing `task` tool behavior for normal (non-stuck) child sessions is unchanged. Timeouts only add a watchdog spawn — they do not alter the timeout/cancel behavior for sessions that complete within their deadline.
- The existing `SessionPrompt.cancel()` mechanism, `processor.cleanup()`, and `Runner` lifecycle are unchanged.
- The existing retry policy in `processor.ts` continues to work as before for retriable API errors.
- Existing tool permissions, agent definitions, and session creation patterns are unchanged.

### Known Edge Cases

- A watchdog itself could get stuck (the watchdog's LLM call hangs). The watchdog has a hardcoded 60-second timeout enforced via `abortAfterAny` from `src/util/abort.ts` (which exports `abortAfter(ms)` and `abortAfterAny(ms, ...signals)`). After 60 seconds, the watchdog is killed and the stuck session is cancelled with a generic message. There is no recursive watchdog-of-watchdog. This timeout is not user-configurable — it is a safety ceiling, not a tuning parameter.
- The LLM stream idle timeout could fire for models that genuinely pause between events (deep reasoning, very slow local models). The default idle timeout must be generous enough to avoid false alarms for the slowest supported models, and must be configurable.
- Multiple `task` tool calls in the same step run concurrently. If several children stall simultaneously, several watchdogs spawn simultaneously. This is the desired behavior — each watchdog is scoped to its own stuck child.
- The `chunkTimeout` mechanism in `provider.ts` (HTTP-level per-chunk timeout, disabled by default) is complementary to the semantic-level idle timer. A provider could keep sending SSE keepalive bytes while the AI SDK emits zero semantic events. The watchdog's idle timer trigger operates on semantic events, catching stalls that `chunkTimeout` would miss.
- `PartTable.time_updated` is unreliable as an activity signal because Drizzle's `$onUpdate` does not fire on `INSERT ... ON CONFLICT DO UPDATE` (used by projectors). The watchdog should use `time_created` on new parts and bus events instead. See the activity signal inventory in Technical Context for the authoritative ranking.

## Constraints

- **Runtime**: Bun + TypeScript, Effect-TS for concurrency, Vercel AI SDK for LLM streaming
- **Database**: SQLite via Drizzle ORM (synchronous reads, `Database.use()` pattern)
- **Session infrastructure**: Must reuse the existing `Session.create` + `SessionPrompt.prompt` + `Runner` + `runLoop` infrastructure. No parallel execution infrastructure.
- **Model**: Watchdog model must be configurable. Default should be a fast, cheap model (Claude Haiku or similar). Must work with all supported providers.
- **Config**: New config entries go in the `experimental` section. Per-tool-type timeouts and watchdog model selection.
- **Concurrency**: The watchdog runs as its own session with its own `Runner`. No concurrency interference with the stuck session or parent session.
- **Performance**: Watchdog spawn should add minimal overhead. The LLM call is the expensive part, but using a cheap model keeps cost low. DB queries for introspection are lightweight (indexed columns).

## Out of Scope

- **Startup orphan scan**: Detecting sessions left in incomplete state after a process crash/restart. This is a separate concern that requires scanning the DB on startup — useful but orthogonal to the timeout-triggered watchdog design.
- **Persistent watchdog daemon**: A background process that continuously monitors all sessions. The design is reactive (watchdog spawned on timeout), not proactive.
- **Automatic retry of stuck operations**: The watchdog can recommend retry to the parent LLM via the diagnostic report, but automatic transparent retry of the stuck operation itself is out of scope. The parent LLM decides.
- **UI for watchdog status**: No TUI changes to show watchdog activity. Watchdog sessions appear in the session tree like any other child session.
- **Modifications to the Vercel AI SDK**: The design works within the existing AI SDK interface. No SDK patches or forks.
- **Out-of-band execution infrastructure**: The watchdog reuses the session while-loop — no new execution engine, no separate LLM call mechanism, no custom tool dispatch.

## Success Criteria

- A hung LLM stream (the exact scenario from the investigation: `Stream.runDrain` blocking on `AsyncIterator.next()` after a `step-start` with no `step-finish`) is detected within the configured idle timeout and a watchdog is spawned.
- A stuck tool (e.g., `bash` command that hangs) is detected when its execution exceeds the per-tool timeout and a watchdog is spawned.
- A stuck child session (task tool) is detected when its execution exceeds the task timeout and a watchdog is spawned.
- The watchdog correctly distinguishes "slow but healthy" from "truly stuck" by examining DB activity signals — a slow-but-progressing session is not cancelled.
- When the watchdog cancels a stuck child session, the parent session receives a diagnostic report (not a generic abort error) as the tool result, containing what the watchdog found and why it concluded the session is stuck.
- The watchdog's re-prompt action successfully unsticks a child session that was transiently stalled (e.g., LLM returned an empty response but can continue on a nudge).
- All existing tests continue to pass.
- The watchdog's own execution completes within its hard timeout (60 seconds) — it does not itself become stuck.

## Technical Context

### Codebase Findings

- **Stream pipeline insertion point**: `processor.ts:456-460` — A side-effect idle timer can be integrated into the stream pipeline via `Stream.tap`. On every semantic event, the tap resets the timer. When the timer fires (no events for the configured idle duration), it spawns a watchdog. This follows the same `setTimeout`-based pattern used for tool timeout tripwires. (Neither `Stream.timeoutFail` nor `Stream.timeoutOrElse` exist in Effect v4.0.0-beta.43.)
- **Per-tool timeouts**: `bash` has a 2-minute default (`tool/bash.ts`). Other tools have no explicit timeouts. The `task` tool (`src/tool/task.ts`, 166 lines on `upstream/dev`) currently has no timeout or deadline mechanism — the timeout infrastructure (including `DEFAULT_TIMEOUT`, `abortAfterAny` deadline wrapping, and `raceSignal`) will be ported from `local/tool-timeout` as part of this implementation. A `childText()` function for result extraction will be created (ported from `local/session-watchdog` design).
- **Session reuse**: The `task` tool pattern (`tool/task.ts`) creates a child session via `Session.create({ parentID })` and calls `SessionPrompt.prompt()` — this gives the full while-loop, tool dispatch, message persistence, compaction, retry, and Runner for free. ~30 lines of new code vs 200-400 for out-of-band.
- **Agent definition**: Agents are defined at `agent/agent.ts`. The `compaction`, `title`, and `summary` built-in agents (`agent.ts:194-233`) use a maximally restricted `Permission.fromConfig({ "*": "deny" })` with no re-allows — this is the correct base pattern for the watchdog. The `explore` agent (`agent.ts:161-187`) shows the pattern for selectively re-allowing specific tools on top of that base.
- **Child-to-parent result transport**: `tool/task.ts:execute()` returns structured strings. On `upstream/dev`, result extraction is inline at `task.ts:146`: `result.parts.findLast(x => x.type === "text")?.text`. A dedicated `childText()` function (with multiple extraction paths including a WATCHDOG path that embeds the diagnostic report) will be created as part of this implementation.
- **Activity signals**: The following signal channels are available for the watchdog to assess session health (ordered finest to coarsest):
  1. `message.part.delta` bus event — per LLM token (10-50/sec), not persisted to DB, covers LLM text generation
  2. Bash `ctx.metadata()` output chunks — per stdout chunk, persisted as part updates, covers shell execution
  3. `message.part.updated` SyncEvent — part lifecycle boundaries (tool state transitions, LLM part start/end), persisted
  4. `session.status` bus event — ~2-4 per turn (busy/idle/retry), not persisted
  5. `MAX(time_created) FROM part WHERE session_id = ?` — new part creation timestamps in DB
  6. `file.watcher.updated` bus event — per file write by tools, not persisted
  7. `SessionTable.time_updated` — once per user prompt turn via `Session.touch()`, persisted
  8. PTY bus events (pty.created/exited) — terminal lifecycle only
  9. OS process PID checks — manual, no persistent registry

  Note: `PartTable.time_updated` is unreliable because Drizzle's `$onUpdate` is bypassed by `INSERT ... ON CONFLICT DO UPDATE` (used by projectors). Use `time_created` on new parts and bus events instead. The companion KB document's claim that `time_updated` is the "most granular timing signal" is incorrect for parts — this goal's assessment is authoritative.

- **`chunkTimeout` mechanism**: `provider.ts` wraps raw SSE body with per-chunk timers. HTTP-level, disabled by default. Complementary to the semantic-level idle timer.
- **Retry interaction**: Errors flow through `Effect.catchCauseIf` → `Effect.retry` at `processor.ts:463-466`. A raw `Error` is not recognized by `retryable()` and causes halt. To get retry, the error must be wrapped as `MessageV2.APIError` with `isRetryable: true`. `StreamIdleError` (for idle timeout) should NOT be retriable — it halts the prompt cycle and spawns a watchdog.
- **No existing idle detection**: `handleEvent` at `processor.ts:111` tracks no timestamps for inter-event timing. No `lastEvent`, no heartbeat, no idle timer anywhere in the current codebase.
- **Config location**: New entries go in the `experimental` config section at `config.ts`. Existing relevant entries: `mcp_timeout`. Note: `task_timeout` does not yet exist in the config schema and must be added. New entries needed: per-tool-type watchdog timeouts, watchdog model, LLM stream idle timeout.
- **Abort utilities**: `src/util/abort.ts` exports `abortAfter(ms)` and `abortAfterAny(ms, ...signals)`. The `raceSignal()` function (used for combining abort signals with timeouts) does not exist on `upstream/dev` and will be created as part of this implementation (ported from `local/session-watchdog`).
- **`NamedError` factory**: The codebase's error factory at `packages/util/src/error.ts` uses the static factory pattern: `NamedError.create("ErrorName", z.object({...}))`. This produces a class with a static `.isInstance()` predicate. Do NOT use `class extends NamedError("Name")<{...}>` syntax — that is not the actual API.

### Library & API Findings

- **Effect `Stream.tap`**: Used to execute a side effect on every stream element. The idle timer reset is performed inside the `Stream.tap` callback — no new Effect API needed.
- **Effect `Stream.timeout`**: Ends the stream silently after idle duration. Less useful for the watchdog — we need to trigger an action (spawn watchdog), not just end. The side-effect timer approach provides the trigger.
- **Effect `Effect.catchCauseIf`**: Used for error interception (`processor.ts:463-466`). `Effect.catchIf` does NOT exist in this Effect version — use `catchCauseIf` with cause inspection instead.
- **AI SDK tool result flow**: `execute()` return → `tool-result` stream event → `processor.ts` `handleEvent` → `ToolPart.state = completed`. `execute()` throw → `tool-error` stream event → `ToolPart.state = error`. Both appear in parent LLM context.

## Open Questions (Resolved)

| #   | Question                                                        | Resolution                                                                                                                                                                                                                          |
| --- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Should timeouts kill tools/tasks or just trigger investigation? | Timeouts are tripwires that spawn watchdog agents, not kill switches.                                                                                                                                                               |
| 2   | Should the watchdog run as a regular session or out-of-band?    | Regular child session — reuses all existing infrastructure (while-loop, tool dispatch, persistence, Runner). Out-of-band would require 200-400 lines duplicating existing code.                                                     |
| 3   | Whose child is the watchdog?                                    | Child of the **parent session** of the stuck session, not child of the stuck session itself. This lets it outlive the stuck session and report to the parent.                                                                       |
| 4   | How does the diagnostic report reach the parent LLM?            | Via the existing `childText()` → `task.execute()` return → `tool-result` transport. `childText()` is modified to embed the watchdog's diagnostic instead of the generic WATCHDOG message.                                           |
| 5   | What model for the watchdog?                                    | Fast/cheap model (Haiku-class), user-configurable.                                                                                                                                                                                  |
| 6   | What triggers the watchdog for hung LLM streams (Layer 1)?      | A side-effect idle timer integrated into the processor's stream pipeline via `Stream.tap`. Resets on every semantic event from the AI SDK. When the timer fires (no events for the configured idle duration), it spawns a watchdog. |
| 7   | How does the watchdog measure activity beyond token streaming?  | 9 signal channels: bus events (per-token deltas, part updates), DB queries (part `time_created`, message `time.completed`, tool `state.time.start`), file watcher events, PTY events, OS process checks.                            |
| 8   | What about `PartTable.time_updated` for activity detection?     | Unreliable — Drizzle's `$onUpdate` is bypassed by `INSERT ... ON CONFLICT DO UPDATE`. Use `time_created` on new parts instead.                                                                                                      |
| 9   | Can multiple watchdogs run simultaneously?                      | Yes — each scoped to its own stuck session via system prompt. Desired behavior for concurrent stalls.                                                                                                                               |
| 10  | Who watches the watchdog?                                       | Hard timeout (60 seconds). No recursive watchdog-of-watchdog. If the watchdog itself stalls, it's killed and the stuck session is cancelled with a generic message.                                                                 |
| 11  | Should the watchdog cover startup orphan scan?                  | Out of scope. Orthogonal concern — the watchdog is reactive (timeout-triggered), not a background daemon.                                                                                                                           |
| 12  | Per-tool-type timeouts or blanket?                              | Per-tool-type with sensible defaults, configurable via `experimental` config.                                                                                                                                                       |
