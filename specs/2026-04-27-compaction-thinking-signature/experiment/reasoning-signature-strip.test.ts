/**
 * EXPERIMENT: Compaction strips reasoning signatures when the compaction model
 * differs from the agent model.
 *
 * Hypothesis (from goal-developer Q&A round 1):
 *   When `compaction.ts` calls `MessageV2.toModelMessagesEffect(msgs, model, ...)`
 *   with `model` set to the compaction model (potentially different from the
 *   agent's model that produced the assistant turns being summarized), the
 *   `differentModel` branch in `message-v2.ts:790-796` keeps the reasoning
 *   `text` but DROPS `providerMetadata`. After
 *   `convertToModelMessages` runs, the resulting `ModelMessage` carries a
 *   reasoning content part with `text` but NO
 *   `providerOptions.anthropic.signature`.
 *
 *   Anthropic's API rejects echoed thinking blocks that lack a signature
 *   (https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking
 *   "Preserving thinking blocks": signatures cryptographically verify that
 *   the thinking block was produced by Claude; missing/altered signatures
 *   cause a 400 error).
 *
 * What this test proves DIRECTLY (no LLM, no network):
 *   1. Building a `WithParts[]` with a single assistant message containing a
 *      `reasoning` part whose `metadata` carries an Anthropic-style signature
 *      under `providerOptions.anthropic.signature`.
 *   2. Running `toModelMessages` with a compaction model whose
 *      `providerID/modelID` differs from the assistant's recorded
 *      `providerID/modelID` (the compaction trigger condition).
 *   3. Inspecting the returned `ModelMessage[]` and asserting that:
 *        a. A reasoning content part is present in the assistant message.
 *        b. The reasoning part's `text` is preserved verbatim.
 *        c. The reasoning part has NO `providerOptions` (or no
 *           `providerOptions.anthropic.signature`).
 *   4. As a control, running the same input with a SAME-model configuration
 *      and asserting the signature IS preserved.
 *
 * What this test does NOT do:
 *   - Hit Anthropic's API. The Anthropic-side rejection is documented in
 *     Anthropic's public docs (cited above) and is consistent across SDKs.
 *     We do not need to spend tokens to confirm a documented contract; the
 *     bug is that we strip a value the contract requires.
 *
 * Run from packages/opencode:
 *   bun test ../../specs/2026-04-27-compaction-thinking-signature/experiment/reasoning-signature-strip.test.ts
 */

import { describe, expect, test } from "bun:test"
import { MessageV2 } from "../../../packages/opencode/src/session/message-v2"
import type { Provider } from "../../../packages/opencode/src/provider"
import { MessageID, PartID, SessionID } from "../../../packages/opencode/src/session/schema"
import { ModelID, ProviderID } from "../../../packages/opencode/src/provider/schema"

const SIGNATURE = "EuYBCkYIBxgCKkBfaketestthinkingsignaturenottrueactualsignaturejustfortestingxyz=="

function makeModel(opts: { providerID: string; modelID: string }): Provider.Model {
  return {
    id: opts.modelID,
    providerID: opts.providerID,
    name: opts.modelID,
    limit: { context: 200_000, output: 32_000 },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: true,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: "@ai-sdk/anthropic" },
    options: {},
  } as Provider.Model
}

