import { describe, test, expect } from "bun:test"
import { PermissionNext } from "../../src/permission/next"

// Tests for subagent permission propagation
// Validates that permissions merge correctly across parent -> child session boundaries,
// MCP tools are explicitly allowed, and specificity-based evaluation works in subagent context

describe("subagent permission merge", () => {
  // Simulates the permission array constructed in task.ts for a child session
  function subagent(opts: {
    agent: PermissionNext.Ruleset
    session?: PermissionNext.Ruleset
    mcp?: string[]
    hasTask?: boolean
  }): PermissionNext.Ruleset {
    // Mirrors task.ts Session.create() permission construction
    const rules: PermissionNext.Ruleset = [
      { permission: "todowrite", pattern: "*", action: "deny" },
      { permission: "todoread", pattern: "*", action: "deny" },
    ]
    if (!opts.hasTask) {
      rules.push({ permission: "task", pattern: "*", action: "deny" })
    }
    for (const key of opts.mcp ?? []) {
      rules.push({ permission: key, pattern: "*", action: "allow" })
    }
    return rules
  }

  test("child session denies todowrite and todoread", () => {
    const session = subagent({ agent: [] })
    const merged = PermissionNext.merge([{ permission: "*", pattern: "*", action: "allow" }], session)
    expect(PermissionNext.evaluate("todowrite", "anything", merged).action).toBe("deny")
    expect(PermissionNext.evaluate("todoread", "anything", merged).action).toBe("deny")
  })

  test("child session denies task when agent has no task permission", () => {
    const session = subagent({ agent: [], hasTask: false })
    const merged = PermissionNext.merge([{ permission: "*", pattern: "*", action: "allow" }], session)
    expect(PermissionNext.evaluate("task", "general", merged).action).toBe("deny")
  })

  test("child session allows task when agent has task permission", () => {
    const session = subagent({ agent: [], hasTask: true })
    const merged = PermissionNext.merge([{ permission: "*", pattern: "*", action: "allow" }], session)
    // No task deny rule was added, so agent default allow applies
    expect(PermissionNext.evaluate("task", "general", merged).action).toBe("allow")
  })

  test("MCP tools explicitly allowed in child session", () => {
    const session = subagent({
      agent: [],
      mcp: ["mcp_server_search", "mcp_server_index"],
    })
    const agent: PermissionNext.Ruleset = [{ permission: "*", pattern: "*", action: "deny" }]
    const merged = PermissionNext.merge(agent, session)

    // MCP tools should be allowed despite agent wildcard deny
    // Explicit allow (rank 2) beats wildcard deny (rank 0)
    expect(PermissionNext.evaluate("mcp_server_search", "query", merged).action).toBe("allow")
    expect(PermissionNext.evaluate("mcp_server_index", "file", merged).action).toBe("allow")
  })

  test("MCP tools not disabled when agent has wildcard deny", () => {
    const session = subagent({
      agent: [],
      mcp: ["mcp_server_search"],
    })
    const agent: PermissionNext.Ruleset = [{ permission: "*", pattern: "*", action: "deny" }]
    const merged = PermissionNext.merge(agent, session)

    // disabled() should NOT filter out MCP tools that have explicit allow
    const disabled = PermissionNext.disabled(["bash", "edit", "mcp_server_search"], merged)
    expect(disabled.has("bash")).toBe(true)
    expect(disabled.has("edit")).toBe(true)
    expect(disabled.has("mcp_server_search")).toBe(false)
  })

  test("non-MCP tools remain denied under wildcard deny agent", () => {
    const session = subagent({
      agent: [],
      mcp: ["mcp_server_search"],
    })
    const agent: PermissionNext.Ruleset = [{ permission: "*", pattern: "*", action: "deny" }]
    const merged = PermissionNext.merge(agent, session)

    expect(PermissionNext.evaluate("bash", "ls", merged).action).toBe("deny")
    expect(PermissionNext.evaluate("edit", "foo.ts", merged).action).toBe("deny")
  })
})

