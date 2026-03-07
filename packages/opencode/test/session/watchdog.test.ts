import { afterEach, describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { Database, sql } from "../../src/storage/db"
import { PartTable } from "../../src/session/session.sql"
import { watchdogTick } from "../../src/project/bootstrap"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"

/**
 * Tests for the watchdog's leaf-filtering logic.
 *
 * The watchdog scans for tool parts stuck in "running" beyond a cutoff.
 * The key behavior: task tools whose child session also has stuck tools
 * are NOT cancelled (they resolve naturally when the child is cancelled).
 * Only "leaf" tools — non-task tools, or task tools with no live child —
 * are force-errored.
 */

afterEach(async () => {
  await resetDatabase()
})

Log.init({ print: false })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Insert a message row via raw SQL (avoids type constraints for test data). */
function insertMessage(id: string, session: string) {
  const now = Date.now()
  Database.use((db) => {
    db.run(
      sql.raw(
        `INSERT INTO message (id, session_id, time_created, time_updated, data)
         VALUES ('${id}', '${session}', ${now}, ${now},
           '${JSON.stringify({
             role: "assistant",
             time: { created: now },
             agent: "test",
             modelID: "test",
             providerID: "test",
             parentID: "",
             mode: "",
             path: { cwd: "/tmp", root: "/tmp" },
             cost: 0,
             tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
           })}')`,
      ),
    )
  })
}

/** Insert a tool part with "running" status via raw SQL. */
function insertRunning(opts: {
  id: string
  session: string
  message: string
  tool: string
  start: number
  child?: string
}) {
  const metadata = opts.child ? { sessionId: opts.child } : {}
  const data = JSON.stringify({
    type: "tool",
    callID: `call_${opts.id}`,
    tool: opts.tool,
    state: {
      status: "running",
      input: {},
      time: { start: opts.start },
      metadata,
    },
  })
  Database.use((db) => {
    db.run(
      sql.raw(
        `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
         VALUES ('${opts.id}', '${opts.message}', '${opts.session}', ${opts.start}, ${opts.start}, '${data}')`,
      ),
    )
  })
}

/** Read a part's status from the DB. */
function partStatus(id: string): string {
  return Database.use((db) => {
    const row = db
      .select({
        status: sql<string>`json_extract(${PartTable.data}, '$.state.status')`,
      })
      .from(PartTable)
      .where(sql`${PartTable.id} = ${id}`)
      .get()
    return row!.status
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("watchdog: leaf-filtering", () => {
  test("single stuck non-task tool is force-errored", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ses = await Session.create({})
        const msg = Identifier.ascending("message")
        const prt = Identifier.ascending("part")
        insertMessage(msg, ses.id)
        insertRunning({ id: prt, session: ses.id, message: msg, tool: "bash", start: 1000 })

        watchdogTick(Date.now())

        expect(partStatus(prt)).toBe("error")
      },
    })
  })

  test("task tool waiting on child with stuck tool is NOT errored", async () => {
    // 3-level chain: top → child → grandchild
    // grandchild has a stuck "question" tool (the leaf)
    // child has a stuck "task" tool pointing at grandchild
    // top has a stuck "task" tool pointing at child
    //
    // Only the grandchild's "question" tool should be errored.
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const top = await Session.create({})
        const child = await Session.create({ parentID: top.id })
        const grand = await Session.create({ parentID: child.id })

        const topMsg = Identifier.ascending("message")
        const childMsg = Identifier.ascending("message")
        const grandMsg = Identifier.ascending("message")
        const topPrt = Identifier.ascending("part")
        const childPrt = Identifier.ascending("part")
        const grandPrt = Identifier.ascending("part")

        insertMessage(topMsg, top.id)
        insertMessage(childMsg, child.id)
        insertMessage(grandMsg, grand.id)

        const old = 1000
        // Top-level: task tool waiting on child
        insertRunning({
          id: topPrt,
          session: top.id,
          message: topMsg,
          tool: "task",
          start: old,
          child: child.id,
        })
        // Child: task tool waiting on grandchild
        insertRunning({
          id: childPrt,
          session: child.id,
          message: childMsg,
          tool: "task",
          start: old,
          child: grand.id,
        })
        // Grandchild: stuck "question" tool (leaf)
        insertRunning({
          id: grandPrt,
          session: grand.id,
          message: grandMsg,
          tool: "question",
          start: old,
        })

        watchdogTick(Date.now())

        // Only the grandchild's leaf tool should be errored
        expect(partStatus(grandPrt)).toBe("error")
        // Parent task tools should remain running
        expect(partStatus(childPrt)).toBe("running")
        expect(partStatus(topPrt)).toBe("running")
      },
    })
  })

  test("task tool with no child metadata is treated as leaf", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ses = await Session.create({})
        const msg = Identifier.ascending("message")
        const prt = Identifier.ascending("part")
        insertMessage(msg, ses.id)
        // Task tool but no child session ID in metadata
        insertRunning({ id: prt, session: ses.id, message: msg, tool: "task", start: 1000 })

        watchdogTick(Date.now())

        expect(partStatus(prt)).toBe("error")
      },
    })
  })

  test("task tool whose child has no stuck tools is treated as leaf", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({})
        const child = await Session.create({ parentID: parent.id })

        const msg = Identifier.ascending("message")
        const prt = Identifier.ascending("part")
        insertMessage(msg, parent.id)

        // Parent has task tool pointing at child, but child has NO stuck tools
        insertRunning({
          id: prt,
          session: parent.id,
          message: msg,
          tool: "task",
          start: 1000,
          child: child.id,
        })

        watchdogTick(Date.now())

        expect(partStatus(prt)).toBe("error")
      },
    })
  })

  test("no stuck tools means no changes", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Nothing stuck — watchdog should be a no-op
        watchdogTick(Date.now())
        // No assertion needed; just verify it doesn't throw
      },
    })
  })

  test("tools within cutoff are not affected", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ses = await Session.create({})
        const msg = Identifier.ascending("message")
        const prt = Identifier.ascending("part")
        insertMessage(msg, ses.id)

        // Tool started recently
        const recent = Date.now()
        insertRunning({ id: prt, session: ses.id, message: msg, tool: "bash", start: recent })

        // Cutoff is before the tool started — not stuck
        watchdogTick(recent - 1000)

        expect(partStatus(prt)).toBe("running")
      },
    })
  })

  test("multiple leaves across different sessions are all errored", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ses1 = await Session.create({})
        const ses2 = await Session.create({})
        const msg1 = Identifier.ascending("message")
        const msg2 = Identifier.ascending("message")
        const prt1 = Identifier.ascending("part")
        const prt2 = Identifier.ascending("part")

        insertMessage(msg1, ses1.id)
        insertMessage(msg2, ses2.id)

        insertRunning({ id: prt1, session: ses1.id, message: msg1, tool: "bash", start: 1000 })
        insertRunning({ id: prt2, session: ses2.id, message: msg2, tool: "read", start: 1000 })

        watchdogTick(Date.now())

        expect(partStatus(prt1)).toBe("error")
        expect(partStatus(prt2)).toBe("error")
      },
    })
  })

  test("mixed: leaf tools errored, waiting task tools preserved", async () => {
    // Two independent chains:
    //   Chain A: parentA → task(childA) → childA has stuck bash
    //   Chain B: standalone session with stuck read tool
    // Both leaf tools errored, parentA's task tool preserved.
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parentA = await Session.create({})
        const childA = await Session.create({ parentID: parentA.id })
        const sesB = await Session.create({})

        const msgA = Identifier.ascending("message")
        const msgChild = Identifier.ascending("message")
        const msgB = Identifier.ascending("message")
        const prtA = Identifier.ascending("part")
        const prtChild = Identifier.ascending("part")
        const prtB = Identifier.ascending("part")

        insertMessage(msgA, parentA.id)
        insertMessage(msgChild, childA.id)
        insertMessage(msgB, sesB.id)

        const old = 1000
        insertRunning({
          id: prtA,
          session: parentA.id,
          message: msgA,
          tool: "task",
          start: old,
          child: childA.id,
        })
        insertRunning({ id: prtChild, session: childA.id, message: msgChild, tool: "bash", start: old })
        insertRunning({ id: prtB, session: sesB.id, message: msgB, tool: "read", start: old })

        watchdogTick(Date.now())

        // Leaf tools errored
        expect(partStatus(prtChild)).toBe("error")
        expect(partStatus(prtB)).toBe("error")
        // Parent's task tool preserved
        expect(partStatus(prtA)).toBe("running")
      },
    })
  })
})
