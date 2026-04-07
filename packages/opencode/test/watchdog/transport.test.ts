import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { childText } from "../../src/tool/task"
import { diagnostics } from "../../src/watchdog/error"
import type { MessageV2 } from "../../src/session/message-v2"

function parts(...texts: string[]): MessageV2.WithParts {
  return {
    info: {
      role: "assistant",
      time: { created: Date.now() },
      modelID: "test/model",
      providerID: "test",
      mode: "default",
      agent: "test",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      parentID: "msg_parent",
    } as any,
    parts: texts.map((t, i) => ({
      type: "text" as const,
      text: t,
      id: `part_${i}`,
      sessionID: "session_transport_001",
      messageID: "msg_test",
    })) as any,
  }
}

function aborted(msg = "aborted"): MessageV2.WithParts {
  return {
    info: {
      role: "assistant",
      time: { created: Date.now() },
      error: { name: "MessageAbortedError", message: msg },
      modelID: "test/model",
      providerID: "test",
      mode: "default",
      agent: "test",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      parentID: "msg_parent",
    } as any,
    parts: [],
  }
}

const SID = "session_transport_001"

afterEach(() => {
  diagnostics.delete(SID)
})

describe("childText() — diagnostic transport", () => {
  test("Path 1: normal completion extracts latest text part", () => {
    const result = childText(SID, { ok: true, value: parts("first", "second") })
    expect(result).toBe("second")
  })

  test("Path 2: empty response returns generic message", () => {
    const empty: MessageV2.WithParts = {
      ...parts(),
      parts: [],
    }
    const result = childText(SID, { ok: true, value: empty })
    expect(result).toBe("Child session returned no content.")
  })

  test("Path 3: error returns error string", () => {
    const err = new Error("connection refused")
    const result = childText(SID, { ok: false, error: err })
    expect(result).toContain("connection refused")
    expect(result).toContain("Child session error")
  })

  test("Path 4: WATCHDOG abort with diagnostic embeds report", () => {
    const report = [
      "## Diagnostic Report",
      "Session stuck for 120s. Tool `bash` running `sleep 999`.",
      "Recommendation: cancel and retry.",
    ].join("\n")
    diagnostics.set(SID, report)
    const result = childText(SID, { ok: true, value: aborted() })
    expect(result).toContain("watchdog")
    expect(result).toContain("Diagnostic Report")
    expect(result).toContain("sleep 999")
    expect(result).toContain("Recommendation: cancel and retry.")
  })

  test("Path 4: diagnostic is cleared from store after reading", () => {
    diagnostics.set(SID, "some report")
    childText(SID, { ok: true, value: aborted() })
    expect(diagnostics.get(SID)).toBeUndefined()
  })

  test("Path 5: WATCHDOG abort without diagnostic returns generic message", () => {
    const result = childText(SID, { ok: true, value: aborted() })
    expect(result).toContain(SID)
    expect(result).toContain("aborted")
  })

  test("non-abort error on assistant message uses normal text extraction", () => {
    const msg = parts("some text")
    ;(msg.info as any).error = { name: "ProviderAuthError", providerID: "x", message: "bad key" }
    const result = childText(SID, { ok: true, value: msg })
    expect(result).toBe("some text")
  })
})

describe("Property 8: Diagnostic-Round-Trip", () => {
  test("diagnostic content preserved through transport chain", () => {
    const reports = [
      "Simple diagnostic",
      "Multi-line\ndiagnostic\nwith details",
      "Report with special chars: <>&\"'",
      "Unicode: 日本語テスト 🔥",
      "Very long " + "x".repeat(10000),
    ]
    for (const report of reports) {
      diagnostics.set(SID, report)
      const result = childText(SID, { ok: true, value: aborted() })
      expect(result).toContain(report)
    }
  })

  test("round-trip: DiagnosticStore.set → cancel → childText → verify", () => {
    const diagnostic = [
      "## Watchdog Diagnostic",
      "",
      "### Stuck Session Analysis",
      "- Session ID: session_child_42",
      "- Duration: 180s",
      "- Running tool: bash (command: `npm install`)",
      "",
      "### Root Cause",
      "Tool appears hung waiting for network response.",
      "",
      "### Recommendation",
      "Cancel and retry with --timeout flag.",
    ].join("\n")

    diagnostics.set(SID, diagnostic)
    const msg = aborted("cancelled by watchdog")
    const result = childText(SID, { ok: true, value: msg })

    expect(result).toContain("Watchdog Diagnostic")
    expect(result).toContain("session_child_42")
    expect(result).toContain("npm install")
    expect(result).toContain("Root Cause")
    expect(result).toContain("Recommendation")
    expect(diagnostics.get(SID)).toBeUndefined()
  })
})
