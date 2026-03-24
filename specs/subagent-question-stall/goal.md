# Goal: Headless Subagent Mode — Deny Interactive Questions and Improve Watchdog Error Messaging

## Overview

When a subagent (spawned via the Task tool) tries to ask an interactive question, the entire agent tree stalls. The question tool blocks indefinitely (`Question.ask()` creates a bare `Promise` with no timeout), and since no human or parent agent can see or answer the question, the subagent hangs until the watchdog kills it after ~31 minutes. After the watchdog fires, the parent agent receives a misleading message ("Task was cancelled by user.") that doesn't explain what happened or nudge the parent to retry.

This goal addresses two problems:

1. **Prevention**: Subagents should never be allowed to ask interactive questions. They must run in "headless mode." If a subagent has unresolved questions, it should communicate them as structured output alongside its results — never block waiting for an answer.
2. **Clear error messaging**: When the watchdog kills a subagent, the parent must receive a clear, actionable error message that explains what happened and nudges toward retrying the task.

## User Stories

- As an agent developer, I want subagents to run autonomously without interactive prompts, so that the agent tree never stalls on unanswered questions.
- As a parent agent (LLM), I want clear error messages when a child task is killed by the watchdog, so that I can decide whether to retry, adjust my approach, or escalate to the user.
- As a user, I want my agent sessions to make continuous forward progress, so that I don't encounter indefinite "thinking" states caused by stuck subagent trees.

## Behaviors

### Deny Question Tool for All Subagents

- Any session with a `parentID` (i.e., any session spawned via the Task tool) must have the question tool denied and physically removed from the LLM tool list.
- This applies to ALL depths — depth-1 (direct children of the primary session), depth-2 (grandchildren), and beyond.
- Currently, only depth-2+ children have the question tool denied (`task.ts:133,164-171`). Depth-1 children are allowed to ask questions — this is the design flaw being fixed.
- The denial must use the existing dual-layer mechanism: (1) session-level permission deny rule, and (2) physical removal from the tool map passed to `SessionPrompt.prompt()`.
- After this change, only the **primary session** (the one the human user interacts with directly) can use the question tool.

### Subagent Question Communication Pattern

- Subagents that encounter uncertainty or need clarification should communicate their open questions as part of their result text, alongside whatever partial findings they have.
- The parent agent then evaluates whether it can answer the question itself (using context from other subagents), or whether it needs to escalate to its own parent, or ultimately to the user.
- Each agent in the chain must evaluate for itself whether it can resolve the question or needs to escalate.
- This is a behavioral guideline enforced by the system prompt / agent definitions — not a code mechanism. The code change is simply denying the question tool.

### Improve Watchdog Kill Error Messages

- When a child task is killed by the watchdog (tool execution exceeded maximum allowed duration), the error text returned to the parent LLM must clearly state:
  - That the subagent was killed due to exceeding the maximum allowed execution time.
  - The task_id for potential resumption.
  - A nudge to **retry the task** with a simpler or more focused prompt, rather than attempting to do the research directly.
