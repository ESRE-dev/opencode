import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test"
import fc from "fast-check"
import { Database } from "../../src/storage/db"
import { SessionTable, MessageTable, PartTable } from "../../src/session/session.sql"
import { ProjectTable } from "../../src/project/project.sql"
import { resetDatabase } from "../fixture/db"
import type { SessionID, MessageID, PartID } from "../../src/session/schema"
import type { ProjectID } from "../../src/project/schema"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Config } from "../../src/config/config"
import { Provider } from "../../src/provider/provider"
import { diagnostics } from "../../src/watchdog/error"

const PROJECT = "proj_test" as ProjectID
const STUCK = "session_stuck_001" as SessionID
const PARENT = "session_parent_001" as SessionID
const TOPLEVEL = "session_toplevel_001" as SessionID
const MSG = "msg_001" as MessageID
const PART1 = "part_001" as PartID
const PART2 = "part_002" as PartID
const PART3 = "part_003" as PartID

function seed() {
  const now = Date.now()
  Database.use((db) => {
    db.insert(ProjectTable)
      .values({
        id: PROJECT,
        worktree: "/tmp/test",
        time_created: now,
        time_updated: now,
        sandboxes: [],
      })
      .run()

    db.insert(SessionTable)
      .values({
        id: PARENT,
        project_id: PROJECT,
        slug: "parent",
        directory: "/tmp/test",
        title: "Parent Session",
        version: "0.0.0-test",
        time_created: now,
        time_updated: now,
      })
      .run()

    db.insert(SessionTable)
      .values({
        id: STUCK,
        project_id: PROJECT,
        parent_id: PARENT,
        slug: "stuck",
        directory: "/tmp/test",
        title: "Stuck Session",
        version: "0.0.0-test",
        time_created: now,
        time_updated: now,
      })
      .run()

    db.insert(SessionTable)
      .values({
        id: TOPLEVEL,
        project_id: PROJECT,
        slug: "toplevel",
        directory: "/tmp/test",
        title: "Top Level Session",
        version: "0.0.0-test",
        time_created: now,
        time_updated: now,
      })
      .run()

    db.insert(MessageTable)
      .values({
        id: MSG,
        session_id: STUCK,
        time_created: now - 60000,
        time_updated: now - 60000,
        data: {
          role: "assistant",
          format: "text",
          time: { created: now - 60000, completed: now - 59000 },
          finish: "stop",
        } as any,
      })
      .run()

    db.insert(PartTable)
      .values({
        id: PART1,
        message_id: MSG,
        session_id: STUCK,
        time_created: now - 50000,
        time_updated: now - 50000,
        data: { type: "text", text: "hello" } as any,
      })
      .run()

    db.insert(PartTable)
      .values({
        id: PART2,
        message_id: MSG,
        session_id: STUCK,
        time_created: now - 30000,
        time_updated: now - 30000,
        data: {
          type: "tool",
          tool: "bash",
          input: { command: "sleep 999" },
          state: { status: "running", time: { start: now - 30000 } },
        } as any,
      })
      .run()

    db.insert(PartTable)
      .values({
        id: PART3,
        message_id: MSG,
        session_id: STUCK,
        time_created: now - 20000,
        time_updated: now - 20000,
        data: { type: "step-start" } as any,
      })
      .run()
  })
}

