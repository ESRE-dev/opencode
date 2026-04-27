# Goal: Compaction Strips Reasoning Signatures When Compaction Model Differs From Agent Model

## Overview

When OpenCode triggers compaction with a configured `compaction` agent model that differs from the agent's working model (the documented practice — using a cheaper Haiku-tier model to summarize a Sonnet-tier conversation), the conversion path at `message-v2.ts:790-796` emits a reasoning content part with `text` preserved but `providerMetadata` (which carries the Anthropic `signature`) dropped. The signature-less reasoning block is then sent to (a) the compaction model via the input messages array constructed in `compaction.ts:236-257`, and (b) the agent's working model on the next turn after the compaction summary lands. Anthropic's API contract for extended thinking explicitly requires the signature on every echoed thinking block — missing or altered signatures cause the request to be rejected with a 400 error.

The user's direction (relayed through the conversation): fix the bug at the conversion site by **dropping reasoning parts entirely** from compaction's input/output paths when the compaction model differs from the message's recorded model (`differentModel === true` in `message-v2.ts:692`). Apply the same fix symmetrically in `compaction.ts:240-254`, which already does an analogous structural scrub for `tool-call` and `tool-result` parts so the compaction model "never sees tool markup and can't hallucinate tool calls". Reasoning parts should be treated the same way: when they cannot be safely echoed (signature stripped), they should not be echoed at all on the compaction path.

### Trigger Path (Code-Traced Proof)

The bug is structurally reachable along a single deterministic code path. The trace below cites exact files and line numbers in the current `local-integrated` tree.

1. **Compaction model selection** — `compaction.ts:181-184`:
   ```ts
   const agent = yield* agents.get("compaction")
   const model = agent.model
     ? yield* provider.getModel(agent.model.providerID, agent.model.modelID)
     : yield* provider.getModel(userMessage.model.providerID, userMessage.model.modelID)
   ```
   When the user has configured a `compaction` agent with its own `model` (the typical setup for cost-conscious users — a cheaper compaction model summarizing a more expensive working model), this `model` differs from the user message's `model`. This is the trigger condition.

2. **Conversion call** — `compaction.ts:236`:
   ```ts
   const modelMessages = yield* MessageV2.toModelMessagesEffect(msgs, model, { stripMedia: true })
   ```
   The `model` passed in is the compaction model from step 1. The function iterates over every assistant message in `msgs`.

3. **`differentModel` computation** — `message-v2.ts:692`:
   ```ts
   const differentModel = `${model.providerID}/${model.id}` !== `${msg.info.providerID}/${msg.info.modelID}`
   ```
   Each pre-compaction assistant message has its `providerID/modelID` fields populated from the *agent's* model that produced it (see `processor.ts` and the assistant message construction in `compaction.ts:260-285`, where the compaction summary's IDs are written at lines 280-281 — for prior turns, the agent model's ids are stored). Therefore for prior agent turns being summarized **when the configured `compaction` agent has its own `model` field set to a value different from the working agent's model** (the documented cost-saving setup; see step 1), `differentModel === true`. Any configuration that results in `model.providerID/model.id === msg.info.providerID/msg.info.modelID` — whether the compaction agent has no `model` configured and inherits the user message's model via the fallback at compaction.ts:182-184, OR has its `model` explicitly set to match the working agent — produces `differentModel === false` and the code path is not hit. The bug only fires under configurations that produce a true mismatch.

4. **Signature strip site** — `message-v2.ts:790-796`:
   ```ts
   if (part.type === "reasoning") {
     assistantMessage.parts.push({
       type: "reasoning",
       text: part.text,
       ...(differentModel ? {} : { providerMetadata: part.metadata }),
     })
   }
   ```
   When `differentModel === true`, the spread evaluates to `{}` and `providerMetadata` is omitted. The reasoning `text` is unconditionally pushed at line 793. This is the exact line where the signature is dropped.

5. **`convertToModelMessages` step** — `message-v2.ts:825-833`:
   ```ts
   return yield* Effect.promise(() =>
     convertToModelMessages(
       result.filter((msg) => msg.parts.some((part) => part.type !== "step-start")),
       { tools },
     ),
   )
   ```
   `convertToModelMessages` from the AI SDK maps `UIMessage` reasoning parts to `ModelMessage` reasoning parts. The mapping at `ai/dist/index.js:8473-8478` performs an **unconditional assignment** `providerOptions: part.providerMetadata`. When `providerMetadata` is `undefined`, the resulting object has the `providerOptions` key present with value `undefined` — not key-absent. (`JSON.stringify` elides `undefined`-valued keys on serialization, so the wire-format JSON shows no `providerOptions`, but the runtime object retains the key.) The resulting `AssistantModelMessage` carries a `ReasoningPart` (`@ai-sdk/provider-utils` types: `{ type: 'reasoning', text: string, providerOptions?: ProviderOptions }`) with `text` set and `providerOptions === undefined`.

6. **Input-side reshape** — `compaction.ts:240-254`:
   The block transforms `tool-call` and `tool-result` parts into plain text but **does not touch reasoning parts**. The reasoning content part with the missing signature is therefore passed through verbatim into the messages array sent to the compaction model.

