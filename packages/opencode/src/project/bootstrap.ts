import { Plugin } from "../plugin"
import { Format } from "../format"
import { LSP } from "../lsp"
import { FileWatcher } from "../file/watcher"
import { File } from "../file"
import { Project } from "./project"
import { Bus } from "../bus"
import { Command } from "../command"
import { Instance } from "./instance"
import { Vcs } from "./vcs"
import { Log } from "@/util/log"
import { ShareNext } from "@/share/share-next"
import { Snapshot } from "../snapshot"
import { Truncate } from "../tool/truncation"
import { Database, sql } from "../storage/db"
import { PartTable } from "../session/session.sql"
import { SessionPrompt } from "../session/prompt"
import { SessionActivity } from "../session/activity"
import { Config } from "../config/config"

const log = Log.create({ service: "bootstrap" })

const WATCHDOG_INTERVAL = 60_000
const MAX_RUNNING = 15 * 60 * 1_000
const DEFAULT_IDLE = 5 * 60 * 1_000

export async function InstanceBootstrap() {
  Log.Default.info("bootstrapping", { directory: Instance.directory })
  await Plugin.init()
  ShareNext.init()
  Format.init()
  await LSP.init()
  FileWatcher.init()
  File.init()
  Vcs.init()
  Snapshot.init()
  Truncate.init()
  SessionActivity.init()
  cleanupOrphanedParts()
  watchdog()

  Bus.subscribe(Command.Event.Executed, async (payload) => {
    if (payload.properties.name === Command.Default.INIT) {
      await Project.setInitialized(Instance.project.id)
    }
  })
}

/**
 * Mark any tool parts left in "running" state from a previous process as errored.
 * When the process exits (crash or clean shutdown), in-flight tool executions
 * are lost but their DB state remains "running" forever. This recovers them.
 */
function cleanupOrphanedParts() {
  const now = Date.now()
  Database.use((db) => {
    const orphaned = db
      .select({ id: PartTable.id })
      .from(PartTable)
      .where(
        sql`json_extract(${PartTable.data}, '$.type') = 'tool'
            AND json_extract(${PartTable.data}, '$.state.status') = 'running'`,
      )
      .all()
    if (orphaned.length === 0) return
    log.info("cleaning up orphaned tool parts", { count: orphaned.length })
    db.update(PartTable)
      .set({
        data: sql`json_set(
          json_set(
            json_set(${PartTable.data}, '$.state.status', 'error'),
            '$.state.error', 'Tool execution orphaned by process restart'
          ),
          '$.state.time.end', ${now}
        )`,
      })
      .where(
        sql`json_extract(${PartTable.data}, '$.type') = 'tool'
            AND json_extract(${PartTable.data}, '$.state.status') = 'running'`,
      )
      .run()
  })
}

/**
 * Single watchdog tick: find tool parts stuck in "running" beyond the cutoff,
 * filter to leaf-level tools, cancel their sessions, and force-error the
 * DB rows as a safety net.
 *
 * Only cancels "leaf" stuck tools — i.e. non-task tools that are the actual
 * root cause.  Task tools that are waiting on a child session with its own
 * stuck tool are left alone so the normal error-propagation path can run:
 * child cancel → task tool resolves → parent LLM processes the error.
 *
 * Exported for testing.
 */
