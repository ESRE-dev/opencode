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

const log = Log.create({ service: "bootstrap" })

const WATCHDOG_INTERVAL = 60_000
const MAX_RUNNING = 15 * 60 * 1_000

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
export function watchdogTick(cutoff: number) {
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

    // Cancel only the sessions that own leaf-level stuck tools.
    // Parent sessions with waiting task tools keep running so
    // their LLM can process the child error normally.
    const sessions = [...new Set(leaf.map((r) => r.session_id))]
    for (const id of sessions) {
      log.warn("watchdog: cancelling stuck session", { sessionID: id })
      SessionPrompt.cancel(id)
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
  })
}

/**
 * Periodic scan for tool parts stuck in "running" beyond MAX_RUNNING.
 * Safety net for cases where the bash hard-stop or abort signal also fails.
 */
function watchdog() {
  const timer = setInterval(() => {
    watchdogTick(Date.now() - MAX_RUNNING)
  }, WATCHDOG_INTERVAL)
  timer.unref()
}