7. **Anthropic-side rejection** — Anthropic's published contract:
   The Anthropic Extended Thinking documentation ("Preserving thinking blocks" section) states that signatures cryptographically verify that a thinking block was produced by Claude and that they must be passed back unchanged when echoing thinking blocks. Sending a thinking block without signature returns HTTP 400. This is documented behavior of Anthropic's API, not provider-adapter behavior. Source: https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking

The bug surfaces along a single deterministic code path triggered by a documented user configuration (different compaction model). It is reproducible without any LLM call — the proof is structural, derived from line-by-line source code reading.

### Verification Experiment Status

**Executed and PASSED on 2026-04-27** against `local/compaction-agent-identity` tip `49700133b6` (`bun test v1.3.13`, 2 tests, 0 fail, 8 expect() calls). The experiment confirms the trigger path empirically — not just by code trace. Full evidence including the captured `ModelMessage[]` output for both branches is at `specs/2026-04-27-compaction-thinking-signature/experiment/RESULTS.md`.

Key data points from the run:

- **Different-model path** (`anthropic/claude-haiku-4-5` over an assistant message recorded with `anthropic/claude-sonnet-4-5`): reasoning content part emitted with `text` preserved and `providerOptions` set to `undefined` (the JSON wire-form printed in `RESULTS.md` shows no `providerOptions` key because `JSON.stringify` elides `undefined`-valued keys; the runtime object has the key with `undefined` value). `providerOptions?.anthropic?.signature` is `undefined`. This is exactly the shape Anthropic's API rejects with `messages.N.content.M.thinking.signature: Field required`.
- **Same-model control** (both recorded and call model are `anthropic/claude-sonnet-4-5`): reasoning content part emitted as `{ "type": "reasoning", "text": "...", "providerOptions": { "anthropic": { "signature": "EuYBCkYIBxgC..." } } }` — signature preserved verbatim.

The script lives at `specs/2026-04-27-compaction-thinking-signature/experiment/reasoning-signature-strip.test.ts` and runs without any LLM call or network access. Reproduction:

```bash
cd packages/opencode
bun test ../../specs/2026-04-27-compaction-thinking-signature/experiment/reasoning-signature-strip.test.ts
```

The implementation phase must re-run this experiment as a regression check before merging the fix.

## User Stories

- As a user with a configured `compaction` agent that uses a cheaper model than my working agent (the documented cost-saving setup), I want compaction to succeed without 400 errors from Anthropic, so that long sessions with reasoning-enabled models continue to work.
- As a user running a session with extended thinking enabled, I want compaction to not silently corrupt my conversation history, so that the post-compaction agent receives a valid messages array on its next turn.
- As a maintainer, I want the compaction conversion path to be symmetric with the existing tool-call/tool-result scrub, so that any structured part type that cannot safely cross a model boundary is handled the same way.

## Behaviors

### Reasoning Strip on the Conversion Path (`message-v2.ts:790-796`)

- When `differentModel === true` for an assistant message during `toModelMessagesEffect`, the reasoning part must be **dropped entirely** — neither the `text` nor any `providerMetadata` should be emitted into the resulting `UIMessage.parts` array. The current behavior emits `{ type: "reasoning", text: part.text }` (text without signature); the new behavior emits nothing.
- When `differentModel === false`, the reasoning part continues to be emitted with `providerMetadata` intact (no change from current behavior).
- The drop applies only to the reasoning part. Other parts in the same assistant message (text, tool calls, tool results) continue to be emitted following their current rules.

### Symmetric Input-Side Scrub in Compaction (`compaction.ts:240-254`)

- The existing `for (const msg of modelMessages)` block at compaction.ts:240-254 must be extended to filter out any `type: "reasoning"` content parts from each message's `content` array. **This addition is an optional preventive measure, not load-bearing for the bug fix.** The primary fix is the message-v2.ts:790-796 drop; the compaction-side scrub provides defense-in-depth: today the plugin runs at compaction.ts:235 *before* `toModelMessagesEffect` at compaction.ts:236, so a plugin cannot inject reasoning parts after the conversion drop. The symmetric scrub mirrors the established tool-call/tool-result pattern in the same loop, costs effectively nothing, and future-proofs against plugin-ordering changes that would re-introduce the bypass. Both changes ship together because (a) the marginal cost is trivial and (b) they form a coherent "structured part type that cannot safely cross the compaction boundary" treatment alongside the existing tool-call scrub.
- The filter must mirror the tool-call/tool-result handling pattern at lines 243-252 (the fallthrough `return part` is at line 253): structural inspection of `part.type`, no provider-specific assumptions. Implementation note: the existing loop uses `.map()` (transform-in-place) for tool-call/tool-result. The reasoning case requires `.filter()` (drop) semantics. Either chain `.filter(part => part.type !== "reasoning").map(...)` or insert a separate `.filter()` pass before the existing `.map()`; both are equivalent.
- Empty `content` arrays after the filter are acceptable; the existing tool-role filter at line 257 already handles emptiness for `role: "tool"` messages. For `role: "assistant"` messages with empty content after the scrub, downstream AI SDK call handling tolerates empty content arrays — but the integration test should verify this for the rare case where a plugin-injected reasoning-only assistant message survives to the scrub.

### Compaction Model Call Inputs

