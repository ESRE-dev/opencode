import { Effect, Layer } from "effect"
import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Instance } from "../../src/project/instance"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Permission } from "../../src/permission"
import { SkillTool } from "../../src/tool/skill"
import { description, SkillDescription } from "../../src/tool/skill"
import { ToolRegistry } from "../../src/tool"
import { SessionID, MessageID } from "../../src/session/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import type { Tool } from "../../src/tool"

afterEach(async () => {
  await Instance.disposeAll()
})

const node = CrossSpawnSpawner.defaultLayer

const it = testEffect(Layer.mergeAll(ToolRegistry.defaultLayer, SystemPrompt.defaultLayer, Skill.defaultLayer, node))

const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

// --- Skill Classification with real SKILL.md files ---

describe("Skill.classify with real skills", () => {
  it.live("alwaysApply skill classifies as auto with any file list", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".opencode", "skill", "always-on", "SKILL.md"),
              `---
name: always-on
description: Always applies.
alwaysApply: true
---

# Always On
`,
            ),
          )
          const home = process.env.OPENCODE_TEST_HOME
          process.env.OPENCODE_TEST_HOME = dir
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              process.env.OPENCODE_TEST_HOME = home
            }),
          )
          const svc = yield* Skill.Service
          const skills = yield* svc.all()
          const skill = skills.find((s) => s.name === "always-on")
          expect(skill).toBeDefined()
          expect(Skill.classify(skill!, [])).toBe("auto")
          expect(Skill.classify(skill!, ["random.txt"])).toBe("auto")
        }),
      { git: true },
    ),
  )

  it.live("glob skill classifies as auto when files match", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".opencode", "skill", "python", "SKILL.md"),
              `---
name: python
description: Python skill.
globs:
  - "**/*.py"
  - pyproject.toml
---

# Python
`,
            ),
          )
          const home = process.env.OPENCODE_TEST_HOME
          process.env.OPENCODE_TEST_HOME = dir
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              process.env.OPENCODE_TEST_HOME = home
            }),
          )
          const svc = yield* Skill.Service
          const skills = yield* svc.all()
          const skill = skills.find((s) => s.name === "python")
          expect(skill).toBeDefined()
          expect(Skill.classify(skill!, ["pyproject.toml"])).toBe("auto")
          expect(Skill.classify(skill!, ["src/main.py"])).toBe("auto")
          expect(Skill.classify(skill!, ["README.md"])).toBe("on-demand")
          expect(Skill.classify(skill!, [])).toBe("on-demand")
        }),
      { git: true },
    ),
  )

  it.live("on-demand skill with no globs classifies as on-demand", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".opencode", "skill", "manual", "SKILL.md"),
              `---
name: manual
description: Manual only.
---

# Manual
`,
            ),
          )
          const home = process.env.OPENCODE_TEST_HOME
          process.env.OPENCODE_TEST_HOME = dir
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              process.env.OPENCODE_TEST_HOME = home
            }),
          )
          const svc = yield* Skill.Service
          const skills = yield* svc.all()
          const skill = skills.find((s) => s.name === "manual")
          expect(skill).toBeDefined()
          expect(Skill.classify(skill!, ["anything.ts", "pyproject.toml"])).toBe("on-demand")
        }),
      { git: true },
    ),
  )
})

// --- System Prompt Filtering ---