describe("buildSystemPrompt", () => {
  beforeEach(async () => {
    await resetDatabase()
    seed()
  })

  test("contains stuck session ID", async () => {
    const { buildSystemPrompt } = await import("../../src/watchdog/prompt")
    const prompt = await buildSystemPrompt({
      stuckSessionID: STUCK,
      parentSessionID: PARENT,
      trigger: { tool: "bash", timeout: 120, elapsed: 180 },
    })
    expect(prompt).toContain(STUCK)
  })

  test("contains parent session ID", async () => {
    const { buildSystemPrompt } = await import("../../src/watchdog/prompt")
    const prompt = await buildSystemPrompt({
      stuckSessionID: STUCK,
      parentSessionID: PARENT,
      trigger: { tool: "bash", timeout: 120, elapsed: 180 },
    })
    expect(prompt).toContain(PARENT)
  })

  test("contains trigger info", async () => {
    const { buildSystemPrompt } = await import("../../src/watchdog/prompt")
    const prompt = await buildSystemPrompt({
      stuckSessionID: STUCK,
      parentSessionID: PARENT,
      trigger: { tool: "bash", timeout: 120, elapsed: 180 },
    })
    expect(prompt).toContain("bash")
    expect(prompt).toContain("120")
    expect(prompt).toContain("180")
  })

  test("contains DB snapshot with latest assistant message", async () => {
    const { buildSystemPrompt } = await import("../../src/watchdog/prompt")
    const prompt = await buildSystemPrompt({
      stuckSessionID: STUCK,
      parentSessionID: PARENT,
      trigger: { tool: "bash", timeout: 120, elapsed: 180 },
    })
    expect(prompt).toContain("Latest Assistant Message")
    expect(prompt).toContain(MSG)
  })

  test("contains latest parts", async () => {
    const { buildSystemPrompt } = await import("../../src/watchdog/prompt")
    const prompt = await buildSystemPrompt({
      stuckSessionID: STUCK,
      parentSessionID: PARENT,
      trigger: { tool: "bash", timeout: 120, elapsed: 180 },
    })
    expect(prompt).toContain("Latest 10 Parts")
    expect(prompt).toContain(PART1)
    expect(prompt).toContain(PART2)
    expect(prompt).toContain(PART3)
  })

  test("contains session tree", async () => {
    const { buildSystemPrompt } = await import("../../src/watchdog/prompt")
    const prompt = await buildSystemPrompt({
      stuckSessionID: STUCK,
      parentSessionID: PARENT,
      trigger: { tool: "bash", timeout: 120, elapsed: 180 },
    })
    expect(prompt).toContain("Session Tree")
    expect(prompt).toContain(STUCK)
  })

  test("contains activity signal inventory", async () => {
    const { buildSystemPrompt } = await import("../../src/watchdog/prompt")
    const prompt = await buildSystemPrompt({
      stuckSessionID: STUCK,
      parentSessionID: PARENT,
      trigger: { tool: "bash", timeout: 120, elapsed: 180 },
    })
    expect(prompt).toContain("Activity Signal Inventory")
    expect(prompt).toContain("MAX(time_created)")
  })

  test("contains available actions", async () => {
    const { buildSystemPrompt } = await import("../../src/watchdog/prompt")
    const prompt = await buildSystemPrompt({
      stuckSessionID: STUCK,
      parentSessionID: PARENT,
      trigger: { tool: "bash", timeout: 120, elapsed: 180 },
    })
    expect(prompt).toContain("watchdog_query")
    expect(prompt).toContain("watchdog_activity")
    expect(prompt).toContain("watchdog_cancel")
    expect(prompt).toContain("watchdog_reprompt")
  })

  test("contains decision criteria", async () => {
    const { buildSystemPrompt } = await import("../../src/watchdog/prompt")
    const prompt = await buildSystemPrompt({
      stuckSessionID: STUCK,
      parentSessionID: PARENT,
      trigger: { tool: "bash", timeout: 120, elapsed: 180 },
    })
    expect(prompt).toContain("Decision Criteria")
  })

  test("contains strict scoping warning", async () => {
    const { buildSystemPrompt } = await import("../../src/watchdog/prompt")
    const prompt = await buildSystemPrompt({
      stuckSessionID: STUCK,
      parentSessionID: PARENT,
      trigger: { tool: "bash", timeout: 120, elapsed: 180 },
    })
    expect(prompt).toContain(`You may ONLY act on session ${STUCK}`)
  })

  test("contains classification priority order", async () => {
    const { buildSystemPrompt } = await import("../../src/watchdog/prompt")
    const prompt = await buildSystemPrompt({
      stuckSessionID: STUCK,
      parentSessionID: PARENT,
      trigger: { tool: "bash", timeout: 120, elapsed: 180 },
    })
    expect(prompt).toContain("Classification Priority Order")
  })

  test("works with stream trigger type", async () => {
    const { buildSystemPrompt } = await import("../../src/watchdog/prompt")
    const prompt = await buildSystemPrompt({
      stuckSessionID: STUCK,
      parentSessionID: PARENT,
      trigger: { tool: "stream", timeout: 120, elapsed: 150 },
    })
    expect(prompt).toContain("stream")
    expect(prompt).toContain(STUCK)
    expect(prompt).toContain(PARENT)
  })

  test("works with undefined parentSessionID", async () => {
    const { buildSystemPrompt } = await import("../../src/watchdog/prompt")
    const prompt = await buildSystemPrompt({
      stuckSessionID: STUCK,
      parentSessionID: undefined,
      trigger: { tool: "bash", timeout: 120, elapsed: 180 },
    })
    expect(prompt).toContain(STUCK)
    expect(prompt).toContain("unknown")
  })

  test("prompt contains all required fields for arbitrary inputs (Property 1)", async () => {
    const { buildSystemPrompt } = await import("../../src/watchdog/prompt")
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 50 }),
        fc.integer({ min: 1, max: 86400 }),
        async (tool, timeout) => {
          const prompt = await buildSystemPrompt({
            stuckSessionID: STUCK,
            parentSessionID: PARENT,
            trigger: { tool, timeout, elapsed: timeout + 10 },
          })
          expect(prompt).toContain(STUCK)
          expect(prompt).toContain(PARENT)
          expect(prompt).toContain(tool)
          expect(prompt).toContain(String(timeout))
          expect(prompt).toContain("watchdog_query")
          expect(prompt).toContain("watchdog_cancel")
          expect(prompt).toContain("ONLY act on session")
        },
      ),
      { numRuns: 50 },
    )
  })
})