- After the conversion + scrub, the messages array passed into the `processor.process({...})` call (which opens at compaction.ts:292 and closes at compaction.ts:307) must contain zero reasoning content parts on assistant messages when `differentModel === true` was hit during the conversion. The `messages` field of that call object is at compaction.ts:298-304. (Validated by structural assertion in the integration test described under Success Criteria.)
- The compaction prompt user message at compaction.ts:300-303 must not be modified by this change. Its current shape (`{ role: "user", content: [{ type: "text", text: prompt }] }`) is preserved.
- `toolChoice: "none"` at compaction.ts:306 must continue to be set.

### Post-Compaction Auto-Continue Path

- The compaction summary itself is produced as a fresh assistant message (compaction.ts:260-285, with the compaction model IDs written at lines 280-281) tagged with the compaction model's `providerID/modelID`. On the next agent turn, when that summary message is re-converted via `toModelMessages` for the agent's working model, `differentModel === true` will trigger again (compaction-model-tagged summary, agent's working model on the call). The same drop-reasoning-entirely behavior at `message-v2.ts:790-796` applies, which is correct: the compaction summary should not propagate any reasoning blocks across the model boundary.
- The auto-continue user message (replay path at compaction.ts:323-360 and standard path at compaction.ts:362-412) is unaffected. Its current shape is preserved.

### Out-of-Compaction Conversion (Non-Compaction Call Sites)

- `toModelMessages` is called from at least three sites: (a) **compaction** at compaction.ts:236; (b) the **standard agent turn** in `prompt.ts` near line 1477; and (c) **title generation** in `prompt.ts` near line 188. The title-generation call site routinely uses a small/cheap model — meaning `differentModel === true` is *also* the common case there for any session whose assistant messages were produced by reasoning-enabled models. When the agent's standard-turn call has `differentModel === true` for some historical assistant message (e.g., the user changed models mid-session), the existing strip-signature-keep-text behavior at message-v2.ts:790-796 is **also buggy** but is **out of scope for this goal** per the user's Q1 direction ("Compaction-only fix. Mid-session-switch path will be addressed later if necessary."). The change at message-v2.ts:790-796 affects ALL three callers, however — because the line is shared. The user's chosen behavior (drop reasoning entirely when `differentModel === true`) is therefore applied uniformly, which incidentally also fixes mid-session-switch and title-generation but is justified by the compaction case alone. See Out of Scope and Open Questions for the rationale.

## Edge Cases & Invariants

### Invariants (always true)

- After the fix, no `ModelMessage` produced by `toModelMessagesEffect` contains a reasoning content part where `differentModel === true` was the controlling condition for that assistant message. This is testable structurally without an LLM call.
- The reasoning `text` content (the chain-of-thought prose) is never sent across a model boundary without its signature. Either the entire reasoning part is preserved (signature included) or it is dropped entirely. Half-states (text without signature) do not exist in the post-fix output.
- The signature itself is never modified — when `differentModel === false`, it passes through unchanged. The fix only affects what happens when the cross-model condition fires.
- The compaction message array sent to `processor.process` (the call opens at compaction.ts:292 and closes at compaction.ts:307; the `messages` field is at compaction.ts:298-304) contains zero reasoning content parts when the compaction model differs from any prior assistant message's model. (Belt from the message-v2 drop, suspenders from the compaction.ts scrub.)
- Reasoning parts in OpenCode's database (via `Session.updatePart`) are never modified by this change. The drop happens at conversion time only. The original reasoning parts with their signatures remain intact in the persistent message store.

### Idempotent Operations

- Running `toModelMessages` multiple times on the same input with the same model returns identical output. The drop is deterministic.
- Running the compaction.ts:240-254 scrub twice on the same `modelMessages` array (e.g., if a future refactor accidentally double-applies it) is a no-op the second time — there are no reasoning parts to filter on the second pass.

### Round-trip Guarantees

- There is **no round-trip** for dropped reasoning parts on the compaction path. The drop is intentionally lossy: the chain-of-thought prose is not summarized into the compaction prompt and is not visible to the compaction model. The justification is that the prose is internal scratch work, not load-bearing for the compaction summary, and the alternative (echoing without signature) is forbidden by Anthropic's API. Loss of reasoning prose is the accepted trade.
- For non-compaction callers in the same conversion code path (e.g., the standard agent turn), this same loss applies when models differ. This is acceptable per the user's direction and matches industry practice (most providers treat reasoning blocks as ephemeral and recompute them on each turn).

### Preservation (must not change)

- The existing tool-call and tool-result transformations at compaction.ts:243-252 must continue to work exactly as they do today. The new reasoning filter is an *addition* to the same loop, not a replacement.
- The hardcoded `"What did we do so far?"` text in `toModelMessagesEffect` at message-v2.ts:676-681 (the compaction trigger user message) must not change.
- The compaction summary message construction at compaction.ts:260-285 must not change. The summary's own assistant message (which carries `summary: true` and the compaction model's `providerID/modelID`) is unaffected by this fix.
- The text part conversion at message-v2.ts:710-715, which uses the same `differentModel ? {} : { providerMetadata: ... }` pattern to strip text providerMetadata across model boundaries, must not change. The fix applies only to the reasoning branch.
- The tool part conversions at message-v2.ts:743-788, which use the same pattern for tool-call providerMetadata, must not change.
- Identity reinforcement, todo state preservation, and the cache-compatibility concerns from `specs/2026-04-23-compaction-identity-and-state/goal.md` must continue to work. This goal is a strict-superset addition and does not modify any code touched by that sibling goal.
- The prompt-cache invariants from the sibling goal (`system[0]` content unchanged across compaction) are unaffected — this fix touches only conversion logic for assistant messages, not the system prompt path.

