import { describe, expect, test } from "bun:test"
import { SessionCompaction } from "../../src/session/compaction"
import type { Todo } from "../../src/session/todo"

describe("SessionCompaction.formatTodos", () => {
  test("returns undefined for empty array", () => {
    expect(SessionCompaction.formatTodos([])).toBeUndefined()
  })

  test("formats single todo item", () => {
    const todos: Todo.Info[] = [{ content: "Fix bug", status: "pending", priority: "high" }]
    const result = SessionCompaction.formatTodos(todos)
    expect(result).toContain("## Current Task List")
    expect(result).toContain("- [pending] (high) Fix bug")
  })

  test("formats multiple todo items", () => {
    const todos: Todo.Info[] = [
      { content: "Fix bug", status: "pending", priority: "high" },
      { content: "Write tests", status: "in_progress", priority: "medium" },
      { content: "Deploy", status: "completed", priority: "low" },
    ]
    const result = SessionCompaction.formatTodos(todos)!
    expect(result).toContain("- [pending] (high) Fix bug")
    expect(result).toContain("- [in_progress] (medium) Write tests")
    expect(result).toContain("- [completed] (low) Deploy")
  })

  test("includes survival note in header", () => {
    const todos: Todo.Info[] = [{ content: "task", status: "pending", priority: "low" }]
    const result = SessionCompaction.formatTodos(todos)!
    expect(result).toContain("persist")
    expect(result).toContain("survive compaction")
  })

  test("preserves special characters in todo content", () => {
    const todos: Todo.Info[] = [{ content: 'Fix "quotes" & <tags> in `code`', status: "pending", priority: "high" }]
    const result = SessionCompaction.formatTodos(todos)!
    expect(result).toContain('Fix "quotes" & <tags> in `code`')
  })

  test("entry count matches input array length", () => {
    const todos: Todo.Info[] = [
      { content: "a", status: "pending", priority: "high" },
      { content: "b", status: "in_progress", priority: "medium" },
      { content: "c", status: "completed", priority: "low" },
      { content: "d", status: "pending", priority: "low" },
    ]
    const result = SessionCompaction.formatTodos(todos)!
    const lines = result.split("\n").filter((l: string) => l.startsWith("- ["))
    expect(lines.length).toBe(todos.length)
  })
})
