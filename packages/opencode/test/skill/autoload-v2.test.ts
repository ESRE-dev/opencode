import { describe, test, expect } from "bun:test"
import { Skill } from "../../src/skill"

// Minimal Skill.Info factory. classify() and injectLevel() are pure functions
// that only read the auto-load metadata fields, so a literal object matching
// the Info shape is sufficient and avoids spinning up the Skill layer.
function makeSkill(overrides: Partial<Skill.Info> & Pick<Skill.Info, "name">): Skill.Info {
  return {
    name: overrides.name,
    description: overrides.description ?? "A test skill.",
    location: overrides.location ?? "/skills/test/SKILL.md",
    content: overrides.content ?? "# Body\nfull skill instructions here",
    alwaysApply: overrides.alwaysApply ?? false,
    globs: overrides.globs ?? [],
    triggers: overrides.triggers ?? [],
    markers: overrides.markers ?? [],
    inject: overrides.inject,
  }
}

describe("classify v2", () => {
  test("alwaysApply takes precedence and is auto regardless of other signals", () => {
    const skill = makeSkill({ name: "always", alwaysApply: true })
    expect(Skill.classify(skill, { files: [], text: "" })).toBe("auto")
    expect(Skill.classify(skill, { files: ["unrelated.ts"] })).toBe("auto")
  })

  test("v1 globs still match against files", () => {
    const skill = makeSkill({ name: "go", globs: ["**/*.go"] })
    expect(Skill.classify(skill, { files: ["cmd/main.go"] })).toBe("auto")
    expect(Skill.classify(skill, { files: ["src/index.ts"] })).toBe("on-demand")
  })

  test("triggers match case-insensitively as substrings of text", () => {
    const skill = makeSkill({ name: "rebase", triggers: ["rebase", "AccessDenied"] })
    expect(Skill.classify(skill, { files: [], text: "please REBASE my branch" })).toBe("auto")
    expect(Skill.classify(skill, { files: [], text: "got an accessdenied error" })).toBe("auto")
    expect(Skill.classify(skill, { files: [], text: "nothing relevant here" })).toBe("on-demand")
  })

  test("triggers do nothing when text is absent", () => {
    const skill = makeSkill({ name: "rebase", triggers: ["rebase"] })
    expect(Skill.classify(skill, { files: [] })).toBe("on-demand")
  })

  test("markers match by full path or basename", () => {
    const byBasename = makeSkill({ name: "uv", markers: ["pyproject.toml", "uv.lock"] })
    expect(Skill.classify(byBasename, { files: ["packages/app/pyproject.toml"] })).toBe("auto")
    expect(Skill.classify(byBasename, { files: ["uv.lock"] })).toBe("auto")
    expect(Skill.classify(byBasename, { files: ["packages/app/setup.py"] })).toBe("on-demand")
  })

  test("no signals and no metadata is on-demand", () => {
    const skill = makeSkill({ name: "plain" })
    expect(Skill.classify(skill, { files: ["a.ts", "b.ts"], text: "hello" })).toBe("on-demand")
  })
})

describe("injectLevel", () => {
  test("alwaysApply defaults to full", () => {
    expect(Skill.injectLevel(makeSkill({ name: "a", alwaysApply: true }))).toBe("full")
  })

  test("non-alwaysApply defaults to preamble", () => {
    expect(Skill.injectLevel(makeSkill({ name: "b" }))).toBe("preamble")
  })

  test("explicit inject overrides the alwaysApply-derived default", () => {
    expect(Skill.injectLevel(makeSkill({ name: "c", alwaysApply: true, inject: "preamble" }))).toBe("preamble")
    expect(Skill.injectLevel(makeSkill({ name: "d", alwaysApply: false, inject: "full" }))).toBe("full")
  })
})

// The preamble payload is emitted by session/prompt.ts buildPreamble(), which is
// private to the prompt layer closure. This test pins the format contract the
// design mandates: a stub advertising the skill and the upgrade instruction,
// WITHOUT the skill body or a file listing.
describe("preamble payload shape", () => {
  // Mirror of session/prompt.ts buildPreamble() — kept in lockstep with the
  // design's <skill_preamble> template.
  function buildPreamble(s: Skill.Info) {
    return [
      `<skill_preamble name="${s.name}">`,
      `${s.name}: ${s.description ?? ""}`,
      `This is an availability notice only — the skill tool has NOT been`,
      `called for "${s.name}" and its full instructions are NOT in context.`,
      `Call the skill tool with name "${s.name}" to load them when relevant;`,
      `that call will return the full content (it has not happened yet).`,
      `</skill_preamble>`,
    ].join("\n")
  }

  test("contains name, description, base dir, and upgrade instruction", () => {
    const skill = makeSkill({
      name: "aws-iam-debug",
      description: "Debug AWS IAM access errors.",
      location: "/skills/aws-iam-debug/SKILL.md",
      content: "SECRET_FULL_BODY_MARKER",
    })
    const out = buildPreamble(skill)
    expect(out).toContain(`<skill_preamble name="aws-iam-debug">`)
    expect(out).toContain("aws-iam-debug: Debug AWS IAM access errors.")
    // No path/base-dir in the preamble — it baits models into read()ing the
    // SKILL.md instead of calling the skill tool.
    expect(out).not.toContain("Base directory:")
    expect(out).not.toContain("file://")
    expect(out).toContain("skill tool")
    expect(out).toContain(`name "aws-iam-debug"`)
    // Anti-illusion notice: the model must not believe the skill tool was
    // already called and returned only this stub.
    expect(out).toContain("has NOT been")
    expect(out).toContain("not happened yet")
  })

  test("does NOT contain the skill body or a file listing", () => {
    const skill = makeSkill({
      name: "aws-iam-debug",
      content: "SECRET_FULL_BODY_MARKER",
      location: "/skills/aws-iam-debug/SKILL.md",
    })
    const out = buildPreamble(skill)
    expect(out).not.toContain("SECRET_FULL_BODY_MARKER")
    expect(out).not.toContain("<skill_files>")
    expect(out).not.toContain("<skill_content")
  })
})