### Known Edge Cases

- **No reasoning parts in input**: most assistant messages have no reasoning parts (reasoning is only emitted by reasoning-capable models with extended thinking enabled). The fix is a no-op for those — the drop branch simply doesn't execute. The compaction.ts scrub also no-ops when no reasoning parts exist.
- **Mixed parts in one assistant message**: an assistant message can contain reasoning + text + tool-call parts. The fix drops only the reasoning part; text and tool-call parts continue through their respective branches. The resulting `UIMessage.parts` may go from `[reasoning, text]` → `[text]`. This is valid input for `convertToModelMessages` and produces a valid `AssistantModelMessage` with non-empty content.
- **Reasoning-only assistant message**: an assistant message that contains only a reasoning part (no text, no tool calls) becomes empty after the drop. Two safety nets ensure such messages do not propagate: (1) the check at message-v2.ts:798 (`if (assistantMessage.parts.length > 0) result.push(assistantMessage)`) skips assistant messages whose `parts` array is empty after the drop loop completes; (2) the post-loop filter at message-v2.ts:825-833 (`result.filter((msg) => msg.parts.some((part) => part.type !== "step-start"))`) drops any remaining message whose only surviving part is a `step-start`. The line-798 check alone is *not* sufficient — `step-start` parts are unconditionally pushed at message-v2.ts:716-719, so a real-world reasoning-only turn frequently arrives as `[step-start, reasoning]` and after the drop becomes `[step-start]` (length 1, passes line-798), and only the line-825-833 filter removes it. The integration test must include a fixture asserting that a `[step-start, reasoning]` input after drop produces zero output messages from `toModelMessagesEffect`.
- **`metadata` is `undefined` on reasoning part**: the fix never reads `part.metadata` on the drop branch, so undefined metadata is irrelevant. On the same-model branch, `providerMetadata: part.metadata` may set `providerMetadata` to `undefined`, which is the current behavior and is preserved.
- **Provider metadata shape variance**: Anthropic stores the signature under `providerOptions.anthropic.signature`. Other providers (Bedrock-Anthropic, Vertex-Anthropic) likely route through the same `anthropic` provider key (these adapters wrap the same Anthropic API surface), but this has not been independently verified. The fix is provider-agnostic at the conversion site — it drops the entire reasoning part regardless of which provider key produced the metadata. For Anthropic and adapters that wrap Anthropic, this is strictly correct. For non-Anthropic providers (e.g., Anthropic agent compacted by an OpenAI Haiku-equivalent), the drop is at minimum no worse than the current behavior — a verification step against OpenAI/o3 reasoning contracts is deferred to implementation phase if cross-provider compaction is exercised.
- **Plugin-injected reasoning parts**: a plugin running on `experimental.chat.messages.transform` (compaction.ts:235) could in theory inject a reasoning part into `msgs` after the structuredClone but before the conversion. The fix at message-v2.ts:790-796 will drop that part on the conversion if `differentModel === true`. The compaction.ts:240-254 scrub is preventive — under the current ordering (plugin runs before `toModelMessages`), no reasoning part can survive the conversion drop. The scrub future-proofs against ordering changes that would re-introduce the bypass.
- **Compaction model and agent model identical (any cause)**: any configuration that produces `model.providerID/model.id === msg.info.providerID/msg.info.modelID` makes `differentModel === false` and the fix is a no-op for that message. This subsumes both subcases — (a) the compaction agent has no `model` configured and inherits the user message's model via the fallback at compaction.ts:182-184; and (b) the compaction agent has `model` explicitly configured to match the working model (a defensible setup — same model, separate prompt template). In both subcases reasoning parts pass through with signatures intact, just as today.
- **Double compaction**: the second compaction's input includes the first compaction's summary as an assistant message. That summary has no reasoning parts (the compaction model is called with `toolChoice: "none"` and is prompted to produce a text summary; even if the compaction model emits reasoning blocks during its own generation, they would be stored on the summary message but never echoed because `differentModel === true` will fire again on the second compaction, and after this fix they will be dropped).
- **`toolChoice: "none"` and reasoning models**: some reasoning-capable models still emit thinking blocks even when forced to skip tool calls. The compaction summary message can therefore contain reasoning parts. This fix ensures those reasoning parts are dropped on the auto-continue conversion to the working model — they cannot leak into the agent's next turn.

## Constraints

