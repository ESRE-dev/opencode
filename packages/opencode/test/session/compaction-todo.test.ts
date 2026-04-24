import { describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { SessionCompaction } from "../../src/session/compaction"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config"
import { Agent } from "../../src/agent/agent"
import { Plugin } from "../../src/plugin"
import { Instance } from "../../src/project/instance"
import { Session as SessionNs } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import type { Provider } from "../../src/provider"
import { Todo } from "../../src/session/todo"
import { ProviderTest } from "../fake/provider"
import { tmpdir } from "../fixture/fixture"
import * as SessionProcessorModule from "../../src/session/processor"

describe("SessionCompaction.formatTodos", () => {
  test("returns undefined for empty array", () => {
    expect(SessionCompaction.formatTodos([])).toBeUndefined()
  })

  test("returns section with header for non-empty list", () => {
    const result = SessionCompaction.formatTodos([{ content: "Fix bug", status: "pending", priority: "high" }])
    expect(result).toContain("## Current Task List")
  })

  test("includes one entry per item", () => {
    const todos = [
      { content: "Fix bug", status: "pending", priority: "high" },
      { content: "Write tests", status: "in_progress", priority: "medium" },
      { content: "Deploy", status: "completed", priority: "low" },
    ]
    const result = SessionCompaction.formatTodos(todos)!
    expect(result).toContain("- [pending] (high) Fix bug")
    expect(result).toContain("- [in_progress] (medium) Write tests")
    expect(result).toContain("- [completed] (low) Deploy")
  })

  test("formats status, priority, and content in markdown", () => {
    const result = SessionCompaction.formatTodos([{ content: "Task A", status: "open", priority: "low" }])!
    expect(result).toContain("- [open] (low) Task A")
  })

  test("entry count matches input length", () => {
    const todos = Array.from({ length: 5 }, (_, i) => ({
      content: `Task ${i}`,
      status: "pending",
      priority: "medium",
    }))
    const result = SessionCompaction.formatTodos(todos)!
    const entries = result.split("\n").filter((line) => line.startsWith("- ["))
    expect(entries).toHaveLength(5)
  })

  test("section starts with double newline for prompt concatenation", () => {
    const result = SessionCompaction.formatTodos([{ content: "Task", status: "pending", priority: "high" }])!
    expect(result.startsWith("\n\n")).toBe(true)
  })

  test("includes persistence note for agent context", () => {
    const result = SessionCompaction.formatTodos([{ content: "Task", status: "pending", priority: "high" }])!
    expect(result).toContain("persisted in the database")
    expect(result).toContain("survive compaction")
  })

  test("no section header in empty result", () => {
    const result = SessionCompaction.formatTodos([])
    expect(result).toBeUndefined()
    expect(result ?? "").not.toContain("## Current Task List")
  })

  test("handles special characters in content", () => {
    const result = SessionCompaction.formatTodos([
      { content: "Fix `code` in **bold** & <html>", status: "pending", priority: "high" },
    ])!
    expect(result).toContain("Fix `code` in **bold** & <html>")
  })

  // Property 6: Todo Injection Completeness
  test("each todo item's content, status, and priority appear in output", () => {
    const todos = [
      { content: "Implement feature X", status: "in_progress", priority: "high" },
      { content: "Review PR #42", status: "pending", priority: "medium" },
      { content: "Update docs", status: "completed", priority: "low" },
    ]
    const result = SessionCompaction.formatTodos(todos)!
    for (const t of todos) {
      expect(result).toContain(t.content)
      expect(result).toContain(t.status)
      expect(result).toContain(t.priority)
    }
  })

  // Property 7: Empty Todo Omission
  test("empty todo list returns undefined", () => {
    expect(SessionCompaction.formatTodos([])).toBeUndefined()
  })
})

describe("SessionCompaction.buildPostCompactionContext", () => {
  const sampleReminder = `<system-reminder>\nYou are the "reviewer" agent.\nRole: Code reviewer\n</system-reminder>`
  const sampleTodos = [
    { content: "Fix bug", status: "pending", priority: "high" },
    { content: "Write tests", status: "in_progress", priority: "medium" },
  ]

  test("combines reminder and todos with separator", () => {
    const result = SessionCompaction.buildPostCompactionContext(sampleReminder, sampleTodos)!
    expect(result).toContain(sampleReminder)
    expect(result).toContain("## Current Task List")
    expect(result).toContain("Fix bug")
    expect(result).toContain("Write tests")
    // Verify separator between reminder and todos
    expect(result.indexOf(sampleReminder)).toBeLessThan(result.indexOf("## Current Task List"))
  })

  test("returns reminder only when todos are empty", () => {
    const result = SessionCompaction.buildPostCompactionContext(sampleReminder, [])
    expect(result).toBe(sampleReminder)
  })

  test("returns todo section only when reminder is undefined", () => {
    const result = SessionCompaction.buildPostCompactionContext(undefined, sampleTodos)!
    expect(result).toContain("## Current Task List")
    expect(result).toContain("Fix bug")
    expect(result).not.toContain("system-reminder")
  })

  test("returns undefined when both are absent", () => {
    expect(SessionCompaction.buildPostCompactionContext(undefined, [])).toBeUndefined()
  })

  // Property 8: Context Composition Idempotence
  test("same inputs produce same output", () => {
    const a = SessionCompaction.buildPostCompactionContext(sampleReminder, sampleTodos)
    const b = SessionCompaction.buildPostCompactionContext(sampleReminder, sampleTodos)
    expect(a).toBe(b)
  })

  // Property 9: Self-Containment — output depends only on inputs
  test("output depends only on inputs, no external state", () => {
    const result1 = SessionCompaction.buildPostCompactionContext(sampleReminder, sampleTodos)
    const result2 = SessionCompaction.buildPostCompactionContext(sampleReminder, sampleTodos)
    expect(result1).toEqual(result2)
  })

  // Property 10: Cache Anchor Preservation — returns plain string/undefined
  test("returns plain string or undefined", () => {
    const withBoth = SessionCompaction.buildPostCompactionContext(sampleReminder, sampleTodos)
    expect(typeof withBoth).toBe("string")

    const withNeither = SessionCompaction.buildPostCompactionContext(undefined, [])
    expect(withNeither).toBeUndefined()
  })

  // Property 11: Schema Backward Compatibility — uses only existing part types
  test("output is a plain string suitable for TextPart injection", () => {
    const result = SessionCompaction.buildPostCompactionContext(sampleReminder, sampleTodos)!
    expect(typeof result).toBe("string")
    // No structured objects, no new part types — just a string
    expect(result.length).toBeGreaterThan(0)
  })
})

describe("SessionCompaction.process todo injection", () => {
  const ref = {
    providerID: ProviderID.make("test"),
    modelID: ModelID.make("test-model"),
  }

  function createModel(): Provider.Model {
    return {
      id: "test-model",
      providerID: "test",
      name: "Test",
      limit: { context: 100_000, output: 32_000 },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      capabilities: {
        toolcall: true,
        attachment: false,
        reasoning: false,
        temperature: true,
        input: { text: true, image: false, audio: false, video: false },
        output: { text: true, image: false, audio: false, video: false },
      },
      api: { npm: "@ai-sdk/anthropic" },
      options: {},
    } as Provider.Model
  }

  function wide() {
    return ProviderTest.fake({ model: createModel() })
  }

  function run<A, E>(fx: Effect.Effect<A, E, SessionNs.Service | Todo.Service>) {
    return Effect.runPromise(fx.pipe(Effect.provide(SessionNs.defaultLayer), Effect.provide(Todo.defaultLayer)))
  }

  function layer(result: "continue" | "compact") {
    return Layer.succeed(
      SessionProcessorModule.SessionProcessor.Service,
      SessionProcessorModule.SessionProcessor.Service.of({
        create: () =>
          Effect.succeed({
            message: {
              id: MessageID.ascending(),
              role: "assistant" as const,
              parentID: MessageID.ascending(),
              sessionID: SessionID.make("test"),
              mode: "compaction" as const,
              agent: "compaction",
              summary: true,
              path: { cwd: "/tmp", root: "/tmp" },
              cost: 0,
              tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: ModelID.make("test"),
              providerID: ProviderID.make("test"),
              time: { created: Date.now() },
            },
            updateToolCall: Effect.fn("TestSessionProcessor.updateToolCall")(() => Effect.succeed(undefined)),
            completeToolCall: Effect.fn("TestSessionProcessor.completeToolCall")(() => Effect.void),
            process: () => Effect.succeed(result),
          }),
      }),
    )
  }

  function runtime(result: "continue" | "compact", provider = wide()) {
    const bus = Bus.layer
    return ManagedRuntime.make(
      Layer.mergeAll(SessionCompaction.layer, bus).pipe(
        Layer.provide(provider.layer),
        Layer.provide(SessionNs.defaultLayer),
        Layer.provide(layer(result)),
        Layer.provide(Agent.defaultLayer),
        Layer.provide(Plugin.defaultLayer),
        Layer.provide(bus),
        Layer.provide(Config.defaultLayer),
        Layer.provide(Todo.defaultLayer),
      ),
    )
  }

  async function user(sessionID: SessionID, text: string) {
    const msg = await run(
      SessionNs.Service.use((svc) =>
        svc.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        }),
      ),
    )
    await run(
      SessionNs.Service.use((svc) =>
        svc.updatePart({
          id: PartID.ascending(),
          messageID: msg.id,
          sessionID,
          type: "text",
          text,
        }),
      ),
    )
    return msg
  }

  test("auto-continue message contains todo list when session has todos", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await run(SessionNs.Service.use((svc) => svc.create({})))
        await run(
          Todo.Service.use((svc) =>
            svc.update({
              sessionID: session.id,
              todos: [
                { content: "Fix the login bug", status: "pending", priority: "high" },
                { content: "Write unit tests", status: "in_progress", priority: "medium" },
              ],
            }),
          ),
        )
        const msg = await user(session.id, "hello")
        const rt = runtime("continue")
        try {
          const msgs = await run(SessionNs.Service.use((svc) => svc.messages({ sessionID: session.id })))
          const result = await rt.runPromise(
            SessionCompaction.Service.use((svc) =>
              svc.process({
                parentID: msg.id,
                messages: msgs,
                sessionID: session.id,
                auto: true,
              }),
            ),
          )
          expect(result).toBe("continue")

          const all = await run(SessionNs.Service.use((svc) => svc.messages({ sessionID: session.id })))
          const last = all.at(-1)
          expect(last?.info.role).toBe("user")
          expect(last?.parts[0]?.type).toBe("text")
          if (last?.parts[0]?.type === "text") {
            expect(last.parts[0].text).toContain("## Current Task List")
            expect(last.parts[0].text).toContain("Fix the login bug")
            expect(last.parts[0].text).toContain("Write unit tests")
          }
        } finally {
          await rt.dispose()
        }
      },
    })
  })

  test("auto-continue message omits todo section when session has zero todos", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await run(SessionNs.Service.use((svc) => svc.create({})))
        const msg = await user(session.id, "hello")
        const rt = runtime("continue")
        try {
          const msgs = await run(SessionNs.Service.use((svc) => svc.messages({ sessionID: session.id })))
          const result = await rt.runPromise(
            SessionCompaction.Service.use((svc) =>
              svc.process({
                parentID: msg.id,
                messages: msgs,
                sessionID: session.id,
                auto: true,
              }),
            ),
          )
          expect(result).toBe("continue")

          const all = await run(SessionNs.Service.use((svc) => svc.messages({ sessionID: session.id })))
          const last = all.at(-1)
          expect(last?.info.role).toBe("user")
          expect(last?.parts[0]?.type).toBe("text")
          if (last?.parts[0]?.type === "text") {
            expect(last.parts[0].text).not.toContain("## Current Task List")
          }
        } finally {
          await rt.dispose()
        }
      },
    })
  })
})
