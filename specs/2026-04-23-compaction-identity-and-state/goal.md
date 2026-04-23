# Goal: Compaction Identity Preservation & Structured State Survival

## Overview

When OpenCode's context window fills up, the compaction system summarizes the conversation history so the agent can continue working. However, specialized agents (goal-developer, spec-writer, spec-judge, etc.) lose their behavioral identity after compaction — they start implementing code instead of performing their designated role (asking questions, writing specs, judging). Additionally, the agent's todo list is only included as a textual hint in the compaction prompt rather than being preserved as structured data that the agent can directly access post-compaction.

The existing implementation on `local-integrated` has two feature branches already merged (`local/compaction-agent-identity` and `local/compaction-todo`) that add a `<system-reminder>` tag and todo formatting to the compaction flow. These are necessary but may be insufficient — the reminder is a soft text hint in a user message, and the todo list is only visible to the compaction model, not directly to the post-compaction agent.

### Root Cause Hypothesis

The agent's full system prompt (from the `.opencode/agent/*.md` file body) survives compaction — it is injected on every LLM call via `llm.ts:117-129` regardless of conversation state. So the procedural memory (behavioral rules) is technically intact. The hypothesis for why identity drift still occurs despite an intact system prompt:

1. **Conversational frame override**: After compaction, the LLM sees a 4-message context: (a) system prompt, (b) "What did we do so far?", (c) the compaction summary, (d) "Continue if you have next steps...". The compaction summary — produced by a potentially cheaper model that may not faithfully follow the template — can frame the work in implementation-oriented language (e.g., "We were implementing feature X" instead of "We were developing a goal for feature X"). This implementation-oriented framing in the most recent assistant message creates a strong recency signal that competes with the system prompt's behavioral constraints.

2. **Compaction model infidelity**: The `## Agent Role & Constraints` section in the compaction prompt template (compaction.ts:202-204) asks the compaction model to preserve the agent's role. But the compaction model (which may be Haiku or another cheaper model) receives a truncated version of the agent's system prompt (max 4000 chars) and may not faithfully reproduce the role constraints in its summary. If the summary omits or dilutes the role description, the post-compaction agent has no conversational reinforcement of its role — only the system prompt, which may be overridden by the summary's framing.

3. **Minimal reinforcement**: The current `<system-reminder>` is a single generic sentence: `"You are the 'goal-developer' agent. Your role and constraints from your system prompt still apply after this compaction. Do not deviate from your assigned role."` This references the system prompt but doesn't restate the specific constraints. The agent must "remember" what the system prompt says, but after compaction the conversational context that previously reinforced those constraints is gone.

**Important caveat**: This is a design hypothesis, not a confirmed root cause. The identity drift has been observed anecdotally during development of the compaction-agent-identity feature branch, but no systematic reproduction or A/B testing has been performed. The proposed changes should be validated by testing with specialized agents (goal-developer, spec-writer) across compaction events. If identity drift does not occur in practice, the changes may be unnecessary — but they are low-risk and align with industry best practices for agent identity preservation.

## User Stories

- As a user working with a specialized agent (goal-developer, spec-writer), I want the agent to maintain its role after compaction, so that it continues asking questions / writing specs instead of switching to code implementation.
- As a user with an active todo list, I want the agent to see the exact todo state after compaction, so that it can continue tracking progress without losing or duplicating tasks.
- As a user on a long session, I want compaction to preserve the agent's behavioral constraints, so that I don't have to manually remind the agent of its role after every compaction event.

## Behaviors

### Agent Identity Preservation