- **Language/Runtime**: TypeScript, Bun runtime, Effect library for service composition.
- **Framework**: Vercel AI SDK (`ai` package, version per `packages/opencode/package.json` catalog) for `convertToModelMessages` and `ModelMessage`/`UIMessage` types. The AI SDK's `ReasoningPart` type (`@ai-sdk/provider-utils`) defines `providerOptions?: ProviderOptions` as the carrier for the signature.
- **Codebase**: `/Users/EHMKIE/Code/opencode-local-dev`, integration branch `local-integrated`. Current working branch: `local/compaction-agent-identity` (the goal file is being authored on this branch but the implementation will move to its own branch — see Branch delivery strategy).
- **Existing changes**: Must build on top of the existing compaction work merged into `local-integrated` (commits `0f3e831237` "prevent tool calls from models that ignore prompt instructions", `3bd0eac9df` "eliminate tool-call hallucinations from open-weight models", `78f37a0454` "preserve agent identity across context compaction", `49700133b6` "extract buildIdentityReinforcement helper"). The reasoning fix is independent of identity preservation but lives in adjacent code.
- **Branch delivery strategy**:
  - All implementation commits go to a new branch `local/compaction-thinking-signature` (created at implementation time; the spec phase only writes files on the current branch).
  - The new branch is merged into `local-integrated` via a merge commit, matching the workflow used by the sibling compaction features.
  - Spec files (this `goal.md`, downstream `requirements.md`, `design.md`) live under `specs/2026-04-27-compaction-thinking-signature/`. They are committed on whatever branch the spec author is on at the time and travel into `local-integrated` as part of the merge of the implementation branch.
- **Anthropic API contract**: signature is required on echoed thinking blocks. Source: https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking ("Preserving thinking blocks").
- **Cache preservation (sibling-goal compatibility)**: this fix does not modify `system[0]` content. The Anthropic prompt cache invariants from `specs/2026-04-23-compaction-identity-and-state/goal.md` remain satisfied.
- **Backward compatibility**: no changes to message schema, no changes to part types, no changes to plugin hooks, no changes to public APIs. The fix is internal to the conversion + compaction wiring.
- **Testing**: changes must be covered by unit-level structural assertions (drop branch in `toModelMessagesEffect`) AND a fixture-based integration test that exercises the full compaction conversion path. Both per the user's Q5 direction ("Both — structural assertion + fixture-based integration test").
- **Test location**: tests run from `packages/opencode` via `bun test`. The verification experiment script lives under the spec directory (`specs/2026-04-27-compaction-thinking-signature/experiment/`) for one-time execution and reference; the production-grade tests added during implementation live under `packages/opencode/test/session/` alongside the existing compaction tests.

## Out of Scope

