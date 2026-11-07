// The decision a human reaches for a pending `promote_request`.
//
// Issue #271, option 2 — the decision is delivered back down the still-open
// MCP-tool socket connection. "accepted" carries the new worktree session's
// own id/path so the model's tool result can tell it where its work moved;
// "declined" optionally carries a reason.
//
// It lives here rather than in src/plugins/hooks.ts because THREE other
// modules need it — src/services/session-backend.ts and
// src/services/remote-host-client.ts (both of which resolve the pending
// promote) and src/routes/internal-schemas.ts (the request body). A service
// importing a plugin inverts the layering (routes -> services -> db, plugins
// above both), which is issue #2413's whole subject.
//
// The plugin re-exports it, so every existing importer keeps its path.

export type PromoteDecision =
  | { decision: "accepted"; worktreePath: string; newSessionId: number }
  | { decision: "declined"; reason?: string };
