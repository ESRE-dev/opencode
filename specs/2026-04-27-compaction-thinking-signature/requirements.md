# Requirements Document

## Introduction

This document specifies requirements for fixing the compaction-time reasoning-signature strip in OpenCode. When the configured `compaction` agent uses a model that differs from the working agent's model (the documented cost-saving setup), the conversion path at `packages/opencode/src/session/message-v2.ts:790-796` emits a reasoning content part whose `text` is preserved but whose `providerMetadata` (carrying the Anthropic `signature`) is dropped. Anthropic's API then rejects the resulting messages array with a 400 because echoed thinking blocks are required to carry their original signature unchanged.

The fix is intentionally tiny:

1. **Conversion-site fix** at `message-v2.ts:790-796` — when `differentModel === true`, drop the reasoning part entirely (skip the push) instead of pushing it without `providerMetadata`.
2. **Symmetric preventive scrub** at `compaction.ts:240-254` (loop body; closing brace at `:255`) — filter out `type: "reasoning"` content parts from each `msg.content` before the messages array is sent to the compaction model, mirroring the existing tool-call/tool-result scrub. Per the goal's Logic-L3 finding, the compaction-side scrub is **defense-in-depth, not load-bearing for the bug fix** — under the current ordering the message-v2 drop already removes every reasoning part before the compaction loop runs. The scrub future-proofs against plugin-ordering changes.

The change must NOT introduce a refactor. No new modules, no schema changes, no public-API changes.

**Tech stack**: TypeScript, Bun runtime, Effect library, Vercel AI SDK (`ai`, `@ai-sdk/anthropic`, `@ai-sdk/provider-utils`).
**Source of truth**: `specs/2026-04-27-compaction-thinking-signature/goal.md`
**Verification artifact**: `specs/2026-04-27-compaction-thinking-signature/experiment/reasoning-signature-strip.test.ts` and `RESULTS.md` (executed 2026-04-27, 2 pass / 0 fail / 8 expect calls).
**Primary files**:

- `packages/opencode/src/session/message-v2.ts`
- `packages/opencode/src/session/compaction.ts`

## Glossary

- **Compaction**: The process of summarizing conversation history when the context window fills up, replacing the full history with a condensed summary
- **Compaction model**: The model used by the configured `compaction` agent to produce the summary — selected at `compaction.ts:181-184`. May differ from the working agent's model (the documented cost-saving setup, e.g. Haiku summarizing Sonnet)
- **Working model**: The model used by the user's active agent for normal turns. Stored on each pre-compaction assistant message at `msg.info.providerID/modelID`
- **`differentModel`**: The boolean computed at `message-v2.ts:692` — `true` when the conversion call's `model` does not match the assistant message's recorded `providerID/modelID`. The trigger condition for the bug
- **Reasoning part**: A `MessageV2.Part` of type `"reasoning"` with `text` (the chain-of-thought prose) and optional `metadata` (carrying the Anthropic signature under `metadata.anthropic.signature`)
- **Signature**: An Anthropic-emitted cryptographic verification token attached to thinking blocks. Required on every echoed thinking block. Stored at `providerMetadata.anthropic.signature` (UIMessage form) / `providerOptions.anthropic.signature` (ModelMessage form)
- **`step-start` part**: A structural marker part unconditionally pushed at `message-v2.ts:716-719`. Always present alongside an assistant message's content parts. Filtered out at `message-v2.ts:825-833` when it would be the only surviving part
- **Conversion path**: `MessageV2.toModelMessagesEffect` at `message-v2.ts` — converts `MessageV2.WithParts[]` to `ModelMessage[]` for an LLM call
- **Compaction conversion call**: The call at `compaction.ts:236` — `MessageV2.toModelMessagesEffect(msgs, model, { stripMedia: true })` where `model` is the compaction model
- **Symmetric scrub**: The existing post-conversion loop at `compaction.ts:240-254` (loop body; closing brace at `:255`) that flattens `tool-call` and `tool-result` content parts into plain text. The fix extends this loop with a reasoning-filter step
- **Replay path / standard path**: The two post-summary auto-continue construction paths in `compaction.ts` (replay path at lines 323-360, standard path at lines 362-412). Unchanged by this fix

## Requirements

### Requirement 1: Drop Reasoning Parts at the Conversion Site When Models Differ

