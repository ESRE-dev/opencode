import { test, expect, afterEach } from "bun:test"
import { Question } from "../../src/question"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { SessionID } from "../../src/session/schema"

afterEach(async () => {
  await Instance.disposeAll()
})

test("list - returns questions from multiple sessions", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const p1 = Question.ask({
        sessionID: SessionID.make("ses_parent"),
        questions: [{ question: "Parent?", header: "P", options: [{ label: "A", description: "A" }] }],
      })
      const p2 = Question.ask({
        sessionID: SessionID.make("ses_child"),
        questions: [{ question: "Child?", header: "C", options: [{ label: "B", description: "B" }] }],
      })

      const pending = await Question.list()
      expect(pending.length).toBe(2)
      const ids = pending.map((p) => p.sessionID)
      expect(ids).toContain(SessionID.make("ses_parent"))
      expect(ids).toContain(SessionID.make("ses_child"))

      // cleanup
      for (const req of pending) await Question.reject(req.id)
      await p1.catch(() => {})
      await p2.catch(() => {})
    },
  })
})

test("reply - can answer child session question from parent context", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const ask = Question.ask({
        sessionID: SessionID.make("ses_child"),
        questions: [
          { question: "Child needs input", header: "Input", options: [{ label: "Yes", description: "Confirm" }] },
        ],
      })

      const pending = await Question.list()
      expect(pending.length).toBe(1)
      expect(pending[0].sessionID).toBe(SessionID.make("ses_child"))

      await Question.reply({ requestID: pending[0].id, answers: [["Yes"]] })
      const answers = await ask
      expect(answers).toEqual([["Yes"]])
    },
  })
})

test("reject - can reject child session question from parent context", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const ask = Question.ask({
        sessionID: SessionID.make("ses_child"),
        questions: [
          { question: "Child needs input", header: "Input", options: [{ label: "Yes", description: "Confirm" }] },
        ],
      })

      const pending = await Question.list()
      await Question.reject(pending[0].id)
      await expect(ask).rejects.toBeInstanceOf(Question.RejectedError)
    },
  })
})

test("list - returns questions from deeply nested sessions", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const promises = [
        Question.ask({
          sessionID: SessionID.make("ses_parent"),
          questions: [{ question: "Level 0?", header: "L0", options: [{ label: "A", description: "A" }] }],
        }),
        Question.ask({
          sessionID: SessionID.make("ses_child"),
          questions: [{ question: "Level 1?", header: "L1", options: [{ label: "B", description: "B" }] }],
        }),
        Question.ask({
          sessionID: SessionID.make("ses_grandchild"),
          questions: [{ question: "Level 2?", header: "L2", options: [{ label: "C", description: "C" }] }],
        }),
      ]

      const pending = await Question.list()
      expect(pending.length).toBe(3)

      for (const req of pending) await Question.reject(req.id)
      for (const p of promises) await p.catch(() => {})
    },
  })
})

test("rejectSession - only rejects questions for the specified session", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const child = Question.ask({
        sessionID: SessionID.make("ses_child"),
        questions: [{ question: "Child?", header: "C", options: [{ label: "X", description: "X" }] }],
      })
      const other = Question.ask({
        sessionID: SessionID.make("ses_other"),
        questions: [{ question: "Other?", header: "O", options: [{ label: "Y", description: "Y" }] }],
      })

      await Question.rejectSession(SessionID.make("ses_child"))
      await expect(child).rejects.toBeInstanceOf(Question.RejectedError)

      const pending = await Question.list()
      expect(pending.length).toBe(1)
      expect(pending[0].sessionID).toBe(SessionID.make("ses_other"))

      // cleanup
      await Question.reject(pending[0].id)
      await other.catch(() => {})
    },
  })
})

test("rejectSession - idempotent, no-op if no pending questions", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // Should not throw when called with no pending questions
      await Question.rejectSession(SessionID.make("ses_nonexistent"))
      await Question.rejectSession(SessionID.make("ses_nonexistent"))
    },
  })
})

test("rejectSession twice does not throw", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const ask = Question.ask({
        sessionID: SessionID.make("ses_double"),
        questions: [{ question: "Q?", header: "Q", options: [{ label: "A", description: "A" }] }],
      })

      await Question.rejectSession(SessionID.make("ses_double"))
      // Second call is a no-op
      await Question.rejectSession(SessionID.make("ses_double"))

      await expect(ask).rejects.toBeInstanceOf(Question.RejectedError)
    },
  })
})

test("reply - resolving parent question does not affect child questions", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const parent = Question.ask({
        sessionID: SessionID.make("ses_parent"),
        questions: [{ question: "Parent?", header: "P", options: [{ label: "A", description: "A" }] }],
      })
      const child = Question.ask({
        sessionID: SessionID.make("ses_child"),
        questions: [{ question: "Child?", header: "C", options: [{ label: "B", description: "B" }] }],
      })

      const pending = await Question.list()
      const req = pending.find((p) => p.sessionID === SessionID.make("ses_parent"))!
      await Question.reply({ requestID: req.id, answers: [["A"]] })
      await expect(parent).resolves.toEqual([["A"]])

      const remaining = await Question.list()
      expect(remaining.length).toBe(1)
      expect(remaining[0].sessionID).toBe(SessionID.make("ses_child"))

      // cleanup
      await Question.reject(remaining[0].id)
      await child.catch(() => {})
    },
  })
})
