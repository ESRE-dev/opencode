import { Effect } from "effect"
import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Permission } from "../../src/permission"
import { description, SkillDescription } from "../../src/tool/skill"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})

const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }

// --- Skill Classification with real SKILL.md files ---

describe("Skill.classify with real skills", () => {
  test("alwaysApply skill classifies as auto with any file list", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
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
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const skills = await Skill.all()
          const skill = skills.find((s) => s.name === "always-on")
          expect(skill).toBeDefined()
          expect(Skill.classify(skill!, [])).toBe("auto")
          expect(Skill.classify(skill!, ["random.txt"])).toBe("auto")
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("glob skill classifies as auto when files match", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
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
        )
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const skills = await Skill.all()
          const skill = skills.find((s) => s.name === "python")
          expect(skill).toBeDefined()
          expect(Skill.classify(skill!, ["pyproject.toml"])).toBe("auto")
          expect(Skill.classify(skill!, ["src/main.py"])).toBe("auto")
          expect(Skill.classify(skill!, ["README.md"])).toBe("on-demand")
          expect(Skill.classify(skill!, [])).toBe("on-demand")
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("on-demand skill with no globs classifies as on-demand", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, ".opencode", "skill", "manual", "SKILL.md"),
          `---
name: manual
description: Manual only.
---

# Manual
`,
        )
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const skills = await Skill.all()
          const skill = skills.find((s) => s.name === "manual")
          expect(skill).toBeDefined()
          expect(Skill.classify(skill!, ["anything.ts", "pyproject.toml"])).toBe("on-demand")
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })
})

// --- System Prompt Filtering ---

describe("SystemPrompt.skills filtering", () => {
  test("excludes skills in the exclude set", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        for (const [name, desc] of [
          ["alpha", "Alpha skill."],
          ["beta", "Beta skill."],
          ["gamma", "Gamma skill."],
        ]) {
          await Bun.write(
            path.join(dir, ".opencode", "skill", name, "SKILL.md"),
            `---
name: ${name}
description: ${desc}
---

# ${name}
`,
          )
        }
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const exclude = new Set(["alpha", "gamma"])
          const result = await SystemPrompt.skills(agent, exclude)
          expect(result).toBeDefined()
          expect(result).not.toContain("<name>alpha</name>")
          expect(result).not.toContain("<name>gamma</name>")
          expect(result).toContain("<name>beta</name>")
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("returns undefined when all skills are excluded", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, ".opencode", "skill", "only", "SKILL.md"),
          `---
name: only
description: The only skill.
---

# Only
`,
        )
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const exclude = new Set(["only"])
          const result = await SystemPrompt.skills(agent, exclude)
          expect(result).toBeUndefined()
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("preserves on-demand skills when exclude is empty", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, ".opencode", "skill", "kept", "SKILL.md"),
          `---
name: kept
description: Kept skill.
---

# Kept
`,
        )
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const result = await SystemPrompt.skills(agent, new Set())
          expect(result).toBeDefined()
          expect(result).toContain("<name>kept</name>")
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("returns same result with no exclude as with undefined exclude", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, ".opencode", "skill", "stable", "SKILL.md"),
          `---
name: stable
description: Stable skill.
---

# Stable
`,
        )
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const without = await SystemPrompt.skills(agent)
          const empty = await SystemPrompt.skills(agent, new Set())
          expect(without).toBe(empty)
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })
})

// --- Skill Tool Idempotency ---

describe("skill tool idempotency", () => {
  test("returns already-loaded message when skill is in loadedSkills", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, ".opencode", "skill", "cached", "SKILL.md"),
          `---
name: cached
description: A cached skill.
---

# Cached
`,
        )
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { SkillTool } = await import("../../src/tool/skill")
          const tool = await SkillTool.init()
          const loaded = new Set(["cached"])
          const ctx = {
            sessionID: "ses_test" as any,
            messageID: "" as any,
            callID: "",
            agent: "build" as any,
            abort: AbortSignal.any([]),
            messages: [],
            metadata: () => {},
            extra: { loadedSkills: loaded },
            ask: async () => {},
          }

          const result = await tool.execute({ name: "cached" }, ctx as any)
          expect(result.output).toContain('Skill "cached" is already loaded')
          expect(result.title).toBe("Skill: cached")
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("loads normally when skill is not in loadedSkills and adds to set", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, ".opencode", "skill", "fresh", "SKILL.md"),
          `---
name: fresh
description: A fresh skill.
---

# Fresh Skill

Instructions here.
`,
        )
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { SkillTool } = await import("../../src/tool/skill")
          const tool = await SkillTool.init()
          const loaded = new Set<string>()
          const ctx = {
            sessionID: "ses_test" as any,
            messageID: "" as any,
            callID: "",
            agent: "build" as any,
            abort: AbortSignal.any([]),
            messages: [],
            metadata: () => {},
            extra: { loadedSkills: loaded },
            ask: async () => {},
          }

          const result = await tool.execute({ name: "fresh" }, ctx as any)
          expect(result.output).toContain('<skill_content name="fresh">')
          expect(result.output).toContain("Instructions here.")
          expect(loaded.has("fresh")).toBe(true)
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("idempotency: second call returns already-loaded", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, ".opencode", "skill", "twice", "SKILL.md"),
          `---
name: twice
description: Load me twice.
---

# Twice
`,
        )
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { SkillTool } = await import("../../src/tool/skill")
          const tool = await SkillTool.init()
          const loaded = new Set<string>()
          const ctx = {
            sessionID: "ses_test" as any,
            messageID: "" as any,
            callID: "",
            agent: "build" as any,
            abort: AbortSignal.any([]),
            messages: [],
            metadata: () => {},
            extra: { loadedSkills: loaded },
            ask: async () => {},
          }

          const first = await tool.execute({ name: "twice" }, ctx as any)
          expect(first.output).toContain('<skill_content name="twice">')
          expect(loaded.has("twice")).toBe(true)

          const second = await tool.execute({ name: "twice" }, ctx as any)
          expect(second.output).toContain('Skill "twice" is already loaded')
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })
})

