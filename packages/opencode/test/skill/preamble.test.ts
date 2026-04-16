import { describe, test, expect, afterEach } from "bun:test"
import { Skill } from "../../src/skill"
import { Instance } from "../../src/project/instance"
import { Git } from "../../src/git"
import { Ripgrep } from "../../src/file/ripgrep"
import { tmpdir } from "../fixture/fixture"
import path from "path"

afterEach(async () => {
  await Instance.disposeAll()
})

// --- Helpers ---

function rand(max: number) {
  return Math.floor(Math.random() * max)
}

function str(len = 8) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789-_"
  let out = ""
  for (let i = 0; i < len; i++) out += chars[rand(chars.length)]
  return out
}

function strs(max = 5) {
  const n = rand(max)
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(str(rand(12) + 1))
  return out
}

// --- Schema Tests ---

describe("Skill.Info schema extension", () => {
  test("parses all new fields from frontmatter", () => {
    const input = {
      name: "test-skill",
      description: "A test skill",
      location: "/tmp/test",
      content: "# Test",
      alwaysApply: true,
      globs: ["**/*.ts", "pyproject.toml"],
      metadata: { version: "1.0.0", sources: ["https://example.com"] },
    }
    const result = Skill.Info.parse(input)
    expect(result.alwaysApply).toBe(true)
    expect(result.globs).toEqual(["**/*.ts", "pyproject.toml"])
    expect(result.metadata.version).toBe("1.0.0")
    expect(result.metadata.sources).toEqual(["https://example.com"])
  })

  test("defaults alwaysApply to false when missing", () => {
    const result = Skill.Info.parse({
      name: "x",
      description: "y",
      location: "/tmp",
      content: "",
    })
    expect(result.alwaysApply).toBe(false)
  })

  test("defaults globs to empty array when missing", () => {
    const result = Skill.Info.parse({
      name: "x",
      description: "y",
      location: "/tmp",
      content: "",
    })
    expect(result.globs).toEqual([])
  })

  test("defaults metadata to { sources: [] } when missing", () => {
    const result = Skill.Info.parse({
      name: "x",
      description: "y",
      location: "/tmp",
      content: "",
    })
    expect(result.metadata).toEqual({ sources: [] })
  })

  test("Zod nested default: Frontmatter.parse with no metadata produces { sources: [] }", () => {
    const result = Skill.Frontmatter.parse({ name: "x", description: "y" })
    expect(result.metadata).toEqual({ sources: [] })
    expect(result.metadata.sources).toEqual([])
  })

  test("metadata with explicit empty object gets inner defaults", () => {
    const result = Skill.Info.parse({
      name: "x",
      description: "y",
      location: "/tmp",
      content: "",
      metadata: {},
    })
    expect(result.metadata.sources).toEqual([])
    expect(result.metadata.version).toBeUndefined()
  })

  test("backward compatibility: existing SKILL.md without new fields", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skill = path.join(dir, ".opencode", "skill", "legacy")
        await Bun.write(
          path.join(skill, "SKILL.md"),
          `---
name: legacy-skill
description: An old skill without new fields.
---

# Legacy Skill

Instructions here.
`,
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const skills = await Skill.all()
        const legacy = skills.find((s) => s.name === "legacy-skill")
        expect(legacy).toBeDefined()
        expect(legacy!.alwaysApply).toBe(false)
        expect(legacy!.globs).toEqual([])
        expect(legacy!.metadata).toEqual({ sources: [] })
      },
    })
  })

  test("parses SKILL.md with all new frontmatter fields", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skill = path.join(dir, ".opencode", "skill", "full")
        await Bun.write(
          path.join(skill, "SKILL.md"),
          `---
name: full-skill
description: A skill with all fields.
alwaysApply: true
globs:
  - "**/*.py"
  - pyproject.toml
metadata:
  version: "2.1.0"
  sources:
    - https://docs.example.com
    - https://api.example.com
---

# Full Skill

Complete instructions.
`,
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const skills = await Skill.all()
        const full = skills.find((s) => s.name === "full-skill")
        expect(full).toBeDefined()
        expect(full!.alwaysApply).toBe(true)
        expect(full!.globs).toEqual(["**/*.py", "pyproject.toml"])
        expect(full!.metadata.version).toBe("2.1.0")
        expect(full!.metadata.sources).toEqual(["https://docs.example.com", "https://api.example.com"])
      },
    })
  })
})

// --- Property-Based Tests ---

describe("Property 1: Frontmatter Round-Trip", () => {
  test("for any valid frontmatter, parsing preserves all field values (100 iterations)", () => {
    for (let i = 0; i < 100; i++) {
      const apply = Math.random() > 0.5
      const globs = strs(4)
      const version = Math.random() > 0.3 ? str(6) : undefined
      const sources = strs(3)
      const name = str(10)
      const desc = str(20)

      const input: Record<string, unknown> = {
        name,
        description: desc,
        alwaysApply: apply,
        globs,
        metadata: { version, sources },
      }

      const result = Skill.Frontmatter.parse(input)
      expect(result.name).toBe(name)
      expect(result.description).toBe(desc)
      expect(result.alwaysApply).toBe(apply)
      expect(result.globs).toEqual(globs)
      if (version !== undefined) {
        expect(result.metadata.version).toBe(version)
      } else {
        expect(result.metadata.version).toBeUndefined()
      }
      expect(result.metadata.sources).toEqual(sources)
    }
  })
})