function buildAssistantWithReasoning(opts: {
  assistantProviderID: string
  assistantModelID: string
  signature: string
}): MessageV2.WithParts[] {
  const sessionID = SessionID.descending()
  const userID = MessageID.ascending()
  const userPartID = PartID.ascending()
  const assistantID = MessageID.ascending()
  const reasoningPartID = PartID.ascending()
  const textPartID = PartID.ascending()

  const userMsg: MessageV2.WithParts = {
    info: {
      id: userID,
      role: "user",
      sessionID,
      agent: "goal-developer",
      model: {
        providerID: ProviderID.make(opts.assistantProviderID),
        modelID: ModelID.make(opts.assistantModelID),
      },
      time: { created: Date.now() - 1000 },
    },
    parts: [
      {
        id: userPartID,
        sessionID,
        messageID: userID,
        type: "text",
        text: "Help me design a feature.",
      },
    ],
  }

  const assistantMsg: MessageV2.WithParts = {
    info: {
      id: assistantID,
      role: "assistant",
      sessionID,
      mode: "build",
      agent: "goal-developer",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 100, output: 50, reasoning: 200, cache: { read: 0, write: 0 } },
      modelID: ModelID.make(opts.assistantModelID),
      providerID: ProviderID.make(opts.assistantProviderID),
      parentID: userID,
      time: { created: Date.now() - 500 },
      finish: "end_turn",
    },
    parts: [
      {
        id: reasoningPartID,
        sessionID,
        messageID: assistantID,
        type: "reasoning",
        text: "Let me think about this carefully. The user wants...",
        // Anthropic-style metadata: signatures live in providerOptions.anthropic
        // shape, but the OpenCode storage layer keeps the raw provider metadata
        // map under part.metadata. The shape used by the AI SDK is mirrored
        // here as { anthropic: { signature: "..." } }.
        metadata: {
          anthropic: {
            signature: opts.signature,
          },
        },
        time: { start: Date.now() - 500, end: Date.now() - 400 },
      },
      {
        id: textPartID,
        sessionID,
        messageID: assistantID,
        type: "text",
        text: "Here is my analysis of the feature.",
      },
    ],
  }

  return [userMsg, assistantMsg]
}

describe("EXPERIMENT: compaction reasoning signature strip", () => {
  test("DIFFERENT model drops reasoning part entirely (post-fix)", async () => {
    // Agent ran on Claude Sonnet 4.5
    const input = buildAssistantWithReasoning({
      assistantProviderID: "anthropic",
      assistantModelID: "claude-sonnet-4-5",
      signature: SIGNATURE,
    })

    // Compaction runs on a different model (e.g. Haiku, or any model whose
    // providerID/modelID does not match the assistant's). This is exactly the
    // condition under which `differentModel === true` in message-v2.ts:692.
    const compactionModel = makeModel({
      providerID: "anthropic",
      modelID: "claude-haiku-4-5",
    })

    const modelMessages = await MessageV2.toModelMessages(input, compactionModel)

    // Print the full output for the experiment record.
    console.log(
      "\n=== DIFFERENT MODEL OUTPUT (post-fix: reasoning dropped) ===\n" +
        JSON.stringify(modelMessages, null, 2),
    )

    const assistantOut = modelMessages.find((m) => m.role === "assistant")
    expect(assistantOut).toBeDefined()
    expect(Array.isArray(assistantOut!.content)).toBe(true)

    const content = assistantOut!.content as Array<{
      type: string
      text?: string
      providerOptions?: Record<string, unknown>
    }>

    // Post-fix invariant: when the call's model differs from the assistant's
    // recorded model, the reasoning content part is dropped entirely from the
    // assistant message. No half-state (text without signature) exists.
    const reasoning = content.find((p) => p.type === "reasoning")
    expect(reasoning).toBeUndefined()

    // Other (non-reasoning) parts continue to flow through.
    const textPart = content.find((p) => p.type === "text")
    expect(textPart).toBeDefined()
    expect(textPart!.text).toBe("Here is my analysis of the feature.")
  })

  test("SAME model preserves signature (control)", async () => {
    const input = buildAssistantWithReasoning({
      assistantProviderID: "anthropic",
      assistantModelID: "claude-sonnet-4-5",
      signature: SIGNATURE,
    })

    // No compaction-different-model condition: compaction model == assistant model.
    const sameModel = makeModel({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
    })

    const modelMessages = await MessageV2.toModelMessages(input, sameModel)

    console.log(
      "\n=== SAME MODEL OUTPUT (control) ===\n" + JSON.stringify(modelMessages, null, 2),
    )

    const assistantOut = modelMessages.find((m) => m.role === "assistant")
    const content = assistantOut!.content as Array<{
      type: string
      text?: string
      providerOptions?: Record<string, unknown>
    }>
    const reasoning = content.find((p) => p.type === "reasoning")
    expect(reasoning).toBeDefined()
    expect(reasoning!.text).toBe("Let me think about this carefully. The user wants...")

    const anthropicOpts = reasoning!.providerOptions?.anthropic as
      | { signature?: string }
      | undefined
    const observedSignature = anthropicOpts?.signature
    console.log("Observed signature on same-model path:", observedSignature ?? "<MISSING>")
    expect(observedSignature).toBe(SIGNATURE)
  })
})
