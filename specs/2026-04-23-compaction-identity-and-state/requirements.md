# Requirements Document

## Introduction

This document specifies requirements for improving OpenCode's compaction system to better preserve agent identity and todo state across context compaction events. The feature targets two files — `compaction.ts` (identity reinforcement and todo injection) — across two feature branches (`local/compaction-agent-identity` and `local/compaction-todo`), building on existing changes already merged into the `local-integrated` integration branch.

**Tech stack**: TypeScript, Bun runtime, Effect library, Vercel AI SDK
**Source of truth**: `specs/2026-04-23-compaction-identity-and-state/goal.md`
**Primary file**: `packages/opencode/src/session/compaction.ts`

## Glossary

- **Compaction**: The process of summarizing conversation history when the context window fills up, replacing the full history with a condensed summary
- **Auto-continue message**: The synthetic user message injected after compaction that prompts the agent to continue working (contains `metadata: { compaction_continue: true }`)
- **Identity reinforcement**: Text injected into the auto-continue message that reminds the agent of its role and behavioral constraints
- **Native agent**: A built-in agent (build, plan, general, etc.) with `native: true` — has no specialized behavioral constraints requiring reinforcement
- **Custom agent**: An agent defined in `.opencode/agent/*.md` with `native: false` — has a `prompt` field containing the full markdown body and may have a `description` field
- **Replay path**: The compaction injection path at compaction.ts:362-372 that replays the last user message when compacting due to overflow with earlier context
- **Standard path**: The compaction injection path at compaction.ts:395-423 that creates a new auto-continue user message
- **`system[0]`**: The first element of the system prompt array in `llm.ts:117-129`, constructed by joining `agent.prompt + input.system + user.system` — the Anthropic cache anchor
- **`source`**: The resolved agent definition at compaction.ts:236, obtained via `agents.get(userMessage.agent)` — may be `undefined` at runtime

## Requirements

### Requirement 1: Strengthened Identity Reinforcement

**User Story:** As a user working with a specialized agent, I want the agent to receive a detailed role reminder after compaction, so that the agent maintains its designated behavior instead of drifting to generic implementation.

#### Acceptance Criteria

1. WHEN compaction completes for a custom agent (`source?.prompt && !source?.native`) THE SYSTEM SHALL include identity reinforcement text in the auto-continue message that contains the agent name, a role description, and a behavioral constraint reminder.

2. WHEN the agent definition has a non-empty `description` field THE SYSTEM SHALL use the `description` field value as the role description in the identity reinforcement text.

3. WHEN the agent definition has an absent or empty `description` field THE SYSTEM SHALL use a generic fallback role description (e.g., "You are a specialized agent") in the identity reinforcement text.

4. WHEN compaction completes via the replay path (compaction.ts:362-372) THE SYSTEM SHALL inject the identity reinforcement text as a synthetic text part on the replayed user message.

5. WHEN compaction completes via the standard auto-continue path (compaction.ts:395-423) THE SYSTEM SHALL append the identity reinforcement text to the auto-continue message text.

6. WHEN compaction completes for a native agent (`source?.native === true`) THE SYSTEM SHALL omit identity reinforcement from the auto-continue message.

**Technical Implementation Notes:**

- The existing `reminder` variable at compaction.ts:332-335 is the injection point — strengthen its content
- Both the replay path (line 362-372) and standard path (line 418) already use `reminder` — no new injection points needed
- The `description` field is optional on `Agent.Info` (`config/agent.ts:28`)
- The `source` variable is resolved at compaction.ts:236 via `agents.get(userMessage.agent)`

### Requirement 2: Todo State Post-Compaction Injection

**User Story:** As a user with an active todo list, I want the agent to see the exact todo state immediately after compaction, so that the agent can continue tracking progress without losing context.

#### Acceptance Criteria

1. WHEN compaction completes with auto-continue enabled THE SYSTEM SHALL inject the current todo list into the auto-continue message text.

2. WHEN the session has one or more todo items THE SYSTEM SHALL include each todo item's content, status, and priority in the injected todo list.

3. WHEN the session has zero todo items THE SYSTEM SHALL omit the todo list section from the auto-continue message.

4. THE SYSTEM SHALL continue to include the todo list in the compaction prompt (the input to the compaction model) as it does today.

5. WHEN compaction completes via the replay path THE SYSTEM SHALL inject the todo list as a synthetic text part on the replayed user message.

6. WHEN compaction completes via the standard auto-continue path THE SYSTEM SHALL append the todo list to the auto-continue message text.

**Technical Implementation Notes:**

- Reuse the existing `formatTodos()` function (compaction.ts:32-36) to produce the todo markdown
- The todo list is fetched from `Todo.Service` at compaction.ts:228 — reuse this value for post-compaction injection
- The `todoread` tool (tool/todo.ts:56-84) remains available as a fallback for mid-conversation refresh

