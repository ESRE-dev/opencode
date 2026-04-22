# Goal: Stream Idle Tripwire Tool-Aware Suppression

## Overview

The intelligent watchdog's stream idle tripwire (`startStreamIdleTripwire` in `processor.ts`) fires `StreamIdleError` when no AI SDK stream events arrive within the configured `stream_idle` timeout (currently 300 seconds). The tripwire is already gated to child sessions only (root sessions skip it entirely). However, it still produces false positives on child sessions during normal tool execution.

The root cause: when the AI SDK's `streamText()` makes a tool call, the `fullStream` async iterable does not yield any events between the `tool-call` event and the `tool-result` event. The `tool-result` is emitted only after `tool.execute()` resolves. For long-running tools (bash commands, MCP calls, task child sessions), this healthy silence window can last minutes to hours. The idle tripwire interprets this as a stuck LLM connection and spawns a watchdog agent unnecessarily, which then cancels a perfectly healthy session.

The fix is surgical: before firing, the tripwire checks whether any tools are currently in-flight via `ctx.toolcalls`. If tools are present in the map (regardless of their `pending`/`running` status), the silence is expected -- re-arm the timer instead of aborting. Once all tools complete and the stream resumes, the timer resets normally via `Stream.tap`. If tools finish but the stream still doesn't resume within the next timeout window, the tripwire fires as intended.

## Relationship to Prior Work

This goal is a targeted refinement of the `specs/intelligent-watchdog/goal.md` system. It addresses a specific false-positive path discovered during live testing of the `local/intelligent-session-watchdog` branch. The broader watchdog architecture (tripwires, watchdog agent, tools, diagnostic delivery) is unchanged.

## User Stories

- As a developer running multi-agent workflows, I want the stream idle tripwire to not kill my child sessions while their tools are executing, so that long-running bash commands, MCP calls, and sub-subagent tasks complete successfully.
- As a developer with a genuinely stuck child session (dead LLM connection with no tools running), I want the tripwire to still detect and recover via watchdog spawn, so that stuck sessions don't hang indefinitely.

## Behaviors

### Tool-Aware Fire Suppression

- When the stream idle timer expires, the tripwire checks whether any tools are in-flight by inspecting the count of entries in `ctx.toolcalls`. Presence in `ctx.toolcalls` means the tool lifecycle is active (entry added at `tool-input-start`, removed at `settleToolCall`). This includes tools in `pending` status (args being streamed) and `running` status (executing). Both states indicate expected stream silence.
- If the count is greater than zero: the tripwire re-arms its timer for another `stream_idle` interval and does NOT fire `StreamIdleError`.
- If the count is zero: the tripwire fires `StreamIdleError` as it does today, spawning a watchdog.
- Re-arming can happen an unlimited number of times. As long as tools are in-flight, the tripwire stays dormant.
- The re-arm interval is the same as the original `stream_idle` interval (no separate "tool check" interval).

### Signal Plumbing

- `startStreamIdleTripwire` accepts an optional third parameter: an options object with shape `{ getActiveToolCount?: () => number }`. The full signature becomes: `startStreamIdleTripwire(ms: number, sessionID: string, opts?: { getActiveToolCount?: () => number })`.
- The call site in `processor.ts` passes `{ getActiveToolCount: () => Object.keys(ctx.toolcalls).length }`.
- This is a getter function (not a snapshot) because `ctx.toolcalls` mutates during the stream lifecycle.
- When the options parameter is omitted or `getActiveToolCount` is undefined, the tripwire behaves exactly as it does today (unconditional fire on timeout). This preserves backward compatibility with existing tests and any other callers.

### Existing Behavior Preserved

- Root sessions continue to skip the tripwire entirely (the `streamInput.parentSessionID` ternary is unchanged).
- `reset()` on every `Stream.tap` event continues to work as before.
- `clear()` on stream completion continues to work as before.
- The `StreamIdleError` catch handler, watchdog spawn, and retry pipeline are unchanged.
- The per-tool tripwire (`startToolTripwire` in `prompt.ts`) is unchanged.
- The task tool deadline (`task.ts`) is unchanged.

## Edge Cases & Invariants

### Invariants (always true)

- A child session with in-flight tools (non-empty `ctx.toolcalls`) is never aborted by the stream idle tripwire.
- A child session with NO in-flight tools AND no stream events for `stream_idle` seconds IS aborted by the stream idle tripwire (this is the "truly stuck" case).
- The tripwire's `fired` flag is never set to `true` during a re-arm. Only an actual abort or an explicit `clear()` sets it.

