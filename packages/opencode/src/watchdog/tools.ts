import { Effect, Schema } from "effect"
import * as Tool from "../tool/tool"
import { Database, eq, sql, desc } from "../storage"
import { PartTable, MessageTable, SessionTable } from "../session/session.sql"
import type { TaskPromptOps } from "../tool/task"
import { diagnostics } from "./error"
import type { SessionID } from "../session/schema"

function scope(id: string, ctx: Tool.Context) {
  const stuck = ctx.extra?.stuckSessionID as string | undefined
  if (!stuck) throw new Error("Watchdog context missing stuckSessionID")
  if (id !== stuck) throw new Error(`Scope violation: tool targets ${id} but watchdog is scoped to ${stuck}`)
}

const QueryParameters = Schema.Struct({
  session_id: Schema.String.annotate({ description: "Session ID to query" }),
  query: Schema.Literals(["latest_message", "running_tools", "latest_parts", "session_tree", "lifecycle_pairs"]),
})

export const WatchdogQueryTool = Tool.define(
  "watchdog_query",
  Effect.succeed({
    description: "Query the database for stuck session state. SELECT-only — no mutations.",
    parameters: QueryParameters,
    execute: (args: Schema.Schema.Type<typeof QueryParameters>, ctx: Tool.Context) =>
      Effect.gen(function* () {
        scope(args.session_id, ctx)
        const sid = args.session_id as SessionID
        const result = Database.use((db) => {
          switch (args.query) {
            case "latest_message":
              return db
                .select({ id: MessageTable.id, data: MessageTable.data, time_created: MessageTable.time_created })
                .from(MessageTable)
                .where(eq(MessageTable.session_id, sid))
                .orderBy(desc(MessageTable.time_created))
                .all()
                .filter((row) => (row.data as Record<string, unknown>).role === "assistant")
                .slice(0, 1)
            case "running_tools":
              return db
                .select({ id: PartTable.id, data: PartTable.data, time_created: PartTable.time_created })
                .from(PartTable)
                .where(eq(PartTable.session_id, sid))
                .all()
                .filter((row) => {
                  const d = row.data as Record<string, unknown>
                  if (d.type !== "tool") return false
                  const state = d.state as Record<string, unknown> | undefined
                  return state?.status === "running"
                })
            case "latest_parts":
              return db
                .select({ id: PartTable.id, data: PartTable.data, time_created: PartTable.time_created })
                .from(PartTable)
                .where(eq(PartTable.session_id, sid))
                .orderBy(desc(PartTable.time_created))
                .limit(10)
                .all()
            case "session_tree":
              return db
                .select({ id: SessionTable.id, parent_id: SessionTable.parent_id, title: SessionTable.title })
                .from(SessionTable)
                .where(sql`${SessionTable.id} = ${sid} OR ${SessionTable.parent_id} = ${sid}`)
                .all()
            case "lifecycle_pairs": {
              const parts = db
                .select({ id: PartTable.id, data: PartTable.data, time_created: PartTable.time_created })
                .from(PartTable)
                .where(eq(PartTable.session_id, sid))
                .all()
              return parts.filter((row) => {
                const d = row.data as Record<string, unknown>
                if (d.type === "step-start") {
                  return !parts.some(
                    (f) =>
                      (f.data as Record<string, unknown>).type === "step-finish" && f.time_created > row.time_created,
                  )
                }
                if (d.type === "tool") {
                  const state = d.state as Record<string, unknown> | undefined
                  return state?.status === "running"
                }
                return false
              })
            }
          }
        })
        return { title: `query:${args.query}`, metadata: {}, output: JSON.stringify(result) }
      }),
  }),
)

const ActivityParameters = Schema.Struct({
  session_id: Schema.String.annotate({ description: "Session ID to check" }),
})

