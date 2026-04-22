# Requirements Document

## Introduction

This document specifies the requirements for adding tool-aware fire suppression to the stream idle tripwire in OpenCode's intelligent watchdog system. The tripwire (`startStreamIdleTripwire` in `processor.ts`) currently fires `StreamIdleError` after a configurable silence window, even when the silence is caused by healthy tool execution. This change makes the tripwire check whether tools are in-flight before firing, suppressing false positives while preserving detection of genuinely stuck LLM connections.

**Tech stack**: TypeScript, Bun 1.3.12, Effect-TS, Vercel AI SDK  
**Source of truth**: `specs/2026-04-22-stream-idle-tool-suppression/goal.md`  
**Branch**: `local-integrated` (cherry-picked to `local/intelligent-session-watchdog`)

## Glossary

- **Stream idle tripwire**: A `setTimeout`-based timer in `processor.ts` that fires `StreamIdleError` when no AI SDK stream events arrive within `stream_idle` seconds. Resets on every `Stream.tap` event.
- **In-flight tool**: A tool whose lifecycle is active -- present as an entry in `ctx.toolcalls`. Includes tools in `pending` status (arguments being streamed) and `running` status (executing). Entry added at `tool-input-start`, removed at `settleToolCall`.
- **Re-arm**: Clearing and restarting the idle timer for another full interval without firing `StreamIdleError`.
- **`ctx.toolcalls`**: A `Record<string, ToolCall>` on `ProcessorContext` (processor.ts:98). Presence of a key means the tool lifecycle is active; absence means done.
- **Per-tool tripwire**: A separate mechanism (`startToolTripwire` in `session/prompt.ts:64-89`) that enforces per-tool-type timeouts. Unrelated to the stream idle tripwire and unchanged by this work.
- **Watchdog agent**: An LLM agent spawned by `spawnWatchdog` to investigate stuck sessions. Unchanged by this work.

## Requirements

### Requirement 1: Tool-Aware Fire Suppression

**User Story:** As a developer running multi-agent workflows, I want the stream idle tripwire to suppress firing while tools are in-flight, so that long-running bash commands, MCP calls, and child sessions complete successfully without false `StreamIdleError` aborts.

#### Acceptance Criteria

1. WHILE the in-flight tool count is greater than zero WHEN the stream idle timer expires THE SYSTEM SHALL re-arm the timer for another `stream_idle` interval without firing `StreamIdleError`.
2. WHILE the in-flight tool count is zero WHEN the stream idle timer expires THE SYSTEM SHALL fire `StreamIdleError` and abort the stream via `controller.abort()`.
3. WHILE tools are in-flight THE SYSTEM SHALL re-arm the timer on each expiration, with no upper limit on the number of consecutive re-arms.
4. THE SYSTEM SHALL use the same `stream_idle` interval for re-arm timers as for the initial timer.
5. THE SYSTEM SHALL NOT set the `fired` flag to `true` during a re-arm.

**Technical Implementation Notes:**

- The in-flight tool count is obtained via a getter function `getActiveToolCount` passed as an option to `startStreamIdleTripwire`.
- `ctx.toolcalls` entries are added at the `tool-input-start` event (processor.ts:290) and removed by `settleToolCall` (processor.ts:165). Both `pending` and `running` statuses count as in-flight.

### Requirement 2: Signal Plumbing Interface

**User Story:** As a developer maintaining the watchdog system, I want the tool-awareness mechanism to be cleanly injected via an options parameter, so that the tripwire function remains testable in isolation and backward compatible.

#### Acceptance Criteria

