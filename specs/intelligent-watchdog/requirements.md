# Requirements Document: Intelligent Agent Watchdog

## Introduction

OpenCode sessions can stall silently when an LLM stream hangs, a tool execution blocks indefinitely, or a child session never returns. This feature introduces an **intelligent watchdog** — an LLM agent spawned on timeout that introspects the stuck session via database queries and activity signals, judges whether the session is truly stuck, and takes targeted recovery action.

The watchdog replaces dumb kill-switch timers with informed judgment: timeouts become tripwires that spawn an investigator agent, not kill switches.

**Tech stack**: TypeScript, Bun runtime, Effect-TS (concurrency/streams), Vercel AI SDK (LLM streaming), Drizzle ORM (SQLite persistence), `bun:test` (testing).

**Source of truth**: `specs/intelligent-watchdog/goal.md`

## Glossary

- **Watchdog**: A lightweight LLM agent session spawned to investigate a stalled session. Runs as a regular child session using the `task` tool infrastructure.
- **Tripwire**: A timeout threshold that spawns a watchdog agent when exceeded. Does not kill or cancel the timed-out operation.
- **Stuck session**: A session that has stopped making observable progress — no new parts created, no tool state transitions, no LLM events for a configurable duration.
- **Healthy session**: A session that is slow but still making observable progress — activity signals indicate forward motion.
- **Activity signal**: An observable event or database field that indicates a session is making progress. Nine channels exist, ranked from finest to coarsest granularity.
- **Diagnostic report**: A structured text report produced by the watchdog describing what it found, why it concluded the session is stuck, and what it recommends. Delivered to the parent LLM as a tool result.
- **Parent session**: The session that spawned the stuck session via the `task` tool. The watchdog is a child of this session.
- **Layer 1 stall**: A hung LLM stream where `Stream.runDrain` blocks on `AsyncIterator.next()` with no semantic events from the AI SDK.
- **Layer 2 stall**: A tool execution that blocks indefinitely (e.g., a `bash` command that hangs).
- **Layer 3 stall**: A child session (via `task` tool) that never returns, blocking the parent session.
- **Re-prompt**: Sending a nudge message into a stuck child session to attempt to unstick it.
- **Idle timeout**: The maximum duration with no semantic events from the AI SDK before the stream is considered stalled.
- **Per-tool-type timeout**: A configurable timeout threshold for each tool type, triggering a watchdog when exceeded.
- **`childText()`**: A function to be created in `tool/task.ts` that extracts the result string from a completed or aborted child session for delivery to the parent LLM. Does not exist on `upstream/dev` — result extraction is currently inline at `task.ts:146`.

## Requirements

### Requirement 1: Timeout Tripwires

**User Story:** As a developer using OpenCode, I want tool and stream timeouts to trigger investigation rather than immediate cancellation, so that slow-but-progressing operations are not killed prematurely.

#### Acceptance Criteria

1. WHEN a tool's execution duration exceeds the configured per-tool-type timeout threshold THE SYSTEM SHALL spawn a watchdog agent scoped to that specific tool invocation.

2. WHEN a `task` tool invocation (child session) exceeds the configured task timeout threshold THE SYSTEM SHALL spawn a watchdog agent scoped to the stuck child session.

3. WHEN no semantic event arrives from the AI SDK on the processor's LLM stream for longer than the configured idle timeout duration THE SYSTEM SHALL spawn a watchdog agent to investigate the idle stream.

4. WHILE the LLM stream is receiving semantic events at intervals shorter than the idle timeout THE SYSTEM SHALL reset the idle timer on each event received.

5. THE SYSTEM SHALL provide per-tool-type timeout thresholds with the following defaults: `bash` 120 seconds, `task` 14400 seconds (4 hours), LLM stream idle 120 seconds.

6. WHERE the user has configured custom timeout thresholds in the `experimental` config section THE SYSTEM SHALL use the user-configured values instead of the defaults.

7. WHEN a timeout tripwire fires THE SYSTEM SHALL allow the timed-out tool or stream to continue running while the watchdog investigates.

8. IF the timed-out tool or task completes normally between the tripwire firing and the watchdog's investigation THE SYSTEM SHALL allow the watchdog to observe the healthy state and exit with no action.

**Technical Implementation Notes:**