// --- Skill Tool Description Filtering ---

describe("skill tool description filtering", () => {
  test("description(exclude) omits excluded skills", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        for (const [name, desc] of [
          ["inc", "Included skill."],
          ["exc", "Excluded skill."],
        ]) {
          await Bun.write(
            path.join(dir, ".opencode", "skill", name, "SKILL.md"),
            `---
name: ${name}
description: ${desc}
---

# ${name}
`,
          )
        }
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const exclude = new Set(["exc"])
          const desc = description(exclude)
          const result = await Effect.runPromise(desc(agent))
          expect(result).toContain("**inc**: Included skill.")
          expect(result).not.toContain("**exc**: Excluded skill.")
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("description() with no exclude lists all skills", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        for (const name of ["one", "two"]) {
          await Bun.write(
            path.join(dir, ".opencode", "skill", name, "SKILL.md"),
            `---
name: ${name}
description: Skill ${name}.
---

# ${name}
`,
          )
        }
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const desc = description()
          const result = await Effect.runPromise(desc(agent))
          expect(result).toContain("**one**: Skill one.")
          expect(result).toContain("**two**: Skill two.")
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("description(exclude) returns no-skills message when all excluded", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, ".opencode", "skill", "solo", "SKILL.md"),
          `---
name: solo
description: Solo skill.
---

# Solo
`,
        )
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const exclude = new Set(["solo"])
          const desc = description(exclude)
          const result = await Effect.runPromise(desc(agent))
          expect(result).toBe("No skills are currently available.")
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("SkillDescription matches description() with no exclude", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, ".opencode", "skill", "compare", "SKILL.md"),
          `---
name: compare
description: Compare skill.
---

# Compare
`,
        )
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const a = await Effect.runPromise(SkillDescription(agent))
          const b = await Effect.runPromise(description()(agent))
          expect(a).toBe(b)
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })
})

// --- Property 4: No Double Loading ---

describe("Property 4: No Double Loading", () => {
  test("idempotency guard returns already-loaded when skill is in loadedSkills set", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, ".opencode", "skill", "guard", "SKILL.md"),
          `---
name: guard
description: Guard test.
---

# Guard
`,
        )
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { SkillTool } = await import("../../src/tool/skill")
          const tool = await SkillTool.init()
          const loaded = new Set(["guard"])
          const ctx = {
            sessionID: "ses_test" as any,
            messageID: "" as any,
            callID: "",
            agent: "build" as any,
            abort: AbortSignal.any([]),
            messages: [],
            metadata: () => {},
            extra: { loadedSkills: loaded },
            ask: async () => {},
          }

          const result = await tool.execute({ name: "guard" }, ctx as any)
          expect(result.output).toContain('Skill "guard" is already loaded')
          // Set should still have exactly one entry
          expect(loaded.size).toBe(1)
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("calling guard twice with same name does not add it twice", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, ".opencode", "skill", "dup", "SKILL.md"),
          `---
name: dup
description: Dup test.
---

# Dup
`,
        )
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { SkillTool } = await import("../../src/tool/skill")
          const tool = await SkillTool.init()
          const loaded = new Set<string>()
          const ctx = {
            sessionID: "ses_test" as any,
            messageID: "" as any,
            callID: "",
            agent: "build" as any,
            abort: AbortSignal.any([]),
            messages: [],
            metadata: () => {},
            extra: { loadedSkills: loaded },
            ask: async () => {},
          }

          await tool.execute({ name: "dup" }, ctx as any)
          expect(loaded.size).toBe(1)
          expect(loaded.has("dup")).toBe(true)

          const second = await tool.execute({ name: "dup" }, ctx as any)
          expect(second.output).toContain('Skill "dup" is already loaded')
          expect(loaded.size).toBe(1)
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })
})

// --- Property 5: Available Skills Exclusion ---

