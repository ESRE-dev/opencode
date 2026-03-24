import { describe, expect, test } from "bun:test"
import { SessionCompaction } from "../../src/session/compaction"

describe("SessionCompaction.formatTodos", () => {
  test("returns undefined for empty array", () => {
    expect(SessionCompaction.formatTodos([])).toBeUndefined()
  })

  test("returns section with header for non-empty list", () => {
    const result = SessionCompaction.formatTodos([{ content: "Fix bug", status: "pending", priority: "high" }])
    expect(result).toContain("## Current Task List")
  })

  test("includes one entry per item", () => {
    const todos = [
      { content: "Fix bug", status: "pending", priority: "high" },
      { content: "Write tests", status: "in_progress", priority: "medium" },
      { content: "Deploy", status: "completed", priority: "low" },
    ]
    const result = SessionCompaction.formatTodos(todos)!
    expect(result).toContain("- [pending] (high) Fix bug")
    expect(result).toContain("- [in_progress] (medium) Write tests")
    expect(result).toContain("- [completed] (low) Deploy")
  })

  test("formats status, priority, and content in markdown", () => {
    const result = SessionCompaction.formatTodos([{ content: "Task A", status: "open", priority: "low" }])!
    expect(result).toContain("- [open] (low) Task A")
  })

  test("entry count matches input length", () => {
    const todos = Array.from({ length: 5 }, (_, i) => ({
      content: `Task ${i}`,
      status: "pending",
      priority: "medium",
    }))
    const result = SessionCompaction.formatTodos(todos)!
    const entries = result.split("\n").filter((line) => line.startsWith("- ["))
    expect(entries).toHaveLength(5)
  })

  test("section starts with double newline for prompt concatenation", () => {
    const result = SessionCompaction.formatTodos([{ content: "Task", status: "pending", priority: "high" }])!
    expect(result.startsWith("\n\n")).toBe(true)
  })

  test("includes persistence note for agent context", () => {
    const result = SessionCompaction.formatTodos([{ content: "Task", status: "pending", priority: "high" }])!
    expect(result).toContain("persisted in the database")
    expect(result).toContain("survive compaction")
  })

  test("no section header in empty result", () => {
    const result = SessionCompaction.formatTodos([])
    expect(result).toBeUndefined()
    // also verify no string contains the header
    expect(result ?? "").not.toContain("## Current Task List")
  })

  test("handles special characters in content", () => {
    const result = SessionCompaction.formatTodos([
      { content: "Fix `code` in **bold** & <html>", status: "pending", priority: "high" },
    ])!
    expect(result).toContain("Fix `code` in **bold** & <html>")
  })
})
