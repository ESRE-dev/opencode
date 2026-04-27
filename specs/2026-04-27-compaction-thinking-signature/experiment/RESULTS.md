# Experiment Results: Reasoning-Signature Strip in `toModelMessagesEffect`

## Summary

**Hypothesis CONFIRMED.** The bug is reproducible in pure unit-test conditions
without any LLM call or network access. The conversion path at
`packages/opencode/src/session/message-v2.ts:790-796` emits a reasoning
content part with `text` preserved but `providerOptions` (carrying the
Anthropic `signature`) elided when the call's model differs from the
assistant message's stored model.

## Reproduction

```bash
cd packages/opencode
bun test ../../specs/2026-04-27-compaction-thinking-signature/experiment/reasoning-signature-strip.test.ts
```

Run on 2026-04-27 against `local/compaction-agent-identity` tip
`49700133b6 compaction: extract buildIdentityReinforcement helper`.

```
bun test v1.3.13 (bf2e2cec)
 2 pass
 0 fail
 8 expect() calls
Ran 2 tests across 1 file. [794.00ms]
```

## Evidence

### Different-model path (compaction trigger condition)

Compaction model: `anthropic/claude-haiku-4-5`. Assistant message
recorded with: `anthropic/claude-sonnet-4-5`. `differentModel === true`.

Output `ModelMessage[]` from `MessageV2.toModelMessages`:

```json
[
  {
    "role": "user",
    "content": [
      {
        "type": "text",
        "text": "Help me design a feature."
      }
    ]
  },
  {
    "role": "assistant",
    "content": [
      {
        "type": "reasoning",
        "text": "Let me think about this carefully. The user wants..."
      },
      {
        "type": "text",
        "text": "Here is my analysis of the feature."
      }
    ]
  }
]
```

The reasoning content part has **no `providerOptions` field at all**.
`providerOptions.anthropic.signature` is `undefined`.

This matches the shape that Anthropic's API rejects with
`messages.N.content.M.thinking.signature: Field required`.

### Same-model path (control)

Both call model and assistant message recorded with
`anthropic/claude-sonnet-4-5`. `differentModel === false`.

Output `ModelMessage[]`:

```json
[
  {
    "role": "user",
    "content": [
      {
        "type": "text",
        "text": "Help me design a feature."
      }
    ]
  },
  {
    "role": "assistant",
    "content": [
      {
        "type": "reasoning",
        "text": "Let me think about this carefully. The user wants...",
        "providerOptions": {
          "anthropic": {
            "signature": "EuYBCkYIBxgCKkBfaketestthinkingsignaturenottrueactualsignaturejustfortestingxyz=="
          }
        }
      },
      {
        "type": "text",
        "text": "Here is my analysis of the feature."
      }
    ]
  }
]
```

Signature preserved verbatim.

## Conclusion

The trigger path identified by code-trace is **structurally exact** —
not a probabilistic claim. The fix described in the goal
(drop reasoning parts entirely from `message-v2.ts:790-796` and
symmetric scrub at `compaction.ts:240-254` when crossing the model
boundary) is the minimal correct change.

## What was NOT verified by this experiment

- Anthropic's API actually returning a 400 on this shape. This is taken
  from Anthropic's published contract
  (https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking
  — "Preserving thinking blocks") plus the user's reported reproduction
  (`messages.1.content.7.thinking.signature: Field required` on every
  compaction event in the user's environment). The experiment proves
  OpenCode produces the rejection-shaped messages; combined with the
  user's field report, that closes the loop.
- End-to-end compaction flow. The structural assertion is at the
  conversion site only; an integration test through `compaction.process`
  is part of the implementation phase per Success Criteria.
