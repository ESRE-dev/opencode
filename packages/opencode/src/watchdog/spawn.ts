import { SessionPrompt } from "../session/prompt"
import { Session } from "../session"
import { buildSystemPrompt, type SpawnInput } from "./prompt"
import { abortAfterAny } from "../util/abort"
import { diagnostics } from "./error"
import { Config } from "../config"
import { Provider } from "../provider"
import { ModelID, ProviderID } from "../provider/schema"
import type { SessionID } from "../session/schema"

// Lazy import to break circular dependency:
// processor.ts → watchdog/spawn.ts → app-runtime.ts → processor.ts
const getAppRuntime = () => import("../effect/app-runtime").then((m) => m.AppRuntime)

export interface WatchdogResult {
  action: "none" | "reprompted" | "cancelled"
  diagnostic: string
  sessionID: SessionID
}

export const WATCHDOG_MODELS: Record<string, string> = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-4o-mini",
  google: "gemini-1.5-flash",
}

const HARD_TIMEOUT = 60_000

async function resolveModel() {
  const AppRuntime = await getAppRuntime()
  const cfg = await AppRuntime.runPromise(Config.Service.use((svc) => svc.get()))
  const watchdog = cfg.experimental?.watchdog?.model
  if (watchdog) {
    return {
      providerID: ProviderID.make(watchdog.providerID),
      modelID: ModelID.make(watchdog.modelID),
    }
  }
  const fallback = await AppRuntime.runPromise(Provider.Service.use((svc) => svc.defaultModel()))
  const provider = fallback.providerID as string
  const mapped = WATCHDOG_MODELS[provider]
  if (mapped) return { providerID: fallback.providerID, modelID: ModelID.make(mapped) }
  return fallback
}

export async function spawnWatchdog(input: SpawnInput): Promise<WatchdogResult> {
  if (!input.parentSessionID) {
    return {
      action: "none",
      diagnostic: "No parent session — top-level sessions do not spawn watchdogs",
      sessionID: input.stuckSessionID,
    }
  }

  const AppRuntime = await getAppRuntime()
  const child = await AppRuntime.runPromise(
    Session.Service.use((svc) => svc.create({ parentID: input.parentSessionID })),
  )
  const system = await buildSystemPrompt(input)
  const model = await resolveModel()

  const timeout = input.hardTimeout ?? HARD_TIMEOUT
  const deadline = abortAfterAny(timeout)

  const onTimeout = () => {
    AppRuntime.runPromise(SessionPrompt.Service.use((svc) => svc.cancel(child.id))).catch(() => {})
    AppRuntime.runPromise(SessionPrompt.Service.use((svc) => svc.cancel(input.stuckSessionID))).catch(() => {})
  }
  deadline.signal.addEventListener("abort", onTimeout)

  try {
    await AppRuntime.runPromise(
      SessionPrompt.Service.use((svc) =>
        svc.prompt({
          sessionID: child.id,
          agent: "watchdog",
          model,
          system,
          parts: [
            {
              type: "text",
              text: `Investigate stuck session ${input.stuckSessionID}. Trigger: ${input.trigger.tool} exceeded ${input.trigger.timeout}s timeout (elapsed: ${input.trigger.elapsed}s). Use your tools to query the session state, classify the failure mode, and take appropriate action.`,
            },
          ],
        }),
      ),
    )

    deadline.signal.removeEventListener("abort", onTimeout)
    deadline.clearTimeout()

    const report = diagnostics.get(input.stuckSessionID)
    if (report) {
      diagnostics.delete(input.stuckSessionID)
      return { action: "cancelled", diagnostic: report, sessionID: child.id }
    }

    return {
      action: "none",
      diagnostic: "Watchdog completed — session appears healthy or recovered",
      sessionID: child.id,
    }
  } catch (err) {
    deadline.signal.removeEventListener("abort", onTimeout)
    deadline.clearTimeout()

    if (deadline.signal.aborted) {
      try {
        await AppRuntime.runPromise(SessionPrompt.Service.use((svc) => svc.cancel(input.stuckSessionID)))
      } catch {
        // best-effort cancel
      }
      return {
        action: "cancelled",
        diagnostic: `Watchdog timed out after ${timeout / 1000}s. Stuck session cancelled with generic message.`,
        sessionID: child.id,
      }
    }

    try {
      await AppRuntime.runPromise(SessionPrompt.Service.use((svc) => svc.cancel(input.stuckSessionID)))
    } catch {
      // best-effort cancel
    }
    const msg = err instanceof Error ? err.message : String(err)
    return {
      action: "cancelled",
      diagnostic: `Watchdog failed: ${msg}. Stuck session cancelled.`,
      sessionID: child.id,
    }
  }
}
