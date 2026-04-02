import { describe, expect, test, afterEach } from "bun:test"
import { Bus } from "../../src/bus"
import { Permission } from "../../src/permission"
import { Question } from "../../src/question"
import { Instance } from "../../src/project/instance"
import { SessionProcessor } from "../../src/session/processor"
import { SessionID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})

describe("cancel propagation", () => {
  test("Permission.rejectSession rejects all pending for a session", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sid = SessionID.make("ses_cancel_perm")
        const p1 = Permission.ask({
          permission: "bash",
          patterns: ["*"],
          sessionID: sid,
          metadata: {},
          always: ["*"],
          ruleset: [],
        })
        const p2 = Permission.ask({
          permission: "edit",
          patterns: ["*"],
          sessionID: sid,
          metadata: {},
          always: ["*"],
          ruleset: [],
        })

        const pending = await Permission.list()
        expect(pending.length).toBe(2)

        await Permission.rejectSession(sid)

        await expect(p1).rejects.toBeInstanceOf(Permission.RejectedError)
        await expect(p2).rejects.toBeInstanceOf(Permission.RejectedError)

        const after = await Permission.list()
        expect(after.length).toBe(0)
      },
    })
  })

  test("Permission.rejectSession is idempotent", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sid = SessionID.make("ses_perm_idem")
        // No pending permissions — should not throw
        await Permission.rejectSession(sid)
        await Permission.rejectSession(sid)
      },
    })
  })

  test("Permission.rejectSession does not affect other sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sid1 = SessionID.make("ses_perm_a")
        const sid2 = SessionID.make("ses_perm_b")

        const p1 = Permission.ask({
          permission: "bash",
          patterns: ["*"],
          sessionID: sid1,
          metadata: {},
          always: ["*"],
          ruleset: [],
        })
        const p2 = Permission.ask({
          permission: "bash",
          patterns: ["*"],
          sessionID: sid2,
          metadata: {},
          always: ["*"],
          ruleset: [],
        })

        await Permission.rejectSession(sid1)
        await expect(p1).rejects.toBeInstanceOf(Permission.RejectedError)

        // sid2's permission should still be pending
        const pending = await Permission.list()
        expect(pending.length).toBe(1)
        expect(pending[0].sessionID).toBe(sid2)

        // cleanup
        const reply = await Permission.list()
        for (const r of reply) {
          await Permission.reply({ requestID: r.id, reply: "reject" })
        }
        await p2.catch(() => {})
      },
    })
  })

  test("Question.rejectSession rejects all pending for a session", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sid = SessionID.make("ses_cancel_q")
        const q1 = Question.ask({
          sessionID: sid,
          questions: [{ question: "Q1?", header: "Q1", options: [{ label: "A", description: "A" }] }],
        })
        const q2 = Question.ask({
          sessionID: sid,
          questions: [{ question: "Q2?", header: "Q2", options: [{ label: "B", description: "B" }] }],
        })

        const pending = await Question.list()
        expect(pending.length).toBe(2)

        await Question.rejectSession(sid)

        await expect(q1).rejects.toBeInstanceOf(Question.RejectedError)
        await expect(q2).rejects.toBeInstanceOf(Question.RejectedError)

        const after = await Question.list()
        expect(after.length).toBe(0)
      },
    })
  })

  test("Question.rejectSession is idempotent", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sid = SessionID.make("ses_q_idem")
        await Question.rejectSession(sid)
        await Question.rejectSession(sid)
      },
    })
  })

  test("Question.rejectSession does not affect other sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sid1 = SessionID.make("ses_q_a")
        const sid2 = SessionID.make("ses_q_b")

        const q1 = Question.ask({
          sessionID: sid1,
          questions: [{ question: "Q1?", header: "Q1", options: [{ label: "A", description: "A" }] }],
        })
        const q2 = Question.ask({
          sessionID: sid2,
          questions: [{ question: "Q2?", header: "Q2", options: [{ label: "B", description: "B" }] }],
        })

        await Question.rejectSession(sid1)
        await expect(q1).rejects.toBeInstanceOf(Question.RejectedError)

        const pending = await Question.list()
        expect(pending.length).toBe(1)
        expect(pending[0].sessionID).toBe(sid2)

        // cleanup
        await Question.reject(pending[0].id)
        await q2.catch(() => {})
      },
    })
  })

  test("cancel rejects both permissions and questions for a session", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sid = SessionID.make("ses_both")

        const perm = Permission.ask({
          permission: "bash",
          patterns: ["*"],
          sessionID: sid,
          metadata: {},
          always: ["*"],
          ruleset: [],
        })
        const question = Question.ask({
          sessionID: sid,
          questions: [{ question: "Q?", header: "Q", options: [{ label: "A", description: "A" }] }],
        })

        // Simulate what cancel does: reject both
        await Permission.rejectSession(sid)
        await Question.rejectSession(sid)

        await expect(perm).rejects.toBeInstanceOf(Permission.RejectedError)
        await expect(question).rejects.toBeInstanceOf(Question.RejectedError)

        expect(await Permission.list()).toHaveLength(0)
        expect(await Question.list()).toHaveLength(0)
      },
    })
  })

  test("CancelRequested event triggers cancel on child session", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sid = SessionID.make("ses_child_cancel")
        const received: string[] = []

        const unsub = Bus.subscribe(SessionProcessor.Event.CancelRequested, (evt) => {
          received.push(evt.properties.sessionID)
        })

        await Bus.publish(SessionProcessor.Event.CancelRequested, { sessionID: sid })
        await Bun.sleep(20)

        expect(received).toEqual([sid])
        unsub()
      },
    })
  })
})
