# Chapter 4: LLM Provider System

> How OpenCode abstracts 20+ AI providers through the Vercel AI SDK, with model routing, streaming, and provider-specific transforms.

---

## The Provider Abstraction

One of OpenCode's most impressive feats is supporting **20+ LLM providers** — from Anthropic to xAI — without the core agent code knowing or caring which provider is active. This is achieved through a clean layered abstraction:

```
Agent says "use model X"
        │
        ▼
┌─────────────────────┐
│  Provider Registry   │  Maps "anthropic/claude-sonnet-4" → adapter
│  provider/provider.ts│
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  @ai-sdk/anthropic  │  Provider-specific SDK adapter
│  (or openai, etc.)  │  Returns a LanguageModelV2 instance
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  Vercel AI SDK      │  streamText(), generateObject()
│  ai@5.0.124         │  Unified streaming protocol
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  HTTP to Provider   │  Anthropic API, OpenAI API, etc.
└─────────────────────┘
```

The key insight: **the agent and session code never import provider-specific packages**. They only interact with the `LanguageModelV2` protocol from the Vercel AI SDK. The provider module handles all the specifics.

---

## The Vercel AI SDK

The **[Vercel AI SDK](https://sdk.vercel.ai)** (`ai` package, version **5.0.124**) is the cornerstone of OpenCode's LLM integration. It provides:

### Core Functions

| Function              | Purpose                                         | Used In                      |
| --------------------- | ----------------------------------------------- | ---------------------------- |
| `streamText()`        | Stream a text completion with tool support      | `session/llm.ts` — main loop |
| `generateObject()`    | Generate a structured JSON object from a schema | Compaction, title generation |
| `streamObject()`      | Stream a structured object                      | Structured output sessions   |
| `wrapLanguageModel()` | Add middleware (logging, transforms) to a model | Provider transforms          |

### The LanguageModelV2 Protocol

Every provider adapter returns an object implementing `LanguageModelV2` — the universal interface:

```typescript
interface LanguageModelV2 {
  // The model can produce text and tool calls
  doStream(options: {
    prompt: LanguageModelV2Prompt
    tools?: Record<string, Tool>
    temperature?: number
    maxTokens?: number
    // ...
  }): Promise<AsyncIterable<StreamPart>>
}
```

This means the session's `llm.ts` can call `streamText()` with **any** provider and get back the same stream of text chunks, tool calls, and metadata — regardless of whether it's talking to Anthropic's Messages API, OpenAI's Chat Completions API, or Google's Gemini API.

### Tool Integration

The AI SDK's tool system is how OpenCode's 25+ built-in tools become available to the LLM:

```typescript
import { streamText, tool } from "ai"

const result = streamText({
  model, // LanguageModelV2 from any provider
  messages,
  tools: {
    bash: tool({
      description: "Execute a shell command",
      parameters: z.object({
        command: z.string(),
      }),
      execute: async ({ command }) => {
        // ... run the command
      },
    }),
    // ... 24 more tools
  },
})
```

When the LLM decides to call a tool, the AI SDK:

1. Parses the tool call from the stream
2. Validates parameters against the Zod schema
3. Calls the `execute` function
4. Returns the result to the LLM for the next turn

---

## Supported Providers

OpenCode ships adapters for over 20 providers. Each one is a separate `@ai-sdk/*` package:

### Tier 1 — Full Support

These providers have deep integration with provider-specific optimizations:

| Provider  | Package                  | Version | Notable Features                         |
| --------- | ------------------------ | ------- | ---------------------------------------- |
| Anthropic | `@ai-sdk/anthropic`      | 2.0.65  | Extended thinking, prompt caching, PDFs  |
| OpenAI    | `@ai-sdk/openai`         | 2.0.89  | Function calling, JSON mode, vision      |
| Google    | `@ai-sdk/google`         | 2.0.54  | Gemini models, grounding, code execution |
| Azure     | `@ai-sdk/azure`          | 2.0.91  | OpenAI models via Azure endpoints        |
| Bedrock   | `@ai-sdk/amazon-bedrock` | 3.0.82  | AWS-hosted models, IAM auth              |

### Tier 2 — Standard Support

| Provider   | Package              | Version |
| ---------- | -------------------- | ------- |
| xAI        | `@ai-sdk/xai`        | 2.0.51  |
| Mistral    | `@ai-sdk/mistral`    | 2.0.27  |
| Groq       | `@ai-sdk/groq`       | 2.0.34  |
| Cohere     | `@ai-sdk/cohere`     | 2.0.22  |
| DeepInfra  | `@ai-sdk/deepinfra`  | 1.0.36  |
| Cerebras   | `@ai-sdk/cerebras`   | 1.0.36  |
| Perplexity | `@ai-sdk/perplexity` | 2.0.23  |
| TogetherAI | `@ai-sdk/togetherai` | 1.0.34  |
| Vercel     | `@ai-sdk/vercel`     | 1.0.33  |

### Tier 3 — Gateway & Compatible

| Provider          | Package                       | Version | Notes                                |
| ----------------- | ----------------------------- | ------- | ------------------------------------ |
| OpenRouter        | `@openrouter/ai-sdk-provider` | 1.5.4   | Multi-provider routing (patched)     |
| GitLab            | `@gitlab/gitlab-ai-provider`  | 3.6.0   | GitLab Duo integration               |
| GitHub Copilot    | `@ai-sdk/openai-compatible`   | 1.0.32  | Custom wrapper for Copilot API       |
| Google Vertex     | `@ai-sdk/google-vertex`       | 3.0.106 | GCP Vertex AI                        |
| Gateway           | `@ai-sdk/gateway`             | 2.0.30  | Vercel AI Gateway                    |
| AI Gateway        | `ai-gateway-provider`         | 2.3.1   | Generic gateway provider             |
| Any OpenAI-compat | `@ai-sdk/openai-compatible`   | 1.0.32  | Works with any OpenAI-compatible API |

---

## Provider Registry

The provider module (`provider/provider.ts`) maintains a registry that maps provider identifiers to their factory functions:

```typescript
// Conceptual — simplified from actual code
const providers = {
  anthropic: (config) => createAnthropic({ apiKey: config.apiKey }),
  openai: (config) => createOpenAI({ apiKey: config.apiKey }),
  google: (config) => createGoogleGenerativeAI({ apiKey: config.apiKey }),
  // ... 17 more
}
```

### Model Resolution

When an agent specifies a model like `"anthropic/claude-sonnet-4-20250514"`, the provider module:

1. **Splits** the string at `/` → provider ID (`anthropic`) + model ID (`claude-sonnet-4-20250514`)
2. **Looks up** the provider in the registry
3. **Creates** the provider instance with the user's API key (from config or environment)
4. **Returns** a `LanguageModelV2` instance for that specific model

```
"anthropic/claude-sonnet-4-20250514"
     │              │
     │              └──→ Model ID passed to createAnthropic().chat("claude-sonnet-4-20250514")
     │
     └──→ Provider ID → look up in registry → createAnthropic({ apiKey })
```

### Configuration

Users configure providers in `opencode.json` or `~/.config/opencode/config.toml`:

```json
{
  "provider": {
    "anthropic": {
      "apiKey": "sk-ant-..."
    },
    "openai": {
      "apiKey": "sk-..."
    },
    "custom": {
      "type": "openai-compatible",
      "baseURL": "https://my-llm-server.com/v1",
      "apiKey": "..."
    }
  }
}
```

Or via environment variables:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENAI_API_KEY="sk-..."
```

The provider module checks both config and environment, preferring config when present.

---

## Provider-Specific Transforms

Not all providers implement the same features or format tool calls identically. The provider module applies **transforms** — middleware that adapts the AI SDK's universal format to each provider's quirks:

### Why Transforms Are Needed

| Problem                         | Provider(s) Affected   | Transform                                   |
| ------------------------------- | ---------------------- | ------------------------------------------- |
| Different tool call JSON format | Anthropic, Bedrock     | Normalize tool call serialization           |
| No native tool support          | Some OpenAI-compatible | Convert tools to system prompt instructions |
| Extended thinking tokens        | Anthropic              | Handle reasoning/thinking blocks            |
| Prompt caching                  | Anthropic, Google      | Add cache control headers to system prompts |
| Context window limits vary      | All                    | Track token usage, trigger compaction       |
| Streaming format differences    | Various                | Normalize chunk format                      |
| Error response formats          | Various                | Unified error handling                      |

### The wrapLanguageModel Pattern

OpenCode uses the AI SDK's `wrapLanguageModel()` to compose middleware:

```typescript
import { wrapLanguageModel } from "ai"

const wrapped = wrapLanguageModel({
  model: baseModel,
  middleware: {
    transformParams: async ({ params }) => {
      // Modify request before sending to provider
      return modifiedParams
    },
    wrapStream: async ({ stream }) => {
      // Transform the response stream
      return transformedStream
    },
  },
})
```

This allows OpenCode to add logging, token counting, prompt caching, and provider-specific fixes without modifying the core streaming logic.

---

## Model Catalog

OpenCode maintains a snapshot of available models from **[models.dev](https://models.dev)** — a community API catalog. During the build process, the build script fetches this catalog and embeds it as a compile-time constant:

```typescript
// In build.ts
const models = await fetch("https://models.dev/api.json").then(r => r.json())
// Embedded via Bun's define option:
define: {
  MODELS_SNAPSHOT: JSON.stringify(models),
}
```

This means the CLI binary knows about all available models without making a network request at startup. The catalog is refreshed with each release.

The model catalog powers:

- **Auto-completion** in the TUI when selecting models
- **Token limit detection** for compaction thresholds
- **Capability flags** (vision, function calling, extended thinking)

---

## Streaming Architecture

When `streamText()` is called, it returns an async iterable of **stream parts**. Here's how the streaming flows through OpenCode:

```
LLM Provider (Anthropic, OpenAI, etc.)
     │
     │  HTTP SSE stream
     ▼
┌──────────────────┐
│ @ai-sdk/provider │  Parses provider-specific SSE format
│ adapter          │  → Normalizes to AI SDK stream parts
└────────┬─────────┘
         │
         ▼  AsyncIterable<StreamPart>
┌──────────────────┐
│ wrapLanguageModel│  Applies middleware transforms
│ (transforms)     │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ streamText()     │  Manages the streaming lifecycle
│ (AI SDK)         │  Handles tool calls, retries
└────────┬─────────┘
         │
         ▼  Stream parts: text-delta, tool-call, tool-result, finish, ...
┌──────────────────┐
│ session/llm.ts   │  Processes each part:
│                  │  - Stores as Message Part in SQLite
│                  │  - Publishes to Event Bus
│                  │  - Executes tool calls
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Event Bus        │  BusEvent.publish(PartCreated, {...})
└────────┬─────────┘
         │
         ▼  SSE to clients
┌──────────────────┐
│ TUI / Web / SDK  │  Renders incrementally
└──────────────────┘
```

### Stream Part Types

The AI SDK produces several types of stream parts:

| Part Type     | Content                                       |
| ------------- | --------------------------------------------- |
| `text-delta`  | A chunk of text from the assistant            |
| `tool-call`   | A complete tool invocation with arguments     |
| `tool-result` | The result of executing a tool                |
| `reasoning`   | Chain-of-thought tokens (extended thinking)   |
| `step-finish` | Marks the end of one inference step           |
| `finish`      | Stream is complete, includes usage statistics |
| `error`       | An error occurred during generation           |

### Partial JSON Parsing

Since tool call arguments arrive as streaming text, OpenCode uses the `partial-json` package to parse incomplete JSON. This allows the TUI to show tool call arguments as they stream in, rather than waiting for the complete JSON object.

---

## Adding a New Provider

To add a new LLM provider to OpenCode:

1. **Install the AI SDK adapter** (or use `@ai-sdk/openai-compatible` for OpenAI-compatible APIs):

   ```bash
   bun add @ai-sdk/new-provider
   ```

2. **Register it in the provider module** (`provider/provider.ts`):

   ```typescript
   import { createNewProvider } from "@ai-sdk/new-provider"

   // Add to the provider registry
   providers.newprovider = (config) =>
     createNewProvider({
       apiKey: config.apiKey,
       baseURL: config.baseURL,
     })
   ```

3. **Add provider-specific transforms** if needed (most providers work without any)

4. **Test it** by setting the API key and specifying the model:
   ```bash
   export NEWPROVIDER_API_KEY="..."
   opencode --model newprovider/model-name
   ```

For providers that are OpenAI-compatible (most are these days), you can skip steps 1-2 and just configure it in `opencode.json`:

```json
{
  "provider": {
    "myserver": {
      "type": "openai-compatible",
      "baseURL": "https://my-server.com/v1",
      "apiKey": "..."
    }
  }
}
```

---

## GitHub Copilot Integration

GitHub Copilot deserves special mention because it's not a standard API — it uses OAuth tokens from the GitHub CLI or VS Code extension. OpenCode's `plugin/copilot.ts` handles:

1. **Token discovery** — Finds the Copilot OAuth token from VS Code settings or `gh` CLI
2. **Token refresh** — Copilot tokens expire frequently and need regular refresh
3. **Endpoint routing** — Copilot requests go through `api.githubcopilot.com` with specific headers
4. **Model mapping** — Maps Copilot model names to the underlying models

This is wrapped as an `@ai-sdk/openai-compatible` provider with custom auth middleware, making it transparent to the rest of the system.

---

## Key Takeaways

1. **One interface, many providers** — The `LanguageModelV2` protocol from the Vercel AI SDK means the core code never knows which provider is active.

2. **Provider-specific transforms** handle the messy reality of different API behaviors without polluting the core streaming logic.

3. **The model catalog** is embedded at build time from models.dev, enabling offline model discovery and auto-completion.

4. **Streaming is end-to-end** — from HTTP SSE at the provider to the event bus to the UI, every layer is streaming-aware.

5. **Adding providers is trivial** — install the adapter package, register it, and it works. OpenAI-compatible providers need zero code changes.

---

**Next:** [Chapter 5: Agent & Session Architecture →](./05-agents-and-sessions.md)

**Previous:** [Chapter 3: The Core Package →](./03-core-package.md)
