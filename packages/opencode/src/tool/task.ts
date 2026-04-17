import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import z from "zod"
import { Session } from "../session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "../config"
import { Cause, Effect, Exit } from "effect"
import { abortAfterAny } from "@/util/abort"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): void
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<MessageV2.WithParts>
}

const DEFAULT_TIMEOUT = 14_400_000 // 4 hours — zombie/stall protection, not performance pressure
const MIN_TIMEOUT = 1_800_000 // 30 minutes — floor for LLM-specified values

const id = "task"

const parameters = z.object({
  description: z.string().describe("A short (3-5 words) description of the task"),
  prompt: z.string().describe("The task for the agent to perform"),
  subagent_type: z.string().describe("The type of specialized agent to use for this task"),
  task_id: z
    .string()
    .describe(
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
    )
    .optional(),
  command: z.string().describe("The command that triggered this task").optional(),
  timeout: z
    .number()
    .optional()
    .describe(
      "Optional timeout in seconds for zombie/stall protection. Default: 4 hours. Minimum: 30 minutes. You almost never need to set this — only override if you have a specific reason.",
    ),
})

function childText(
  result: MessageV2.WithParts,
  sessionId: string,
  sessions: Session.Interface,
  opts?: { skipAbort?: boolean; parentAborted?: boolean; deadlineAborted?: boolean },
): Effect.Effect<string> {
  if (result.info.role !== "assistant") return Effect.succeed("")
  const error = result.info.error
  if (error?.name === "MessageAbortedError" && !opts?.skipAbort) {
    if (opts?.deadlineAborted) return Effect.succeed("")
    if (opts?.parentAborted) return Effect.succeed("Task was cancelled by user.")
    return Effect.succeed(
      [
        `WATCHDOG: Subagent session (${sessionId}) was killed — tool execution exceeded maximum allowed duration.`,
        `task_id: ${sessionId}`,
        "",
        "The subagent stalled (likely waiting on an external resource or internal deadlock).",
        "Recommended: retry this task with a simpler or more focused prompt.",
        "You can resume by passing the task_id above.",
      ].join("\n"),
    )
  }
  const text = result.parts.findLast((x) => x.type === "text")?.text ?? ""
  if (text) return Effect.succeed(text)
  if (!error) return Effect.succeed("")

  return Effect.gen(function* () {
    // The child errored with no text output. Recover substantive work from
    // the session history so the parent doesn't lose everything.
    const lines: string[] = []

    // 1. Collect completed tool outputs from the errored message itself
    for (const p of result.parts) {
      if (p.type !== "tool" || p.state.status !== "completed") continue
      lines.push(`[${p.state.title}]\n${p.state.output}`)
    }

    // 2. Walk backwards through earlier messages for the last substantive text
    if (!lines.length) {
      const msgs = yield* sessions.messages({ sessionID: SessionID.make(sessionId), limit: 10 })
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]
        if (m.info.role !== "assistant" || m.info.id === result.info.id) continue
        const prior = m.parts.findLast((x) => x.type === "text")?.text
        if (prior) {
          lines.push(prior)
          break
        }
      }
    }

    const msg = error.data && "message" in error.data ? (error.data as { message: string }).message : error.name
    const code =
      error.data && "statusCode" in error.data ? ` (status ${(error.data as { statusCode: number }).statusCode})` : ""
    const header = `ERROR: The subagent session (${sessionId}) failed with: ${error.name}${code}\n${msg}`

    if (!lines.length) {
      return [header, "", "You can retry this task by passing the task_id above, or try a different approach."].join(
        "\n",
      )
    }

    return [
      "NOTE: The subagent errored after completing some work. Partial output below:",
      "",
      ...lines,
      "",
      header,
      "",
      "You can retry this task by passing the task_id above, or try a different approach.",
    ].join("\n")
  })
}

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service

    const run = Effect.fn("TaskTool.execute")(function* (params: z.infer<typeof parameters>, ctx: Tool.Context) {
      const cfg = yield* config.get()

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const next = yield* agent.get(params.subagent_type)
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`))
      }

      const canTask = next.permission.some((rule) => rule.permission === id)

      const taskID = params.task_id
      const session = taskID
        ? yield* sessions.get(SessionID.make(taskID)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      const nextSession =
        session ??
        (yield* sessions.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${next.name} subagent)`,
          permission: [
            {
              permission: "todowrite" as const,
              pattern: "*" as const,
              action: "deny" as const,
            },
            {
              permission: "todoread" as const,
              pattern: "*" as const,
              action: "deny" as const,
            },
            ...(canTask
              ? []
              : [
                  {
                    permission: id,
                    pattern: "*" as const,
                    action: "deny" as const,
                  },
                ]),
            {
              permission: "question" as const,
              pattern: "*" as const,
              action: "deny" as const,
            },
            ...(cfg.experimental?.primary_tools?.map((item) => ({
              pattern: "*",
              action: "allow" as const,
              permission: item,
            })) ?? []),
          ],
        }))

      const msg = yield* Effect.sync(() => MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }))
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))

      const model = next.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }

      yield* ctx.metadata({
        title: params.description,
        metadata: {
          sessionId: nextSession.id,
          model,
        },
      })

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))

      const messageID = MessageID.ascending()

      function cancel() {
        ops.cancel(nextSession.id)
      }

      const raw = params.timeout ? params.timeout * 1000 : DEFAULT_TIMEOUT
      // MIN_TIMEOUT guards against LLM-specified timeouts that are too short.
      const ms = params.timeout ? Math.max(MIN_TIMEOUT, raw) : raw
      const deadline = abortAfterAny(ms, ctx.abort)

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", cancel)
          deadline.signal.addEventListener("abort", cancel)
        }),
        () =>
          Effect.gen(function* () {
            const parts = yield* ops.resolvePromptParts(params.prompt)

            const exit = yield* ops
              .prompt({
                messageID,
                sessionID: nextSession.id,
                model: {
                  modelID: model.modelID,
                  providerID: model.providerID,
                },
                agent: next.name,
                tools: {
                  todowrite: false,
                  todoread: false,
                  ...(canTask ? {} : { task: false }),
                  question: false,
                  ...Object.fromEntries((cfg.experimental?.primary_tools ?? []).map((item) => [item, false])),
                },
                parts,
              })
              .pipe(Effect.exit)

            deadline.clearTimeout()

            if (Exit.isFailure(exit)) {
              // If parent was aborted (user Ctrl+C), re-throw
              if (ctx.abort.aborted) return yield* Effect.failCause(exit.cause)
              // If the deadline fired, it's a real timeout
              if (deadline.signal.aborted) {
                cancel()
                const limit = Math.round(ms / 1000)
                return {
                  title: params.description,
                  metadata: {
                    sessionId: nextSession.id,
                    model,
                  },
                  output: [
                    `TIMEOUT: Task exceeded ${limit}s deadline and was cancelled.`,
                    `task_id: ${nextSession.id}`,
                    "",
                    "You can resume this task by passing the task_id above.",
                    "Recommended: retry with a simpler or more focused prompt. Break large tasks into smaller sub-tasks.",
                  ].join("\n"),
                }
              }
              // Non-timeout, non-abort error — surface the actual failure
              cancel()
              const reason = Cause.pretty(exit.cause)
              return {
                title: params.description,
                metadata: {
                  sessionId: nextSession.id,
                  model,
                },
                output: [
                  `ERROR: Task failed: ${reason}`,
                  `task_id: ${nextSession.id}`,
                  "",
                  "You can retry this task by passing the task_id above, or try a different approach.",
                ].join("\n"),
              }
            }

            const result = exit.value

            // Detect timeout: deadline fired after prompt returned but before we got here
            if (deadline.signal.aborted && !ctx.abort.aborted) {
              const limit = Math.round(ms / 1000)
              const partial = yield* childText(result, nextSession.id, sessions, { skipAbort: true })
              return {
                title: params.description,
                metadata: {
                  sessionId: nextSession.id,
                  model,
                },
                output: [
                  `TIMEOUT: Task exceeded ${limit}s deadline and was cancelled.`,
                  `task_id: ${nextSession.id}`,
                  "",
                  ...(partial ? ["Partial output recovered from the timed-out session:", "", partial, ""] : []),
                  "You can resume this task by passing the task_id above.",
                  "Recommended: retry with a simpler or more focused prompt. Break large tasks into smaller sub-tasks.",
                ].join("\n"),
              }
            }

            const text = yield* childText(result, nextSession.id, sessions, {
              parentAborted: ctx.abort.aborted,
              deadlineAborted: deadline.signal.aborted,
            })

            return {
              title: params.description,
              metadata: {
                sessionId: nextSession.id,
                model,
              },
              output: [
                `task_id: ${nextSession.id} (for resuming to continue this task if needed)`,
                "",
                "<task_result>",
                text,
                "</task_result>",
              ].join("\n"),
            }
          }),
        () =>
          Effect.sync(() => {
            deadline.clearTimeout()
            deadline.signal.removeEventListener("abort", cancel)
            ctx.abort.removeEventListener("abort", cancel)
          }),
      )
    })

    return {
      description: DESCRIPTION,
      parameters,
      execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