describe("subagent permission merge with session overrides", () => {
  test("session deny overrides agent allow (same specificity, later wins)", () => {
    const agent: PermissionNext.Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }]
    const session: PermissionNext.Ruleset = [{ permission: "bash", pattern: "*", action: "deny" }]
    const merged = PermissionNext.merge(agent, session)
    expect(PermissionNext.evaluate("bash", "ls", merged).action).toBe("deny")
  })

  test("session specific allow overrides agent wildcard deny", () => {
    const agent: PermissionNext.Ruleset = [{ permission: "*", pattern: "*", action: "deny" }]
    const session: PermissionNext.Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }]
    const merged = PermissionNext.merge(agent, session)
    // bash (rank 2) beats * (rank 0)
    expect(PermissionNext.evaluate("bash", "ls", merged).action).toBe("allow")
    // edit still denied
    expect(PermissionNext.evaluate("edit", "foo.ts", merged).action).toBe("deny")
  })

  test("three-way merge: defaults + agent + session", () => {
    const defaults: PermissionNext.Ruleset = [{ permission: "*", pattern: "*", action: "ask" }]
    const agent: PermissionNext.Ruleset = [
      { permission: "bash", pattern: "*", action: "allow" },
      { permission: "edit", pattern: "*", action: "allow" },
    ]
    const session: PermissionNext.Ruleset = [{ permission: "bash", pattern: "rm *", action: "deny" }]
    const merged = PermissionNext.merge(defaults, agent, session)

    // bash generally allowed by agent
    expect(PermissionNext.evaluate("bash", "ls", merged).action).toBe("allow")
    // bash rm denied by session (specific pattern wins)
    expect(PermissionNext.evaluate("bash", "rm -rf /", merged).action).toBe("deny")
    // edit allowed by agent
    expect(PermissionNext.evaluate("edit", "foo.ts", merged).action).toBe("allow")
    // unknown tool falls back to defaults ask
    expect(PermissionNext.evaluate("webfetch", "url", merged).action).toBe("ask")
  })

  test("session permission merge at prompt.ts callsite", () => {
    // Simulates the merge at prompt.ts:443:
    // PermissionNext.merge(taskAgent.permission, session.permission ?? [])
    const agent: PermissionNext.Ruleset = [
      { permission: "*", pattern: "*", action: "ask" },
      { permission: "bash", pattern: "*", action: "allow" },
      { permission: "read", pattern: "*", action: "allow" },
      { permission: "glob", pattern: "*", action: "allow" },
      { permission: "grep", pattern: "*", action: "allow" },
    ]
    const session: PermissionNext.Ruleset = [
      { permission: "todowrite", pattern: "*", action: "deny" },
      { permission: "todoread", pattern: "*", action: "deny" },
      { permission: "task", pattern: "*", action: "deny" },
    ]
    const merged = PermissionNext.merge(agent, session)

    // Agent-allowed tools remain allowed
    expect(PermissionNext.evaluate("bash", "ls", merged).action).toBe("allow")
    expect(PermissionNext.evaluate("read", "file.ts", merged).action).toBe("allow")

    // Session-denied tools are denied (explicit > wildcard ask)
    expect(PermissionNext.evaluate("todowrite", "anything", merged).action).toBe("deny")
    expect(PermissionNext.evaluate("todoread", "anything", merged).action).toBe("deny")
    expect(PermissionNext.evaluate("task", "general", merged).action).toBe("deny")

    // Unmentioned tools fall back to agent default ask
    expect(PermissionNext.evaluate("webfetch", "url", merged).action).toBe("ask")
  })
})

describe("subagent disabled() with merged permissions", () => {
  test("disabled tools filtered from merged agent+session ruleset", () => {
    const agent: PermissionNext.Ruleset = [{ permission: "*", pattern: "*", action: "allow" }]
    const session: PermissionNext.Ruleset = [
      { permission: "todowrite", pattern: "*", action: "deny" },
      { permission: "todoread", pattern: "*", action: "deny" },
      { permission: "task", pattern: "*", action: "deny" },
    ]
    const merged = PermissionNext.merge(agent, session)

    const disabled = PermissionNext.disabled(["bash", "edit", "read", "task", "todowrite", "todoread"], merged)

    // Session-denied tools should be disabled
    expect(disabled.has("todowrite")).toBe(true)
    expect(disabled.has("todoread")).toBe(true)
    expect(disabled.has("task")).toBe(true)

    // Agent-allowed tools should NOT be disabled
    expect(disabled.has("bash")).toBe(false)
    expect(disabled.has("edit")).toBe(false)
    expect(disabled.has("read")).toBe(false)
  })

  test("resolveTools uses merged permission (session overrides agent)", () => {
    // Simulates llm.ts resolveTools receiving merged permission
    const agent: PermissionNext.Ruleset = [{ permission: "*", pattern: "*", action: "allow" }]
    const session: PermissionNext.Ruleset = [{ permission: "bash", pattern: "*", action: "deny" }]
    const merged = PermissionNext.merge(agent, session)

    const disabled = PermissionNext.disabled(["bash", "edit", "read"], merged)
    // bash denied by session override
    expect(disabled.has("bash")).toBe(true)
    // edit and read still allowed
    expect(disabled.has("edit")).toBe(false)
    expect(disabled.has("read")).toBe(false)
  })
})

describe("headless mode permission behavior", () => {
  test("evaluate returns ask for unmatched permissions (triggers timeout in headless)", () => {
    // In headless mode, "ask" triggers the timeout auto-approve path
    const ruleset: PermissionNext.Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }]
    // Unmatched permission returns "ask" which in headless mode
    // will auto-approve after OPENCODE_PERMISSION_TIMEOUT
    expect(PermissionNext.evaluate("edit", "foo.ts", ruleset).action).toBe("ask")
  })

  test("deny overrides even in headless context", () => {
    // Explicit deny cannot be auto-approved — this is correct behavior
    const ruleset: PermissionNext.Ruleset = [{ permission: "*", pattern: "*", action: "deny" }]
    expect(PermissionNext.evaluate("bash", "ls", ruleset).action).toBe("deny")
    expect(PermissionNext.evaluate("edit", "foo.ts", ruleset).action).toBe("deny")
  })
})
