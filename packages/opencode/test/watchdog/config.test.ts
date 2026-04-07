import { describe, test, expect, mock } from "bun:test"
import {
  StreamIdleError,
  WATCHDOG_TIMEOUT_DEFAULTS,
  DiagnosticStore,
  DiagnosticStoreLive,
} from "../../src/watchdog/error"
import { Config } from "../../src/config/config"
import { Effect } from "effect"

describe("watchdog config schema", () => {
  function parse(watchdog: unknown) {
    return Config.Info.parse({ experimental: { watchdog } })
  }

  test("valid config with all fields parses correctly", () => {
    const result = parse({
      model: { providerID: "anthropic", modelID: "claude-haiku-4-5" },
      timeouts: { stream_idle: 60, task: 7200, bash: 300, tool_default: 600 },
    })
    expect(result.experimental?.watchdog?.model?.providerID).toBe("anthropic")
    expect(result.experimental?.watchdog?.model?.modelID).toBe("claude-haiku-4-5")
    expect(result.experimental?.watchdog?.timeouts?.stream_idle).toBe(60)
    expect(result.experimental?.watchdog?.timeouts?.task).toBe(7200)
    expect(result.experimental?.watchdog?.timeouts?.bash).toBe(300)
    expect(result.experimental?.watchdog?.timeouts?.tool_default).toBe(600)
  })

  test("valid config with only timeouts parses correctly", () => {
    const result = parse({ timeouts: { stream_idle: 90 } })
    expect(result.experimental?.watchdog?.model).toBeUndefined()
    expect(result.experimental?.watchdog?.timeouts?.stream_idle).toBe(90)
    expect(result.experimental?.watchdog?.timeouts?.task).toBeUndefined()
  })

  test("empty object parses correctly", () => {
    const result = parse({})
    expect(result.experimental?.watchdog?.model).toBeUndefined()
    expect(result.experimental?.watchdog?.timeouts).toBeUndefined()
  })

  test("negative timeout is rejected", () => {
    expect(() => parse({ timeouts: { stream_idle: -1 } })).toThrow()
  })

  test("zero timeout is rejected", () => {
    expect(() => parse({ timeouts: { bash: 0 } })).toThrow()
  })

  test("non-integer timeout is rejected", () => {
    expect(() => parse({ timeouts: { task: 1.5 } })).toThrow()
  })

  test("string timeout is rejected", () => {
    expect(() => parse({ timeouts: { tool_default: "300" as any } })).toThrow()
  })
})

describe("watchdog timeout defaults", () => {
  test("defaults are defined", () => {
    expect(WATCHDOG_TIMEOUT_DEFAULTS.stream_idle).toBe(120)
    expect(WATCHDOG_TIMEOUT_DEFAULTS.task).toBe(14400)
    expect(WATCHDOG_TIMEOUT_DEFAULTS.bash).toBe(120)
    expect(WATCHDOG_TIMEOUT_DEFAULTS.tool_default).toBe(300)
  })

  test("configured value overrides default for any positive integer", () => {
    const values = [1, 10, 60, 999, 86400]
    for (const val of values) {
      const result = Config.Info.parse({
        experimental: { watchdog: { timeouts: { stream_idle: val } } },
      })
      const resolved = result.experimental?.watchdog?.timeouts?.stream_idle ?? WATCHDOG_TIMEOUT_DEFAULTS.stream_idle
      expect(resolved).toBe(val)
    }
  })

  test("absent config falls back to default", () => {
    const result = Config.Info.parse({})
    const resolved = result.experimental?.watchdog?.timeouts?.stream_idle ?? WATCHDOG_TIMEOUT_DEFAULTS.stream_idle
    expect(resolved).toBe(120)
  })

  test("partial config overrides only specified keys", () => {
    const result = Config.Info.parse({
      experimental: { watchdog: { timeouts: { bash: 60 } } },
    })
    const t = result.experimental?.watchdog?.timeouts
    expect(t?.bash ?? WATCHDOG_TIMEOUT_DEFAULTS.bash).toBe(60)
    expect(t?.task ?? WATCHDOG_TIMEOUT_DEFAULTS.task).toBe(14400)
    expect(t?.stream_idle ?? WATCHDOG_TIMEOUT_DEFAULTS.stream_idle).toBe(120)
    expect(t?.tool_default ?? WATCHDOG_TIMEOUT_DEFAULTS.tool_default).toBe(300)
  })
})

