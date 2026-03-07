import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { SessionPrompt } from "../../src/session/prompt"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { Identifier } from "../../src/id/id"
import { tmpdir } from "../fixture/fixture"

/**
 * Tests that verify error propagation in the TaskTool / subagent system.
 *
 * Core bug: when a child session's LLM fails with a non-abort error, the error
 * is stored on `assistantMessage.error` (processor.ts:393) but the old TaskTool
 * only checked for `MessageAbortedError`. All other errors produced an empty
 * `<task_result>`. The fix in `childText()` (task.ts:36-52) now extracts error
 * information from the child's assistant message.
 *
 * Tests use the "direct subtask" path: a SubtaskPart on a user message triggers
 * TaskTool.execute() directly via prompt.ts:352-525, bypassing the AI SDK tool
 * call parsing. This is the path used for @agent invocations and command subtasks.
 */

// ---------------------------------------------------------------------------
// Mock HTTP server infrastructure
// ---------------------------------------------------------------------------

const state = {
  server: null as ReturnType<typeof Bun.serve> | null,
  queue: [] as Array<{
    match: (pathname: string) => boolean
    response: Response | (() => Response)
    resolve: (value: void) => void
  }>,
  fallback: null as ((pathname: string) => Response) | null,
}

function waitRequest(pathname: string, response: Response | (() => Response)) {
  return new Promise<void>((resolve) => {
    state.queue.push({
      match: (p) => p.endsWith(pathname),
      response,
      resolve,
    })
  })
}

beforeAll(() => {
  state.server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      await req.json().catch(() => ({}))
      const idx = state.queue.findIndex((q) => q.match(url.pathname))
      if (idx === -1) {
        if (state.fallback) return state.fallback(url.pathname)
        return new Response(
          JSON.stringify({
            error: { message: "no queued handler for " + url.pathname, type: "invalid_request_error" },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        )
      }
      const [next] = state.queue.splice(idx, 1)
      next.resolve()
      const resp = typeof next.response === "function" ? next.response() : next.response
      return resp
    },
  })
})

beforeEach(() => {
  state.queue.length = 0
  state.fallback = null
})

afterAll(() => {
  state.server?.stop()
})

// ---------------------------------------------------------------------------
// Stream helpers — OpenAI chat completions format
// ---------------------------------------------------------------------------

function createChatStream(text: string) {
  const payload =
    [
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: { role: "assistant" } }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: { content: text } }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: {}, finish_reason: "stop" }],
      })}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n"
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    },
  })
}

function chatResponse(text: string) {
  return new Response(createChatStream(text), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  })
}