- LLM stream idle detection via a side-effect idle timer integrated into the processor stream pipeline at `packages/opencode/src/session/processor.ts`. A `Stream.tap` callback resets the timer on every semantic event. When the timer fires (no events for the configured idle duration), it triggers a `StreamIdleError` and spawns a watchdog. (Neither `Stream.timeoutFail` nor `Stream.timeoutOrElse` exist in Effect v4.0.0-beta.43 — the side-effect timer approach follows the same `setTimeout`-based pattern as tool timeout tripwires.)
- `StreamIdleError` defined using the codebase's `NamedError` factory from `packages/util/src/error.ts`: `NamedError.create("StreamIdleError", z.object({ sessionID: z.string(), timeout: z.number() }))`. Caught with `Effect.catchCauseIf` (not `Effect.catchIf`, which does not exist in this Effect version) with cause inspection.
- Per-tool-type timeout tripwires wrap `execute` closures inside `resolveTools()` at `packages/opencode/src/session/prompt.ts` using a `setTimeout`-based `startToolTripwire()` with an atomicity boolean guard (Bun had `clearTimeout` bug #28927 fixed ~April 2026 — guard is cheap insurance)
- Per-tool-type timeouts configured in the `experimental` section of `packages/opencode/src/config/config.ts`
- The `bash` tool already has a 2-minute default timeout. The `task` tool currently has no timeout on `upstream/dev` — a `DEFAULT_TIMEOUT = 14_400_000ms` (4 hours) will be added as part of this implementation (ported from `local/tool-timeout`). Other tools currently lack explicit timeouts.

### Requirement 2: Watchdog Agent Lifecycle

**User Story:** As a developer running long multi-agent workflows, I want the watchdog to be a lightweight, scoped agent that cannot interfere with unrelated sessions, so that the watchdog mechanism is safe to run in production.

#### Acceptance Criteria

1. WHEN a watchdog is spawned THE SYSTEM SHALL create the watchdog as a child session of the **parent session** of the stuck session (not a child of the stuck session itself).

2. WHEN a watchdog is spawned THE SYSTEM SHALL use the user-configured watchdog model; WHERE no watchdog model is configured THE SYSTEM SHALL use a hardcoded per-provider default fast model (e.g., `claude-haiku-4-5` for Anthropic providers, `gpt-4o-mini` for OpenAI providers) that must be declared in the watchdog spawn logic as a static lookup table.

3. WHEN a watchdog is spawned THE SYSTEM SHALL inject into the watchdog's system prompt all of: the stuck session's ID, the parent session's ID, the triggering tool name, the timeout duration, the elapsed execution time, a snapshot of the stuck session's current DB state (latest message, latest parts, timing data), the session tree (parent-child relationships), available actions, and the activity signal inventory with interpretation guidance.

4. THE SYSTEM SHALL grant the watchdog agent exactly four tool permissions: two read-only introspection tools (`watchdog_query`, `watchdog_activity`) for database state examination, and two scoped action tools (`watchdog_reprompt`, `watchdog_cancel`) for recovery actions on the stuck session.

5. THE SYSTEM SHALL scope each watchdog's impact radius strictly to the stuck session the watchdog was spawned for and that session's parent.

6. WHEN multiple tool invocations or child sessions stall simultaneously THE SYSTEM SHALL spawn a separate watchdog for each stalled invocation, each scoped to its own stuck session.

7. WHEN a watchdog's execution exceeds 60 seconds THE SYSTEM SHALL kill the watchdog and cancel the stuck session with a generic abort message.

8. THE SYSTEM SHALL NOT spawn a watchdog to monitor another watchdog (no recursive watchdog-of-watchdog).

9. IF the stuck session has no parent session (the stuck session is the top-level user session) THE SYSTEM SHALL NOT spawn a watchdog.

**Technical Implementation Notes:**

- Reuses `Session.create({ parentID })` + `SessionPrompt.prompt({ sessionID, agent: "watchdog", system: builtPrompt, parts: [...] })` + `Runner` infrastructure from `task` tool. The `system` field in `PromptInput` is the correct way to inject a dynamic system prompt — there is no `systemPrompt` on `Session.create`.
- Watchdog fired as background fiber via `Effect.forkIn(scope)` — the idiomatic fire-and-forget pattern in this codebase (not `Effect.fork` or `Effect.forkDaemon`, which are not used anywhere)
- The watchdog agent definition follows the pattern of `compaction`/`title`/`summary` built-in agents with `Permission.fromConfig({ "*": "deny" })` as the base
- 60-second hard timeout via `abortAfterAny(60_000, ctx.abort)` from `src/util/abort.ts` (the same mechanism that will be used for the `task` tool's 4-hour deadline — both the `raceSignal()` helper and the task deadline wrapping are new code ported from `local/session-watchdog` and `local/tool-timeout` respectively)

### Requirement 3: Session Introspection

**User Story:** As a developer whose session has stalled, I want the watchdog to distinguish between "slow but making progress" and "truly stuck" by examining actual session state, so that legitimate long-running tasks are not incorrectly cancelled.

#### Acceptance Criteria

1. WHEN the watchdog introspects a session THE SYSTEM SHALL query the database for the latest assistant message's `data.time.completed` and `data.finish` fields.

2. WHEN the watchdog introspects a session THE SYSTEM SHALL query the database for tool parts in `running` state and examine each tool part's `state.time.start` field.

3. WHEN the watchdog introspects a session THE SYSTEM SHALL query `MAX(time_created) FROM part WHERE session_id = ?` to determine when the last new part was created.

4. WHEN the watchdog introspects a session THE SYSTEM SHALL query for unmatched lifecycle pairs: `step-start` events without corresponding `step-finish` events, and tool parts in `running` state without a completion state.

5. WHEN the watchdog introspects a session THE SYSTEM SHALL query the session tree via `parent_id` to understand parent-child relationships.

6. THE SYSTEM SHALL classify the stuck session into exactly one failure mode by applying the following priority order when multiple patterns match: (1) parent blocked on stuck child (parent's task tool in running state), (2) stuck tool (tool part in running state with old start time), (3) hung LLM stream (step-start without step-finish, no new parts), (4) infinite empty-response loop (multiple recent assistant messages with finish set but zero tool parts). When mode (1) is detected the watchdog shall recurse into the child session to classify its sub-mode.

7. WHEN the watchdog detects that the stuck session's `MAX(time_created)` has advanced within the last 30 seconds THE SYSTEM SHALL classify the session as healthy (slow but progressing).

8. THE SYSTEM SHALL NOT use `PartTable.time_updated` as an activity signal for introspection queries.

**Technical Implementation Notes:**

- `PartTable.time_updated` is unreliable because Drizzle's `$onUpdate` is bypassed by `INSERT ... ON CONFLICT DO UPDATE` used by projectors
- Use `time_created` on new parts for activity detection
- DB queries use existing Drizzle schema and `Database.use()` pattern

### Requirement 4: Watchdog Actions

**User Story:** As a developer whose child session stalled, I want the watchdog to attempt recovery before cancellation and deliver a detailed diagnostic report, so that the parent agent can make an informed decision about how to proceed.

#### Acceptance Criteria

1. WHEN the watchdog classifies a session as healthy (slow but progressing) THE SYSTEM SHALL exit the watchdog session with no action taken on the stuck session.

2. WHEN the watchdog classifies a session as stuck AND the stuck session is a child session (Layer 2 or Layer 3 stall) THE SYSTEM SHALL first attempt a re-prompt action by sending a nudge message into the stuck child session.

2a. WHEN the watchdog classifies a session as stuck AND the stall is a Layer 1 hung LLM stream THE SYSTEM SHALL proceed directly to the cancel-with-diagnostic action without attempting a re-prompt (re-prompt is not applicable when the stream itself has hung).

3. WHEN the watchdog sends a re-prompt THE SYSTEM SHALL poll `MAX(time_created) FROM part WHERE session_id = ?` every 2 seconds for up to 10 seconds (5 polls total).

4. WHEN the re-prompt polling detects that `MAX(time_created)` has advanced between any two consecutive polls THE SYSTEM SHALL classify the session as recovered and exit with no further action.

5. IF the re-prompt polling detects no advancement in `MAX(time_created)` across all 5 polls THE SYSTEM SHALL fall back to the cancel-with-diagnostic action.

6. WHEN the watchdog cancels a stuck child session THE SYSTEM SHALL call `SessionPrompt.cancel()` on the stuck child session's ID.

7. WHEN the watchdog cancels a stuck child session THE SYSTEM SHALL produce a diagnostic report containing: the failure mode classification, the evidence examined (DB query results, timing data), why the watchdog concluded the session is stuck, and a recommendation for the parent session (retry, skip, try a different approach).

8. WHEN a stuck child session is cancelled by the watchdog THE SYSTEM SHALL deliver the watchdog's diagnostic report to the parent session as the tool result via the `childText()` extraction path.

9. THE SYSTEM SHALL NOT deliver a bare "aborted" error to the parent session when a watchdog cancels a child session.

**Technical Implementation Notes:**

- Re-prompt: `SessionPrompt.prompt({ sessionID: stuckSessionId, parts: [{ type: "text", text: nudgeMessage }] })` — `parts` is the correct field; no `content` field exists in `PromptInput`
- Cancel: `SessionPrompt.cancel(stuckSessionId)` — existing mechanism
- Diagnostic delivery: create `childText()` in `tool/task.ts` (does not exist on `upstream/dev` — currently result extraction is inline at `task.ts:146`) with a WATCHDOG path that reads from the `DiagnosticStore` service; the store is backed by a `Context.Tag` + `Layer.effect` pattern (following `session/status.ts` conventions — `EffectService` helper does not exist)
- The parent LLM sees the diagnostic as the `tool-result` event

### Requirement 5: Diagnostic Report Transport

**User Story:** As a developer running multi-agent workflows, I want the watchdog's diagnostic report to flow through the existing child-to-parent result transport, so that the parent LLM can read the diagnostic in its context window and act on it.

#### Acceptance Criteria

1. WHEN a `task` tool's child session is cancelled by the watchdog THE SYSTEM SHALL extract the diagnostic report via the `childText()` function and return the diagnostic report as the tool result from `task.execute()`.

2. THE SYSTEM SHALL preserve the diagnostic report through the full transport chain: watchdog session output, `childText()` extraction, `task.execute()` return value, AI SDK `tool-result` event, parent `ToolPart.state.output` in the database, and parent LLM context window.

3. WHEN the LLM stream idle timeout fires (Layer 1 stall) THE SYSTEM SHALL deliver the watchdog's findings by halting the current prompt cycle and recording the watchdog diagnostic in the session's error state; the processor SHALL halt (not retry) after a `StreamIdleError`.

4. THE SYSTEM SHALL NOT create a new transport mechanism for diagnostic reports — all diagnostic delivery uses existing `childText()` and processor pipeline paths.

5. WHEN a child session completes normally (not cancelled by watchdog) THE SYSTEM SHALL deliver the normal result through `childText()` with no modification to the existing behavior.

**Technical Implementation Notes:**

- `childText()` (to be created in `tool/task.ts`) has multiple extraction paths; the WATCHDOG path (via `MessageAbortedError` handling) embeds the actual diagnostic from the `DiagnosticStore`
- Layer 1 stall: `StreamIdleError` is caught via `Effect.catchCauseIf` with cause inspection, inserted before the existing `Effect.catchCauseIf` block at `processor.ts:463`. The handler spawns a watchdog via `Effect.forkIn(scope)` and returns `Effect.fail(error)` to halt the current prompt cycle. The processor does NOT retry on `StreamIdleError` — retriable API errors (429/503) use the separate `Effect.catchCauseIf` → `Effect.retry` path.

### Requirement 6: Configuration

**User Story:** As an operator, I want to configure timeout thresholds per tool type and choose the watchdog's model, so that I can tune the system for my specific models and workflows.

#### Acceptance Criteria

1. THE SYSTEM SHALL expose the following configuration entries in the `experimental` config section: per-tool-type watchdog timeout thresholds, LLM stream idle timeout duration, and watchdog model selection (provider and model ID).

2. WHERE the user has not configured a watchdog model THE SYSTEM SHALL use a static per-provider default model declared in the spawn logic: `claude-haiku-4-5` for Anthropic, `gpt-4o-mini` for OpenAI, `gemini-1.5-flash` for Google, and the user's first configured model for any other provider.

3. WHERE the user has configured per-tool-type timeout overrides THE SYSTEM SHALL apply those overrides to the corresponding tool types, leaving unconfigured tool types at their defaults.

4. THE SYSTEM SHALL validate all timeout configuration values as positive integers representing seconds.

5. WHERE the user has configured the LLM stream idle timeout THE SYSTEM SHALL use the configured value instead of the default.

6. THE SYSTEM SHALL NOT expose the watchdog's 60-second self-timeout as a configurable parameter — the self-timeout is a safety ceiling.

**Technical Implementation Notes:**

- New Zod schema entries in `Config.Info` at `packages/opencode/src/config/config.ts` under the `experimental` section
- Existing `experimental` entries include `mcp_timeout` — follow the same pattern
- `task_timeout` does not yet exist in the config schema and must be added
- `DEFAULT_TIMEOUT` and deadline wrapping for the `task` tool do not exist on `upstream/dev` — they will be ported from `local/tool-timeout`

### Requirement 7: Preservation of Existing Behavior

**User Story:** As a developer using OpenCode, I want the watchdog feature to not alter any existing session, tool, or retry behavior for normal (non-stuck) operations, so that the watchdog is a pure addition with no regressions.

#### Acceptance Criteria

1. WHEN a child session completes within its timeout THE SYSTEM SHALL return the result through `task.execute()` with the same behavior as before the watchdog feature was added.

2. THE SYSTEM SHALL NOT modify the existing `SessionPrompt.cancel()` mechanism, `processor.cleanup()`, or `Runner` lifecycle.

3. THE SYSTEM SHALL NOT modify the existing retry policy in `processor.ts` for retriable API errors.

4. THE SYSTEM SHALL NOT modify existing tool permissions, agent definitions (except adding the watchdog agent), or session creation patterns.

5. WHEN no timeout tripwire has fired THE SYSTEM SHALL NOT spawn any watchdog sessions.

6. THE SYSTEM SHALL pass all pre-existing tests without modification after the watchdog feature is added.

**Technical Implementation Notes:**

- Non-requirement: The watchdog does NOT monitor itself. The 60-second hard timeout (Requirement 2.7) is the only safety mechanism for a hung watchdog — no recursive watchdog-of-watchdog (Requirement 2.8).
- All existing tool permissions, retry policies, session creation patterns, and cancellation mechanisms remain unmodified.
