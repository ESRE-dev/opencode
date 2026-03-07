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
 * Periodic scan for tool parts stuck in "running" beyond MAX_RUNNING.
 * Safety net for cases where the bash hard-stop or abort signal also fails.
 */
function watchdog() {
  const timer = setInterval(() => {
    const cutoff = Date.now() - MAX_RUNNING
    Database.use((db) => {
      const stuck = db
        .select({ id: PartTable.id })
        .from(PartTable)
        .where(
          sql`json_extract(${PartTable.data}, '$.type') = 'tool'
              AND json_extract(${PartTable.data}, '$.state.status') = 'running'
              AND json_extract(${PartTable.data}, '$.state.time.start') < ${cutoff}`,
        )
        .all()
      if (stuck.length === 0) return
      log.warn("watchdog: force-erroring stuck tool parts", {
        count: stuck.length,
        ids: stuck.map((r) => r.id),
      })
      const now = Date.now()
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
          sql`json_extract(${PartTable.data}, '$.type') = 'tool'
              AND json_extract(${PartTable.data}, '$.state.status') = 'running'
              AND json_extract(${PartTable.data}, '$.state.time.start') < ${cutoff}`,
        )
        .run()
    })
  }, WATCHDOG_INTERVAL)
  timer.unref()
}