**User Story:** As a user with a configured `compaction` agent that uses a cheaper model than my working agent, I want the conversion path to drop reasoning parts entirely when models differ, so that no signature-less thinking block is ever produced for downstream consumption.

#### Acceptance Criteria

1. WHEN `toModelMessagesEffect` processes an assistant message AND `differentModel === true` AND the assistant message contains a part of `type: "reasoning"` THE SYSTEM SHALL omit that reasoning part from the resulting `UIMessage.parts` array.

2. WHEN `toModelMessagesEffect` processes an assistant message AND `differentModel === false` AND the assistant message contains a part of `type: "reasoning"` THE SYSTEM SHALL emit that reasoning part to the resulting `UIMessage.parts` array with the existing `providerMetadata: part.metadata` assignment preserved.

3. WHEN `toModelMessagesEffect` processes an assistant message containing a reasoning part alongside other parts (text, tool-call, tool-result, step-start) AND `differentModel === true` THE SYSTEM SHALL drop only the reasoning part from the resulting `UIMessage.parts` array.

4. WHEN `toModelMessagesEffect` processes an assistant message containing a reasoning part alongside other parts AND `differentModel === true` THE SYSTEM SHALL continue to emit the text, tool-call, tool-result, and step-start parts following their existing branch rules at `message-v2.ts:710-719` and `:720-788`.

5. THE SYSTEM SHALL NOT modify the `text`, `tool-call`, `tool-result`, or `step-start` part conversion branches at `message-v2.ts:710-719`, `:720-788`.

6. WHEN an assistant message's only content parts after the drop are a `step-start` part (input shape `[step-start, reasoning]` after dropping reasoning becomes `[step-start]`) THE SYSTEM SHALL exclude that assistant message from the final output via the existing post-loop filter at `message-v2.ts:825-833`.

7. WHEN an assistant message's `parts` array is empty after the drop loop completes (input shape `[reasoning]` becomes `[]`) THE SYSTEM SHALL exclude that assistant message from the final output via the existing length check at `message-v2.ts:798`.

8. THE SYSTEM SHALL NOT modify reasoning parts persisted in OpenCode's database via `Session.updatePart` — the drop SHALL apply only at conversion time.

**Technical Implementation Notes:**

- The drop is implemented by guarding the `if (part.type === "reasoning")` block at `message-v2.ts:790-796` with an additional check on `differentModel`. When `differentModel === true`, the entire `assistantMessage.parts.push(...)` call is skipped.
- Implementation pattern: change the existing block to `if (part.type === "reasoning" && !differentModel) { assistantMessage.parts.push({ type: "reasoning", text: part.text, providerMetadata: part.metadata }) }`. The conditional spread `...(differentModel ? {} : ...)` is no longer needed because the branch is now only entered when `differentModel === false`.
- The text branch at `:710-715`, the step-start branch at `:716-719`, and the tool branches at `:720-788` retain the `differentModel ? {} : ...` pattern unchanged — those branches are out of scope for this fix.
- This change affects all three call sites of `toModelMessagesEffect` (compaction at `compaction.ts:236`; standard agent turn near `prompt.ts:1477`; title generation near `prompt.ts:188`). Per the goal, the unified application is intentional — the compaction case alone justifies the change, and the other two call sites are incidentally improved.

### Requirement 2: Symmetric Reasoning Scrub on the Compaction Input Loop

**User Story:** As a maintainer, I want the compaction conversion path to be symmetric with the existing tool-call/tool-result scrub, so that any structured part type that cannot safely cross a model boundary is handled the same way and future plugin-ordering changes cannot reintroduce the bug.

#### Acceptance Criteria

1. WHEN the loop at `compaction.ts:240-254` processes a `ModelMessage` AND that message's `content` is an array AND any element has `type === "reasoning"` THE SYSTEM SHALL remove that element from the message's `content` array.

2. THE SYSTEM SHALL preserve the existing transformations at `compaction.ts:243-252` — the `tool-call → text` flattening at `:243-247` and the `tool-result → text` flattening at `:248-252` SHALL continue to execute exactly as they do today.

3. THE SYSTEM SHALL preserve the fallthrough `return part` at `compaction.ts:253` for content parts whose `type` is none of `"reasoning"`, `"tool-call"`, or `"tool-result"`.