- **Mid-session model switch (non-compaction)**: when a user manually changes models mid-session, `toModelMessages` is called with the new model and `differentModel === true` fires for prior assistant messages. The same signature-strip bug applies. Per user Q1, this path is **not in scope** for this goal. It will be addressed in a follow-up if symptoms appear in practice. (The shared line at message-v2.ts:790-796 incidentally improves this path as described in Behaviors → "Out-of-Compaction Conversion"; no targeted work beyond the compaction case is added — no user notification, telemetry, or recovery concerns specific to mid-session switches.)
- **OpenAI / o1 / o3 reasoning blocks**: OpenAI reasoning-summary handling and any provider-specific reasoning behavior that does not follow the Anthropic signature contract. The fix is provider-agnostic at the conversion site — it drops reasoning parts uniformly when models differ — but the goal is motivated by Anthropic. No provider-specific branches are added.
- **Bedrock / Vertex Anthropic adapters**: the bug affects these adapters identically because they wrap the same Anthropic API. No adapter-specific changes are needed; the conversion-site fix covers them.
- **Persisting signatures across sessions**: signatures are tied to the conversation and Anthropic's API, not to OpenCode's session storage semantics. No changes to schema or persistence.
- **Tool-call signatures**: tool calls do not carry signatures in the Anthropic contract; only thinking blocks do. The fix does not touch the tool-call or tool-result conversion at message-v2.ts:720-788 or compaction.ts:243-252.
- **Re-introducing reasoning into compaction summaries**: there is a hypothetical alternative fix (re-sign reasoning blocks via Anthropic's API on cross-model echo) that would preserve the prose. This is not feasible — Anthropic does not expose a re-sign endpoint, and signatures are model-specific. Rejected.
- **Telemetry / metrics**: no logging of "reasoning parts dropped" counts. Such observability is desirable but not required for this fix.
- **UI surfacing**: no TUI changes. Reasoning parts that are dropped at conversion are still displayed in the OpenCode UI (which reads from the persistent message store, not from `toModelMessages` output). The user's view of past reasoning is unaffected.
- **Compaction trigger logic**: when compaction fires, what context size triggers it, and the auto-continue plumbing are all out of scope. Sibling-goal concerns are unaffected.
- **Migration of existing stored messages**: no database migration is needed. The fix is read-side only.

## Success Criteria

- A compaction run with `compaction.model` configured to a different model than the working agent's model completes without 400 errors from the Anthropic API. (Validated by manual end-to-end test against a real Anthropic key on a session with reasoning enabled, OR by inspecting the constructed messages array in the integration test described below.)
- Structural unit assertion: `MessageV2.toModelMessages(input, model)` returns a `ModelMessage[]` where, for every assistant message whose source had `providerID/modelID` differing from `model`, the message contains zero `type: "reasoning"` content parts. (Validated by a unit test that builds a synthetic `WithParts[]` with reasoning parts and asserts the absence in the output.)
- Structural unit assertion: when `model.providerID/model.id` matches the assistant message's `providerID/modelID`, reasoning parts pass through with `providerOptions.anthropic.signature` (or whatever the original metadata key was) preserved. (Validated by the same unit test, control case.)
- Fixture-based integration test: a session containing pre-compaction assistant messages with reasoning parts is fed through the full `compaction.process` flow with a different compaction model. The resulting `compactionMessages` array (compaction.ts:257) is captured (via test injection / spy on `processor.process`) and asserted to contain zero reasoning content parts. (Validated by a new test alongside `packages/opencode/test/session/compaction.test.ts`.)
- The verification experiment script at `specs/2026-04-27-compaction-thinking-signature/experiment/reasoning-signature-strip.test.ts` runs to green when executed by `bun test` from `packages/opencode` (after path-fix if needed). This is a pre-implementation gating check, distinct from the production tests above.
- All existing compaction tests in `packages/opencode/test/session/compaction.test.ts` and `compaction-todo.test.ts` continue to pass.
- All existing message conversion tests (any test that exercises `toModelMessagesEffect` outside compaction) continue to pass.
- No type-check regressions: `bun run typecheck` from `packages/opencode` continues to pass.
- The fix is reviewable as a small, focused diff: one branch change in `message-v2.ts` (the reasoning emit at lines 790-796) and one filter addition in `compaction.ts` (the loop at lines 240-254). No new modules, no schema changes.

## Technical Context

### Codebase Findings

- **Conversion site**: `packages/opencode/src/session/message-v2.ts:692` computes `differentModel` per assistant message; `:790-796` is the reasoning emit branch. The `...(differentModel ? {} : { providerMetadata: part.metadata })` spread on line 794 is the strip site. Same pattern is used for text at `:714` and tool-call provider metadata at `:750, :763, :773, :787` — but the user's Q2 direction restricts the change to the reasoning branch.
- **Compaction conversion call**: `packages/opencode/src/session/compaction.ts:236` calls `MessageV2.toModelMessagesEffect(msgs, model, { stripMedia: true })`. The `model` is selected at lines 181-184 based on the configured compaction agent's `model` field (overrides the user message's model when present).
- **Input-side scrub**: `compaction.ts:240-254` is the existing post-conversion loop that flattens `tool-call` and `tool-result` content parts to plain text. This is the established symmetric-input-scrub pattern. The reasoning filter slots into this loop.
- **Tool-role filter**: `compaction.ts:257` filters out `role: "tool"` messages after the scrub. Empty assistant messages are not filtered there but are tolerated by downstream `processor.process`.
- **Reasoning part schema**: `packages/opencode/src/session/message-v2.ts:129-140` defines `ReasoningPart` with optional `metadata: z.record(z.string(), z.any()).optional()`. The metadata is the storage-side carrier for `providerMetadata` (UIMessage) / `providerOptions` (ModelMessage) on the conversion path.
- **AI SDK types**: `ReasoningPart` in `@ai-sdk/provider-utils` (line ~627 of the bundled `dist/index.d.ts`) defines `{ type: 'reasoning', text: string, providerOptions?: ProviderOptions }`. `providerOptions` is the carrier for `{ anthropic: { signature: "..." } }` and equivalents for other providers.
- **Compaction summary message**: `compaction.ts:260-285` constructs the summary as a fresh `MessageV2.Assistant` with `mode: "compaction"`, `summary: true`, and the compaction model's `providerID/modelID`. On the next agent turn, when this message is re-converted with the agent's working model, `differentModel === true` fires and the same drop applies (correctly).
- **Sibling-goal interaction**: `specs/2026-04-23-compaction-identity-and-state/goal.md` covers identity preservation and todo state. That work touches the auto-continue user message construction (compaction.ts:323-360 replay path and compaction.ts:362-412 standard path) and `buildIdentityReinforcement` (compaction.ts:59-63). It does not touch the conversion path (message-v2.ts:790-796) or the input-side scrub (compaction.ts:240-254). The two goals' code touch points are disjoint — no shared lines — so the resulting branches can be merged in any order without conflict.
- **Existing test scaffolding**: `packages/opencode/test/session/compaction.test.ts` provides `runtime`, `liveRuntime`, `llm`, `provideTmpdirInstance`, `assistant`, `user`, and the `ProviderTest.fake` helper. The `createModel` helper accepts `npm: "@ai-sdk/anthropic"` and produces a fake Provider.Model suitable for asserting `differentModel` behavior. A `processor.process` spy can be wired to capture the messages array sent to the compaction call (the `fake` factory at lines 146-159 returns a stub processor whose `process` accepts arbitrary input).
- **No existing reasoning-part fixture**: searches in `packages/opencode/test/session/` show no test that constructs an assistant message with a reasoning part. The integration test for this fix will be the first such test in the suite.

### Library & API Findings

