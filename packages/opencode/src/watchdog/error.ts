import { NamedError } from "@opencode-ai/core/util/error"
import { Context, Effect, Layer } from "effect"
import z from "zod"

export const StreamIdleError = NamedError.create(
  "StreamIdleError",
  z.object({
    sessionID: z.string(),
    timeout: z.number(),
  }),
)

export const WATCHDOG_TIMEOUT_DEFAULTS = {
  stream_idle: 300,
  task: 14400,
  bash: 120,
  tool_default: 300,
} as const

interface DiagnosticEntry {
  report: string
  created: number
}

export interface DiagnosticStoreInterface {
  readonly set: (id: string, report: string) => void
  readonly get: (id: string) => string | undefined
  readonly delete: (id: string) => void
}

export class DiagnosticStore extends Context.Service<DiagnosticStore, DiagnosticStoreInterface>()(
  "@opencode/DiagnosticStore",
) {}

const EVICTION_AGE = 5 * 60 * 1000

const store = new Map<string, DiagnosticEntry>()

function evict() {
  const cutoff = Date.now() - EVICTION_AGE
  for (const [key, entry] of store) {
    if (entry.created < cutoff) store.delete(key)
  }
}

export const diagnostics = {
  set(id: string, report: string) {
    evict()
    store.set(id, { report, created: Date.now() })
  },
  get(id: string) {
    evict()
    return store.get(id)?.report
  },
  delete(id: string) {
    store.delete(id)
  },
}

export const DiagnosticStoreLive = Layer.effect(
  DiagnosticStore,
  Effect.sync(() =>
    DiagnosticStore.of({
      set: diagnostics.set,
      get: diagnostics.get,
      delete: diagnostics.delete,
    }),
  ),
)