describe("SystemPrompt.skills filtering", () => {
  it.live("excludes skills in the exclude set", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          for (const [name, desc] of [
            ["alpha", "Alpha skill."],
            ["beta", "Beta skill."],
            ["gamma", "Gamma skill."],
          ]) {
            yield* Effect.promise(() =>
              Bun.write(
                path.join(dir, ".opencode", "skill", name, "SKILL.md"),
                `---
name: ${name}
description: ${desc}
---

# ${name}
`,
              ),
            )
          }
          const home = process.env.OPENCODE_TEST_HOME
          process.env.OPENCODE_TEST_HOME = dir
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              process.env.OPENCODE_TEST_HOME = home
            }),
          )
          const svc = yield* SystemPrompt.Service
          const exclude = new Set(["alpha", "gamma"])
          const result = yield* svc.skills(agent, exclude)
          expect(result).toBeDefined()
          expect(result).not.toContain("<name>alpha</name>")
          expect(result).not.toContain("<name>gamma</name>")
          expect(result).toContain("<name>beta</name>")
        }),
      { git: true },
    ),
  )

  it.live("returns undefined when all skills are excluded", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".opencode", "skill", "only", "SKILL.md"),
              `---
name: only
description: The only skill.
---

# Only
`,
            ),
          )
          const home = process.env.OPENCODE_TEST_HOME
          process.env.OPENCODE_TEST_HOME = dir
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              process.env.OPENCODE_TEST_HOME = home
            }),
          )
          const svc = yield* SystemPrompt.Service
          const exclude = new Set(["only"])
          const result = yield* svc.skills(agent, exclude)
          expect(result).toBeUndefined()
        }),
      { git: true },
    ),
  )

  it.live("preserves on-demand skills when exclude is empty", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".opencode", "skill", "kept", "SKILL.md"),
              `---
name: kept
description: Kept skill.
---

# Kept
`,
            ),
          )
          const home = process.env.OPENCODE_TEST_HOME
          process.env.OPENCODE_TEST_HOME = dir
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              process.env.OPENCODE_TEST_HOME = home
            }),
          )
          const svc = yield* SystemPrompt.Service
          const result = yield* svc.skills(agent, new Set())
          expect(result).toBeDefined()
          expect(result).toContain("<name>kept</name>")
        }),
      { git: true },
    ),
  )

  it.live("returns same result with no exclude as with undefined exclude", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".opencode", "skill", "stable", "SKILL.md"),
              `---
name: stable
description: Stable skill.
---

# Stable
`,
            ),
          )
          const home = process.env.OPENCODE_TEST_HOME
          process.env.OPENCODE_TEST_HOME = dir
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              process.env.OPENCODE_TEST_HOME = home
            }),
          )
          const svc = yield* SystemPrompt.Service
          const without = yield* svc.skills(agent)
          const empty = yield* svc.skills(agent, new Set())
          expect(without).toBe(empty)
        }),
      { git: true },
    ),
  )
})

// --- Skill Tool Idempotency ---

describe("skill tool idempotency", () => {
  it.live("returns already-loaded message when skill is in loadedSkills", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".opencode", "skill", "cached", "SKILL.md"),
              `---
name: cached
description: A cached skill.
---

# Cached
`,
            ),
          )
          const home = process.env.OPENCODE_TEST_HOME
          process.env.OPENCODE_TEST_HOME = dir
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              process.env.OPENCODE_TEST_HOME = home
            }),
          )
          const registry = yield* ToolRegistry.Service
          const tool = (yield* registry.tools({
            providerID: "opencode" as any,
            modelID: "gpt-5" as any,
            agent,
          })).find((t) => t.id === SkillTool.id)
          if (!tool) throw new Error("Skill tool not found")

          const loaded = new Set(["cached"])
          const ctx: Tool.Context = {
            ...baseCtx,
            extra: { loadedSkills: loaded },
            ask: () => Effect.void,
          }

          const result = yield* tool.execute({ name: "cached" }, ctx)
          expect(result.output).toContain('Skill "cached" is already loaded')
          expect(result.title).toBe("Skill: cached")
        }),
      { git: true },
    ),
  )

  it.live("loads normally when skill is not in loadedSkills and adds to set", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".opencode", "skill", "fresh", "SKILL.md"),
              `---
name: fresh
description: A fresh skill.
---

# Fresh Skill

Instructions here.
`,
            ),
          )
          const home = process.env.OPENCODE_TEST_HOME
          process.env.OPENCODE_TEST_HOME = dir
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              process.env.OPENCODE_TEST_HOME = home
            }),
          )
          const registry = yield* ToolRegistry.Service
          const tool = (yield* registry.tools({
            providerID: "opencode" as any,
            modelID: "gpt-5" as any,
            agent,
          })).find((t) => t.id === SkillTool.id)
          if (!tool) throw new Error("Skill tool not found")

          const loaded = new Set<string>()
          const ctx: Tool.Context = {
            ...baseCtx,
            extra: { loadedSkills: loaded },
            ask: () => Effect.void,
          }

          const result = yield* tool.execute({ name: "fresh" }, ctx)
          expect(result.output).toContain('<skill_content name="fresh">')
          expect(result.output).toContain("Instructions here.")
          expect(loaded.has("fresh")).toBe(true)
        }),
      { git: true },
    ),
  )

  it.live("idempotency: second call returns already-loaded", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".opencode", "skill", "twice", "SKILL.md"),
              `---
name: twice
description: Load me twice.
---

# Twice
`,
            ),
          )
          const home = process.env.OPENCODE_TEST_HOME
          process.env.OPENCODE_TEST_HOME = dir
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              process.env.OPENCODE_TEST_HOME = home
            }),
          )
          const registry = yield* ToolRegistry.Service
          const tool = (yield* registry.tools({
            providerID: "opencode" as any,
            modelID: "gpt-5" as any,
            agent,
          })).find((t) => t.id === SkillTool.id)
          if (!tool) throw new Error("Skill tool not found")

          const loaded = new Set<string>()
          const ctx: Tool.Context = {
            ...baseCtx,
            extra: { loadedSkills: loaded },
            ask: () => Effect.void,
          }

          const first = yield* tool.execute({ name: "twice" }, ctx)
          expect(first.output).toContain('<skill_content name="twice">')
          expect(loaded.has("twice")).toBe(true)

          const second = yield* tool.execute({ name: "twice" }, ctx)
          expect(second.output).toContain('Skill "twice" is already loaded')
        }),
      { git: true },
    ),
  )
})