- The current message `"Task was cancelled by user."` is misleading for watchdog kills. The parent LLM interprets this as a deliberate user cancellation, not a timeout.
- The current message `"TIMEOUT: Task exceeded Xs deadline and was cancelled."` is better but could be improved. The nudge text currently says "retry up to 5 times before giving up" — it should also suggest simplifying the prompt or breaking the work into smaller tasks.
- The error message should distinguish between: (a) user-initiated cancellation (Ctrl+C / ESC), (b) deadline timeout (the task tool's own timer), and (c) watchdog kill (the system-level safety net).

### Error Path Behavior

- When `SessionPrompt.cancel()` is called by the watchdog on a child session:
  1. The child's `AbortController` is signalled.
  2. `Question.rejectSession()` is called (unblocking any pending question — though after this fix, subagents won't have the question tool at all).
  3. `PermissionNext.rejectSession()` is called (unblocking pending permissions).
  4. The child's processor catches the `AbortError`, runs cleanup, and the loop exits.
  5. The parent's `raceSignal` settles (either resolving with the child's last message, or rejecting if the deadline also fired).
  6. The parent LLM receives the error text and can decide to retry or move on.
- The error text formatting happens in `task.ts` — specifically in the catch block (`task.ts:285-326`) and the `childText()` function (`task.ts:38-92`).

## Edge Cases & Invariants

### Invariants (always true)

- A session with a `parentID` never has the question tool available in its LLM tool list.
- A session without a `parentID` (primary session) always has the question tool available (subject to agent definition permissions).
- The question tool's permission deny rule and the tools map `{ question: false }` are always applied together for subagent sessions — never one without the other.
- The parent agent always receives a tool result (success or error text) when a child task completes, times out, or is killed — never an indefinitely pending promise.

### Idempotent Operations

- Calling `SessionPrompt.cancel()` on an already-cancelled session is safe and has no harmful side effects (idempotent at the session level, though the earlier investigation identified issues with the no-op path — see Technical Context).

### Preservation (must not change)

- The question tool continues to work normally for primary sessions (user-facing agents).
- `Question.ask()` retains its current behavior for primary sessions: it blocks indefinitely waiting for a human response, with no timeout.
- The watchdog's core timeout mechanism (scanning for stuck tool parts, calling `SessionPrompt.cancel()`) continues to work as-is. Only the error messages change.
- The `task_id` resumption mechanism continues to work — killed tasks can be resumed by passing `task_id` in a subsequent task tool call.
- Depth-2+ subagents continue to have the question tool denied (existing behavior preserved, now extended to depth-1).

### Known Edge Cases

- **Context compaction in subagents**: A subagent that has been compacted may lose context about its task and attempt to ask a clarifying question. After this fix, it won't have the question tool, so it will need to work with whatever context it has or return a partial result with explicit uncertainty markers.
- **Agent definitions with explicit question permission**: Some agent definitions may explicitly allow the question tool. The session-level deny rule from the task tool must override agent-level defaults. The current mechanism at `llm.ts:281-290` (`resolveTools`) already handles this correctly — session-level deny rules take precedence.
- **Watchdog kill during parallel tool execution**: If a subagent has multiple tools running in parallel when the watchdog fires, all of them should be marked as error in the cleanup sweep.
- **Race between task deadline and watchdog**: Both the task tool's own deadline (via `raceSignal`) and the watchdog can independently kill a child session. The parent should receive a clear error message regardless of which one fires first.

## Constraints

- **Language/Runtime**: TypeScript on Bun runtime.
- **Files to modify**: Primarily `packages/opencode/src/tool/task.ts` (question denial scope change + error message improvement). May also touch `packages/opencode/src/session/prompt.ts` if the `cancel()` error propagation needs adjustment.
- **Backward compatibility**: No changes to the public API, CLI interface, or configuration schema. This is an internal behavioral fix.
- **No new dependencies**: Use existing `AbortController`, `raceSignal`, and session infrastructure.
- **Test location**: Tests run from `packages/opencode/`, not from repo root. Existing test pattern in `packages/opencode/test/session/task-error.test.ts`.

## Out of Scope

- **Session lifecycle race conditions (Bugs #1-#3 from the investigation)**: The `defer(() => cancel(id))` killing new loops, zombie children from early abort, and dropped callbacks are real bugs identified in the earlier investigation (`scratch/stuck-subagent-investigation.md`). They are critical but represent a deeper architectural fix to the session lifecycle — they should be addressed in a separate goal/spec.
- **Watchdog restructuring (Bugs #4-#6 from the investigation)**: The idle detection being gated behind the 45-minute absolute timeout, `leaf.length === 0` skipping idle detection, and no-op cancel removing activity tracking are related but separate fixes. A restructured watchdog with decoupled fast idle check + slow absolute check should be a separate goal.
- **Iterator leak on abort (Bug #8)**: The async iterator not being closed when the abort promise wins `Promise.race` is a resource leak but doesn't directly cause the stuck-agent symptom.
- **`abortChildren` not calling `SessionPrompt.cancel()` (Bug #7)**: This is a defense-in-depth issue — the primary cancel path works via the abort signal chain, but the cleanup sweep's `abortChildren()` should also call cancel. Separate fix.
- **Adding a timeout to `Question.ask()`**: The user decided against this. Primary sessions wait indefinitely for human input. Subagents simply don't get the question tool at all.
- **Heartbeat / supervisor patterns**: While the web research surfaced OTP-style supervisor patterns and heartbeat protocols, implementing these is a larger architectural change. The immediate fix is simpler: deny the tool and improve the message.
- **Changes to agent system prompts**: While the "communicate questions as structured output" pattern is desirable, modifying agent system prompts to instruct subagents on how to handle uncertainty is a separate concern (agent authoring, not code).

## Success Criteria

- A depth-1 subagent session spawned via the Task tool does NOT have the question tool in its LLM tool list — verified by inspecting the tools passed to `streamText()` in a test.
- A depth-2+ subagent session continues to NOT have the question tool (regression check).
- The primary session (no `parentID`) continues to have the question tool available.
- When a child task is killed by the watchdog, the parent LLM receives an error message that: (a) mentions "watchdog" or "maximum allowed duration", (b) includes the `task_id`, and (c) suggests retrying with a simpler prompt.
- When a child task hits its own deadline timeout, the parent LLM receives a distinct error message that mentions "deadline" or "timeout" — not "cancelled by user."
- When the user manually cancels (Ctrl+C), the parent receives a message indicating user cancellation.
- All existing tests in `task-error.test.ts` continue to pass.
- New tests cover: (a) depth-1 subagent cannot use question tool, (b) watchdog kill produces correct error text for parent.

## Technical Context

### Codebase Findings

- **Question tool denial mechanism** (`task.ts:133,164-171,234` + `llm.ts:281-290`): Currently uses a `nested` flag — `const nested = !!(await Session.get(ctx.sessionID)).parentID` — to determine if the CALLING session has a parent. If `nested = true` (depth-2+), the question tool is denied. The fix is to deny the question tool regardless of depth — any child session (any session with `parentID`) should deny it.
- **Error message generation** (`task.ts:38-92,267-326`): The `childText()` function extracts the last text from the child's result. The catch block at `task.ts:285` handles timeouts and aborts. The message formatting uses `TIMEOUT:` prefix for deadline errors and `"Task was cancelled by user."` for abort errors.
- **Watchdog kill flow** (`bootstrap.ts:140-173` → `prompt.ts:258-275`): The watchdog calls `SessionPrompt.cancel(childSession)`, which fires `abort.abort()`, calls `Question.rejectSession()` and `PermissionNext.rejectSession()`, then deletes the state. The child processor catches `AbortError`, runs cleanup, and the loop exits.
- **`raceSignal` utility** (`abort.ts:42-57`): Races a promise against an abort signal. If the signal fires first, rejects with the error message. If the promise settles first, resolves/rejects normally.
- **Test infrastructure** (`test/session/task-error.test.ts`): Comprehensive tests for task timeout, grandchild hang rescue, and parent abort breaking stuck children. No tests for question tool denial at depth-1, or for watchdog error message content.

### Related Investigation

- A thorough investigation exists at `scratch/stuck-subagent-investigation.md` identifying 10 bugs in the session lifecycle and watchdog system. This goal addresses the root trigger (question tool access, Bugs #0) and the notification clarity (improved messages). The deeper session lifecycle bugs (#1-#10) are documented there for future work.

### Library & API Findings

- **AbortController patterns**: The `signal.throwIfAborted()` pattern should be used as the first line of any abortable function. Each new task attempt needs a fresh `AbortController` — never reuse aborted signals. Generation/epoch counters prevent the "stale cancel kills new task" race (relevant to Bug #1 from the investigation).
- **AI framework patterns for headless subagents**: Industry best practice (LangGraph, AutoGen, OpenAI Agents SDK) is to have subagents return structured output with `clarification_needed: boolean` and `questions: string[]` fields rather than blocking on interactive prompts. This aligns with the user's design decision.
- **OTP supervisor patterns**: The `one_for_one` restart strategy maps well to the task tool's retry behavior. The generation counter pattern prevents stale cancels from killing new task instances.

## Open Questions (Resolved)

| #   | Question                                                                                                | Resolution                                                                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Should depth-1 subagents ever be allowed to ask questions?                                              | No. All subagents run headless. If they have questions, they communicate them as part of their result text. The parent evaluates whether to answer or escalate.                                                                                                                              |
| 2   | Which fixes are in scope — A (deny question), B (add timeout), C (faster watchdog), D (error messages)? | A and D only. B is unnecessary (primary sessions wait indefinitely, subagents don't get the tool). C is a separate watchdog restructuring goal.                                                                                                                                              |
| 3   | Should `Question.ask()` have a timeout for primary sessions?                                            | No. Primary sessions wait indefinitely for human input. The fix is preventing subagents from calling it at all.                                                                                                                                                                              |
| 4   | Should the parent automatically retry killed tasks?                                                     | No — the current behavior (parent LLM decides) is fine. But the error message should nudge toward retrying with a simpler prompt rather than attempting to do the work directly.                                                                                                             |
| 5   | Are the deeper session lifecycle bugs (investigation Bugs #1-#10) in scope?                             | No. They are documented in `scratch/stuck-subagent-investigation.md` for future work. This goal fixes the root trigger and the notification clarity.                                                                                                                                         |
| 6   | Where should the `nested` check change in `task.ts`?                                                    | The change is at `task.ts:133` — instead of `const nested = !!(await Session.get(ctx.sessionID)).parentID`, the question denial should apply unconditionally for all child sessions. The simplest approach: always deny question for child sessions (any session created via the task tool). |
