// Shared API types for sessions: subagents, background tasks and stored events (#2412).
//
// The single declaration of each API shape here, used by both workspaces.
// Most were hand-copied into frontend/src/api/ before #2412; the backend
// module that produces one re-exports it, so its importers are unchanged, and
// the frontend imports it through src/shared/types.ts, the one entry point.
// Type-only: no runtime code, and no import from outside src/shared/ (an
// import back from types.ts would be a cycle).

/** Phase 5 (Track A) — one subagent's identity and activity, built from the
 * agentId-bearing hook messages (see hook-protocol.ts's agent-attribution
 * envelope). Purely additive to `subagentCount`/`subagentCountAt` above,
 * never a replacement: not every adapter can supply an `agentId` (OpenCode's
 * `session.subagent` carries none), and a `.state.json` written before this
 * registry existed restores a bare count with no entries at all — either
 * case means `subagents` may legitimately be shorter than `subagentCount`,
 * which is "count known, detail unavailable," not an inconsistency. */
export interface SubagentInfo {
  agentId: string;
  agentType: string | null;
  startedAt: number;
  /** Set when a matching SubagentStop arrives, OR when the staleness sweep
   * (clearStaleBlockedIfOlderThan) force-finalizes this still-open entry
   * against its own `startedAt` — independent of subagentCount's own
   * staleness, which only zeroes the aggregate count and never touches
   * this field. That second (registry-side) case leaves `summary` null (no
   * final message was ever recorded), distinguishing a genuine finish from
   * a stale one. */
  endedAt: number | null;
  summary: string | null;
  fileChanges: number;
  toolFailures: number;
  /** Count of `fileChanges` + `toolFailures` attributed to this subagent —
   * NOT every hook message involving it (e.g. its own SubagentStart/Stop
   * aren't counted here). */
  eventCount: number;
}

export interface BackgroundTask {
  id: string;
  type: string;
  status: string;
  description: string;
  /** Optional passthrough fields Claude Code's own `BackgroundTaskSummary`
   * carries (`command` for a background shell, `agent_type` for a
   * background subagent, `server`/`tool` for an MCP-backed task, `name` as
   * a generic label) — kept snake_case and untyped-beyond-string, same
   * "opaque blob forwarded verbatim" posture hook-protocol.ts gives
   * agent-authored payloads elsewhere (see that module's header comment). */
  command?: string;
  agent_type?: string;
  server?: string;
  tool?: string;
  name?: string;
}

export interface StoredEventRow {
  id: number;
  sessionId: number | null;
  seq: number;
  kind: string;
  ts: number;
  payload: Record<string, unknown> | null;
}
