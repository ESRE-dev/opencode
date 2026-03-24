# Requirements Document

## Introduction

This specification addresses a bug in OpenCode where subagent sessions spawned via the Task tool can call the interactive `question` tool, causing the entire agent tree to stall indefinitely. The fix has two parts: (1) deny the question tool for ALL subagent sessions regardless of depth, and (2) improve error messages when the watchdog kills a stuck subagent so the parent LLM receives actionable feedback.

**Tech stack**: TypeScript on Bun runtime. Changes are internal to the `packages/opencode` package.

**Source of truth**: `specs/subagent-question-stall/goal.md`

## Glossary

- **Primary session**: The top-level session the human user interacts with directly. Has no `parentID`.
- **Subagent session**: Any session spawned via the Task tool. Has a `parentID` linking to the spawning session.
- **Depth-1 subagent**: A direct child of the primary session (one level deep).
- **Depth-2+ subagent**: A grandchild or deeper descendant of the primary session.
- **Question tool**: The interactive tool (`tool/question.ts`) that blocks execution waiting for human input via `Question.ask()`.
- **Watchdog**: The system-level safety net (`packages/opencode/src/project/bootstrap.ts`) that scans for stuck tool parts and calls `SessionPrompt.cancel()` after a maximum allowed duration.
- **Deadline timeout**: The task tool's own configurable timer that cancels a child session via `raceSignal` when the deadline elapses.
- **User cancellation**: The human pressing Ctrl+C or ESC to cancel an operation, triggering `SessionPrompt.cancel()`.
- **Permission deny rule**: A session-level rule that marks a tool as denied, checked during tool resolution in `resolveTools()`.
- **Tools map**: The `{ question: false }` object passed to `SessionPrompt.prompt()` that physically removes tools from the LLM tool list.

## Requirements

### Requirement 1: Deny Question Tool for All Subagent Sessions

**User Story:** As an agent developer, I want subagents to run autonomously without interactive prompts, so that the agent tree never stalls on unanswered questions.

#### Acceptance Criteria

1. WHEN the Task tool creates a child session THE SYSTEM SHALL add a permission deny rule for the question tool to the child session, regardless of the depth of the spawning session.

2. WHEN the Task tool invokes `SessionPrompt.prompt()` for a child session THE SYSTEM SHALL pass a tools map that excludes the question tool, regardless of the depth of the spawning session.

3. THE SYSTEM SHALL apply both the permission deny rule and the tools map exclusion together for every subagent session — never one mechanism without the other.

4. WHEN a subagent session's LLM tool list is resolved via `resolveTools()` THE SYSTEM SHALL exclude the question tool from the list passed to `streamText()`.

5. WHEN a primary session (a session without a `parentID`) is created THE SYSTEM SHALL retain the question tool in the LLM tool list, subject to agent definition permissions.

6. IF an agent definition explicitly allows the question tool for a subagent session THEN THE SYSTEM SHALL deny the question tool via the session-level deny rule, overriding the agent-level default.

### Requirement 2: Distinguish Watchdog Kill Error Messages

**User Story:** As a parent agent (LLM), I want clear error messages when a child task is killed, so that I can decide whether to retry, adjust my approach, or escalate to the user.

#### Acceptance Criteria

1. WHEN the watchdog kills a child session THE SYSTEM SHALL return an error message to the parent that contains the phrase "watchdog" or "maximum allowed duration".

2. WHEN the watchdog kills a child session THE SYSTEM SHALL include the child session's `task_id` in the error message returned to the parent.

3. WHEN the watchdog kills a child session THE SYSTEM SHALL include a suggestion to retry the task with a simpler or more focused prompt in the error message returned to the parent.

4. WHEN a child session exceeds the task tool's deadline timeout THE SYSTEM SHALL return an error message to the parent that contains the phrase "deadline" or "timeout".

5. WHEN a child session exceeds the task tool's deadline timeout THE SYSTEM SHALL NOT return an error message containing the phrase "cancelled by user".

6. WHEN the user cancels a child session via Ctrl+C or ESC THE SYSTEM SHALL return an error message to the parent that indicates user-initiated cancellation.

7. THE SYSTEM SHALL produce distinct error message text for each of the three kill paths: user cancellation, deadline timeout, and watchdog kill.

### Requirement 3: Preserve Primary Session Question Behavior

**User Story:** As a user, I want the question tool to continue working normally in my direct session, so that agents can ask me clarifying questions when needed.

#### Acceptance Criteria

1. WHILE a primary session is active THE SYSTEM SHALL allow `Question.ask()` to wait for human input without enforcing any timeout or automatic cancellation.

2. THE SYSTEM SHALL NOT modify the `Question.ask()` implementation or add any timeout mechanism to the question tool.

3. WHEN `SessionPrompt.cancel()` is called on a primary session THE SYSTEM SHALL call `Question.rejectSession()` to unblock any pending question.

### Requirement 4: Parent Always Receives Task Result

**User Story:** As a user, I want my agent sessions to make continuous forward progress, so that I don't encounter indefinite "thinking" states caused by stuck subagent trees.

#### Acceptance Criteria

1. WHEN a child task completes successfully THE SYSTEM SHALL return the child session's last text content to the parent as a tool result.

2. WHEN a child task is killed by the watchdog THE SYSTEM SHALL return an error text to the parent within 5 seconds of the watchdog firing.

3. WHEN a child task exceeds the deadline timeout THE SYSTEM SHALL return an error text to the parent within 5 seconds of the deadline elapsing.

4. THE SYSTEM SHALL return a tool result (success or error text) to the parent for every child task invocation — never an indefinitely pending promise.

### Requirement 5: Backward Compatibility

**User Story:** As an agent developer, I want this fix to be transparent to existing functionality, so that nothing breaks.

#### Acceptance Criteria

1. THE SYSTEM SHALL pass all pre-existing tests in `task-error.test.ts` without modification.

2. THE SYSTEM SHALL NOT change the public API surface exposed to CLI consumers.

3. THE SYSTEM SHALL NOT add new entries to the dependencies section of package.json.

4. WHEN a depth-2+ subagent session is created THE SYSTEM SHALL continue to deny the question tool (regression preservation of existing behavior).

5. THE SYSTEM SHALL preserve the `task_id` resumption mechanism — killed tasks remain resumable by passing `task_id` in a subsequent task tool call.
