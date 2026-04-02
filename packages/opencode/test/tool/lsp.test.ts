import { describe, expect, test } from "bun:test"
import { abortAfterAny, raceSignal } from "../../src/util/abort"

/**
 * Tests for LSP timeout protection (Req 8).
 *
 * The LSP tool wraps every operation with abortAfterAny(LSP_TIMEOUT, ctx.abort)
 * + raceSignal to enforce a 10s deadline. Since LSP_TIMEOUT is module-private,
 * we verify the constant via source inspection and test the composition pattern
 * that enforces the timeout.
 */
describe("tool.lsp timeout protection", () => {
  test("LSP_TIMEOUT constant is 10_000", async () => {
    const src = await Bun.file(new URL("../../src/tool/lsp.ts", import.meta.url).pathname).text()
    const match = src.match(/^const LSP_TIMEOUT\s*=\s*(\d[\d_]*)/m)
    expect(match).not.toBeNull()
    expect(Number(match![1].replace(/_/g, ""))).toBe(10_000)
  })

  test("LSP operations are wrapped with raceSignal + abortAfterAny", async () => {
    const src = await Bun.file(new URL("../../src/tool/lsp.ts", import.meta.url).pathname).text()
    expect(src).toContain("abortAfterAny(LSP_TIMEOUT, ctx.abort)")
    expect(src).toContain("raceSignal(")
    expect(src).toContain("deadline.signal")
    expect(src).toContain("deadline.clearTimeout()")
  })

  test("raceSignal rejects immediately when signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve("done"), 5000))
    await expect(raceSignal(slow, controller.signal, "timed out")).rejects.toThrow("timed out")
  })

  test("abortAfterAny + raceSignal aborts a slow operation", async () => {
    const deadline = abortAfterAny(50)
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve("done"), 5000))
    try {
      await expect(raceSignal(slow, deadline.signal, "LSP operation timed out after 0.05s")).rejects.toThrow(
        "LSP operation timed out",
      )
    } finally {
      deadline.clearTimeout()
    }
  })

  test("abortAfterAny combines timeout with external abort signal", async () => {
    const external = new AbortController()
    const deadline = abortAfterAny(60_000, external.signal)
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve("done"), 5000))
    // Abort externally before the timeout fires
    setTimeout(() => external.abort(), 30)
    try {
      await expect(raceSignal(slow, deadline.signal, "aborted")).rejects.toThrow("aborted")
    } finally {
      deadline.clearTimeout()
    }
  })

  test("raceSignal resolves when operation completes before timeout", async () => {
    const deadline = abortAfterAny(5000)
    const fast = Promise.resolve("result")
    try {
      const val = await raceSignal(fast, deadline.signal, "timed out")
      expect(val).toBe("result")
    } finally {
      deadline.clearTimeout()
    }
  })

  test("clearTimeout prevents late abort after operation completes", async () => {
    const deadline = abortAfterAny(50)
    const fast = Promise.resolve("ok")
    const val = await raceSignal(fast, deadline.signal, "timed out")
    deadline.clearTimeout()
    expect(val).toBe("ok")
    // Signal should not be aborted since we cleared the timeout
    expect(deadline.signal.aborted).toBe(false)
  })
})
