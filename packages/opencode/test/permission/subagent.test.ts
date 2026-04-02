import { afterEach, describe, test, expect } from "bun:test"
import { Permission } from "../../src/permission"
import { PermissionID } from "../../src/permission/schema"
import { Instance } from "../../src/project/instance"
import { Flag } from "../../src/flag/flag"
import { tmpdir } from "../fixture/fixture"
import { SessionID } from "../../src/session/schema"

afterEach(async () => {
  await Instance.disposeAll()
})

async function waitForPending(count: number) {
  for (let i = 0; i < 20; i++) {
    const list = await Permission.list()
    if (list.length === count) return list
    await Bun.sleep(0)
  }
  return Permission.list()
}

describe("rejectSession", () => {
  test("rejects all pending requests for a session", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const a = Permission.ask({
          id: PermissionID.make("per_rs_a"),
          sessionID: SessionID.make("session_child"),
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [],
        })

        const b = Permission.ask({
          id: PermissionID.make("per_rs_b"),
          sessionID: SessionID.make("session_child"),
          permission: "edit",
          patterns: ["foo.ts"],
          metadata: {},
          always: [],
          ruleset: [],
        })

        await waitForPending(2)

        const ra = a.catch((e) => e)
        const rb = b.catch((e) => e)

        await Permission.rejectSession(SessionID.make("session_child"))

        expect(await ra).toBeInstanceOf(Permission.RejectedError)
        expect(await rb).toBeInstanceOf(Permission.RejectedError)
        expect(await Permission.list()).toHaveLength(0)
      },
    })
  })

  test("does not reject requests from other sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const a = Permission.ask({
          id: PermissionID.make("per_rs_c"),
          sessionID: SessionID.make("session_child"),
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [],
        })

        const b = Permission.ask({
          id: PermissionID.make("per_rs_d"),
          sessionID: SessionID.make("session_other"),
          permission: "bash",
          patterns: ["pwd"],
          metadata: {},
          always: [],
          ruleset: [],
        })

        await waitForPending(2)

        const ra = a.catch((e) => e)

        await Permission.rejectSession(SessionID.make("session_child"))

        expect(await ra).toBeInstanceOf(Permission.RejectedError)
        // Other session's request should still be pending
        expect(await Permission.list()).toHaveLength(1)
        expect((await Permission.list())[0].sessionID).toBe(SessionID.make("session_other"))

        // Clean up
        await Permission.reply({
          requestID: PermissionID.make("per_rs_d"),
          reply: "reject",
        })
        await b.catch(() => {})
      },
    })
  })

  test("Property 10: reject idempotency — calling twice does not throw", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const a = Permission.ask({
          id: PermissionID.make("per_rs_e"),
          sessionID: SessionID.make("session_idem"),
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [],
        })

        await waitForPending(1)
        const ra = a.catch((e) => e)

        await Permission.rejectSession(SessionID.make("session_idem"))
        expect(await ra).toBeInstanceOf(Permission.RejectedError)

        // Second call should be a no-op, not throw
        await Permission.rejectSession(SessionID.make("session_idem"))
        expect(await Permission.list()).toHaveLength(0)
      },
    })
  })

  test("no-op for non-existent session", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Permission.rejectSession(SessionID.make("session_nonexistent"))
        expect(await Permission.list()).toHaveLength(0)
      },
    })
  })
})

describe("merge", () => {
  test("Property 8: merge superset — result contains all rules from both", () => {
    const parent: Permission.Ruleset = [
      { permission: "bash", pattern: "*", action: "allow" },
      { permission: "edit", pattern: "src/*", action: "deny" },
    ]
    const child: Permission.Ruleset = [
      { permission: "task", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "rm", action: "deny" },
    ]
    const merged = Permission.merge(parent, child)

    // All parent rules present
    for (const rule of parent) {
      expect(merged).toContainEqual(rule)
    }
    // All child rules present
    for (const rule of child) {
      expect(merged).toContainEqual(rule)
    }
    expect(merged).toHaveLength(parent.length + child.length)
  })

  test("merge preserves order: parent rules before child rules", () => {
    const parent: Permission.Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }]
    const child: Permission.Ruleset = [{ permission: "bash", pattern: "*", action: "deny" }]
    const merged = Permission.merge(parent, child)

    expect(merged[0].action).toBe("allow")
    expect(merged[1].action).toBe("deny")
  })
})

describe("timeout", () => {
  test("OPENCODE_PERMISSION_TIMEOUT defaults to 30s", () => {
    expect(Flag.OPENCODE_PERMISSION_TIMEOUT).toBe(30_000)
  })

  test("timer is cleaned up when user replies before timeout", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const id = PermissionID.make("per_timeout_cleanup")
        const result = Permission.ask({
          id,
          sessionID: SessionID.make("session_timeout"),
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [],
        })

        await waitForPending(1)

        // Reply before timeout fires
        await Permission.reply({ requestID: id, reply: "once" })
        await result

        // After reply, the request should be removed from pending
        expect(await Permission.list()).toHaveLength(0)
      },
    })
  })
})
