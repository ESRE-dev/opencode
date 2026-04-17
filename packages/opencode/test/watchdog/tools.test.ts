import { describe, test, expect, beforeEach } from "bun:test"
import { Database, eq, sql } from "../../src/storage/db"
import { SessionTable, MessageTable, PartTable } from "../../src/session/session.sql"
import { ProjectTable } from "../../src/project/project.sql"
import { resetDatabase } from "../fixture/db"
import type { SessionID, MessageID, PartID } from "../../src/session/schema"
import type { ProjectID } from "../../src/project/schema"

const PROJECT = "proj_test" as ProjectID
const STUCK = "session_stuck_001" as SessionID
const PARENT = "session_parent_001" as SessionID
const OTHER = "session_other_999" as SessionID
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

function ctx(stuck: string = STUCK): any {
  return {
    sessionID: "watchdog_ses" as SessionID,
    messageID: "watchdog_msg" as MessageID,
    agent: "watchdog",
    abort: new AbortController().signal,
    extra: { stuckSessionID: stuck },
    messages: [],
    metadata: () => {},
    ask: async () => {},
  }
}

describe("watchdog_query tool", () => {
  beforeEach(async () => {
    await resetDatabase()
    seed()
  })

  test("latest_message returns most recent message", async () => {
    const { WatchdogQueryTool } = await import("../../src/watchdog/tools")
    const def = await WatchdogQueryTool.init()
    const result = await def.execute({ session_id: STUCK, query: "latest_message" }, ctx())
    expect(result.title).toBe("query:latest_message")
    const parsed = JSON.parse(result.output)
    expect(parsed).toBeArray()
    expect(parsed.length).toBe(1)
    expect(parsed[0].id).toBe(MSG)
  })

  test("running_tools returns tool parts in running state", async () => {
    const { WatchdogQueryTool } = await import("../../src/watchdog/tools")
    const def = await WatchdogQueryTool.init()
    const result = await def.execute({ session_id: STUCK, query: "running_tools" }, ctx())
    const parsed = JSON.parse(result.output)
    expect(parsed).toBeArray()
    expect(parsed.length).toBe(1)
    expect(parsed[0].id).toBe(PART2)
  })

  test("latest_parts returns up to 10 parts ordered by time_created desc", async () => {
    const { WatchdogQueryTool } = await import("../../src/watchdog/tools")
    const def = await WatchdogQueryTool.init()
    const result = await def.execute({ session_id: STUCK, query: "latest_parts" }, ctx())
    const parsed = JSON.parse(result.output)
    expect(parsed).toBeArray()
    expect(parsed.length).toBe(3)
    expect(parsed[0].id).toBe(PART3)
  })

  test("session_tree returns parent and child sessions", async () => {
    const { WatchdogQueryTool } = await import("../../src/watchdog/tools")
    const def = await WatchdogQueryTool.init()
    const result = await def.execute({ session_id: STUCK, query: "session_tree" }, ctx())
    const parsed = JSON.parse(result.output)
    expect(parsed).toBeArray()
    const ids = parsed.map((r: { id: string }) => r.id)
    expect(ids).toContain(STUCK)
  })

  test("lifecycle_pairs returns unmatched step-start and running tools", async () => {
    const { WatchdogQueryTool } = await import("../../src/watchdog/tools")
    const def = await WatchdogQueryTool.init()
    const result = await def.execute({ session_id: STUCK, query: "lifecycle_pairs" }, ctx())
    const parsed = JSON.parse(result.output)
    expect(parsed).toBeArray()
    expect(parsed.length).toBe(2)
    const ids = parsed.map((r: { id: string }) => r.id)
    expect(ids).toContain(PART2)
    expect(ids).toContain(PART3)
  })
})

describe("watchdog_activity tool", () => {
  beforeEach(async () => {
    await resetDatabase()
    seed()
  })

  test("returns max_part_created and age_ms", async () => {
    const { WatchdogActivityTool } = await import("../../src/watchdog/tools")
    const def = await WatchdogActivityTool.init()
    const result = await def.execute({ session_id: STUCK }, ctx())
    expect(result.title).toBe("activity")
    const parsed = JSON.parse(result.output)
    expect(parsed.max_part_created).toBeNumber()
    expect(parsed.now).toBeNumber()
    expect(parsed.age_ms).toBeNumber()
    expect(parsed.age_ms).toBeGreaterThan(0)
  })

  test("returns null for session with no parts", async () => {
    const { WatchdogActivityTool } = await import("../../src/watchdog/tools")
    const def = await WatchdogActivityTool.init()
    const result = await def.execute({ session_id: PARENT }, ctx(PARENT))
    const parsed = JSON.parse(result.output)
    expect(parsed.max_part_created).toBeNull()
    expect(parsed.age_ms).toBeNull()
  })
})

