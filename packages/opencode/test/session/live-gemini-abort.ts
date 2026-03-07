#!/usr/bin/env bun
/**
 * Live integration test: Gemini sub-sub-agent abort propagation
 *
 * This script creates a real session using Gemini 3.1 Pro via github-copilot
 * provider, spawns a sub-agent that uses tools, then cancels the parent
 * to verify abort propagates correctly.
 *
 * Run from packages/opencode/:
 *   bun test/session/live-gemini-abort.ts
 *
 * Requires: github-copilot authentication (will use real LLM calls)
 */

import path from "path"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { SessionPrompt } from "../../src/session/prompt"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { Identifier } from "../../src/id/id"
import { Log } from "../../src/util/log"
import { Database } from "../../src/storage/db"

Log.init({ print: true, dev: true, level: "INFO" })

const TIMEOUT = 60_000

async function main() {
  const dir = path.resolve(import.meta.dir, "../..")
  console.log(`[live-test] Using project dir: ${dir}`)
  console.log(`[live-test] This test uses REAL Gemini 3.1 Pro via github-copilot`)
  console.log()

  await Instance.provide({
    directory: dir,
    fn: async () => {
      // Verify model availability
      let model
      try {
        model = await Provider.getModel("github-copilot", "gemini-3.1-pro-preview")
        console.log(`[live-test] Model found: ${model.providerID}/${model.id}`)
      } catch (e: any) {
        console.error(`[live-test] SKIP: gemini-3.1-pro-preview not available: ${e.message}`)
        return
      }

      // --- Test 1: Sub-agent with bash tools, then cancel ---
      console.log()
      console.log("=== Test 1: Cancel parent while Gemini sub-agent runs bash tools ===")
      console.log()

      const session = await Session.create({})
      const msgID = Identifier.ascending("message")

      const user: MessageV2.User = {
        id: msgID,
        sessionID: session.id,
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model: { providerID: "github-copilot", modelID: "gemini-3.1-pro-preview" },
      }
      await Session.updateMessage(user)

      // Create a subtask that asks Gemini to run several bash commands
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: msgID,
        sessionID: session.id,
        type: "subtask",
        prompt:
          "List the files in the current directory using bash, then show the git status, then show the first 5 lines of package.json. Execute each command separately.",
        description: "live gemini bash test",
        agent: "general",
      } satisfies MessageV2.SubtaskPart)

      console.log(`[live-test] Session: ${session.id}`)
      console.log(`[live-test] Starting prompt loop...`)

      const start = Date.now()
      const done = SessionPrompt.loop({ sessionID: session.id })

      // Wait for Gemini to start processing (should make at least one tool call)
      console.log(`[live-test] Waiting 8s for Gemini to start tools...`)
      await new Promise((r) => setTimeout(r, 8000))

      // Check child session status
      const children = await Session.children(session.id)
      console.log(`[live-test] Child sessions: ${children.length}`)

      for (const child of children) {
        const childMsgs = await Session.messages({ sessionID: child.id })
        const toolParts = childMsgs.flatMap((m) =>
          m.parts.filter((p) => p.type === "tool").map((p) => p as MessageV2.ToolPart),
        )
        console.log(
          `[live-test] Child ${child.id}: ${childMsgs.length} messages, ${toolParts.length} tool parts`,
        )
        for (const tp of toolParts) {
          console.log(`[live-test]   tool=${tp.tool} status=${tp.state.status}`)
        }
      }

      // Cancel the parent
      console.log(`[live-test] Cancelling parent session...`)
      const cancelTime = Date.now()
      SessionPrompt.cancel(session.id)

      // Wait for the loop to finish
      try {
        const result = await Promise.race([
          done,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("HUNG: did not complete within 15s of cancel")), 15_000),
          ),
        ])
        const elapsed = Date.now() - cancelTime
        console.log(`[live-test] Loop resolved ${elapsed}ms after cancel`)
        console.log(`[live-test] Result role: ${result.info.role}`)
      } catch (e: any) {
        const elapsed = Date.now() - cancelTime
        console.error(`[live-test] FAILED: ${e.message} (${elapsed}ms after cancel)`)
      }

      // Check final state of all tool parts
      console.log()
      console.log("=== Final state ===")

      const parentMsgs = await Session.messages({ sessionID: session.id })
      const parentTools = parentMsgs.flatMap((m) =>
        m.parts.filter((p) => p.type === "tool").map((p) => p as MessageV2.ToolPart),
      )
      console.log(`[live-test] Parent tool parts:`)
      for (const tp of parentTools) {
        console.log(`[live-test]   tool=${tp.tool} status=${tp.state.status}`)
        if (tp.state.status === "running") {
          console.error(`[live-test]   *** BUG: tool stuck in running! ***`)
        }
      }

      for (const child of await Session.children(session.id)) {
        const childMsgs = await Session.messages({ sessionID: child.id })
        const toolParts = childMsgs.flatMap((m) =>
          m.parts.filter((p) => p.type === "tool").map((p) => p as MessageV2.ToolPart),
        )
        console.log(`[live-test] Child ${child.id} tool parts:`)
        for (const tp of toolParts) {
          console.log(`[live-test]   tool=${tp.tool} status=${tp.state.status}`)
          if (tp.state.status === "running") {
            console.error(`[live-test]   *** BUG: tool stuck in running! ***`)
          }
        }
      }

      const total = Date.now() - start
      console.log()
      console.log(`[live-test] Total elapsed: ${total}ms`)

      // --- Test 2: Let Gemini run to completion (no cancel) ---
      console.log()
      console.log("=== Test 2: Gemini sub-agent runs to natural completion ===")
      console.log()

      const session2 = await Session.create({})
      const msgID2 = Identifier.ascending("message")

      const user2: MessageV2.User = {
        id: msgID2,
        sessionID: session2.id,
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model: { providerID: "github-copilot", modelID: "gemini-3.1-pro-preview" },
      }
      await Session.updateMessage(user2)

      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: msgID2,
        sessionID: session2.id,
        type: "subtask",
        prompt: "Run 'echo hello world' using bash, then respond with the output.",
        description: "live gemini simple test",
        agent: "general",
      } satisfies MessageV2.SubtaskPart)

      console.log(`[live-test] Session: ${session2.id}`)
      console.log(`[live-test] Starting prompt loop (natural completion)...`)

      const start2 = Date.now()
      try {
        const result2 = await Promise.race([
          SessionPrompt.loop({ sessionID: session2.id }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("HUNG: natural completion took > 45s")), 45_000),
          ),
        ])
        const elapsed2 = Date.now() - start2
        console.log(`[live-test] Completed in ${elapsed2}ms`)
        console.log(`[live-test] Result role: ${result2.info.role}`)

        // Show child's output
        const children2 = await Session.children(session2.id)
        for (const child of children2) {
          const childMsgs = await Session.messages({ sessionID: child.id })
          const toolParts = childMsgs.flatMap((m) =>
            m.parts.filter((p) => p.type === "tool").map((p) => p as MessageV2.ToolPart),
          )
          console.log(`[live-test] Child ${child.id}: ${childMsgs.length} msgs, ${toolParts.length} tools`)
          for (const tp of toolParts) {
            console.log(`[live-test]   tool=${tp.tool} status=${tp.state.status}`)
            if (tp.state.status === "running") {
              console.error(`[live-test]   *** BUG: tool stuck in running! ***`)
            }
          }
        }
      } catch (e: any) {
        console.error(`[live-test] FAILED: ${e.message}`)
      }

      console.log()
      console.log("[live-test] Done.")
    },
  })

  Database.close()
  process.exit(0)
}

const timer = setTimeout(() => {
  console.error(`[live-test] GLOBAL TIMEOUT: ${TIMEOUT}ms exceeded`)
  process.exit(1)
}, TIMEOUT)

main()
  .catch((e) => {
    console.error("[live-test] Fatal:", e)
    process.exit(1)
  })
  .finally(() => clearTimeout(timer))