describe("spawnWatchdog — no parent (Property 11)", () => {
  test("returns none for arbitrary inputs without parentSessionID", async () => {
    const { spawnWatchdog } = await import("../../src/watchdog/spawn")
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 30 }),
        fc.integer({ min: 1, max: 86400 }),
        fc.integer({ min: 1, max: 86400 }),
        async (tool, timeout, elapsed) => {
          const result = await spawnWatchdog({
            stuckSessionID: `session_${tool}` as SessionID,
            parentSessionID: undefined,
            trigger: { tool, timeout, elapsed },
          })
          expect(result.action).toBe("none")
          expect(result.diagnostic).toContain("No parent session")
        },
      ),
      { numRuns: 20 },
    )
  })
})

describe("spawnWatchdog — WATCHDOG_MODELS lookup table", () => {
  test("has entries for anthropic, openai, google", async () => {
    const { WATCHDOG_MODELS } = await import("../../src/watchdog/spawn")
    expect(WATCHDOG_MODELS.anthropic).toBe("claude-haiku-4-5")
    expect(WATCHDOG_MODELS.openai).toBe("gpt-4o-mini")
    expect(WATCHDOG_MODELS.google).toBe("gemini-1.5-flash")
  })
})

describe("raceSignal", () => {
  test("returns signal that aborts when first input aborts", async () => {
    const { raceSignal } = await import("../../src/util/abort")
    const a = new AbortController()
    const b = new AbortController()
    const combined = raceSignal(a.signal, b.signal)
    expect(combined.aborted).toBe(false)
    a.abort()
    expect(combined.aborted).toBe(true)
  })

  test("returns signal that aborts when second input aborts", async () => {
    const { raceSignal } = await import("../../src/util/abort")
    const a = new AbortController()
    const b = new AbortController()
    const combined = raceSignal(a.signal, b.signal)
    b.abort()
    expect(combined.aborted).toBe(true)
  })

  test("inherits aborted state from already-aborted input", async () => {
    const { raceSignal } = await import("../../src/util/abort")
    const a = new AbortController()
    a.abort()
    const b = new AbortController()
    const combined = raceSignal(a.signal, b.signal)
    expect(combined.aborted).toBe(true)
  })
})

describe("abortAfterAny utility (tests abortAfterAny, not spawnWatchdog timeout)", () => {
  test("signal aborts after arbitrary short durations", async () => {
    const { abortAfterAny } = await import("../../src/util/abort")
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 10, max: 100 }), async (ms) => {
        const result = abortAfterAny(ms)
        expect(result.signal.aborted).toBe(false)
        await new Promise((r) => setTimeout(r, ms + 50))
        expect(result.signal.aborted).toBe(true)
      }),
      { numRuns: 10 },
    )
  })

  test("clearTimeout prevents abort", async () => {
    const { abortAfterAny } = await import("../../src/util/abort")
    const result = abortAfterAny(50)
    result.clearTimeout()
    await new Promise((r) => setTimeout(r, 100))
    expect(result.signal.aborted).toBe(false)
  })
})