describe("watchdog scope isolation (Property 4)", () => {
  beforeEach(async () => {
    await resetDatabase()
    seed()
  })

  test("watchdog_query rejects mismatched session_id", async () => {
    const { WatchdogQueryTool } = await import("../../src/watchdog/tools")
    const def = await WatchdogQueryTool.init()
    await expect(def.execute({ session_id: OTHER, query: "latest_message" }, ctx(STUCK))).rejects.toThrow(
      "Scope violation",
    )
  })

  test("watchdog_activity rejects mismatched session_id", async () => {
    const { WatchdogActivityTool } = await import("../../src/watchdog/tools")
    const def = await WatchdogActivityTool.init()
    await expect(def.execute({ session_id: OTHER }, ctx(STUCK))).rejects.toThrow("Scope violation")
  })

  test("watchdog_cancel rejects mismatched session_id", async () => {
    const { WatchdogCancelTool } = await import("../../src/watchdog/tools")
    const def = await WatchdogCancelTool.init()
    await expect(def.execute({ session_id: OTHER, reason: "test" }, ctx(STUCK))).rejects.toThrow("Scope violation")
  })

  test("watchdog_reprompt rejects mismatched session_id", async () => {
    const { WatchdogRepromptTool } = await import("../../src/watchdog/tools")
    const def = await WatchdogRepromptTool.init()
    await expect(def.execute({ session_id: OTHER, message: "wake up" }, ctx(STUCK))).rejects.toThrow("Scope violation")
  })

  test("tools reject when stuckSessionID is missing from context", async () => {
    const { WatchdogQueryTool } = await import("../../src/watchdog/tools")
    const def = await WatchdogQueryTool.init()
    const bare = { ...ctx(), extra: undefined }
    await expect(def.execute({ session_id: STUCK, query: "latest_message" }, bare)).rejects.toThrow(
      "Watchdog context missing",
    )
  })
})

describe("watchdog_cancel tool", () => {
  beforeEach(async () => {
    await resetDatabase()
    seed()
  })

  test("aborts cancel if session has recent activity within 10s", async () => {
    const now = Date.now()
    Database.use((db) =>
      db
        .insert(PartTable)
        .values({
          id: "part_fresh" as PartID,
          message_id: MSG,
          session_id: STUCK,
          time_created: now - 5000,
          time_updated: now - 5000,
          data: { type: "text", text: "recent" } as any,
        })
        .run(),
    )
    const { WatchdogCancelTool } = await import("../../src/watchdog/tools")
    const def = await WatchdogCancelTool.init()
    const result = await def.execute({ session_id: STUCK, reason: "stuck" }, ctx())
    expect(result.title).toBe("cancel:aborted")
    expect(result.output).toContain("recovered")
  })

  test("calls SessionPrompt.cancel and returns cancel:ok when session is stale", async () => {
    const { WatchdogCancelTool } = await import("../../src/watchdog/tools")
    const { SessionPrompt } = await import("../../src/session/prompt")
    const calls: string[] = []
    const orig = SessionPrompt.cancel
    SessionPrompt.cancel = async (sid: string) => {
      calls.push(sid)
    }
    try {
      const def = await WatchdogCancelTool.init()
      const result = await def.execute({ session_id: STUCK, reason: "diagnostic report" }, ctx())
      expect(result.title).toBe("cancel:ok")
      expect(result.output).toContain(STUCK)
      expect(calls).toContain(STUCK)
    } finally {
      SessionPrompt.cancel = orig
    }
  })
})

describe("watchdog_reprompt recovery detection (Property 7)", () => {
  test("returns recovered:false when no activity advances", async () => {
    await resetDatabase()
    seed()

    // Mock SessionPrompt.prompt to be a no-op (since no real session runner)
    const tools = await import("../../src/watchdog/tools")
    const { SessionPrompt } = await import("../../src/session/prompt")
    const orig = SessionPrompt.prompt
    // @ts-expect-error: override for testing
    SessionPrompt.prompt = async () => ({ id: "msg_mock" as MessageID, info: {}, parts: [] })

    try {
      const def = await tools.WatchdogRepromptTool.init()
      // With very short poll intervals we can test the logic
      // The DB data is static, so max_created never advances between polls
      const result = await def.execute({ session_id: STUCK, message: "nudge" }, ctx())
      const parsed = JSON.parse(result.output)
      expect(parsed.recovered).toBe(false)
      expect(parsed.polls).toBeArray()
      expect(parsed.polls.length).toBe(5)
    } finally {
      SessionPrompt.prompt = orig
    }
  }, 30000)

  test("returns recovered:true when new parts appear during polling", async () => {
    await resetDatabase()
    seed()

    const tools = await import("../../src/watchdog/tools")
    const { SessionPrompt } = await import("../../src/session/prompt")
    const orig = SessionPrompt.prompt
    // @ts-expect-error: override for testing
    SessionPrompt.prompt = async () => {
      // Schedule a new part to appear after 1s so poll 1 sees max > prev
      setTimeout(() => {
        Database.use((db) =>
          db
            .insert(PartTable)
            .values({
              id: "part_recovery" as PartID,
              message_id: MSG,
              session_id: STUCK,
              time_created: Date.now(),
              time_updated: Date.now(),
              data: { type: "text", text: "recovered" } as any,
            })
            .run(),
        )
      }, 1000)
      return { id: "msg_mock" as MessageID, info: {}, parts: [] }
    }

    try {
      const def = await tools.WatchdogRepromptTool.init()
      const result = await def.execute({ session_id: STUCK, message: "nudge" }, ctx())
      expect(result.title).toBe("reprompt:recovered")
      const parsed = JSON.parse(result.output)
      expect(parsed.recovered).toBe(true)
      expect(parsed.polls).toBeArray()
    } finally {
      SessionPrompt.prompt = orig
    }
  }, 30000)
})