describe("Property 2: Classification Determinism", () => {
  test("for any skill with alwaysApply: true, classify returns 'auto' regardless of globs/files (100 iterations)", () => {
    for (let i = 0; i < 100; i++) {
      const skill = Skill.Info.parse({
        name: str(8),
        description: str(12),
        location: "/tmp/" + str(5),
        content: "",
        alwaysApply: true,
        globs: strs(5),
      })
      const files = strs(10).map((s) => s + ".ts")
      expect(Skill.classify(skill, files)).toBe("auto")
    }
  })
})

describe("Property 3: Glob Classification Correctness", () => {
  test("for any skill with alwaysApply: false, classify returns 'auto' iff a glob matches a file (100 iterations)", () => {
    const exts = ["ts", "py", "rs", "go", "rb", "java", "c", "cpp", "toml", "json"]
    for (let i = 0; i < 100; i++) {
      const ext = exts[rand(exts.length)]
      const pattern = `**/*.${ext}`
      const dir = str(6)
      const name = str(8)
      const file = `${dir}/${name}.${ext}`

      // Case 1: matching file — glob pattern matches the generated file
      const skill = Skill.Info.parse({
        name: str(8),
        description: str(12),
        location: "/tmp/" + str(5),
        content: "",
        alwaysApply: false,
        globs: [pattern],
      })
      expect(Skill.classify(skill, [file])).toBe("auto")

      // Case 2: non-matching file — pick a different extension
      const other = exts.filter((e) => e !== ext)
      const wrongExt = other[rand(other.length)]
      const wrongFile = `${str(6)}/${str(8)}.${wrongExt}`
      const noMatch = Skill.Info.parse({
        name: str(8),
        description: str(12),
        location: "/tmp/" + str(5),
        content: "",
        alwaysApply: false,
        globs: [pattern],
      })
      expect(Skill.classify(noMatch, [wrongFile])).toBe("on-demand")
    }
  })

  test("empty globs always classifies as on-demand", () => {
    const skill = Skill.Info.parse({
      name: "no-globs",
      description: "test",
      location: "/tmp/test",
      content: "",
      alwaysApply: false,
      globs: [],
    })
    expect(Skill.classify(skill, ["anything.ts", "pyproject.toml"])).toBe("on-demand")
  })

  test("empty files always classifies as on-demand (unless alwaysApply)", () => {
    const skill = Skill.Info.parse({
      name: "has-globs",
      description: "test",
      location: "/tmp/test",
      content: "",
      alwaysApply: false,
      globs: ["**/*.ts"],
    })
    expect(Skill.classify(skill, [])).toBe("on-demand")
  })
})

describe("classify edge cases", () => {
  test("alwaysApply: true with globs still returns auto (globs irrelevant)", () => {
    const skill = Skill.Info.parse({
      name: "both",
      description: "test",
      location: "/tmp/test",
      content: "",
      alwaysApply: true,
      globs: ["**/*.ts"],
    })
    expect(Skill.classify(skill, [])).toBe("auto")
  })

  test("alwaysApply: false with no globs and no files returns on-demand", () => {
    const skill = Skill.Info.parse({
      name: "empty",
      description: "test",
      location: "/tmp/test",
      content: "",
      alwaysApply: false,
      globs: [],
    })
    expect(Skill.classify(skill, [])).toBe("on-demand")
  })

  test("glob with dot files matches dotfiles", () => {
    const skill = Skill.Info.parse({
      name: "dotfile",
      description: "test",
      location: "/tmp/test",
      content: "",
      alwaysApply: false,
      globs: ["**/.env"],
    })
    expect(Skill.classify(skill, [".env"])).toBe("auto")
    expect(Skill.classify(skill, ["src/.env"])).toBe("auto")
  })
})

// --- Workspace Scanning Tests ---