### Requirement 3: Cache Compatibility

**User Story:** As a user on Anthropic models, I want compaction to preserve the prompt cache, so that I benefit from the 90% cost reduction on cache hits.

#### Acceptance Criteria

1. THE SYSTEM SHALL preserve `system[0]` content identically before and after compaction — identity reinforcement and todo injection must not modify the system prompt array.

2. THE SYSTEM SHALL inject identity reinforcement and todo state exclusively into conversation messages (the auto-continue user message), not via `input.system` or by modifying the system prompt.

3. THE SYSTEM SHALL NOT add mid-conversation `role: 'system'` messages for identity reinforcement or todo injection.

**Technical Implementation Notes:**

- `system[0]` in `llm.ts:117-129` joins `agent.prompt + input.system + user.system` — anything added to `input.system` changes `system[0]` and invalidates the Anthropic cache
- The caching logic at `llm.ts:139-146` checks if `system[0]` (the "header") is unchanged after plugin transforms

### Requirement 4: Graceful Degradation

**User Story:** As a user, I want compaction to complete without errors even when agent definitions are missing or incomplete, so that my session is not interrupted.

#### Acceptance Criteria

1. IF the `source` variable is `undefined` (agent definition not found) THEN THE SYSTEM SHALL skip identity reinforcement without error and complete compaction normally.

2. IF the `source` variable has no `prompt` field THEN THE SYSTEM SHALL skip identity reinforcement without error.

3. IF the `source` variable is a native agent (`native === true`) THEN THE SYSTEM SHALL skip identity reinforcement.

4. IF compaction triggers a second time immediately after a prior compaction (double compaction) THEN THE SYSTEM SHALL complete without error, produce a new auto-continue message containing fresh identity reinforcement text and a fresh todo list snapshot from the database, and set `finish` to a non-error value on the summary assistant message.

5. WHILE multiple compaction events occur in sequence THE SYSTEM SHALL produce identity reinforcement text that does not contradict prior reinforcement text — each reinforcement instance is self-contained with no assumptions about prior reinforcement state.

**Technical Implementation Notes:**

- Use optional chaining on `source` (`source?.prompt`, `source?.native`, `source?.description`)
- The `agents.get()` at `agent.ts:301-303` returns `agents[agent]` which is `Info | undefined` at runtime

### Requirement 5: Backward Compatibility

**User Story:** As a user, I want the compaction improvements to work without breaking existing behavior, so that my current sessions and configurations continue to function.

#### Acceptance Criteria

1. THE SYSTEM SHALL preserve the existing `CompactionPart` schema (`{ type: "compaction", auto: boolean, overflow?: boolean }`) without modification.

2. THE SYSTEM SHALL preserve the existing `TextPart.metadata` field behavior — the `compaction_continue: true` marker must continue to be set on auto-continue message parts.

3. THE SYSTEM SHALL preserve the existing plugin hooks (`experimental.session.compacting`, `experimental.compaction.autocontinue`, `experimental.chat.system.transform`, `experimental.chat.messages.transform`) — each hook must continue to fire at the same point in the compaction flow.

4. THE SYSTEM SHALL preserve the existing compaction flow structure: prune, summarize, auto-continue.

5. THE SYSTEM SHALL preserve the hardcoded "What did we do so far?" text in `toModelMessagesEffect` (message-v2.ts:676-681).

6. THE SYSTEM SHALL preserve the `filterCompactedEffect` logic that identifies compaction boundaries via `summary: true`.

7. WHEN all existing compaction tests are run THE SYSTEM SHALL pass all pre-existing tests without modification.

**Technical Implementation Notes:**

- No changes to `message-v2.ts`, `llm.ts`, `prompt.ts`, or any file other than `compaction.ts`
- Tests run from `packages/opencode` via `bun test`

### Requirement 6: Branch Delivery (Delivery Constraint — not runtime behavior)

**User Story:** As a maintainer, I want each feature branch to contain only its relevant commits, so that I can review, revert, or cherry-pick changes independently.

**Note:** These criteria describe delivery process constraints, not runtime system behavior. They are verified by git log inspection, not by automated tests.

#### Acceptance Criteria

1. THE SYSTEM SHALL deliver identity-related changes (Requirement 1, 3, 4 identity aspects) as commits on the `local/compaction-agent-identity` branch.

2. THE SYSTEM SHALL deliver todo-related changes (Requirement 2, 4 todo aspects) as commits on the `local/compaction-todo` branch.

3. THE SYSTEM SHALL make both sets of changes available in `local-integrated` via merge commits from the feature branches.

4. THE SYSTEM SHALL NOT commit changes for these features directly to `local-integrated`.

**Technical Implementation Notes:**

- Identity and todo changes both modify `compaction.ts` — the branches must be compatible for merging
- Existing commits on both branches are already merged into `local-integrated`