export const WatchdogActivityTool = Tool.define(
  "watchdog_activity",
  Effect.succeed({
    description: "Check when the last new part was created for a session.",
    parameters: ActivityParameters,
    execute: (args: Schema.Schema.Type<typeof ActivityParameters>, ctx: Tool.Context) =>
      Effect.gen(function* () {
        scope(args.session_id, ctx)
        const sid = args.session_id as SessionID
        const max = Database.use((db) =>
          db
            .select({ max: sql<number>`MAX(${PartTable.time_created})` })
            .from(PartTable)
            .where(eq(PartTable.session_id, sid))
            .get(),
        )
        const now = Date.now()
        const result = { max_part_created: max?.max ?? null, now, age_ms: max?.max ? now - max.max : null }
        return { title: "activity", metadata: {}, output: JSON.stringify(result) }
      }),
  }),
)

const CancelParameters = Schema.Struct({
  session_id: Schema.String.annotate({ description: "Session ID to cancel — must match the stuck session from context" }),
  reason: Schema.String.annotate({ description: "Full diagnostic report: failure mode, evidence, recommendation" }),
})

export const WatchdogCancelTool = Tool.define(
  "watchdog_cancel",
  Effect.succeed({
    description: "Cancel the stuck session with a diagnostic report after confirming no recovery.",
    parameters: CancelParameters,
    execute: (args: Schema.Schema.Type<typeof CancelParameters>, ctx: Tool.Context) =>
      Effect.gen(function* () {
        scope(args.session_id, ctx)
        const sid = args.session_id as SessionID
        const activity = Database.use((db) =>
          db
            .select({ max: sql<number>`MAX(${PartTable.time_created})` })
            .from(PartTable)
            .where(eq(PartTable.session_id, sid))
            .get(),
        )
        if (activity?.max && Date.now() - activity.max < 10_000)
          return { title: "cancel:aborted", metadata: {}, output: "Session recovered during cancel — no action taken" }

        diagnostics.set(args.session_id, args.reason)

        const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
        if (ops) {
          ops.cancel(sid)
        }
        return { title: "cancel:ok", metadata: {}, output: `Cancelled session ${args.session_id}` }
      }),
  }),
)

const RepromptParameters = Schema.Struct({
  session_id: Schema.String.annotate({ description: "Session ID to nudge — must be a Layer 2/3 stall, not Layer 1" }),
  message: Schema.String.annotate({ description: "Nudge message to send" }),
})

export const WatchdogRepromptTool = Tool.define(
  "watchdog_reprompt",
  Effect.succeed({
    description: "Send a nudge message to a stuck child session and poll for recovery.",
    parameters: RepromptParameters,
    execute: (args: Schema.Schema.Type<typeof RepromptParameters>, ctx: Tool.Context) =>
      Effect.gen(function* () {
        scope(args.session_id, ctx)
        const sid = args.session_id as SessionID
        const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
        if (!ops) return yield* Effect.die(new Error("WatchdogRepromptTool requires promptOps in ctx.extra"))
        yield* ops.prompt({
          sessionID: sid,
          parts: [{ type: "text", text: args.message }],
        })
        const polls: { time: number; max_created: number | null }[] = []
        let prev: number | null = null
        for (let i = 0; i < 5; i++) {
          if (i > 0) yield* Effect.promise(() => new Promise<void>((r) => setTimeout(r, 2000)))
          const row = Database.use((db) =>
            db
              .select({ max: sql<number>`MAX(${PartTable.time_created})` })
              .from(PartTable)
              .where(eq(PartTable.session_id, sid))
              .get(),
          )
          const max = row?.max ?? null
          polls.push({ time: Date.now(), max_created: max })
          if (max !== null && prev !== null && max > prev)
            return { title: "reprompt:recovered", metadata: {}, output: JSON.stringify({ recovered: true, polls }) }
          prev = max
        }
        return { title: "reprompt:no-recovery", metadata: {}, output: JSON.stringify({ recovered: false, polls }) }
      }),
  }),
)