1. THE SYSTEM SHALL accept an optional third parameter of type `{ getActiveToolCount?: () => number }` on `startStreamIdleTripwire`.
2. WHEN the options parameter is omitted THE SYSTEM SHALL fire unconditionally on timeout, identical to the current behavior.
3. WHILE `getActiveToolCount` is provided WHEN the stream idle timer expires with `getActiveToolCount` returning zero THE SYSTEM SHALL fire `StreamIdleError`.
4. THE SYSTEM SHALL call `getActiveToolCount` at most once per timer expiration.
5. THE SYSTEM SHALL pass `{ getActiveToolCount: () => Object.keys(ctx.toolcalls).length }` at the call site in `processor.ts`.

**Technical Implementation Notes:**

- The getter is a function (not a snapshot) because `ctx.toolcalls` is mutated during the stream lifecycle.
- The options object pattern is chosen for extensibility and call-site readability.

### Requirement 3: Existing Behavior Preservation

**User Story:** As a developer relying on the watchdog system, I want the stream idle tripwire to continue protecting child sessions with genuinely stuck LLM connections, so that stuck sessions are still detected and recovered.

#### Acceptance Criteria

1. THE SYSTEM SHALL skip the tripwire entirely for root sessions (where `streamInput.parentSessionID` is falsy).
2. WHEN `reset()` is called THE SYSTEM SHALL clear and restart the timer, including during a re-arm cycle.
3. WHEN `clear()` is called THE SYSTEM SHALL cancel the timer and prevent future firing.
4. WHILE `parentSessionID` exists WHEN `StreamIdleError` fires THE SYSTEM SHALL spawn a watchdog agent via `spawnWatchdog`.
5. THE SYSTEM SHALL NOT modify `startToolTripwire`, `spawnWatchdog`, the watchdog agent, or watchdog tools.
6. THE SYSTEM SHALL NOT modify the `stream_idle` default value (300 seconds).
7. THE SYSTEM SHALL NOT modify the task tool deadline mechanism in `task.ts`.

**Technical Implementation Notes:**

- The `parentSessionID` ternary at the call site (processor.ts:586) is unchanged.
- The `StreamIdleError` catch handler (processor.ts:616-627) is unchanged.

### Requirement 4: Race Safety

**User Story:** As a developer, I want the tripwire to behave correctly regardless of the relative timing between tool completion and timer expiration, so that no race condition causes incorrect behavior.

#### Acceptance Criteria

1. IF the in-flight tool count transitions from greater than zero to zero before the timer fires THE SYSTEM SHALL fire `StreamIdleError` on the next timer expiration.
2. IF the timer fires while the in-flight tool count is greater than zero THE SYSTEM SHALL re-arm the timer.
3. IF `clear()` is called during a re-arm cycle (tools in-flight, timer re-armed) THE SYSTEM SHALL cancel the re-armed timer and prevent future firing.

**Technical Implementation Notes:**

- JavaScript is single-threaded; both orderings are safe because `fire()` and `settleToolCall` cannot interleave within a single microtask.
- The `clear()` method sets `fired = true` which prevents any subsequent `fire()` from executing.

### Requirement 5: Test Coverage

**User Story:** As a developer maintaining the watchdog tests, I want comprehensive test coverage for the new tool-aware suppression behavior, so that regressions are caught immediately.

#### Acceptance Criteria

1. THE SYSTEM SHALL include a test that verifies suppression when `getActiveToolCount` returns a value greater than zero.
2. THE SYSTEM SHALL include a test that verifies firing after tools complete (count transitions from greater than zero to zero).
3. THE SYSTEM SHALL include a test that verifies multiple consecutive re-arm cycles while tools remain in-flight.
4. THE SYSTEM SHALL include a test that verifies `clear()` prevents firing during a tool-suppressed state.
5. THE SYSTEM SHALL include a test that verifies unconditional firing when `getActiveToolCount` returns zero (same as no-options behavior).
6. THE SYSTEM SHALL correct the stale `WATCHDOG_TIMEOUT_DEFAULTS.stream_idle` assertion from 120 to 300 in the existing test.
7. THE SYSTEM SHALL preserve all existing tripwire tests without behavioral modification.
