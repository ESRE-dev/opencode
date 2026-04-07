import { Database, eq, sql, desc, and } from "../storage/db"
import { PartTable, MessageTable, SessionTable } from "../session/session.sql"
import type { SessionID } from "../session/schema"

export interface SpawnInput {
  stuckSessionID: SessionID
  parentSessionID: SessionID | undefined
  trigger: {
    tool: string
    timeout: number
    elapsed: number
  }
  /** Override hard timeout in ms — defaults to HARD_TIMEOUT (60_000) */
  hardTimeout?: number
}

export async function buildSystemPrompt(input: SpawnInput): Promise<string> {
  const sid = input.stuckSessionID
  const pid = input.parentSessionID ?? "unknown"

  const latest = Database.use((db) =>
    db
      .select({ id: MessageTable.id, data: MessageTable.data, time_created: MessageTable.time_created })
      .from(MessageTable)
      .where(and(eq(MessageTable.session_id, sid), sql`json_extract(${MessageTable.data}, '$.role') = 'assistant'`))
      .orderBy(desc(MessageTable.time_created))
      .limit(1)
      .all(),
  )

  const parts = Database.use((db) =>
    db
      .select({ id: PartTable.id, data: PartTable.data, time_created: PartTable.time_created })
      .from(PartTable)
      .where(eq(PartTable.session_id, sid))
      .orderBy(desc(PartTable.time_created))
      .limit(10)
      .all(),
  )

  const tree = Database.use((db) =>
    db
      .select({ id: SessionTable.id, parent_id: SessionTable.parent_id, title: SessionTable.title })
      .from(SessionTable)
      .where(sql`${SessionTable.id} = ${sid} OR ${SessionTable.parent_id} = ${sid}`)
      .all(),
  )

  return `You are a watchdog agent investigating a stuck session.

## Stuck Session
- Session ID: ${sid}
- Parent Session ID: ${pid}

## Trigger
- Tool: ${input.trigger.tool}
- Configured timeout: ${input.trigger.timeout}s
- Elapsed time: ${input.trigger.elapsed}s

## Scope
You may ONLY act on session ${sid}. Any tool call targeting a different session will be rejected.

## DB Snapshot

### Latest Assistant Message
${JSON.stringify(latest, null, 2)}

### Latest 10 Parts
${JSON.stringify(parts, null, 2)}

### Session Tree
${JSON.stringify(tree, null, 2)}

## Activity Signal Inventory
Use these signals to determine if the session is stuck or merely slow:
1. MAX(time_created) on parts — the most reliable activity signal
2. Tool parts in "running" state with state.time.start — how long a tool has been running
3. Unmatched step-start without step-finish — hung LLM stream indicator
4. Assistant message data.time.completed — whether the last LLM turn finished
5. Session tree parent_id relationships — blocked parent detection

Interpretation:
- If MAX(time_created) advanced within 30s: session is HEALTHY (slow but progressing)
- If tool parts stuck in "running" for > timeout: STUCK TOOL
- If step-start without step-finish and no new parts: HUNG LLM STREAM
- If parent's task tool in running state pointing to this session: PARENT BLOCKED ON STUCK CHILD

## Available Actions
1. watchdog_query — query DB for session state (read-only)
2. watchdog_activity — check last part creation time
3. watchdog_reprompt — send nudge message to stuck child session (Layer 2/3 only, NOT for Layer 1 hung streams)
4. watchdog_cancel — cancel session with diagnostic report (last resort)

## Decision Criteria
1. First: query session state to classify the failure mode
2. If healthy (recent activity within 30s): exit with no action
3. If stuck AND Layer 2/3 stall: attempt reprompt, poll for recovery
4. If stuck AND Layer 1 hung stream: proceed directly to cancel (reprompt cannot reach a hung stream)
5. If reprompt fails (no recovery after 5 polls): cancel with diagnostic
6. Always provide a detailed diagnostic report when cancelling

## Classification Priority Order
1. Parent blocked on stuck child (parent's task tool in running state)
2. Stuck tool (tool part in running state with old start time)
3. Hung LLM stream (step-start without step-finish, no new parts)
4. Infinite empty-response loop (multiple recent assistant messages with finish set but zero tool parts)`
}