- **Anthropic Extended Thinking — Preserving thinking blocks**: signatures are cryptographic verification tags that prove a thinking block was produced by Claude. When echoing thinking blocks back to the API in a multi-turn conversation, the signature must be passed through unchanged. Missing or altered signatures result in a 400 error. The signature is stored in `providerMetadata.anthropic.signature` (UIMessage form) / `providerOptions.anthropic.signature` (ModelMessage form) on Vercel AI SDK constructs. Sources: https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking ("Preserving thinking blocks" — conceptual contract; URL and section name verified by the goal-judge sources panel on 2026-04-27); https://docs.anthropic.com/en/api/messages (Messages API reference — `ThinkingBlockParam` defines `signature: string` as a required field, not optional; this is the formal spec corroborating the 400-on-missing behavior).
- **Vercel AI SDK `convertToModelMessages` semantics**: maps `UIMessage` reasoning parts (`{ type: 'reasoning', text, providerMetadata? }`) to `ModelMessage` reasoning content parts (`{ type: 'reasoning', text, providerOptions? }`). The mapping at `ai/dist/index.js:8473-8478` performs an **unconditional assignment** `providerOptions: part.providerMetadata` — when `providerMetadata` is `undefined` (absent), `providerOptions` is set to `undefined` explicitly, not omitted from the object. Tests should therefore assert `part.providerOptions === undefined` (value check), not `!("providerOptions" in part)` (key-presence check). Contrast with the text/file branches in the same function (lines 8463/8471), which use a conditional spread; the reasoning branch does not. The function does not synthesize signatures; it only carries through what the caller provides. (Sources: `ai/dist/index.js:8473-8478` for the mapping; `@ai-sdk/provider-utils/dist/index.d.ts:627-639` for the `ReasoningPart` type definition; `ai/dist/index.d.ts` near `ReasoningUIPart` for the input shape.)
- **AI SDK reasoning-part shape**: the current `packages/opencode` install uses `@ai-sdk/anthropic@3.0.70` and the corresponding `@ai-sdk/provider-utils@4.0.23`. The `ReasoningPart` interface (with `providerOptions?: ProviderOptions`) is defined in `@ai-sdk/provider-utils/dist/index.d.ts` at lines 627-639 and is consumed (but not separately re-exported) by `@ai-sdk/anthropic`. The `ai` package exposes the matching `ReasoningUIPart` type with `providerMetadata?: ProviderMetadata` for the UIMessage layer. The structural test added during implementation pins behavior against the installed version; if a future SDK upgrade changes the shape, that test fails fast rather than silently regressing the fix.
- **Same-pattern precedent in compaction.ts**: the existing tool-call/tool-result-to-text conversion at compaction.ts:240-254 is the established codebase pattern for "structured part type that cannot safely cross the compaction boundary, replace with plain-text representation or filter out". The reasoning filter follows this pattern. The commit history shows this pattern was added explicitly to address tool-call hallucinations (commits `0f3e831237` and `3bd0eac9df`); the reasoning fix is the natural symmetric extension.
- **Drop-vs-text-flatten choice**: for tool calls, the codebase chose to flatten to text (`[Called tool: X]\n[Input: Y]`) so the compaction model can reference the call in its summary. For reasoning, dropping entirely is preferred because (a) reasoning prose is internal scratch work that the compaction summary template does not reference, (b) including the prose risks the compaction model treating it as instructions or factual claims, and (c) the prose can be very large (thousands of tokens) and would inflate the compaction-model context. The user's Q2 direction confirms the drop choice.

### Web Research Status

The research findings cited above are derived from:
1. Direct reading of bundled `.d.ts` and `.js` files in `packages/opencode/node_modules/{ai,@ai-sdk/anthropic,@ai-sdk/provider-utils}/dist/` — these files are the source of truth for the SDK types/behavior and were inspected line-by-line. Notably `ai/dist/index.js:8473-8478` for the `convertToModelMessages` reasoning branch.
2. Direct reading of OpenCode source files at the cited line numbers.
3. Cross-reference with the Anthropic documentation URLs cited above. The conceptual docs URL (`/en/docs/build-with-claude/extended-thinking`) was originally cited unfetched by the goal-developer; the goal-judge sources panel verified on 2026-04-27 that the URL resolves and that the "Preserving thinking blocks" section exists with the cited content. The Messages API reference URL (`/en/api/messages`) was added during the same review and confirms `ThinkingBlockParam.signature` as a required field. The user's relayed field error (`messages.1.content.7.thinking.signature: Field required`) is independent corroboration of the 400-on-missing behavior.

### Verification Experiment Artifact

- Script: `specs/2026-04-27-compaction-thinking-signature/experiment/reasoning-signature-strip.test.ts`
- Results: `specs/2026-04-27-compaction-thinking-signature/experiment/RESULTS.md`
- Type: Bun test, structural — does not call any LLM, does not hit any network.
- Asserts: (a) on different-model conversion, `text` preserved and `providerOptions.anthropic.signature` is `undefined`; (b) on same-model conversion (control), signature preserved verbatim.
- **Execution status**: PASSED on 2026-04-27 against `local/compaction-agent-identity@49700133b6`. 2 tests / 0 fail / 8 expect() calls. Captured output for both branches is preserved in `RESULTS.md`.
- The experiment confirms the trigger path empirically. The structural code trace above is the *explanation*; the test is the *proof*.

## Open Questions (Resolved)