4. WHEN a message's `content` becomes empty after the reasoning filter AND `msg.role === "assistant"` THE SYSTEM SHALL leave that message in the `modelMessages` array — the existing tool-role filter at `compaction.ts:257` removes only `role: "tool"` messages. (Note: under current plugin ordering this scenario does not arise — the message-v2 drop already suppresses reasoning-only assistants before the scrub runs. This criterion specifies the scrub's behavior under future-state plugin orderings that could allow reasoning parts to reach this loop.)

5. THE SYSTEM SHALL NOT modify the compaction prompt user message construction at `compaction.ts:300-303`.

6. THE SYSTEM SHALL NOT modify the `toolChoice: "none"` setting at `compaction.ts:306`.

**Technical Implementation Notes:**

- The reasoning case requires `.filter()` (drop) semantics; the existing tool-call/tool-result cases use `.map()` (transform-in-place). Implementation may either chain `.filter(part => part.type !== "reasoning").map(...)` or insert a separate `.filter()` pass before the existing `.map()` at line 242. Both are equivalent.
- This scrub is preventive defense-in-depth — under the current code ordering (`plugin.trigger("experimental.chat.messages.transform")` at `compaction.ts:235` runs BEFORE `MessageV2.toModelMessagesEffect` at `compaction.ts:236`), no reasoning part can survive the message-v2 drop to reach this scrub. The scrub future-proofs against ordering changes that would re-introduce the bypass.

### Requirement 3: No Signature-less Reasoning Blocks Cross a Model Boundary

**User Story:** As a user running sessions with extended thinking enabled, I want the system to never send a reasoning block without its signature to any model, so that the Anthropic API does not reject my requests with `messages.N.content.M.thinking.signature: Field required`.

#### Acceptance Criteria

1. THE SYSTEM SHALL produce a `ModelMessage[]` from `toModelMessagesEffect` in which no element of any assistant message's `content` array has both `type === "reasoning"` AND missing or undefined `providerOptions.anthropic.signature` when `differentModel` was `true` for that assistant message.

2. THE SYSTEM SHALL produce a `ModelMessage[]` from `toModelMessagesEffect` in which every reasoning content part on any assistant message — when `differentModel` was `false` for that assistant message — has its original `providerMetadata` (and therefore its `providerOptions.anthropic.signature`) preserved verbatim.

3. THE SYSTEM SHALL produce a `messages` array on the `processor.process(...)` call at `compaction.ts:292-307` containing zero reasoning content parts on any assistant message when `differentModel === true` was the controlling condition during the upstream conversion.

4. WHILE multiple compaction events occur in sequence (double compaction) THE SYSTEM SHALL maintain criterion 3 on every compaction call — each invocation of the compaction conversion path independently strips reasoning parts under the same `differentModel === true` rule.

5. THE SYSTEM SHALL NOT modify the chain-of-thought `text` of a reasoning part — when reasoning is preserved (criterion 2), the `text` SHALL pass through unchanged; when reasoning is dropped (criterion 1), no transformed `text` SHALL be emitted in its place.

**Technical Implementation Notes:**

- The half-state "text without signature" must not exist in any post-fix output. Either the entire reasoning part is preserved (signature included) or it is dropped entirely.
- The signature value itself is never modified by this fix — it is either passed through verbatim or omitted along with the rest of the reasoning part.
- The compaction summary message produced by the compaction model (constructed at `compaction.ts:260-285`) carries the compaction model's `providerID/modelID` (set at lines 280-281). On the next agent turn, when the summary is re-converted through `toModelMessagesEffect` for the working model, `differentModel === true` fires again — Requirement 1 then drops any reasoning parts the summary may carry. This is the intended behavior and is covered by criterion 4.

### Requirement 4: Loss of Reasoning Prose Across the Boundary is Acceptable

**User Story:** As a system designer, I want the compaction summary to be produced without the agent's prior reasoning prose visible to the compaction model, so that internal scratch work cannot be misinterpreted as instructions or factual claims.

#### Acceptance Criteria

1. THE SYSTEM SHALL NOT preserve, summarize, or echo the `text` content of dropped reasoning parts in any output of the conversion or compaction paths.

2. THE SYSTEM SHALL NOT introduce a textual placeholder (e.g., `[Reasoning omitted]`) in place of dropped reasoning parts. The drop is silent at the conversion site.

3. THE SYSTEM SHALL NOT introduce telemetry, metrics, or logging that count or surface dropped reasoning parts.

**Technical Implementation Notes:**