- After compaction, the agent's full system prompt (from the `.opencode/agent/*.md` file body) continues to be injected as the system message via the existing `llm.ts:117-129` path. This already works and must not change.
- The compaction summary (produced by the compaction model) should include a dedicated `## Agent Role & Constraints` section that accurately captures the agent's name, role, and behavioral constraints. The current prompt template already requests this (compaction.ts:202-204), but the compaction model may not faithfully produce it.
- **[EXISTING]** The current `<system-reminder>` in the auto-continue user message (compaction.ts:332-335) provides a generic identity reminder. This fires correctly for custom agents (`source?.prompt && !source?.native`).
- **[IMPROVE]** The identity reinforcement in the auto-continue user message should be strengthened to include: the agent name, a concise role description (extracted from the agent definition's `description` field if available, or a generic "specialized agent" fallback if `description` is absent/empty), and specific behavioral constraints relevant to the agent's role. This reinforcement must be injected into the auto-continue user message text — NOT as a system message and NOT via `input.system` (see Constraints: Cache Compatibility). Note: there are two injection paths in the code — the replay path (compaction.ts:362-372, when replaying the last user message) and the standard auto-continue path (compaction.ts:408-423, when creating a new auto-continue message). Both paths must include the strengthened reinforcement.
- For native agents (build, plan, general, etc. where `native: true`), no identity reinforcement is needed — they have no specialized behavioral constraints to preserve.

### Todo State Preservation

- **[EXISTING]** The `formatTodos()` function (compaction.ts:32-36) formats todos as markdown and appends them to the compaction prompt (what the compaction model sees) at compaction.ts:228-231. This helps the compaction model reference task progress in its summary.
- **[NEW]** The todo list must also be injected into the auto-continue user message so the post-compaction agent sees the current todo state directly. Currently, `formatTodos()` output is only appended to the compaction prompt (compaction.ts:228-231), not to the post-compaction context the agent sees. The agent has no direct visibility of todo state after compaction unless it calls the `todoread` tool.
- The todo state injected post-compaction should include all fields: content, status (pending/in_progress/completed/cancelled), and priority (high/medium/low).
- The existing `formatTodos()` markdown format (or a similar structured format) should be used for the post-compaction injection.

#### Design Decision: Injection vs. Tool-Based Retrieval

The codebase already has a `TodoReadTool` (tool/todo.ts:56-84) that allows the agent to query the todo database directly. An alternative to injecting todo state into the auto-continue message would be to prompt the agent to call `todoread` after compaction. However, injection is preferred because:

1. **Zero-cost access**: Injection puts the todo state directly in the context without requiring an extra LLM turn and tool call (which adds latency and token cost).
2. **Guaranteed visibility**: The agent sees the todo state immediately, even if it doesn't think to call `todoread`. After compaction, the agent may not know it has a todo list unless the compaction summary mentions it.
3. **Consistency with identity reinforcement**: Both identity and todo state are injected in the same auto-continue message, creating a single "post-compaction state restoration" point.

The `todoread` tool remains available as a fallback if the agent needs to refresh its view of the todo list mid-conversation.

### Compaction Prompt Quality

- The compaction prompt template should continue to request the `## Agent Role & Constraints` section.
- The compaction model should receive the source agent's system prompt as its own system message (as it does today at compaction.ts:238-243, truncated to 4000 chars) so it has context about the agent's role when producing the summary.
- Tool calls should continue to be converted to plain text before being sent to the compaction model (as they are today at compaction.ts:248-265) to prevent tool-call hallucinations.
- `toolChoice: "none"` should continue to be set on the compaction processor call (as it is today at compaction.ts:316).

### Cache Compatibility

- The system prompt must remain identical before and after compaction to preserve Anthropic's prompt cache (which gives a 90% cost reduction on cache hits). Identity reinforcement must NOT be added to the system prompt or via `input.system`.
- **Critical implementation detail**: In `llm.ts:117-129`, `system[0]` is constructed by joining `agent.prompt + input.system + user.system` with `\n`. The caching logic at `llm.ts:139-146` checks if `system[0]` (the "header") is unchanged after plugin transforms. Any content added via `input.system` would be concatenated into `system[0]`, changing the header and invalidating the Anthropic cache. Therefore, identity reinforcement must be injected into the conversation messages (the auto-continue user message), not into the system prompt path.
- The minimum token threshold for Anthropic caching varies by model (1,024-4,096 tokens). The system prompt for custom agents (which is the full markdown body of the agent definition) typically exceeds this threshold, so caching should work.

## Edge Cases & Invariants

### Invariants (always true)

- The first element of the system array (`system[0]` in `llm.ts:117-129`) is constructed from `agent.prompt` + `input.system` + `user.system` joined with `\n`. When `input.system` and `user.system` are empty (the common case), `system[0]` equals the agent's full markdown body. Compaction never modifies any of these inputs, so the system prompt content is unchanged across compaction.
- After compaction, the agent name on the auto-continue message (`userMessage.agent`) matches the agent that was active before compaction. The compaction system preserves the agent field on messages.
- Native agents (`native: true`) never receive identity reinforcement — they have no specialized behavioral constraints.
- The todo list in the database is the single source of truth. The `Todo.Service` persists todos independently of the conversation history. Compaction does not modify the todo database.

### Idempotent Operations

- Running compaction twice in a row (if the context overflows again immediately after compaction) should produce a valid state. The second compaction should see the first compaction's summary and produce a new summary that still includes the agent role and todo state.
- The identity reinforcement injection is idempotent — injecting it multiple times (e.g., if compaction happens twice) should not cause behavioral drift or contradictory instructions.

### Round-trip Guarantees

- The todo list injected post-compaction should be human-readable and unambiguous enough that the LLM agent can understand the exact state of each todo item (content, status, priority). Note: this is LLM-readability, not programmatic parseability — the `formatTodos()` markdown format is designed for LLM consumption, not for round-tripping back to `Todo.Info[]`.

### Preservation (must not change)

- The existing compaction flow (prune → summarize → auto-continue) must not change structurally.
- The existing `filterCompactedEffect` logic that identifies compaction boundaries via `summary: true` must continue to work.
- The existing plugin hooks (`experimental.session.compacting`, `experimental.compaction.autocontinue`, `experimental.chat.system.transform`, `experimental.chat.messages.transform`) must continue to fire at the same points.
- The existing `CompactionPart` schema (`{ type: "compaction", auto: boolean, overflow?: boolean }`) must remain backward-compatible.
- The existing `TextPart.metadata` field (used for `compaction_continue: true`) must continue to work.
- The hardcoded `"What did we do so far?"` text in `toModelMessagesEffect` (message-v2.ts:676-681) that represents the compaction trigger to the LLM must not change.

### Known Edge Cases

- The `source` variable at compaction.ts:236 (`yield* agents.get(userMessage.agent)`) can return `undefined` if the agent name on the message doesn't match any loaded agent (e.g., if the agent definition was deleted between when the session started and when compaction runs). Note: `agents.get()` at `agent.ts:301-303` returns `agents[agent]` which is `Info | undefined` at runtime despite the type signature. The identity reinforcement must use optional chaining on `source` and handle `undefined` gracefully — no reinforcement rather than a crash.
- The compaction model (which may be a cheaper model like Haiku) may not faithfully follow the prompt template. The `## Agent Role & Constraints` section in the summary may be missing, incomplete, or inaccurate. The identity reinforcement mechanism should not rely solely on the compaction model's output.
- Custom agents loaded from `~/.opencode/agent/*.md` have `native: false` and a `prompt` field containing the full markdown body. Config-only agents (defined in `opencode.json` without a `.md` file) may have `native: false` but an empty or missing `prompt` field. The guard `source?.prompt && !source?.native` correctly handles this — no reinforcement for agents without a prompt.
- The `description` field on agent definitions is optional (`config/agent.ts:28` — `z.string().optional()`). When `description` is absent or empty, the identity reinforcement should fall back to a generic message like "You are a specialized agent" rather than omitting the role description entirely.
- The agent's system prompt can be very long (the goal-developer prompt is ~400 lines). The compaction model receives a truncated version (max 4000 chars). The identity reinforcement should use the `description` field (which is short) rather than re-injecting the full prompt.
- Double compaction: if the context overflows immediately after compaction (e.g., because the summary itself is very long), the system must handle a second compaction gracefully. The identity reinforcement from the first compaction becomes part of the conversation history that gets summarized in the second compaction.

## Constraints

- **Language/Runtime**: TypeScript, Bun runtime, Effect library for service composition
- **Framework**: Vercel AI SDK for LLM interactions. The codebase uses the messages-prepend pattern (`llm.ts:117-129`) to construct the system array, not the `streamText` `system` parameter directly. `input.system` is `string[]` — any reinforcement via this path must be a plain string (no `cache_control` markers possible through this path).
- **Codebase**: `/Users/EHMKIE/Code/opencode-local-dev`, integration branch `local-integrated`
- **Existing changes**: Must build on top of the existing `local/compaction-agent-identity` and `local/compaction-todo` changes already merged into `local-integrated`
- **Branch delivery strategy**: Each feature area has its own branch. New commits must go to the appropriate feature branch, then be merged into `local-integrated` via merge commits:
  - Identity-related changes → commit to `local/compaction-agent-identity`, then merge into `local-integrated`
  - Todo-related changes → commit to `local/compaction-todo`, then merge into `local-integrated`
  - `local-integrated` is the integration branch — it receives merges from the feature branches but should not get direct commits for these features
  - This preserves a clean, self-contained commit history on each feature branch and keeps `local-integrated` buildable without reconstructing it from scratch
- **Cache preservation**: Must not invalidate Anthropic's prompt cache by changing `system[0]` content. Identity and todo reinforcement must be injected into conversation messages (the auto-continue user message), not via `input.system` or by modifying the system prompt. See Cache Compatibility section for the `llm.ts:117-129` concatenation detail.
- **Provider compatibility**: Mid-conversation `role: 'system'` messages are supported by the Vercel AI SDK but provider behavior varies — Anthropic and OpenAI may not honor system messages that aren't at position 0. Identity reinforcement must use the auto-continue user message, not a mid-conversation system message.
- **Backward compatibility**: The `CompactionPart` schema, `TextPart.metadata`, and all existing plugin hooks must remain backward-compatible. No breaking changes to the message schema.
- **Testing**: Changes should be testable via the existing test patterns in `packages/opencode/test/session/compaction.test.ts` and `compaction-todo.test.ts`. Tests run from `packages/opencode`, not from repo root.

## Out of Scope

- **Changing the compaction model**: The choice of which model performs compaction (configured via the `compaction` agent in config) is out of scope. We work with whatever model the user has configured.
- **Persistent memory across sessions**: This goal is about preserving state within a single session across compaction events. Cross-session memory (Honcho, knowledge graph) is a separate concern.
- **Changing the compaction trigger logic**: When compaction fires (overflow detection, token thresholds) is out of scope. We only change what happens during and after compaction.
- **Agent definition format changes**: The `.opencode/agent/*.md` format (YAML frontmatter + markdown body) is not changing. We work with the existing `description`, `prompt`, `native`, and other fields.
- **UI changes**: No changes to how compaction is displayed in the TUI. The compaction message continues to appear as it does today.
- **Plugin API changes**: No new plugin hooks. The existing hooks continue to work as they do today.
- **Changing the `toModelMessagesEffect` function**: The way compaction parts are converted to model messages (the hardcoded "What did we do so far?" text) is not changing.
- **Observability/metrics**: Adding logging or metrics for identity preservation success rates is desirable but out of scope for this goal. Validation will be done through manual testing with specialized agents.

## Success Criteria

- After compaction, a goal-developer agent continues to ask questions and refine the goal rather than switching to code implementation. (Validated by manual testing — run a goal-developer session long enough to trigger compaction and verify the agent maintains its role.)
- After compaction, a spec-writer agent continues to write specs rather than switching to code implementation. (Validated by manual testing.)
- After compaction, the agent's todo list is visible in the auto-continue message as structured data (not just mentioned in the summary) and the agent can reference specific todo items by their content and status.
- The Anthropic prompt cache is not invalidated by compaction — `system[0]` in `llm.ts` remains identical before and after compaction. (Validated by inspecting the system array in tests or by checking `cacheReadInputTokens` in provider metadata.)
- All existing compaction tests continue to pass.
- The compaction flow handles `source` being `undefined` without crashing.
- Double compaction (compaction immediately after compaction) produces a valid state with identity and todo preserved.
- The identity reinforcement text in the auto-continue message includes the agent's `description` field when non-empty, and falls back to a generic message when `description` is absent. (Validated by unit test.)

## Technical Context

### Codebase Findings

- **Agent loading**: Custom agents from `.opencode/agent/*.md` are loaded by `config/agent.ts:101-136`. The markdown body becomes the `prompt` field (line 126). In `agent/agent.ts:256-283`, these are merged into the runtime agents record with `native: false` (line 268). The `description` field is optional (`config/agent.ts:28`).
- **System prompt construction**: At `llm.ts:117-129`, `system[0]` is built by joining `[agent.prompt, ...input.system, user.system].filter(x => x).join("\n")`. The caching logic at `llm.ts:139-146` preserves a 2-part structure if `system[0]` (the "header") is unchanged after plugin transforms. Any modification to `input.system` changes `system[0]` and breaks the cache.
- **Compaction flow**: `prompt.ts` triggers compaction → `compaction.ts:process()` summarizes and optionally auto-continues (pruning is a separate forked operation at `prompt.ts:1783`) → `prompt.ts:1603` loops back (`continue`) and re-invokes the LLM with compacted history.
- **Post-compaction context**: The LLM sees: (1) system prompt (`system[0]`, unchanged), (2) a user message "What did we do so far?" (hardcoded in `toModelMessagesEffect` at message-v2.ts:676-681), (3) the compaction summary as a regular `role: "assistant"` message (no special treatment for `summary: true` in `toModelMessagesEffect`), (4) the auto-continue user message with optional `<system-reminder>`.
- **`source` resolution**: At `compaction.ts:236`, `agents.get(userMessage.agent)` does a simple record lookup (`agent.ts:301-303` returns `agents[agent]`). For custom agents like `goal-developer`, this returns the agent with `native: false` and `prompt` set to the full markdown body. Returns `undefined` if the agent is not found.
- **Identity guard**: At `compaction.ts:332-335`, `source?.prompt && !source?.native` correctly fires for custom agents. The guard works; the question is whether the mechanism it triggers is sufficient.
- **Todo injection (current)**: `formatTodos()` at `compaction.ts:32-36` formats todos as markdown. This is appended to the compaction prompt (what the compaction model sees) at line 228-231. It is NOT injected into the post-compaction context that the agent sees.
- **TodoReadTool**: The `TodoReadTool` (tool/todo.ts:56-84) allows the agent to query the todo database directly. This is a fallback but not a substitute for injection (see Design Decision above).
- **Message schema**: `CompactionPart` (message-v2.ts:209-216) has `{ type: "compaction", auto: boolean, overflow?: boolean }` — no metadata or text field. `TextPart` (message-v2.ts:112-127) has `metadata: z.record(z.string(), z.any()).optional()` at line 123, already used for `compaction_continue: true`. `PartBase` (message-v2.ts:89-93) has no `metadata` field.
- **Part union**: The `Part` discriminated union (message-v2.ts:385-403) includes 12 part types. Adding a new part type would require schema migration.

### Library & API Findings

- **Vercel AI SDK**: Supports multiple system messages and mid-conversation `role: 'system'` messages. The `system` parameter accepts `string | SystemModelMessage | SystemModelMessage[]`. However, the OpenCode codebase uses the messages-prepend pattern (`llm.ts:117-129`), not the `system` parameter directly. Mid-conversation system messages may not be honored by all providers — Anthropic and OpenAI may only respect system messages at position 0. (Source: [Vercel AI SDK — Foundations: Prompts](https://sdk.vercel.ai/docs/foundations/prompts))
- **Anthropic prompt caching**: Prefix-based caching with explicit `cache_control` markers. If the system prompt is unchanged after compaction, the cache remains valid (90% cost reduction on hits). Changing the system prompt invalidates all downstream caches. Minimum token thresholds: 1,024-4,096 tokens depending on model. (Source: [Anthropic — Prompt Caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching))
- **Agent identity patterns in other frameworks**: The CoALA cognitive architecture taxonomy (arXiv:2309.02427, applying classical cognitive science categories to language agents) classifies the system prompt as "procedural long-term memory" that should never be summarized. The "character seed" pattern from Generative Agents (Park et al. 2023, arXiv:2304.03442) — a fixed identity description always prepended to context — is the earliest documented role anchoring pattern. Ablation studies showed removing the character seed caused behavioral incoherence even with intact memory retrieval. MemGPT/Letta, LangGraph, AutoGen, and CrewAI all keep agent identity structurally separate from the summarizable message buffer. (Sources: [CoALA](https://arxiv.org/abs/2309.02427), [Generative Agents](https://arxiv.org/abs/2304.03442), [Letta](https://docs.letta.com/guides/core-concepts/stateful-agents/), [LangGraph](https://blog.langchain.com/launching-long-term-memory-support-in-langgraph/))
- **Structured state preservation**: The industry pattern is a "pinned tier" (verbatim, always present) vs. "compressible tier" (summarizable). Letta uses "memory blocks" pinned to the system prompt. LangGraph uses non-`messages` fields in the `State` TypedDict that are preserved by the checkpointer. In all cases, structured state is never passed through the summarizer — it is re-injected verbatim. (Sources: [MemGPT paper](https://arxiv.org/abs/2310.08560), [LangGraph memory](https://blog.langchain.com/memory-for-agents/))

## Open Questions (Resolved)

| #   | Question                                                                       | Resolution                                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Does the `source` guard at compaction.ts:332 correctly fire for custom agents? | Yes — custom agents have `native: false` and `prompt` set to the full markdown body. The guard fires correctly. The question is whether the mechanism it triggers is sufficient.                                                                                                                                   |
| 2   | Is the agent's system prompt preserved across compaction?                      | Yes — `llm.ts:117-129` constructs `system[0]` from `agent.prompt` on every LLM call regardless of compaction state. The system prompt is never part of the summarizable conversation history.                                                                                                                      |
| 3   | Can we add a mid-conversation system message for identity reinforcement?       | The Vercel AI SDK supports it, but provider behavior varies. Anthropic and OpenAI may not honor system messages that aren't at position 0. Additionally, using `input.system` would concatenate into `system[0]` and break the Anthropic cache. The only viable injection point is the auto-continue user message. |
| 4   | Would adding identity info to the system prompt break the Anthropic cache?     | Yes — any change to `system[0]` content invalidates the cache. Identity reinforcement must be in conversation messages, not in the system prompt path.                                                                                                                                                             |
| 5   | Where should todo state be injected post-compaction?                           | In the auto-continue user message, alongside the identity reinforcement. This keeps it in the "most recent" position and avoids cache invalidation.                                                                                                                                                                |
| 6   | Should we add a new part type for todo state?                                  | No — adding a new part type to the `Part` discriminated union requires schema migration and changes to `toModelMessagesEffect`. Using the existing `TextPart` with `metadata` is simpler and backward-compatible.                                                                                                  |
| 7   | How does the LLM see the compaction summary?                                   | As a regular `role: "assistant"` message. `toModelMessagesEffect` applies no special treatment to `summary: true` messages. The summary text is stored as a standard `TextPart`.                                                                                                                                   |
| 8   | Why not use `todoread` tool instead of injection?                              | Injection is preferred: zero-cost access (no extra LLM turn), guaranteed visibility (agent sees todos immediately), and consistency with identity reinforcement (single restoration point). `todoread` remains available as a fallback.                                                                            |
| 9   | Is identity drift a confirmed problem or a hypothesis?                         | It is a design hypothesis based on anecdotal observation during development. No systematic reproduction or A/B testing has been performed. The proposed changes are low-risk and align with industry best practices, so they are worth implementing even if the problem is less severe than hypothesized.          |
