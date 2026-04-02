import { Wildcard } from "@/util"

type Rule = {
  permission: string
  pattern: string
  action: "allow" | "deny" | "ask"
}

function score(value: string): number {
  if (!value.includes("*") && !value.includes("?")) return 2
  if (value !== "*") return 1
  return 0
}

export function rank(rule: { permission: string; pattern: string }): number {
  return score(rule.permission) + score(rule.pattern)
}

export function evaluate(permission: string, pattern: string, ...rulesets: Rule[][]): Rule {
  const rules = rulesets.flat()
  let best: Rule | undefined
  let top = -1
  for (const rule of rules) {
    if (!Wildcard.match(permission, rule.permission)) continue
    if (!Wildcard.match(pattern, rule.pattern)) continue
    const s = rank(rule)
    if (s >= top) {
      best = rule
      top = s
    }
  }
  return best ?? { action: "ask", permission, pattern: "*" }
}