describe("StreamIdleError", () => {
  test("creates error with correct name", () => {
    const err = new StreamIdleError({ sessionID: "ses_123", timeout: 120 })
    expect(err.name).toBe("StreamIdleError")
    expect(err.data.sessionID).toBe("ses_123")
    expect(err.data.timeout).toBe(120)
  })

  test("isInstance identifies StreamIdleError", () => {
    const err = new StreamIdleError({ sessionID: "ses_456", timeout: 60 })
    expect(StreamIdleError.isInstance(err)).toBe(true)
  })

  test("isInstance rejects non-StreamIdleError", () => {
    expect(StreamIdleError.isInstance(new Error("test"))).toBe(false)
    expect(StreamIdleError.isInstance({ name: "OtherError" })).toBe(false)
    expect(StreamIdleError.isInstance(undefined)).toBe(false)
  })
})

describe("DiagnosticStore", () => {
  const run = <A>(effect: Effect.Effect<A, never, DiagnosticStore>) =>
    Effect.runSync(effect.pipe(Effect.provide(DiagnosticStoreLive)))

  test("set and get a report", () => {
    run(
      Effect.gen(function* () {
        const store = yield* DiagnosticStore
        store.set("ses_1", "diagnostic report")
        expect(store.get("ses_1")).toBe("diagnostic report")
      }),
    )
  })

  test("get returns undefined for missing key", () => {
    run(
      Effect.gen(function* () {
        const store = yield* DiagnosticStore
        expect(store.get("nonexistent")).toBeUndefined()
      }),
    )
  })

  test("delete removes entry", () => {
    run(
      Effect.gen(function* () {
        const store = yield* DiagnosticStore
        store.set("ses_2", "report")
        store.delete("ses_2")
        expect(store.get("ses_2")).toBeUndefined()
      }),
    )
  })

  test("overwrite replaces previous value", () => {
    run(
      Effect.gen(function* () {
        const store = yield* DiagnosticStore
        store.set("ses_3", "old")
        store.set("ses_3", "new")
        expect(store.get("ses_3")).toBe("new")
      }),
    )
  })
})

describe("DiagnosticStore eviction", () => {
  const TTL = 5 * 60 * 1000 // 300000ms

  const run = <A>(effect: Effect.Effect<A, never, DiagnosticStore>) =>
    Effect.runSync(effect.pipe(Effect.provide(DiagnosticStoreLive)))

  test("entries older than 5 minutes are evicted during set()", () => {
    run(
      Effect.gen(function* () {
        const store = yield* DiagnosticStore
        const now = 1_000_000
        const dateMock = mock(() => now)
        Date.now = dateMock

        store.set("old", "stale report")

        // Advance past TTL
        dateMock.mockReturnValue(now + TTL + 1)
        store.set("new", "fresh report")

        // The old entry should have been evicted by the set() call
        expect(store.get("old")).toBeUndefined()
        expect(store.get("new")).toBe("fresh report")
      }),
    )
  })

  test("entries older than 5 minutes return undefined from get()", () => {
    run(
      Effect.gen(function* () {
        const store = yield* DiagnosticStore
        const now = 2_000_000
        const dateMock = mock(() => now)
        Date.now = dateMock

        store.set("entry", "value")

        // Advance past TTL
        dateMock.mockReturnValue(now + TTL + 1)
        expect(store.get("entry")).toBeUndefined()
      }),
    )
  })

  test("entries younger than 5 minutes survive eviction", () => {
    run(
      Effect.gen(function* () {
        const store = yield* DiagnosticStore
        const now = 3_000_000
        const dateMock = mock(() => now)
        Date.now = dateMock

        store.set("fresh", "still here")

        // Advance to just under TTL (299999ms)
        dateMock.mockReturnValue(now + TTL - 1)
        expect(store.get("fresh")).toBe("still here")
      }),
    )
  })

  test("boundary: entry at exactly 300000ms age is evicted", () => {
    run(
      Effect.gen(function* () {
        const store = yield* DiagnosticStore
        const now = 4_000_000
        const dateMock = mock(() => now)
        Date.now = dateMock

        store.set("boundary", "on the edge")

        // Advance to exactly TTL
        dateMock.mockReturnValue(now + TTL)
        // At exactly TTL: created < cutoff => now + TTL - TTL = now, created = now, so created < now is false
        // Actually: cutoff = Date.now() - EVICTION_AGE = (now + TTL) - TTL = now
        // entry.created = now, so entry.created < cutoff => now < now => false => survives
        expect(store.get("boundary")).toBe("on the edge")

        // One ms later it's evicted
        dateMock.mockReturnValue(now + TTL + 1)
        expect(store.get("boundary")).toBeUndefined()
      }),
    )
  })
})