export function watchdogTick(cutoff: number, idle?: number) {
  Database.use((db) => {
    const stuck = db
      .select({
        id: PartTable.id,
        session_id: PartTable.session_id,
        tool: sql<string>`json_extract(${PartTable.data}, '$.tool')`,
        child: sql<string | null>`json_extract(${PartTable.data}, '$.state.metadata.sessionId')`,
      })
      .from(PartTable)
      .where(
        sql`json_extract(${PartTable.data}, '$.type') = 'tool'
            AND json_extract(${PartTable.data}, '$.state.status') = 'running'
            AND json_extract(${PartTable.data}, '$.state.time.start') < ${cutoff}`,
      )
      .all()
    if (stuck.length === 0) return

    // Sessions that contain at least one stuck tool
    const stuckSessions = new Set(stuck.map((r) => r.session_id))

    // A task tool whose child session also has stuck tools is just
    // waiting — it will resolve once the child is cancelled.
    // Everything else (non-task tools, or task tools whose child has
    // no stuck tools) is a leaf that we must force-error.
    const leaf = stuck.filter((r) => {
      if (r.tool !== "task") return true
      if (!r.child) return true
      return !stuckSessions.has(r.child)
    })

    log.warn("watchdog: found stuck tool parts", {
      total: stuck.length,
      leaf: leaf.length,
      ids: stuck.map((r) => r.id),
    })

    if (leaf.length === 0) return

    // For task-tool leaves, cancel the *child* session so the task tool's
    // normal error-propagation path runs: child cancel → SessionPrompt.prompt()
    // resolves → task tool returns structured TIMEOUT to the parent LLM.
    // For non-task leaves, cancel the owning session directly.
    const cancelled = new Set<string>()
    for (const r of leaf) {
      if (r.tool === "task" && r.child) {
        if (cancelled.has(r.child)) continue
        cancelled.add(r.child)
        log.warn("watchdog: cancelling stuck child session", { child: r.child, parent: r.session_id })
        SessionPrompt.cancel(r.child)
      } else {
        if (cancelled.has(r.session_id)) continue
        cancelled.add(r.session_id)
        log.warn("watchdog: cancelling stuck session", { sessionID: r.session_id })
        SessionPrompt.cancel(r.session_id)
      }
    }

    // DB update as redundant safety net — only for leaf tools
    const now = Date.now()
    for (const r of leaf) {
      db.update(PartTable)
        .set({
          data: sql`json_set(
            json_set(
              json_set(${PartTable.data}, '$.state.status', 'error'),
              '$.state.error', 'Tool execution exceeded maximum allowed duration (watchdog)'
            ),
            '$.state.time.end', ${now}
          )`,
        })
        .where(
          sql`${PartTable.id} = ${r.id}
              AND json_extract(${PartTable.data}, '$.state.status') = 'running'`,
        )
        .run()
    }

    // --- Idle detection for subagent sessions ---
    // A session is "idle" when it has recorded activity (stream started)
    // but nothing has happened for longer than the idle threshold.
    // Only subagent sessions (those with a parent task tool among the
    // stuck set) are candidates — root/interactive sessions are exempt.
    if (idle) {
      // Collect child session IDs referenced by stuck task tools
      const children = new Set(stuck.filter((r) => r.tool === "task" && r.child).map((r) => r.child!))
      for (const child of children) {
        if (cancelled.has(child)) continue
        if (!SessionActivity.stale(child, idle)) continue
        const ts = SessionActivity.last(child)
        log.warn("watchdog: idle subagent detected", {
          sessionID: child,
          last: ts,
          threshold: idle,
        })
        cancelled.add(child)
        SessionPrompt.cancel(child)
      }
    }
  })
}

/**
 * Periodic scan for tool parts stuck in "running" beyond the configured timeout.
 * Safety net for cases where the bash hard-stop or abort signal also fails.
 * Respects both tool_timeout and task_timeout config to avoid killing
 * long-running but healthy Task tool executions.
 */
function watchdog() {
  const timer = setInterval(async () => {
    try {
      const cfg = await Config.get()
      const base = cfg.experimental?.tool_timeout ?? MAX_RUNNING
      const task = cfg.experimental?.task_timeout ?? 1_800_000
      const idle = cfg.experimental?.idle_timeout ?? DEFAULT_IDLE
      const grace = 60_000
      const max = Math.max(base, task + grace)
      watchdogTick(Date.now() - max, idle)
    } catch {
      watchdogTick(Date.now() - MAX_RUNNING)
    }
  }, WATCHDOG_INTERVAL)
  timer.unref()
}
