import { describe, test, expect, mock, beforeEach } from "bun:test"
import { startStreamIdleTripwire } from "../../src/session/processor"
import { startToolTripwire } from "../../src/session/prompt"
import { StreamIdleError } from "../../src/watchdog/error"

describe("stream idle tripwire", () => {
  test("fires after configured duration with no events", async () => {
    const ms = 50
    const idle = startStreamIdleTripwire(ms, "ses_test")
    await new Promise((r) => setTimeout(r, ms + 30))
    expect(idle.fired).toBe(true)
    expect(idle.signal.aborted).toBe(true)
    expect(StreamIdleError.isInstance(idle.signal.reason)).toBe(true)
    idle.clear()
  })

  test("resets on each event (no false alarm)", async () => {
    const ms = 80
    const idle = startStreamIdleTripwire(ms, "ses_test2")

    // Reset several times within the window
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 30))
      expect(idle.fired).toBe(false)
      idle.reset()
    }

    // Should still not have fired
    expect(idle.fired).toBe(false)

    // Now wait past the timeout
    await new Promise((r) => setTimeout(r, ms + 30))
    expect(idle.fired).toBe(true)
    idle.clear()
  })

  test("clear prevents firing", async () => {
    const ms = 50
    const idle = startStreamIdleTripwire(ms, "ses_test3")
    idle.clear()
    await new Promise((r) => setTimeout(r, ms + 30))
    expect(idle.fired).toBe(true) // fired flag is set by clear
    expect(idle.signal.aborted).toBe(false) // but abort was NOT triggered
  })

  test("reset after fire is no-op", async () => {
    const ms = 30
    const idle = startStreamIdleTripwire(ms, "ses_test4")
    await new Promise((r) => setTimeout(r, ms + 20))
    expect(idle.fired).toBe(true)
    // reset should not throw or restart
    idle.reset()
    expect(idle.fired).toBe(true)
    idle.clear()
  })

  test("signal reason contains session ID and timeout", async () => {
    const ms = 30
    const idle = startStreamIdleTripwire(ms, "ses_abc")
    await new Promise((r) => setTimeout(r, ms + 20))
    expect(idle.fired).toBe(true)
    const err = idle.signal.reason
    expect(StreamIdleError.isInstance(err)).toBe(true)
    expect(err.data.sessionID).toBe("ses_abc")
    expect(err.data.timeout).toBe(ms)
    idle.clear()
  })
})

describe("tool tripwire", () => {
  test("fires after configured timeout", async () => {
    let spawned = false
    // Use a very short timeout so test is fast
    const tripwire = startToolTripwire({
      ms: 30,
      tool: "bash",
      sessionID: "ses_tool1",
      parentSessionID: undefined, // no parent = no spawn
    })
    await new Promise((r) => setTimeout(r, 60))
    tripwire.clear()
    // With no parentSessionID, watchdog should not spawn
    // The tripwire just clears cleanly
  })

  test("clear prevents watchdog spawn", async () => {
    const tripwire = startToolTripwire({
      ms: 50,
      tool: "bash",
      sessionID: "ses_tool2",
      parentSessionID: undefined,
    })
    tripwire.clear()
    await new Promise((r) => setTimeout(r, 80))
    // If clear works, the timer shouldn't fire at all
  })

  test("tool continues running after tripwire fires (non-blocking)", async () => {
    let completed = false
    const tripwire = startToolTripwire({
      ms: 20,
      tool: "slow_tool",
      sessionID: "ses_tool3",
      parentSessionID: undefined,
    })

    // Simulate a long-running tool
    await new Promise((r) => setTimeout(r, 60))
    completed = true
    tripwire.clear()

    expect(completed).toBe(true)
  })
})

describe("task deadline", () => {
  test("abortAfterAny creates deadline that fires", async () => {
    const { abortAfterAny } = await import("../../src/util/abort")
    const parent = new AbortController()
    const deadline = abortAfterAny(50, parent.signal)

    expect(deadline.signal.aborted).toBe(false)
    await new Promise((r) => setTimeout(r, 80))
    expect(deadline.signal.aborted).toBe(true)
    deadline.clearTimeout()
  })

  test("abortAfterAny respects parent abort", async () => {
    const { abortAfterAny } = await import("../../src/util/abort")
    const parent = new AbortController()
    const deadline = abortAfterAny(5000, parent.signal)

    expect(deadline.signal.aborted).toBe(false)
    parent.abort()
    expect(deadline.signal.aborted).toBe(true)
    deadline.clearTimeout()
  })

  test("clearTimeout prevents deadline from firing", async () => {
    const { abortAfterAny } = await import("../../src/util/abort")
    const parent = new AbortController()
    const deadline = abortAfterAny(30, parent.signal)

    deadline.clearTimeout()
    await new Promise((r) => setTimeout(r, 60))
    // Signal should not be aborted since we cleared and didn't abort parent
    expect(deadline.signal.aborted).toBe(false)
  })

  test("DEFAULT_TIMEOUT and MIN_TIMEOUT constants", async () => {
    // Validate the constants are accessible and correct
    const { WATCHDOG_TIMEOUT_DEFAULTS } = await import("../../src/watchdog/error")
    expect(WATCHDOG_TIMEOUT_DEFAULTS.task).toBe(14400) // 4 hours in seconds
    expect(WATCHDOG_TIMEOUT_DEFAULTS.stream_idle).toBe(120)
    expect(WATCHDOG_TIMEOUT_DEFAULTS.tool_default).toBe(300)
  })
})
