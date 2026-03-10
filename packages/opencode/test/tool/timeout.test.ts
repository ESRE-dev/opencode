import { describe, expect, test } from "bun:test"
import { timeout } from "../../src/tool/tool"

/**
 * Tests for the tool timeout computation extracted from Tool.define.
 *
 * The `timeout()` function computes the effective deadline for a tool
 * execution based on tool ID, args, and config values.
 */

describe("tool.timeout", () => {
  const DEFAULT = 15 * 60 * 1000 // 900_000ms = 15 min
  const GRACE = 60_000

  // -------------------------------------------------------------------
  // Non-task tools
  // -------------------------------------------------------------------

  test("non-task tool uses hardcoded default when no config", () => {
    expect(timeout({ id: "bash", args: {} })).toBe(DEFAULT)
  })

  test("non-task tool respects tool_timeout config", () => {
    expect(timeout({ id: "bash", args: {}, tool: 300_000 })).toBe(300_000)
  })

  test("non-task tool ignores task_timeout config", () => {
    expect(timeout({ id: "bash", args: {}, task: 1_800_000 })).toBe(DEFAULT)
  })

  test("non-task tool ignores args.timeout", () => {
    expect(timeout({ id: "read", args: { timeout: 1800 } })).toBe(DEFAULT)
  })

  // -------------------------------------------------------------------
  // Task tool — defaults
  // -------------------------------------------------------------------

  test("task tool uses default task timeout + grace", () => {
    // No config: effective = 600_000 (default), +60s grace = 660_000
    // max(900_000, 660_000) = 900_000
    expect(timeout({ id: "task", args: {} })).toBe(DEFAULT)
  })

  test("task tool with no config but args.timeout extends beyond default", () => {
    // args.timeout = 1800s = 1_800_000ms, +60s = 1_860_000
    // max(900_000, 1_860_000) = 1_860_000
    expect(timeout({ id: "task", args: { timeout: 1800 } })).toBe(1_860_000)
  })

  // -------------------------------------------------------------------
  // Task tool — tool_timeout config (C1 scenario)
  // -------------------------------------------------------------------

  test("task tool still gets full default timeout when tool_timeout is lower", () => {
    // C1: user sets tool_timeout=300_000 (5min), no task_timeout
    // effective task = 600_000 (default), +60s = 660_000
    // max(300_000, 660_000) = 660_000
    expect(timeout({ id: "task", args: {}, tool: 300_000 })).toBe(660_000)
  })

  test("task tool uses tool_timeout when it exceeds task effective", () => {
    // tool_timeout=2_000_000, task default=600_000+60_000=660_000
    // max(2_000_000, 660_000) = 2_000_000
    expect(timeout({ id: "task", args: {}, tool: 2_000_000 })).toBe(2_000_000)
  })

  // -------------------------------------------------------------------
  // Task tool — task_timeout config
  // -------------------------------------------------------------------

  test("task tool with task_timeout config + grace", () => {
    // task_timeout=900_000 (15min), +60s = 960_000
    // max(900_000, 960_000) = 960_000
    expect(timeout({ id: "task", args: {}, task: 900_000 })).toBe(960_000)
  })

  test("task tool with both tool_timeout and task_timeout", () => {
    // tool_timeout=300_000, task_timeout=1_200_000, +60s = 1_260_000
    // max(300_000, 1_260_000) = 1_260_000
    expect(timeout({ id: "task", args: {}, tool: 300_000, task: 1_200_000 })).toBe(1_260_000)
  })

  // -------------------------------------------------------------------
  // Task tool — args.timeout overrides config
  // -------------------------------------------------------------------

  test("task tool args.timeout overrides task_timeout config", () => {
    // args.timeout=1800s=1_800_000, +60s=1_860_000
    // task_timeout config=300_000 is ignored when args.timeout present
    // max(900_000, 1_860_000) = 1_860_000
    expect(timeout({ id: "task", args: { timeout: 1800 }, task: 300_000 })).toBe(1_860_000)
  })

  test("task tool args.timeout=0 treated as not a number (falsy)", () => {
    // typeof 0 === "number" is true, so 0*1000=0, +60s=60_000
    // max(900_000, 60_000) = 900_000
    expect(timeout({ id: "task", args: { timeout: 0 } })).toBe(DEFAULT)
  })

  // -------------------------------------------------------------------
  // Error message format (seconds)
  // -------------------------------------------------------------------

  test("error message uses seconds", () => {
    const ms = timeout({ id: "bash", args: {} })
    expect(Math.round(ms / 1000)).toBe(900)
    const msg = `Tool execution exceeded ${Math.round(ms / 1000)}s global timeout`
    expect(msg).toBe("Tool execution exceeded 900s global timeout")
  })

  test("error message for custom timeout uses seconds", () => {
    const ms = timeout({ id: "task", args: { timeout: 1800 } })
    const msg = `Tool execution exceeded ${Math.round(ms / 1000)}s global timeout`
    expect(msg).toBe("Tool execution exceeded 1860s global timeout")
  })
})