describe("spawnWatchdog — happy path and error handling (F4)", () => {
  const CHILD = "session_child_001" as SessionID

  beforeEach(async () => {
    mock.restore()
    diagnostics.delete(STUCK)
    await resetDatabase()
    seed()
  })

  function stubModel() {
    spyOn(Config, "get").mockResolvedValue({ experimental: {} } as any)
    spyOn(Provider, "defaultModel").mockResolvedValue({
      providerID: "anthropic" as any,
      modelID: "claude-sonnet-4-5" as any,
    })
  }

  test("happy path — prompt completes, returns none when no diagnostic", async () => {
    const { spawnWatchdog } = await import("../../src/watchdog/spawn")
    stubModel()
    spyOn(Session, "create").mockResolvedValue({ id: CHILD } as any)
    spyOn(SessionPrompt, "prompt").mockResolvedValue(undefined as any)
    const cancel = spyOn(SessionPrompt, "cancel").mockResolvedValue()

    const result = await spawnWatchdog({
      stuckSessionID: STUCK,
      parentSessionID: PARENT,
      trigger: { tool: "bash", timeout: 120, elapsed: 180 },
    })

    expect(result.action).toBe("none")
    expect(result.diagnostic).toContain("healthy or recovered")
    expect(result.sessionID).toBe(CHILD)
    expect(cancel).not.toHaveBeenCalled()
  })

  test("happy path — returns diagnostic when watchdog stored a report", async () => {
    const { spawnWatchdog } = await import("../../src/watchdog/spawn")
    stubModel()
    spyOn(Session, "create").mockResolvedValue({ id: CHILD } as any)
    spyOn(SessionPrompt, "prompt").mockImplementation(async () => {
      diagnostics.set(STUCK, "tool bash stuck for 300s — cancelled")
      return undefined as any
    })
    spyOn(SessionPrompt, "cancel").mockResolvedValue()

    const result = await spawnWatchdog({
      stuckSessionID: STUCK,
      parentSessionID: PARENT,
      trigger: { tool: "bash", timeout: 120, elapsed: 180 },
    })

    expect(result.action).toBe("cancelled")
    expect(result.diagnostic).toContain("tool bash stuck")
    expect(result.sessionID).toBe(CHILD)
  })

  test("error path — prompt throws, cancels stuck session", async () => {
    const { spawnWatchdog } = await import("../../src/watchdog/spawn")
    stubModel()
    spyOn(Session, "create").mockResolvedValue({ id: CHILD } as any)
    spyOn(SessionPrompt, "prompt").mockRejectedValue(new Error("LLM connection failed"))
    const cancel = spyOn(SessionPrompt, "cancel").mockResolvedValue()

    const result = await spawnWatchdog({
      stuckSessionID: STUCK,
      parentSessionID: PARENT,
      trigger: { tool: "bash", timeout: 120, elapsed: 180 },
    })

    expect(result.action).toBe("cancelled")
    expect(result.diagnostic).toContain("LLM connection failed")
    expect(cancel).toHaveBeenCalledWith(STUCK)
  })

  test("timeout path — deadline fires, cancels both watchdog and stuck session (Property 9)", async () => {
    const { spawnWatchdog } = await import("../../src/watchdog/spawn")
    stubModel()
    spyOn(Session, "create").mockResolvedValue({ id: CHILD } as any)
    // Prompt hangs until cancel is called on its session, then rejects
    let rejectPrompt: (err: Error) => void
    spyOn(SessionPrompt, "prompt").mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectPrompt = reject
        }),
    )
    const cancel = spyOn(SessionPrompt, "cancel").mockImplementation(async (id) => {
      // When the watchdog's own session is cancelled, reject the hanging prompt
      if (id === CHILD) rejectPrompt(new Error("cancelled"))
    })

    // Use injectable hardTimeout to fire after 50ms
    const result = await spawnWatchdog({
      stuckSessionID: STUCK,
      parentSessionID: PARENT,
      trigger: { tool: "bash", timeout: 120, elapsed: 180 },
      hardTimeout: 50,
    })

    expect(result.action).toBe("cancelled")
    expect(result.diagnostic).toContain("Watchdog timed out")
    // onTimeout should cancel both watchdog child and stuck session
    expect(cancel).toHaveBeenCalledWith(CHILD)
    expect(cancel).toHaveBeenCalledWith(STUCK)
  })
})
