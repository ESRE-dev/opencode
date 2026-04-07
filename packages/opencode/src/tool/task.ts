import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import z from "zod"
import { Session } from "../session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "../config"
import { Effect } from "effect"
import { abortAfterAny } from "@/util/abort"
import { WATCHDOG_TIMEOUT_DEFAULTS, diagnostics } from "@/watchdog/error"
import { spawnWatchdog } from "@/watchdog/spawn"
import { errorMessage } from "@/util/error"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): void
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<MessageV2.WithParts>
}

const DEFAULT_TIMEOUT = 14_400_000
const MIN_TIMEOUT = 30_000

const id = "task"

export function childText(
  sessionID: string,
  result: { ok: true; value: MessageV2.WithParts } | { ok: false; error: unknown },
): string {
  if (!result.ok) return `Child session error: ${errorMessage(result.error)}`

  const msg = result.value
  if (msg.info.role === "assistant" && msg.info.error && MessageV2.AbortedError.isInstance(msg.info.error)) {
    const report = diagnostics.get(sessionID)
    diagnostics.delete(sessionID)
    if (report) return ["Child session was cancelled by watchdog. Diagnostic report:", "", report].join("\n")
    return `Child session ${sessionID} was aborted.`
  }

  const text = msg.parts.findLast((x) => x.type === "text")?.text
  if (!text) return "Child session returned no content."
  return text
}

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
    .int()
    .positive()
    .describe("Optional timeout in seconds for zombie/stall protection. Default: 4 hours. Minimum: 30 minutes.")
    .optional(),
})

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
      const canTodo = next.permission.some((rule) => rule.permission === "todowrite")

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
            ...(canTodo
              ? []
              : [
                  {
                    permission: "todowrite" as const,
                    pattern: "*" as const,
                    action: "deny" as const,
                  },
                ]),
            ...(canTask
              ? []
              : [
                  {
                    permission: id,
                    pattern: "*" as const,
                    action: "deny" as const,
                  },
                ]),
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

      const timeouts = cfg.experimental?.watchdog?.timeouts
      const cfgMs = (timeouts?.task ?? WATCHDOG_TIMEOUT_DEFAULTS.task) * 1000
      const paramMs = params.timeout ? Math.max(params.timeout * 1000, MIN_TIMEOUT) : undefined
      const ms = paramMs ?? cfgMs
      const deadline = abortAfterAny(ms, ctx.abort)

      let watchdogSpawned = false
      const onDeadline = () => {
        if (watchdogSpawned) return
        if (ctx.abort.aborted) return // user cancelled, not a timeout
        watchdogSpawned = true
        try {
          spawnWatchdog({
            stuckSessionID: nextSession.id as any,
            parentSessionID: ctx.sessionID as any,
            trigger: { tool: "task", timeout: ms / 1000, elapsed: ms / 1000 },
          }).catch(() => {})
        } catch {
          // never crash main session
        }
      }
      deadline.signal.addEventListener("abort", onDeadline)

      function cancel() {
        ops.cancel(nextSession.id)
      }

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", cancel)
        }),
        () =>
          Effect.gen(function* () {
            const parts = yield* ops.resolvePromptParts(params.prompt)
            const outcome = yield* ops
              .prompt({
                messageID,
                sessionID: nextSession.id,
                model: {
                  modelID: model.modelID,
                  providerID: model.providerID,
                },
                agent: next.name,
                tools: {
                  ...(canTodo ? {} : { todowrite: false }),
                  ...(canTask ? {} : { task: false }),
                  ...Object.fromEntries((cfg.experimental?.primary_tools ?? []).map((item) => [item, false])),
                },
                parts,
              })
              .pipe(
                Effect.map((value) => ({ ok: true as const, value })),
                Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
              )

            const text = childText(nextSession.id, outcome)

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
            ctx.abort.removeEventListener("abort", cancel)
            deadline.signal.removeEventListener("abort", onDeadline)
            deadline.clearTimeout()
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