| #   | Question                                                                                                | Resolution                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Should the fix cover only compaction or also mid-session model switches?                                | Compaction only (user Q1). The shared line at message-v2.ts:790-796 is changed uniformly, which incidentally improves mid-session switch, but no work is added beyond what the compaction case requires. Mid-session-switch-specific concerns (notifications, recovery) are deferred.                                                                                                                |
| 2   | When dropping reasoning across a model boundary, drop entirely or flatten to text?                      | Drop entirely (user Q2). Reasoning prose is internal scratch work, not load-bearing for the compaction summary template, and can be large enough to bloat the compaction context. Flattening to text would risk the compaction model treating reasoning prose as factual claims.                                                                                                                     |
| 3   | Should the compaction.ts:240-254 input-side reshape also strip reasoning parts symmetrically?           | Yes (user Q3). The compaction-side filter is belt-and-suspenders defense against any path (current or future) that could let a reasoning part survive the message-v2 drop. It mirrors the existing tool-call/tool-result scrub pattern.                                                                                                                                                              |
| 4   | What branch should the implementation use?                                                              | New branch `local/compaction-thinking-signature` (user Q4), matching the spec dir name. The branch is created at implementation time, not now. The goal file lives on the current branch (`local/compaction-agent-identity` per `git status`) and travels into `local-integrated` via the implementation branch's merge commit.                                                                      |
| 5   | What test surface is required?                                                                          | Both structural unit assertion AND fixture-based integration test (user Q5). The structural test covers the message-v2 drop branch in isolation. The integration test covers the full compaction.process flow with a different compaction model and asserts the messages array sent to processor.process contains no reasoning parts.                                                                |
| 6   | Should the goal-developer execute the verification experiment before drafting?                          | The user requested execution (Q6). The experiment was executed by the parent (Claude Code) agent on 2026-04-27 after the goal-developer authored the script. Result: PASSED (2/0 fail). The captured `ModelMessage[]` output confirms reasoning parts are emitted with `text` but no `providerOptions` when models differ. Evidence at `specs/2026-04-27-compaction-thinking-signature/experiment/RESULTS.md`. The trigger path is now backed by hard data, not just code trace.              |
| 7   | What is the spec directory name?                                                                        | `specs/2026-04-27-compaction-thinking-signature/` (user Q7). Compaction-only scope. Name matches the implementation branch name.                                                                                                                                                                                                                                                                      |
| 8   | Why does `differentModel` fire in the compaction conversion?                                            | Resolved by code trace: `compaction.ts:236` passes the *compaction agent's* model to `toModelMessagesEffect`, while pre-compaction assistant messages are tagged with the *working agent's* model. When those differ — the configured cost-saving setup — `differentModel === true` for prior assistant turns. The bug only fires when `compaction.model` is configured AND set to a value different from the working model. If the compaction agent has no `model` set (fallback at compaction.ts:182-184) or has `model` set to the same value as the working model, `differentModel === false` and no strip occurs. |
| 9   | Could the AI SDK regenerate or synthesize a signature on `convertToModelMessages`?                      | No. The AI SDK has no signature-generation API. Signatures are model-specific cryptographic tokens generated server-side by Anthropic. The SDK only carries them through. Confirmed by reading `@ai-sdk/provider-utils/dist/index.d.ts` for the `ReasoningPart` type and finding no synthesis hook.                                                                                                  |
| 10  | Does dropping reasoning lose information that the compaction summary needs?                             | No, by template design. The compaction prompt at compaction.ts:191-223 asks the compaction model to summarize "what we did, what we're doing, which files we're working on, and what we're going to do next" — observable artifacts, not internal reasoning. The reasoning prose is not load-bearing for any section of the summary template.                                                       |
| 11  | What about non-Anthropic reasoning blocks (OpenAI o1/o3, etc.)?                                         | The fix is provider-agnostic at the conversion site — drops the reasoning part regardless of provider when models differ. For Anthropic and adapters that wrap Anthropic (Bedrock-Anthropic, Vertex-Anthropic), this is strictly correct. For non-Anthropic providers (OpenAI o1/o3, etc.), the drop is at minimum no worse than the current behavior (reasoning parts already lose metadata under `differentModel === true`). A formal verification of OpenAI/o3 reasoning-echo contracts is deferred to implementation phase if/when cross-provider compaction is exercised. No provider-specific branches are added in this fix.                                                                |
| 12  | Will this break any existing test?                                                                      | Searches in `packages/opencode/test/session/` show no existing test that constructs an assistant message with a reasoning part. No existing test exercises the message-v2.ts:790-796 reasoning branch. The fix is therefore unlikely to regress existing tests; the new tests added by this work establish the first coverage of this branch.                                                       |
| 13  | Is there a risk of reasoning parts in compaction summaries being dropped on the auto-continue turn?     | Yes — and that is the intended behavior. The compaction summary is tagged with the compaction model's `providerID/modelID`. On the auto-continue turn, the agent's working model is used; `differentModel === true` fires; the summary's reasoning parts (if any) are dropped. This prevents signature-less reasoning from leaking into the working model's input. The summary's text content is unaffected. |

## Notes for Downstream Agents

- The spec-writer should produce a `requirements.md` with EARS acceptance criteria covering: the conversion-time drop branch, the compaction-time scrub, the differentModel false-branch preservation, the empty-after-drop assistant-message handling, and the round-trip-loss invariant (no signature-less reasoning ever sent to a model).
- The design-writer should propose the minimal diff — one branch change in `message-v2.ts`, one filter addition in `compaction.ts` — and the test plan covering the structural assertion and the fixture-based integration test.
- The implementation agent must run `specs/2026-04-27-compaction-thinking-signature/experiment/reasoning-signature-strip.test.ts` first as a pre-implementation gating check. If it fails, escalate before changing code.
- The judge panel should validate the structural code trace at the cited line numbers (especially message-v2.ts:692, :790-796, :825-833 and compaction.ts:181-184, :236, :240-254, :292-307) and confirm no other call sites of `toModelMessagesEffect` are negatively affected by the drop-reasoning-when-different-model behavior. Three call sites are documented: compaction (compaction.ts:236), the standard agent turn (`prompt.ts` near line 1477), and title generation (`prompt.ts` near line 188).