- This is the principled trade per the goal: reasoning prose is internal scratch work, not load-bearing for the compaction summary template, and including it risks the compaction model treating it as instructions.
- The persistent message store retains the original reasoning parts (with signatures) — the loss is conversion-time-only, so the OpenCode UI continues to display reasoning history correctly.

### Requirement 5: Backward Compatibility

**User Story:** As a user, I want the fix to work without breaking existing sessions, agent definitions, plugin hooks, or test suites, so that the change is reviewable as a small focused diff.

#### Acceptance Criteria

1. THE SYSTEM SHALL preserve the `MessageV2.ReasoningPart` schema (`message-v2.ts:129-140`) without modification — `text: z.string()`, `metadata: z.record(z.string(), z.any()).optional()`, and `time: z.object({ start: z.number(), end: z.number().optional() })` SHALL remain.

2. THE SYSTEM SHALL preserve the `Part` discriminated union at `message-v2.ts:385-403` without modification — no new part types SHALL be introduced.

3. THE SYSTEM SHALL preserve all existing plugin hooks (`experimental.session.compacting`, `experimental.compaction.autocontinue`, `experimental.chat.system.transform`, `experimental.chat.messages.transform`) — each hook SHALL continue to fire at the same point in the compaction flow with the same payload shape.

4. THE SYSTEM SHALL preserve the compaction summary message construction at `compaction.ts:260-285` without modification — the `mode: "compaction"`, `summary: true`, and `modelID/providerID` assignments SHALL be unchanged.

5. THE SYSTEM SHALL preserve the hardcoded `"What did we do so far?"` text at `message-v2.ts:676-681`.

6. THE SYSTEM SHALL preserve the auto-continue construction in both the replay path (`compaction.ts:323-360`) and the standard path (`compaction.ts:362-412`) — neither path SHALL be modified by this fix.

7. THE SYSTEM SHALL preserve the identity reinforcement helpers introduced by `specs/2026-04-23-compaction-identity-and-state/` (`buildIdentityReinforcement` at `compaction.ts:59-63`) — the reasoning fix SHALL NOT modify any line touched by that sibling work.

8. WHEN all pre-existing tests in `packages/opencode/test/session/compaction.test.ts`, `compaction-todo.test.ts`, and any other test that exercises `toModelMessagesEffect` are run THE SYSTEM SHALL pass each pre-existing test without modification to the test source.

9. WHEN `bun run typecheck` runs from `packages/opencode` THE SYSTEM SHALL produce zero new type errors.

**Technical Implementation Notes:**

- No changes to `llm.ts`, `prompt.ts`, `processor.ts`, the message schema, or any agent / plugin / config file.
- The diff is scoped to two functions: the reasoning branch in `toModelMessagesEffect` (file `message-v2.ts`) and the post-conversion loop in `process` (file `compaction.ts`).

### Requirement 6: Test Surface

**User Story:** As a maintainer, I want both a structural unit assertion at the conversion site and a fixture-based integration test through the compaction flow, so that the regression is caught at both granularities and across the full set of edge-case fixtures called out in the goal.

#### Acceptance Criteria

1. THE SYSTEM SHALL include a structural unit test that constructs a `WithParts[]` containing an assistant message with a reasoning part carrying an Anthropic-style signature in `metadata`, calls `MessageV2.toModelMessages(input, model)` with a `model` whose `providerID/modelID` differs from the assistant's recorded `providerID/modelID`, and asserts that the resulting `ModelMessage[]` contains zero reasoning content parts on that assistant's message.

2. THE SYSTEM SHALL include a structural unit test (control case) that constructs the same `WithParts[]` as criterion 1, calls `MessageV2.toModelMessages(input, model)` with a `model` whose `providerID/modelID` matches the assistant's recorded `providerID/modelID`, and asserts that the resulting reasoning content part has `providerOptions.anthropic.signature` equal to the original signature value.

3. THE SYSTEM SHALL include a fixture-based integration test that drives `SessionCompaction.process` end-to-end with a configured compaction model that differs from the assistant message's model, captures the `messages` array passed to `processor.process` (via a spy or test double), and asserts that no element of any assistant message's `content` array has `type === "reasoning"`.

4. THE SYSTEM SHALL include a structural unit test fixture for the `[step-start, reasoning]` input shape (a reasoning-only assistant turn) that asserts `toModelMessages` returns zero output messages for that assistant — verifying the line-825-833 step-start filter safety net.