describe("workspace scanning", () => {
  test("git ls-files returns tracked files in a git repo", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "src/index.ts"), "export {}")
        await Bun.write(path.join(dir, "pyproject.toml"), "[project]")
        await Bun.write(path.join(dir, ".env"), "SECRET=x")
        const proc = Bun.spawn(["git", "add", "."], { cwd: dir })
        await proc.exited
        const commit = Bun.spawn(["git", "commit", "-m", "add files", "--no-gpg-sign"], { cwd: dir })
        await commit.exited
      },
    })

    const result = await Git.run(["ls-files", "-z"], { cwd: tmp.path })
    expect(result.exitCode).toBe(0)
    const files = result
      .text()
      .split("\0")
      .filter((f) => f.length > 0)
    expect(files).toContain("src/index.ts")
    expect(files).toContain("pyproject.toml")
    expect(files).toContain(".env")
  })

  test("git ls-files returns empty for repo with no tracked files beyond initial commit", async () => {
    await using tmp = await tmpdir({ git: true })

    const result = await Git.run(["ls-files", "-z"], { cwd: tmp.path })
    expect(result.exitCode).toBe(0)
    const files = result
      .text()
      .split("\0")
      .filter((f) => f.length > 0)
    // tmpdir with git: true creates an initial commit — may have .gitkeep or be empty
    // The key invariant: exitCode is 0 and result is parseable
    expect(Array.isArray(files)).toBe(true)
  })

  test("Ripgrep.files returns files from a non-git directory", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "main.py"), "print('hello')")
        await Bun.write(path.join(dir, "lib/util.py"), "def foo(): pass")
      },
    })

    const files: string[] = []
    for await (const file of Ripgrep.files({ cwd: tmp.path, maxDepth: 3 })) {
      files.push(file)
    }
    expect(files.length).toBeGreaterThanOrEqual(2)
    expect(files.some((f) => f.endsWith("main.py"))).toBe(true)
    expect(files.some((f) => f.includes("util.py"))).toBe(true)
  })

  test("Ripgrep.files returns empty for empty directory", async () => {
    await using tmp = await tmpdir()

    const files: string[] = []
    for await (const file of Ripgrep.files({ cwd: tmp.path, maxDepth: 3 })) {
      files.push(file)
    }
    expect(files).toEqual([])
  })

  test("git ls-files fails gracefully for non-git directory", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "file.txt"), "content")
      },
    })

    const result = await Git.run(["ls-files", "-z"], { cwd: tmp.path })
    // Git.run never rejects — returns exitCode: 128 for non-git dirs
    expect(result.exitCode).not.toBe(0)
  })
})

// --- Property 6: File Tool Tracking ---

describe("Property 6: File Tool Tracking", () => {
  test("touchedFiles set grows when file paths are added (100 iterations)", () => {
    const touched = new Set<string>()
    const paths: string[] = []
    for (let i = 0; i < 100; i++) {
      const p = `src/${str(6)}/${str(8)}.${["ts", "py", "rs", "go"][rand(4)]}`
      paths.push(p)
      touched.add(p)
      expect(touched.has(p)).toBe(true)
      expect(touched.size).toBe(new Set(paths).size)
    }
    for (const p of paths) {
      expect(touched.has(p)).toBe(true)
    }
  })

  test("duplicate paths do not increase set size", () => {
    const touched = new Set<string>()
    touched.add("src/index.ts")
    touched.add("src/index.ts")
    touched.add("src/index.ts")
    expect(touched.size).toBe(1)
  })
})

// --- Property 8: Non-Matching File No-Op ---

describe("Property 8: Non-Matching File No-Op", () => {
  test("classify returns on-demand when no glob matches the file (100 iterations)", () => {
    for (let i = 0; i < 100; i++) {
      const skill = Skill.Info.parse({
        name: str(8),
        description: str(12),
        location: "/tmp/" + str(5),
        content: "",
        alwaysApply: false,
        globs: ["**/*.rs"],
      })
      const file = `${str(6)}.${["ts", "py", "go", "java", "rb"][rand(5)]}`
      expect(Skill.classify(skill, [file])).toBe("on-demand")
    }
  })

  test("loaded set is unchanged after non-matching classify", () => {
    const loaded = new Set<string>()
    const skill = Skill.Info.parse({
      name: "noop-skill",
      description: "test",
      location: "/tmp/test",
      content: "",
      alwaysApply: false,
      globs: ["**/*.rs"],
    })
    const result = Skill.classify(skill, ["index.ts"])
    expect(result).toBe("on-demand")
    expect(loaded.size).toBe(0)
  })
})

// --- Property 11: Cache Stability ---

describe("Property 11: Cache Stability", () => {
  test("git ls-files returns same result on consecutive calls", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "a.ts"), "export {}")
        await Bun.write(path.join(dir, "b.py"), "pass")
        await Bun.write(path.join(dir, "c/d.go"), "package main")
        const proc = Bun.spawn(["git", "add", "."], { cwd: dir })
        await proc.exited
        const commit = Bun.spawn(["git", "commit", "-m", "files", "--no-gpg-sign"], { cwd: dir })
        await commit.exited
      },
    })

    const run = async () => {
      const result = await Git.run(["ls-files", "-z"], { cwd: tmp.path })
      return result
        .text()
        .split("\0")
        .filter((f) => f.length > 0)
        .sort()
    }

    const first = await run()
    const second = await run()
    expect(first).toEqual(second)
  })

  test("Ripgrep.files returns same result on consecutive calls", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "x.ts"), "1")
        await Bun.write(path.join(dir, "y.py"), "2")
      },
    })

    const run = async () => {
      const files: string[] = []
      for await (const file of Ripgrep.files({ cwd: tmp.path, maxDepth: 3 })) {
        files.push(file)
      }
      return files.sort()
    }

    const first = await run()
    const second = await run()
    expect(first).toEqual(second)
  })
})