### Idempotent Operations

- Multiple consecutive re-arms (from repeated timer expirations while tools are running) produce the same result as a single re-arm: the timer is reset, no abort occurs.
- Calling `reset()` during a re-arm cycle works identically to calling it during the initial timer -- it clears the current timer and starts a new one.

### Round-trip Guarantees

- None specific to this change.

### Preservation (must not change)

- The `startStreamIdleTripwire` public API for callers that don't pass the optional getter must behave identically to the current implementation.
- All existing behavioral tests for the tripwire pass without modification (they don't pass a getter, so they exercise the unconditional-fire path). The stale `stream_idle` value assertion (120 vs 300) is corrected as part of this change -- that is a data fix, not a behavioral change.
- The `startToolTripwire`, `spawnWatchdog`, watchdog agent, and watchdog tools are completely untouched.

### Known Edge Cases

- **Tool itself is stuck**: A tool could be in-flight but making no progress (e.g., bash command hung waiting on input, MCP server unresponsive). The stream idle tripwire will keep re-arming because the tool is present in `ctx.toolcalls`. This is the correct behavior for this goal -- per-tool stuck detection is a separate concern (see `specs/2026-04-22-per-tool-stuck-detection/goal.md`). The per-tool tripwire (`startToolTripwire`) already provides a separate deadline for this case.
- **`ctx.toolcalls = {}` wholesale reset in cleanup**: During session teardown, `cleanup()` resets `ctx.toolcalls` to `{}` (processor.ts:551). This is fine -- the tripwire has already been `clear()`-ed by the `Effect.ensuring` wrapper (Effect runs inner-to-outer finalizers, so `ensuring(clear)` at the stream level runs before `cleanup()` at the process level).
- **Tool entries added in `tool-input-start`, not `tool-call`**: The AI SDK event that populates `ctx.toolcalls` is `tool-input-start` (processor.ts:290), which fires before `tool.execute()` begins. The timing is correct for our purposes -- the entry exists before the silence window begins.
- **Race between timer expiry and tool completion**: If a tool completes (entry deleted from `ctx.toolcalls`) at nearly the same time the timer fires, both orderings are safe. If delete happens first: `fire()` sees zero tools, fires correctly (the stream should resume shortly via `tool-result`). If timer fires first: `fire()` sees non-zero tools, re-arms (tool will complete, stream will resume, `reset()` will clear the re-armed timer).
- **Re-arm interval choice**: Using the same `stream_idle` interval for re-arm means worst-case detection latency after tools finish is `stream_idle` seconds (currently 300s = 5 min). This is acceptable because once tools finish, the next stream event from the AI SDK (the `tool-result`) arrives immediately, triggering `reset()`. The re-arm timer only matters if the stream is genuinely stuck after tool completion.

## Constraints

- **Branch**: Changes apply to `local-integrated` and are cherry-picked to `local/intelligent-session-watchdog`.
- **Files modified**: Only `packages/opencode/src/session/processor.ts` (function + call site) and `packages/opencode/test/watchdog/tripwires.test.ts` (new tests + stale assertion fix).
- **No new dependencies**: Pure logic change using existing `ctx.toolcalls` mechanism.
- **Backward compatible**: Optional parameter preserves existing call signatures.

## Out of Scope

- Per-tool stuck detection (monitoring whether a running tool is making progress). That is covered by `specs/2026-04-22-per-tool-stuck-detection/goal.md`.
- Changes to `startToolTripwire`, `spawnWatchdog`, the watchdog agent, or watchdog tools.
- Changes to the `stream_idle` default value (already set to 300 seconds).
- Changes to root session behavior (root sessions already skip the tripwire).
- Any new config options.

## Success Criteria

- A child session executing a long-running tool (simulated with a delayed resolve in tests) does not trigger `StreamIdleError` while the tool is present in `ctx.toolcalls`.
- The same child session with no running tools and no stream events DOES trigger `StreamIdleError` after the configured timeout.
- All existing tripwire tests pass without modification.
- New tests cover: tool-aware suppression, multiple re-arm cycles, fire after tools complete, clear during suppression.
- The stale `WATCHDOG_TIMEOUT_DEFAULTS.stream_idle` test assertion (currently 120, should be 300) is corrected.
- `bun typecheck` passes from `packages/opencode` with 0 errors in `processor.ts` and `tripwires.test.ts`.

## Technical Context

### Codebase Findings

- **`startStreamIdleTripwire`** (`processor.ts:26-53`): Pure function returning `{ signal, reset(), clear(), fired }`. The `fire()` closure checks only `if (fired) return` before aborting -- no tool awareness. Signature: `(ms: number, sessionID: string)`.
- **`ctx.toolcalls`** (`processor.ts:98`): `Record<string, ToolCall>` on `ProcessorContext`. Entries added at `tool-input-start` event (processor.ts:290-311). Entries deleted by `settleToolCall` (processor.ts:165-168), `readToolCall` defensive cleanup (processor.ts:172-180), and wholesale reset in `cleanup()` (processor.ts:551). Presence in the map = tool lifecycle active (may be `pending` or `running` status), absence = done.
- **Call site** (`processor.ts:586`): `const idle = streamInput.parentSessionID ? startStreamIdleTripwire(idleMs, ctx.sessionID) : undefined` -- already gated on child sessions.
- **`StreamIdleError` catch handler** (`processor.ts:616-627`): Catches the error, spawns watchdog if `parentSessionID` exists, then re-throws as `Effect.fail(err)`.
- **`startToolTripwire`** (`prompt.ts:64-89`): Separate mechanism, purely fixed timer, no liveness check. Fires `spawnWatchdog` for per-tool deadlines. Not affected by this change.
- **`spawnWatchdog`** (`spawn.ts:42-127`): Guards on `!input.parentSessionID` at line 43. Creates child session, builds diagnostic prompt, runs cheap model with watchdog tools.
- **Test file** (`test/watchdog/tripwires.test.ts`): 5 existing tests for stream idle tripwire (none test tool awareness). One stale assertion: `stream_idle` expected 120 but actual is 300. Runtime error from circular dep in `app-runtime.ts` -- pre-existing, not caused by our changes.

### Library & API Findings

- **AI SDK `fullStream` behavior**: Does not literally block during tool execution. The `tool-result` event is simply not emitted until `execute()` resolves. Between `tool-call` and `tool-result`, zero events flow through the stream. This is observed behavior consistent with the single-step execution model -- no Vercel doc explicitly guarantees it, but it follows from how `run-tools-transformation.ts` awaits `execute()` before yielding the result. This silence window is what causes false tripwire alarms. (Source: sdk.vercel.ai/docs/reference/ai-sdk-core/stream-text)
- **Event ordering within a step**: `start-step` -> `tool-call` -> [tool executes, no events] -> `tool-result` -> `finish-step`. The event type inventory is documented in the `streamText()` API reference. (Source: sdk.vercel.ai/docs/reference/ai-sdk-core/stream-text)
- **OpenCode uses single-step `streamText()`**: Each `streamText()` call is one LLM inference step -- `maxSteps` is not passed (defaults to 1 in AI SDK v4). Multi-turn is handled by OpenCode's own while-loop in `prompt.ts`. This means tool execution happens inside a single step's stream, and the silence is within a step, not between steps. (Source: `prompt.ts` `streamText()` call site)

## Open Questions (Resolved)

| #   | Question                                                                         | Resolution                                                                                                                                                                                                                                                                                      |
| --- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Should the getter be a function or a direct reference to the record?             | Function (`() => number`). The record mutates during the stream lifecycle; a snapshot would go stale. A count getter is simpler than exposing the full record.                                                                                                                                  |
| 2   | Should the optional parameter be a positional arg or an options object?          | Options object (`{ getActiveToolCount?: () => number }`). More extensible if we need to add other options later, and clearly self-documenting at the call site.                                                                                                                                 |
| 3   | Should re-arm use the same interval or a shorter "check" interval?               | Same interval. Once tools finish, the AI SDK immediately emits `tool-result`, which triggers `reset()`. A shorter check interval adds complexity for no practical benefit.                                                                                                                      |
| 4   | What about the pre-existing test runtime error (circular dep in app-runtime.ts)? | Out of scope. The tripwire tests import from `processor.ts` which pulls in the full dependency graph. This is a pre-existing test infrastructure issue unrelated to our change. The tests should still be written correctly -- they may need the circular dep fixed separately to actually run. |
| 5   | Should the stale `stream_idle` test assertion (120 vs 300) be fixed?             | Yes, as part of this change. It's a one-line fix in the same test file we're modifying.                                                                                                                                                                                                         |