5. THE SYSTEM SHALL include a structural unit test fixture for the `[reasoning]` input shape (no `step-start`, no other parts) that asserts `toModelMessages` returns zero output messages for that assistant — verifying the line-798 length-check safety net.

6. THE SYSTEM SHALL include a structural unit test fixture for the `[reasoning, text]` mixed-parts input shape under `differentModel === true` that asserts the resulting assistant message contains exactly one content part of `type: "text"` and zero of `type: "reasoning"`.

7. THE SYSTEM SHALL include an integration test for double compaction — running compaction twice in sequence with the same different-model configuration — that asserts no signature-less reasoning content part appears in the messages sent to either compaction call's `processor.process`.

8. THE SYSTEM SHALL execute the gating verification experiment at `specs/2026-04-27-compaction-thinking-signature/experiment/reasoning-signature-strip.test.ts` BEFORE any code change is made and confirm both tests still pass on the unfixed code (proving the regression is reproducible). The implementation phase SHALL fail-fast if the gating experiment does not pass on the pre-change tree.

9. THE SYSTEM SHALL include a structural unit test fixture for the `[reasoning, text, tool-call(completed)]` three-part mixed input shape under `differentModel === true` that asserts the resulting assistant message contains the text and tool-call equivalents but zero content parts of `type: "reasoning"`.

**Technical Implementation Notes:**

- Tests run from `packages/opencode` via `bun test`.
- The structural unit tests (criteria 1, 2, 4, 5, 6, 9) are appended to the existing `packages/opencode/test/session/message-v2.test.ts` (which already contains a same-model reasoning fixture at `:671-719` covering the `differentModel === false` path; the new tests cover the `differentModel === true` gap). The integration tests for criteria 3 and 7 are appended to `packages/opencode/test/session/compaction.test.ts` alongside the existing `process` test pattern.
- The integration tests reuse the existing scaffolding in `compaction.test.ts`: `runtime`, `liveRuntime`, `provideTmpdirInstance`, `assistant`, `user`, `ProviderTest.fake`, and the `fake` processor factory at lines 146-159 (whose `process` Effect is replaced with a spy that captures the `messages` argument — see design.md § Integration Test → Spy pattern).
- The `[step-start, reasoning]` fixture is required per the goal's Logic-L1 finding — without it, the line-798 length check passes (`[step-start]` has length 1) and only the line-825-833 filter removes the empty-after-drop assistant. Both safety nets must be exercised.
- The double-compaction integration test is required per the goal's Edge Cases section — it verifies that the auto-continue summary message, when re-converted on the next compaction, also has its reasoning parts dropped.
- The gating experiment is the existing artifact at `specs/2026-04-27-compaction-thinking-signature/experiment/reasoning-signature-strip.test.ts`. Re-execution before code change confirms the bug is still reproducible against the implementation branch's starting tree.

### Requirement 7: Branch Delivery (Delivery Constraint — not runtime behavior)

**User Story:** As a maintainer, I want the implementation to land on its own topic branch and merge into `local-integrated` via a `--no-ff` merge commit, so that the change history follows the established `meta:FORK.md` workflow.

**Note:** These criteria describe delivery process constraints, not runtime system behavior. They are verified by `git log` inspection, not by automated tests.

#### Acceptance Criteria

1. THE SYSTEM SHALL deliver the implementation commits on a new branch named `local/compaction-thinking-signature`, created at implementation time from the current `local-integrated` tip.

2. THE SYSTEM SHALL make the implementation available in `local-integrated` via a `--no-ff` merge commit from the `local/compaction-thinking-signature` branch.

3. THE SYSTEM SHALL NOT commit implementation changes for this fix directly to `local-integrated`.

4. THE SYSTEM SHALL deliver spec files (`goal.md`, `requirements.md`, `design.md`, the experiment artifacts) under `specs/2026-04-27-compaction-thinking-signature/` — these may travel into `local-integrated` either on the implementation branch's merge commit or on a separate spec commit, at the user's discretion.

**Technical Implementation Notes:**

- The branch name must match the spec directory name per goal Q4/Q7.
- The implementation branch is created at implementation time, not during spec authoring.
- All `git commit` and `git push` operations are delegated to the user (or to `@committer` if invoked) — the spec writer does not commit on the user's behalf.