// --- Skill Tool Description Filtering ---

describe("skill tool description filtering", () => {
  it.live("description(exclude) omits excluded skills", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          for (const [name, desc] of [
            ["inc", "Included skill."],
            ["exc", "Excluded skill."],
          ]) {
            yield* Effect.promise(() =>
              Bun.write(
                path.join(dir, ".opencode", "skill", name, "SKILL.md"),
                `---
name: ${name}
description: ${desc}
---

# ${name}
`,
              ),
            )
          }
          const home = process.env.OPENCODE_TEST_HOME
          process.env.OPENCODE_TEST_HOME = dir
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              process.env.OPENCODE_TEST_HOME = home
            }),
          )
          const exclude = new Set(["exc"])
          const desc = description(exclude)
          const result = yield* desc(agent)
          expect(result).toContain("**inc**: Included skill.")
          expect(result).not.toContain("**exc**: Excluded skill.")
        }),
      { git: true },
    ),
  )

  it.live("description() with no exclude lists all skills", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          for (const name of ["one", "two"]) {
            yield* Effect.promise(() =>
              Bun.write(
                path.join(dir, ".opencode", "skill", name, "SKILL.md"),
                `---
name: ${name}
description: Skill ${name}.
---

# ${name}
`,
              ),
            )
          }
          const home = process.env.OPENCODE_TEST_HOME
          process.env.OPENCODE_TEST_HOME = dir
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              process.env.OPENCODE_TEST_HOME = home
            }),
          )
          const desc = description()
          const result = yield* desc(agent)
          expect(result).toContain("**one**: Skill one.")
          expect(result).toContain("**two**: Skill two.")
        }),
      { git: true },
    ),
  )

  it.live("description(exclude) returns no-skills message when all excluded", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".opencode", "skill", "solo", "SKILL.md"),
              `---
name: solo
description: Solo skill.
---

# Solo
`,
            ),
          )
          const home = process.env.OPENCODE_TEST_HOME
          process.env.OPENCODE_TEST_HOME = dir
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              process.env.OPENCODE_TEST_HOME = home
            }),
          )
          const exclude = new Set(["solo"])
          const desc = description(exclude)
          const result = yield* desc(agent)
          expect(result).toBe("No skills are currently available.")
        }),
      { git: true },
    ),
  )

  it.live("SkillDescription matches description() with no exclude", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".opencode", "skill", "compare", "SKILL.md"),
              `---
name: compare
description: Compare skill.
---

# Compare
`,
            ),
          )
          const home = process.env.OPENCODE_TEST_HOME
          process.env.OPENCODE_TEST_HOME = dir
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              process.env.OPENCODE_TEST_HOME = home
            }),
          )
          const a = yield* SkillDescription(agent)
          const b = yield* description()(agent)
          expect(a).toBe(b)
        }),
      { git: true },
    ),
  )
})

// --- Property 4: No Double Loading ---