describe("Property 5: Available Skills Exclusion", () => {
  test("for N random skill names added to exclude set, none appear in output (100 iterations)", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const names = ["aaa", "bbb", "ccc", "ddd", "eee"]
        for (const name of names) {
          await Bun.write(
            path.join(dir, ".opencode", "skill", name, "SKILL.md"),
            `---
name: ${name}
description: Skill ${name}.
---

# ${name}
`,
          )
        }
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const names = ["aaa", "bbb", "ccc", "ddd", "eee"]
          for (let i = 0; i < 100; i++) {
            const count = Math.floor(Math.random() * names.length) + 1
            const shuffled = [...names].sort(() => Math.random() - 0.5)
            const excluded = new Set(shuffled.slice(0, count))
            const result = await SystemPrompt.skills(agent, excluded)
            for (const name of excluded) {
              if (result) {
                expect(result).not.toContain(`<name>${name}</name>`)
              }
            }
          }
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })
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

    // Simulate post-compaction: clear loaded, re-classify against union
    const postCompaction = skills.filter((s) => Skill.classify(s, union) === "auto")

    // Fresh classification against same union
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
  test("skill tool output contains <skill_content> block format", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, ".opencode", "skill", "fmt", "SKILL.md"),
          `---
name: fmt
description: Format test.
---

# Format Skill

Some instructions.
`,
        )
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { SkillTool } = await import("../../src/tool/skill")
          const tool = await SkillTool.init()
          const loaded = new Set<string>()
          const ctx = {
            sessionID: "ses_test" as any,
            messageID: "" as any,
            callID: "",
            agent: "build" as any,
            abort: AbortSignal.any([]),
            messages: [],
            metadata: () => {},
            extra: { loadedSkills: loaded },
            ask: async () => {},
          }

          const result = await tool.execute({ name: "fmt" }, ctx as any)
          // Verify structural format matches expected injection format
          expect(result.output).toContain('<skill_content name="fmt">')
          expect(result.output).toContain("# Skill: fmt")
          expect(result.output).toContain("Some instructions.")
          expect(result.output).toContain("Base directory for this skill:")
          expect(result.output).toContain("<skill_files>")
          expect(result.output).toContain("</skill_files>")
          expect(result.output).toContain("</skill_content>")
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })
})

// --- Property 10: Permission Gate ---

describe("Property 10: Permission Gate", () => {
  test("denied skill is excluded from available list", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
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
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const deny: Permission.Ruleset = [{ permission: "skill", action: "deny", pattern: "blocked" }]
          const restricted = { ...agent, permission: deny }
          const available = await Skill.available(restricted)
          const names = available.map((s) => s.name)
          expect(names).not.toContain("blocked")
          expect(names).toContain("allowed")
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

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
  test("two sessions under one instance do not share loadedSkills state", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
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
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { SkillTool } = await import("../../src/tool/skill")
          const tool = await SkillTool.init()

          const setA = new Set<string>()
          const setB = new Set<string>()

          const ctxA = {
            sessionID: "ses_a" as any,
            messageID: "" as any,
            callID: "",
            agent: "build" as any,
            abort: AbortSignal.any([]),
            messages: [],
            metadata: () => {},
            extra: { loadedSkills: setA },
            ask: async () => {},
          }

          const ctxB = {
            sessionID: "ses_b" as any,
            messageID: "" as any,
            callID: "",
            agent: "build" as any,
            abort: AbortSignal.any([]),
            messages: [],
            metadata: () => {},
            extra: { loadedSkills: setB },
            ask: async () => {},
          }

          // Load in session A
          await tool.execute({ name: "always-on" }, ctxA as any)
          expect(setA.has("always-on")).toBe(true)
          expect(setB.size).toBe(0)

          // Load in session B
          await tool.execute({ name: "always-on" }, ctxB as any)
          expect(setB.has("always-on")).toBe(true)
          expect(setA.size).toBe(1)
          expect(setB.size).toBe(1)

          // Load a different skill in session A only
          await tool.execute({ name: "glob-py" }, ctxA as any)
          expect(setA.has("glob-py")).toBe(true)
          expect(setA.size).toBe(2)
          expect(setB.size).toBe(1)
          expect(setB.has("glob-py")).toBe(false)
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })
})

// --- File-Tool Glob Re-evaluation ---

describe("File-Tool Glob Re-evaluation", () => {
  test("glob skill promotes from on-demand to auto when touched file matches", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
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
        )
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const skills = await Skill.all()
          const skill = skills.find((s) => s.name === "docker-skill")
          expect(skill).toBeDefined()

          // No matching files → on-demand
          expect(Skill.classify(skill!, ["src/index.ts", "README.md"])).toBe("on-demand")

          // Dockerfile added → auto
          expect(Skill.classify(skill!, ["src/index.ts", "README.md", "Dockerfile"])).toBe("auto")

          // docker-compose.yml → auto
          expect(Skill.classify(skill!, ["docker-compose.yml"])).toBe("auto")

          // Nested .dockerfile → auto
          expect(Skill.classify(skill!, ["src/app.dockerfile"])).toBe("auto")
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })
})