function errorResponse(status: number, msg: string) {
  return new Response(JSON.stringify({ error: { message: msg, type: "server_error" } }), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function toolCallResponse(tool: string, id: string, args: Record<string, unknown>) {
  const payload =
    [
      `data: ${JSON.stringify({
        id: "chatcmpl-tc",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant", content: null } }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-tc",
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            delta: {
              content: null,
              tool_calls: [
                {
                  index: 0,
                  id,
                  type: "function",
                  function: { name: tool, arguments: JSON.stringify(args) },
                },
              ],
            },
          },
        ],
        usage: { completion_tokens: 10, prompt_tokens: 100, total_tokens: 110 },
      })}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n"
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(payload))
        controller.close()
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  )
}

// ---------------------------------------------------------------------------
// Config helper — sets up alibaba/qwen-plus pointing to mock server
// ---------------------------------------------------------------------------

function configJson(origin: string, extra?: Record<string, unknown>) {
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    enabled_providers: ["alibaba"],
    provider: {
      alibaba: {
        options: {
          apiKey: "test-key",
          baseURL: `${origin}/v1`,
        },
      },
    },
    ...extra,
  })
}

// ---------------------------------------------------------------------------
// Helper: create a session with a user message containing a SubtaskPart
// ---------------------------------------------------------------------------

async function setupSubtask(opts: { agent: string; prompt: string; description: string }) {
  const model = await Provider.getModel("alibaba", "qwen-plus")
  const session = await Session.create({})
  const msgID = Identifier.ascending("message")

  const user: MessageV2.User = {
    id: msgID,
    sessionID: session.id,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: { providerID: "alibaba", modelID: model.id },
  }
  await Session.updateMessage(user)

  // Create the subtask part — this triggers the direct execution path in prompt.ts:352
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: msgID,
    sessionID: session.id,
    type: "subtask",
    prompt: opts.prompt,
    description: opts.description,
    agent: opts.agent,
  } satisfies MessageV2.SubtaskPart)

  return { session, model }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Config helper — with experimental task_timeout
// ---------------------------------------------------------------------------

function configWithTimeout(origin: string, timeout: number) {
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    enabled_providers: ["alibaba"],
    provider: {
      alibaba: {
        options: {
          apiKey: "test-key",
          baseURL: `${origin}/v1`,
        },
      },
    },
    experimental: {
      task_timeout: timeout,
    },
  })
}

// ---------------------------------------------------------------------------
// Hanging stream — SSE that sends initial data but never closes
// ---------------------------------------------------------------------------

function hangingStream() {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        // Send an initial role chunk so the stream appears alive
        const chunk = `data: ${JSON.stringify({
          id: "chatcmpl-hang",
          object: "chat.completion.chunk",
          choices: [{ delta: { role: "assistant" } }],
        })}\n\n`
        controller.enqueue(new TextEncoder().encode(chunk))
        // Never close — simulates a hanging LLM response
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    },
  )
}

describe("task-error: error propagation in subagent sessions", () => {
  test("processor stores error on assistant message when LLM returns 400", async () => {
    const origin = state.server!.url.origin

    // Queue a 400 error response
    const req = waitRequest("/chat/completions", errorResponse(400, "Bad request: invalid model"))

    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "opencode.json"), configJson(origin))
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = await Provider.getModel("alibaba", "qwen-plus")
        const session = await Session.create({})
        const msgID = Identifier.ascending("message")

        const user: MessageV2.User = {
          id: msgID,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: "alibaba", modelID: model.id },
        }
        await Session.updateMessage(user)
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: msgID,
          sessionID: session.id,
          type: "text",
          text: "Hello",
        })

        const result = await SessionPrompt.loop({ sessionID: session.id })
        await req

        expect(result.info.role).toBe("assistant")
        const assistant = result.info as MessageV2.Assistant
        expect(assistant.error).toBeDefined()
        expect(assistant.error!.name).not.toBe("MessageAbortedError")

        const texts = result.parts.filter((p) => p.type === "text")
        expect(texts.length).toBe(0)
      },
    })
  }, 30_000)

  test("TaskTool propagates child error into task_result via subtask path", async () => {
    const origin = state.server!.url.origin

    // Queue: title (fire-and-forget from ensureTitle), child 400, parent resume
    waitRequest("/chat/completions", () => chatResponse("Test Title"))
    waitRequest("/chat/completions", () => errorResponse(400, "Bad request: invalid model"))
    waitRequest("/chat/completions", () => chatResponse("Task completed."))

    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "opencode.json"), configJson(origin))
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { session } = await setupSubtask({
          agent: "general",
          prompt: "Do something",
          description: "test child error",
        })

        const result = await SessionPrompt.loop({ sessionID: session.id })

        // Parent should complete successfully
        expect(result.info.role).toBe("assistant")

        // Find the task tool part in the parent session
        const msgs = await Session.messages({ sessionID: session.id })
        const taskParts = msgs.flatMap((m) => m.parts.filter((p) => p.type === "tool" && p.tool === "task"))
        expect(taskParts.length).toBeGreaterThan(0)

        const tp = taskParts[0] as MessageV2.ToolPart
        expect(tp.state.status).toBe("completed")

        if (tp.state.status === "completed") {
          const output = tp.state.output as string
          expect(output).toContain("<task_result>")
          expect(output).toContain("</task_result>")

          // With the fix, the error should be propagated into the task_result
          expect(output).toContain("ERROR:")
          expect(output).toContain("APIError")
        }

        // Also verify the child session exists and has the error on its assistant message
        const children = await Session.children(session.id)
        expect(children.length).toBeGreaterThan(0)

        const childMsgs = await Session.messages({ sessionID: children[0].id })
        const childAssistant = childMsgs.find((m) => m.info.role === "assistant")
        expect(childAssistant).toBeDefined()

        const info = childAssistant!.info as MessageV2.Assistant
        expect(info.error).toBeDefined()
        expect(info.error!.name).toBe("APIError")
      },
    })
  }, 30_000)

  test("successful child produces text in task_result", async () => {
    const origin = state.server!.url.origin

    // Queue: title, child success, parent resume
    waitRequest("/chat/completions", () => chatResponse("Test Title"))
    waitRequest("/chat/completions", () => chatResponse("Child completed successfully."))
    waitRequest("/chat/completions", () => chatResponse("All done."))

    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "opencode.json"), configJson(origin))
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { session } = await setupSubtask({
          agent: "general",
          prompt: "Do something",
          description: "test child success",
        })

        const result = await SessionPrompt.loop({ sessionID: session.id })

        expect(result.info.role).toBe("assistant")

        const msgs = await Session.messages({ sessionID: session.id })
        const taskParts = msgs.flatMap((m) => m.parts.filter((p) => p.type === "tool" && p.tool === "task"))
        expect(taskParts.length).toBeGreaterThan(0)

        const tp = taskParts[0] as MessageV2.ToolPart
        expect(tp.state.status).toBe("completed")

        if (tp.state.status === "completed") {
          const output = tp.state.output as string
          expect(output).toContain("<task_result>")
          expect(output).toContain("Child completed successfully.")
        }
      },
    })
  }, 30_000)

  test("childText extracts error details for non-abort errors", async () => {
    // Tests the error format in task_result for different error types
    const origin = state.server!.url.origin

    // Queue: title, child 400, parent resume
    waitRequest("/chat/completions", () => chatResponse("Test Title"))
    waitRequest("/chat/completions", () => errorResponse(400, "model_not_found: no such model"))
    waitRequest("/chat/completions", () => chatResponse("Done."))

    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "opencode.json"), configJson(origin))
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { session } = await setupSubtask({
          agent: "general",
          prompt: "Do work",
          description: "test error format",
        })

        const result = await SessionPrompt.loop({ sessionID: session.id })

        const msgs = await Session.messages({ sessionID: session.id })
        const taskParts = msgs.flatMap((m) => m.parts.filter((p) => p.type === "tool" && p.tool === "task"))
        expect(taskParts.length).toBeGreaterThan(0)

        const tp = taskParts[0] as MessageV2.ToolPart
        expect(tp.state.status).toBe("completed")

        if (tp.state.status === "completed") {
          const output = tp.state.output as string
          // Error output should contain structured information
          expect(output).toContain("ERROR:")
          expect(output).toContain("retry")
          expect(output).toContain("task_id:")
        }
      },
    })
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Tests that verify timeout and retry exhaustion scenarios
// These reproduce the real hang mechanism: retryable errors + infinite retry
// loops, and hanging LLM streams that never complete.
// ---------------------------------------------------------------------------

describe("task-error: timeout and hang scenarios", () => {
  test("abortAfterAny fires cancel after timeout", async () => {
    // Minimal test: verify that the timeout mechanism fires and cancels the child
    const { abortAfterAny } = await import("../../src/util/abort")
    const cancelled = { value: false }
    const deadline = abortAfterAny(500)
    deadline.signal.addEventListener("abort", () => {
      cancelled.value = true
    })
    await new Promise((r) => setTimeout(r, 700))
    expect(cancelled.value).toBe(true)
    deadline.clearTimeout()
  }, 5000)

  test("config loads task_timeout from opencode.json", async () => {
    const origin = state.server!.url.origin

    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "opencode.json"), configWithTimeout(origin, 3000))
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { Config } = await import("../../src/config/config")
        const config = await Config.get()
        expect(config.experimental?.task_timeout).toBe(3000)
      },
    })
  }, 10_000)

  test("retryable 500 errors are terminated by task_timeout", async () => {
    // Reproduces the real hang: child LLM returns 500 (retryable), processor
    // enters retry loop with exponential backoff, but task_timeout fires after
    // 3s and cancels the child. Parent should get a result, not hang forever.
    const origin = state.server!.url.origin

    // Title for parent session (fire-and-forget from ensureTitle — MUST be first)
    waitRequest("/chat/completions", () => chatResponse("Test Title"))

    // All subsequent /chat/completions requests go through the fallback.
    // Phase tracks whether the child is still retrying (500) or the parent is
    // resuming after timeout (200 success).
    let phase: "child" | "parent" = "child"
    state.fallback = (pathname) => {
      if (!pathname.endsWith("/chat/completions"))
        return new Response(
          JSON.stringify({ error: { message: "fallback: " + pathname, type: "invalid_request_error" } }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        )
      if (phase === "child") return errorResponse(500, "Internal server error")
      return chatResponse("Handled timeout.")
    }

    // Flip phase well after the 3s task_timeout fires. The child's abort signal
    // interrupts its retry sleep immediately, so by 4s the child has exited and
    // the parent's next LLM call will find phase === "parent".
    const timer = setTimeout(() => {
      phase = "parent"
    }, 4000)

    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "opencode.json"), configWithTimeout(origin, 3000))
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { session } = await setupSubtask({
          agent: "general",
          prompt: "Do something that triggers 500s",
          description: "test 500 retry timeout",
        })

        const start = Date.now()
        const loopPromise = SessionPrompt.loop({ sessionID: session.id })

        // Safety: if loop doesn't resolve within 12s, fail with details
        const result = await Promise.race([
          loopPromise,
          new Promise<never>((_, reject) => {
            setTimeout(() => {
              const elapsed = Date.now() - start
              reject(
                new Error(`Loop did not complete after ${elapsed}ms. Queue has ${state.queue.length} items remaining.`),
              )
            }, 12_000)
          }),
        ])
        const elapsed = Date.now() - start

        clearTimeout(timer)

        // Parent should complete — NOT hang
        expect(result.info.role).toBe("assistant")
        // Should complete within task_timeout + overhead
        expect(elapsed).toBeLessThan(12_000)

        const msgs = await Session.messages({ sessionID: session.id })
        const taskParts = msgs.flatMap((m) => m.parts.filter((p) => p.type === "tool" && p.tool === "task"))
        expect(taskParts.length).toBeGreaterThan(0)

        const tp = taskParts[0] as MessageV2.ToolPart
        expect(tp.state.status).toBe("completed")

        if (tp.state.status === "completed") {
          const output = tp.state.output as string
          // Should contain task_id (not be empty)
          expect(output).toContain("task_id:")
        }

        // Child session should exist
        const children = await Session.children(session.id)
        expect(children.length).toBeGreaterThan(0)
      },
    })
  }, 20_000)

  test("hanging LLM stream is terminated by task_timeout", async () => {
    // Reproduces: child LLM opens an SSE stream but never sends [DONE].
    // Without timeout, the parent would hang forever waiting for the child.
    // With task_timeout, the child is cancelled and parent gets a result.
    const origin = state.server!.url.origin

    // Title for parent session
    waitRequest("/chat/completions", () => chatResponse("Test Title"))
    // Child gets a hanging stream — never completes
    waitRequest("/chat/completions", () => hangingStream())
    // Parent resume after child timeout
    waitRequest("/chat/completions", () => chatResponse("Handled hang."))

    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "opencode.json"), configWithTimeout(origin, 3000))
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { session } = await setupSubtask({
          agent: "general",
          prompt: "Do something that hangs",
          description: "test hanging stream",
        })

        const result = await SessionPrompt.loop({ sessionID: session.id })

        // Parent should complete — NOT hang
        expect(result.info.role).toBe("assistant")

        const msgs = await Session.messages({ sessionID: session.id })
        const taskParts = msgs.flatMap((m) => m.parts.filter((p) => p.type === "tool" && p.tool === "task"))
        expect(taskParts.length).toBeGreaterThan(0)

        const tp = taskParts[0] as MessageV2.ToolPart
        expect(tp.state.status).toBe("completed")

        if (tp.state.status === "completed") {
          const output = tp.state.output as string
          expect(output).toContain("task_id:")
          // Child was cancelled by timeout
          expect(output).toContain("Task was cancelled")
        }
      },
    })
  }, 15_000)

  test("task tool part transitions to error on parent abort", async () => {
    // Verifies that when the parent session is cancelled (simulating Ctrl+C),
    // the child's task tool part doesn't stay stuck in "running" status.
    const origin = state.server!.url.origin

    // Title for parent
    waitRequest("/chat/completions", () => chatResponse("Test Title"))
    // Child gets a hanging stream
    waitRequest("/chat/completions", () => hangingStream())

    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "opencode.json"), configWithTimeout(origin, 30000))
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { session } = await setupSubtask({
          agent: "general",
          prompt: "Hang forever",
          description: "test abort cleanup",
        })

        // Start the loop, then cancel after 1s
        const done = SessionPrompt.loop({ sessionID: session.id })

        await new Promise((r) => setTimeout(r, 1500))
        SessionPrompt.cancel(session.id)

        const result = await done

        // The parent loop should have exited
        expect(result.info.role).toBe("assistant")

        // Check that the task tool part is NOT stuck in "running"
        const msgs = await Session.messages({ sessionID: session.id })
        const taskParts = msgs.flatMap((m) => m.parts.filter((p) => p.type === "tool" && p.tool === "task"))

        if (taskParts.length > 0) {
          const tp = taskParts[0] as MessageV2.ToolPart
          // Part should transition away from "running" to either "completed" or "error"
          expect(tp.state.status).not.toBe("running")
        }
      },
    })
  }, 15_000)
})

// ---------------------------------------------------------------------------
// Sub-sub-agent cascade test: grandchild hangs → child times out → parent
// gets a structured error. This is the actual production failure mode.
// ---------------------------------------------------------------------------

function configWithAgent(origin: string, timeout: number) {
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    enabled_providers: ["alibaba"],
    provider: {
      alibaba: {
        options: {
          apiKey: "test-key",
          baseURL: `${origin}/v1`,
        },
      },
    },
    experimental: {
      task_timeout: timeout,
    },
    agent: {
      nester: {
        mode: "subagent",
        description: "Agent that can spawn grandchildren",
        permission: { task: "allow" },
      },
    },
  })
}

describe("task-error: sub-sub-agent cascade", () => {
  test("grandchild hang is rescued by task_timeout and parent completes", async () => {
    // The full cascade:
    //   Parent → SubtaskPart → child A (agent "nester" with task permission)
    //   Child A's LLM → tool call for "task" → grandchild B (agent "general")
    //   Grandchild B's LLM → hanging stream (never completes)
    //   task_timeout fires → grandchild B cancelled → child A gets tool result
    //   Child A's LLM (2nd call) → text response → child A finishes
    //   Parent's LLM → text response → parent finishes
    const origin = state.server!.url.origin

    // Response queue (consumed in order):
    // 1. Parent's ensureTitle (fire-and-forget, parent has no parentID)
    waitRequest("/chat/completions", () => chatResponse("Test Title"))

    // 2. Child A's 1st LLM call → returns a task tool call to spawn grandchild
    //    Uses timeout=3 (seconds) so the grandchild times out at 3s, while the
    //    parent→child config timeout is 30s (from opencode.json).
    waitRequest("/chat/completions", () =>
      toolCallResponse("task", "call_grand", {
        description: "grandchild task",
        prompt: "Do the nested work",
        subagent_type: "general",
        timeout: 3,
      }),
    )

    // 3. Grandchild B's LLM call → hanging stream (never sends [DONE])
    waitRequest("/chat/completions", () => hangingStream())

    // After grandchild times out, child A's loop continues with a 2nd LLM call
    // (tool result), and the parent also makes an LLM call. Use fallback to
    // serve these — we don't know the exact ordering.
    state.fallback = (pathname) => {
      if (pathname.endsWith("/chat/completions")) return chatResponse("Cascade completed.")
      return new Response(
        JSON.stringify({ error: { message: "fallback: " + pathname, type: "invalid_request_error" } }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )
    }

    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        // 30s timeout for parent→child; grandchild uses timeout=3 from tool args
        await Bun.write(path.join(dir, "opencode.json"), configWithAgent(origin, 30000))
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { session } = await setupSubtask({
          agent: "nester",
          prompt: "Spawn a child that spawns a grandchild",
          description: "test cascade",
        })

        const start = Date.now()
        const loopPromise = SessionPrompt.loop({ sessionID: session.id })

        // Safety: if the whole cascade doesn't resolve within 15s, fail
        const result = await Promise.race([
          loopPromise,
          new Promise<never>((_, reject) => {
            setTimeout(() => {
              const elapsed = Date.now() - start
              reject(new Error(`Cascade did not complete after ${elapsed}ms.`))
            }, 15_000)
          }),
        ])
        const elapsed = Date.now() - start

        // Parent should complete — NOT hang
        expect(result.info.role).toBe("assistant")
        expect(elapsed).toBeLessThan(15_000)

        // Parent should have a completed task tool part (child A)
        const msgs = await Session.messages({ sessionID: session.id })
        const taskParts = msgs.flatMap((m) => m.parts.filter((p) => p.type === "tool" && p.tool === "task"))
        expect(taskParts.length).toBeGreaterThan(0)

        const tp = taskParts[0] as MessageV2.ToolPart
        expect(tp.state.status).toBe("completed")

        // Child A should exist
        const children = await Session.children(session.id)
        expect(children.length).toBeGreaterThan(0)

        const childA = children[0]

        // Child A should have a task tool part (for grandchild B)
        const childMsgs = await Session.messages({ sessionID: childA.id })
        const childTaskParts = childMsgs.flatMap((m) => m.parts.filter((p) => p.type === "tool" && p.tool === "task"))
        expect(childTaskParts.length).toBeGreaterThan(0)

        const childTp = childTaskParts[0] as MessageV2.ToolPart
        // The grandchild task should have completed (with timeout info)
        expect(childTp.state.status).toBe("completed")

        if (childTp.state.status === "completed") {
          const output = childTp.state.output as string
          // Should contain timeout or cancellation info
          expect(output).toContain("task_id:")
        }

        // Grandchild B should exist
        const grandchildren = await Session.children(childA.id)
        expect(grandchildren.length).toBeGreaterThan(0)
      },
    })
  }, 25_000)

  test("parent abort breaks child stuck waiting for grandchild tool result", async () => {
    // This tests the core hang scenario from production:
    //   Parent → child (nester agent) → child's LLM returns task tool call → grandchild
    //   Grandchild hangs on LLM stream → child's processor.for-await is stuck
    //   waiting for the AI SDK's toolResultsStream → parent is cancelled
    //
    // Without the Promise.race(iter.next(), aborted) fix in processor.ts,
    // the child's for-await loop blocks indefinitely because:
    //   1. The AI SDK's merged stream won't yield new chunks until the tool finishes
    //   2. input.abort.throwIfAborted() only fires when a chunk arrives
    //   3. The abort signal fires but the loop never checks it
    //
    // With the fix, Promise.race rejects immediately on abort, the catch block
    // classifies it as AbortError, and the cleanup sweep marks stuck tools.
    const origin = state.server!.url.origin

    // 1. Parent title (fire-and-forget)
    waitRequest("/chat/completions", () => chatResponse("Abort Test"))

    // 2. Child A LLM → task tool call to spawn grandchild (no timeout arg → uses config)
    waitRequest("/chat/completions", () =>
      toolCallResponse("task", "call_abort", {
        description: "doomed grandchild",
        prompt: "Will be aborted",
        subagent_type: "general",
      }),
    )

    // 3. Grandchild B LLM → hanging stream (never completes)
    waitRequest("/chat/completions", () => hangingStream())

    // Fallback: after abort, any further LLM requests get a simple response
    state.fallback = (pathname) => {
      if (pathname.endsWith("/chat/completions")) return chatResponse("Aborted.")
      return new Response(
        JSON.stringify({ error: { message: "fallback: " + pathname, type: "invalid_request_error" } }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )
    }

    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        // Long timeout so the task_timeout does NOT fire — we want the
        // PARENT ABORT to be what rescues the chain, not the timeout.
        await Bun.write(path.join(dir, "opencode.json"), configWithAgent(origin, 60000))
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { session } = await setupSubtask({
          agent: "nester",
          prompt: "Spawn grandchild that will hang",
          description: "test abort during tool",
        })

        const start = Date.now()
        const done = SessionPrompt.loop({ sessionID: session.id })

        // Wait for the grandchild to start (the hanging stream must be served)
        await new Promise((r) => setTimeout(r, 2000))

        // Cancel the parent — this fires ctx.abort in the task tool for child A,
        // which calls SessionPrompt.cancel(childA.id), which aborts child A's
        // AbortController, which (with the fix) causes child A's processor's
        // Promise.race to reject immediately instead of waiting for the tool.
        SessionPrompt.cancel(session.id)

        // The parent should resolve promptly (< 3s after cancel).
        // Without the fix, this would hang for 60s (the task_timeout).
        const result = await Promise.race([
          done,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Hung for ${Date.now() - start}ms after abort`)), 5000),
          ),
        ])
        const elapsed = Date.now() - start

        expect(result.info.role).toBe("assistant")
        // Should resolve within ~4s total (2s wait + cancel + propagation)
        expect(elapsed).toBeLessThan(8000)

        // The parent's task tool part should NOT be stuck in "running"
        const msgs = await Session.messages({ sessionID: session.id })
        const parts = msgs.flatMap((m) => m.parts.filter((p) => p.type === "tool" && p.tool === "task"))
        for (const p of parts) {
          const tp = p as MessageV2.ToolPart
          expect(tp.state.status).not.toBe("running")
        }

        // Child A should exist
        const children = await Session.children(session.id)
        expect(children.length).toBeGreaterThan(0)

        // Child A's task tool part (for grandchild) should also not be "running"
        const childMsgs = await Session.messages({ sessionID: children[0].id })
        const childParts = childMsgs.flatMap((m) => m.parts.filter((p) => p.type === "tool" && p.tool === "task"))
        for (const p of childParts) {
          const tp = p as MessageV2.ToolPart
          expect(tp.state.status).not.toBe("running")
        }
      },
    })
  }, 15_000)
})