describe("Property 4: No Double Loading", () => {
  it.live("idempotency guard returns already-loaded when skill is in loadedSkills set", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".opencode", "skill", "guard", "SKILL.md"),
              `---
name: guard
description: Guard test.
---

# Guard
`,
            ),
          )
          const home = process.env.OPENCODE_TEST_HOME
          process.env.OPENCODE_TEST_HOME = dir
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              process.env.OPENCODE_TEST_HOME = home
            }),
          )
          const registry = yield* ToolRegistry.Service
          const tool = (yield* registry.tools({
            providerID: "opencode" as any,
            modelID: "gpt-5" as any,
            agent,
          })).find((t) => t.id === SkillTool.id)
          if (!tool) throw new Error("Skill tool not found")

          const loaded = new Set(["guard"])
          const ctx: Tool.Context = {
            ...baseCtx,
            extra: { loadedSkills: loaded },
            ask: () => Effect.void,
          }

          const result = yield* tool.execute({ name: "guard" }, ctx)
          expect(result.output).toContain('Skill "guard" is already loaded')
          expect(loaded.size).toBe(1)
        }),
      { git: true },
    ),
  )

  it.live("calling guard twice with same name does not add it twice", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".opencode", "skill", "dup", "SKILL.md"),
              `---
name: dup
description: Dup test.
---

# Dup
`,
            ),
          )
          const home = process.env.OPENCODE_TEST_HOME
          process.env.OPENCODE_TEST_HOME = dir
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              process.env.OPENCODE_TEST_HOME = home
            }),
          )
          const registry = yield* ToolRegistry.Service
          const tool = (yield* registry.tools({
            providerID: "opencode" as any,
            modelID: "gpt-5" as any,
            agent,
          })).find((t) => t.id === SkillTool.id)
          if (!tool) throw new Error("Skill tool not found")

          const loaded = new Set<string>()
          const ctx: Tool.Context = {
            ...baseCtx,
            extra: { loadedSkills: loaded },
            ask: () => Effect.void,
          }

          yield* tool.execute({ name: "dup" }, ctx)
          expect(loaded.size).toBe(1)
          expect(loaded.has("dup")).toBe(true)

          const second = yield* tool.execute({ name: "dup" }, ctx)
          expect(second.output).toContain('Skill "dup" is already loaded')
          expect(loaded.size).toBe(1)
        }),
      { git: true },
    ),
  )
})

// --- Property 5: Available Skills Exclusion ---

describe("Property 5: Available Skills Exclusion", () => {
  it.live("for N random skill names added to exclude set, none appear in output (100 iterations)", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const names = ["aaa", "bbb", "ccc", "ddd", "eee"]
          for (const name of names) {
            yield* Effect.promise(() =>
              Bun.write(
                path.join(dir, ".opencode", "skill", name, "SKILL.md"),
                `---
name: ${name}
description: Skill ${name}.
---

# ${name}
`,
              ),
            )
          }
          const home = process.env.OPENCODE_TEST_HOME
          process.env.OPENCODE_TEST_HOME = dir
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              process.env.OPENCODE_TEST_HOME = home
            }),
          )
          const svc = yield* SystemPrompt.Service
          for (let i = 0; i < 100; i++) {
            const count = Math.floor(Math.random() * names.length) + 1
            const shuffled = [...names].sort(() => Math.random() - 0.5)
            const excluded = new Set(shuffled.slice(0, count))
            const result = yield* svc.skills(agent, excluded)
            for (const name of excluded) {
              if (result) {
                expect(result).not.toContain(`<name>${name}</name>`)
              }
            }
          }
        }),
      { git: true },
    ),
  )
})

// --- Property 7: Post-Compaction Equivalence ---

