import type { Session } from "./api.js";

// Split out of store.ts so this pure rule stays unit-testable under the
// frontend's node-environment vitest config (test/vitest.config.ts —
// deliberately no jsdom yet, pure-logic modules only): store.ts creates its
// zustand store at module load, which touches `localStorage` synchronously
// (readThemeHint et al.) and would blow up importing it outside a browser/
// jsdom context.
//
// Single source of truth for "does this session belong in the notification
// bell's unread list" — shared by NotificationBell.tsx's badge count and its
// dropdown list so they can never disagree. A session is unread if it
// currently has the live `attention` flag set (src/services/pty-manager.ts's
// sticky-until-restart in-memory state) and either was never acknowledged, or
// has rung again since (its `attentionAt` moved past the acknowledged
// timestamp) — see store.ts's `acknowledgedAttention` map for how the second
// half is maintained.
export function isUnreadAttention(session: Session, acked: Record<number, number>): boolean {
  if (!session.attention) return false;
  const ackedAt = acked[session.id];
  return ackedAt === undefined || (session.attentionAt ?? 0) > ackedAt;
}

// Drops acknowledged-attention entries for sessions that no longer exist
// (deleted, or never seen again by this browser) — otherwise the map, and
// the localStorage blob store.ts persists it to, would grow by one entry
// per ever-acknowledged session id for the lifetime of the browser profile.
export function pruneAckedAttention(
  acked: Record<number, number>,
  sessions: Session[],
): Record<number, number> {
  const liveIds = new Set(sessions.map((s) => s.id));
  const pruned: Record<number, number> = {};
  for (const [id, attentionAt] of Object.entries(acked)) {
    if (liveIds.has(Number(id))) pruned[Number(id)] = attentionAt;
  }
  return pruned;
}
