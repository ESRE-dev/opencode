import { describe, expect, test, afterEach } from "bun:test"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { SessionProcessor } from "../../src/session/processor"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})

describe("SessionProcessor.Event", () => {
  test("CancelRequested event is defined", () => {
    expect(SessionProcessor.Event.CancelRequested).toBeDefined()
    expect(SessionProcessor.Event.CancelRequested.type).toBe("session.prompt.cancel")
  })

  test("CancelRequested event has sessionID property", () => {
    const schema = SessionProcessor.Event.CancelRequested.properties
    const result = schema.safeParse({ sessionID: "ses_test" })
    expect(result.success).toBe(true)
  })

  test("CancelRequested event rejects invalid payload", () => {
    const schema = SessionProcessor.Event.CancelRequested.properties
    const result = schema.safeParse({})
    expect(result.success).toBe(false)
  })

  test("CancelRequested publish/subscribe round-trip delivers sessionID", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const received: string[] = []
        const unsub = Bus.subscribe(SessionProcessor.Event.CancelRequested, (evt) => {
          received.push(evt.properties.sessionID)
        })

        await Bus.publish(SessionProcessor.Event.CancelRequested, { sessionID: "ses_sweep_test" })
        await Bun.sleep(20)

        expect(received).toEqual(["ses_sweep_test"])
        unsub()
      },
    })
  })
})