describe("Property 7: Post-Compaction Equivalence", () => {
  test("re-classifying skills against union matches fresh classification", () => {
    const skills = [
      Skill.Info.parse({
        name: "always",
        description: "test",
        location: "/tmp/a",
        content: "",
        alwaysApply: true,
      }),
      Skill.Info.parse({
        name: "ts-skill",
        description: "test",
        location: "/tmp/b",
        content: "",
        alwaysApply: false,
        globs: ["**/*.ts"],
      }),
      Skill.Info.parse({
        name: "py-skill",
        description: "test",
        location: "/tmp/c",
        content: "",
        alwaysApply: false,
        globs: ["**/*.py"],
      }),
      Skill.Info.parse({
        name: "manual",
        description: "test",
        location: "/tmp/d",
        content: "",
        alwaysApply: false,
        globs: [],
      }),
    ]

    const files = ["src/index.ts", "lib/util.ts"]
    const touched = ["scripts/deploy.py", "config.yaml"]
    const union = [...new Set([...files, ...touched])]

    const postCompaction = skills.filter((s) => Skill.classify(s, union) === "auto")
    const fresh = skills.filter((s) => Skill.classify(s, union) === "auto")

    expect(postCompaction.map((s) => s.name).sort()).toEqual(fresh.map((s) => s.name).sort())
  })

  test("post-compaction equivalence holds for random file sets (100 iterations)", () => {
    const chars = "abcdefghijklmnopqrstuvwxyz"
    const exts = [".ts", ".py", ".rs", ".go", ".rb"]

    for (let i = 0; i < 100; i++) {
      const skill = Skill.Info.parse({
        name: "glob-skill",
        description: "test",
        location: "/tmp/x",
        content: "",
        alwaysApply: false,
        globs: ["**/*.ts"],
      })

      const files: string[] = []
      const touched: string[] = []
      for (let j = 0; j < 5; j++) {
        const name = chars[Math.floor(Math.random() * chars.length)]
        files.push(`src/${name}${exts[Math.floor(Math.random() * exts.length)]}`)
      }
      for (let j = 0; j < 3; j++) {
        const name = chars[Math.floor(Math.random() * chars.length)]
        touched.push(`lib/${name}${exts[Math.floor(Math.random() * exts.length)]}`)
      }

      const union = [...new Set([...files, ...touched])]
      const a = Skill.classify(skill, union)
      const b = Skill.classify(skill, union)
      expect(a).toBe(b)
    }
  })
})

// --- Property 9: Injection Format Equivalence ---

describe("Property 9: Injection Format Equivalence", () => {
  it.live("skill tool output contains <skill_content> block format", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".opencode", "skill", "fmt", "SKILL.md"),
              `---
name: fmt
description: Format test.
---

# Format Skill

Some instructions.
`,
            ),
          )
          const home = process.env.OPENCODE_TEST_HOME
          process.env.OPENCODE_TEST_HOME = dir
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              process.env.OPENCODE_TEST_HOME = home
            }),
          )
          const registry = yield* ToolRegistry.Service
          const tool = (yield* registry.tools({
            providerID: "opencode" as any,
            modelID: "gpt-5" as any,
            agent,
          })).find((t) => t.id === SkillTool.id)
          if (!tool) throw new Error("Skill tool not found")

          const loaded = new Set<string>()
          const ctx: Tool.Context = {
            ...baseCtx,
            extra: { loadedSkills: loaded },
            ask: () => Effect.void,
          }

          const result = yield* tool.execute({ name: "fmt" }, ctx)
          expect(result.output).toContain('<skill_content name="fmt">')
          expect(result.output).toContain("# Skill: fmt")
          expect(result.output).toContain("Some instructions.")
          expect(result.output).toContain("Base directory for this skill:")
          expect(result.output).toContain("<skill_files>")
          expect(result.output).toContain("</skill_files>")
          expect(result.output).toContain("</skill_content>")
        }),
      { git: true },
    ),
  )
})

// --- Property 10: Permission Gate ---

describe("Property 10: Permission Gate", () => {
  it.live("denied skill is excluded from available list", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await Bun.write(
              path.join(dir, ".opencode", "skill", "blocked", "SKILL.md"),
              `---
name: blocked
description: Blocked skill.
---

# Blocked
`,
            )
            await Bun.write(
              path.join(dir, ".opencode", "skill", "allowed", "SKILL.md"),
              `---
name: allowed
description: Allowed skill.
---

# Allowed
`,
            )
          })
          const home = process.env.OPENCODE_TEST_HOME
          process.env.OPENCODE_TEST_HOME = dir
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              process.env.OPENCODE_TEST_HOME = home
            }),
          )
          const svc = yield* Skill.Service
          const deny: Permission.Ruleset = [{ permission: "skill", action: "deny", pattern: "blocked" }]
          const restricted = { ...agent, permission: deny }
          const available = yield* svc.available(restricted)
          const names = available.map((s) => s.name)
          expect(names).not.toContain("blocked")
          expect(names).toContain("allowed")
        }),
      { git: true },
    ),
  )

  test("Permission.evaluate returns deny for blocked skill", () => {
    const deny: Permission.Ruleset = [{ permission: "skill", action: "deny", pattern: "blocked" }]
    const result = Permission.evaluate("skill", "blocked", deny)
    expect(result.action).toBe("deny")
  })

  test("Permission.evaluate returns allow for non-blocked skill", () => {
    const deny: Permission.Ruleset = [{ permission: "skill", action: "deny", pattern: "blocked" }]
    const result = Permission.evaluate("skill", "allowed", deny)
    expect(result.action).not.toBe("deny")
  })
})

// --- Cross-Session Isolation ---

describe("Cross-Session Isolation", () => {
  it.live("two sessions under one instance do not share loadedSkills state", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await Bun.write(
              path.join(dir, ".opencode", "skill", "always-on", "SKILL.md"),
              `---
name: always-on
description: Always applies.
alwaysApply: true
---

# Always On
`,
            )
            await Bun.write(
              path.join(dir, ".opencode", "skill", "glob-py", "SKILL.md"),
              `---
name: glob-py
description: Python glob skill.
globs:
  - "**/*.py"
---

# Glob Py
`,
            )
          })
          const home = process.env.OPENCODE_TEST_HOME
          process.env.OPENCODE_TEST_HOME = dir
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              process.env.OPENCODE_TEST_HOME = home
            }),
          )
          const registry = yield* ToolRegistry.Service
          const tool = (yield* registry.tools({
            providerID: "opencode" as any,
            modelID: "gpt-5" as any,
            agent,
          })).find((t) => t.id === SkillTool.id)
          if (!tool) throw new Error("Skill tool not found")

          const setA = new Set<string>()
          const setB = new Set<string>()

          const ctxA: Tool.Context = {
            ...baseCtx,
            extra: { loadedSkills: setA },
            ask: () => Effect.void,
          }

          const ctxB: Tool.Context = {
            ...baseCtx,
            extra: { loadedSkills: setB },
            ask: () => Effect.void,
          }

          yield* tool.execute({ name: "always-on" }, ctxA)
          expect(setA.has("always-on")).toBe(true)
          expect(setB.size).toBe(0)

          yield* tool.execute({ name: "always-on" }, ctxB)
          expect(setB.has("always-on")).toBe(true)
          expect(setA.size).toBe(1)
          expect(setB.size).toBe(1)

          yield* tool.execute({ name: "glob-py" }, ctxA)
          expect(setA.has("glob-py")).toBe(true)
          expect(setA.size).toBe(2)
          expect(setB.size).toBe(1)
          expect(setB.has("glob-py")).toBe(false)
        }),
      { git: true },
    ),
  )
})

// --- File-Tool Glob Re-evaluation ---

describe("File-Tool Glob Re-evaluation", () => {
  it.live("glob skill promotes from on-demand to auto when touched file matches", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".opencode", "skill", "docker-skill", "SKILL.md"),
              `---
name: docker-skill
description: Docker skill.
globs:
  - Dockerfile
  - docker-compose.yml
  - "**/*.dockerfile"
---

# Docker Skill
`,
            ),
          )
          const home = process.env.OPENCODE_TEST_HOME
          process.env.OPENCODE_TEST_HOME = dir
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              process.env.OPENCODE_TEST_HOME = home
            }),
          )
          const svc = yield* Skill.Service
          const skills = yield* svc.all()
          const skill = skills.find((s) => s.name === "docker-skill")
          expect(skill).toBeDefined()

          expect(Skill.classify(skill!, ["src/index.ts", "README.md"])).toBe("on-demand")
          expect(Skill.classify(skill!, ["src/index.ts", "README.md", "Dockerfile"])).toBe("auto")
          expect(Skill.classify(skill!, ["docker-compose.yml"])).toBe("auto")
          expect(Skill.classify(skill!, ["src/app.dockerfile"])).toBe("auto")
        }),
      { git: true },
    ),
  )
})
