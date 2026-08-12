// Session lifecycle + persisted event history. Split out of the former flat
// frontend/src/api.ts (PR 22 of the refactoring roadmap).
import { request } from "./client.js";
import type { Session, EventHistoryPage, Preview } from "./types.js";

export const sessionsApi = {
  // `status` (perf audit finding A6) lets a caller ask for only e.g. "active"
  // sessions instead of always getting the full list — prod's own
  // /api/sessions was 293 rows, 284 of them `killed` tombstones nothing ever
  // purges. Optional and unused by the default poll today (store.ts's
  // refreshSessions still wants the full list, e.g. for task/history views
  // that reference a killed session), but callers that only need live
  // sessions can now avoid paying for the rest.
  listSessions: (opts?: {
    projectId?: number;
    kind?: "terminal" | "dock";
    status?: Session["status"];
  }) => {
    const params = new URLSearchParams();
    if (opts?.projectId !== undefined) params.set("projectId", String(opts.projectId));
    if (opts?.kind !== undefined) params.set("kind", opts.kind);
    if (opts?.status !== undefined) params.set("status", opts.status);
    const qs = params.toString();
    return request<Session[]>(`/api/sessions${qs ? `?${qs}` : ""}`);
  },

  // Issue #213 (roadmap 4.7) — queries persisted session-event history (GET
  // /api/events). Deliberately no `kind` param: the server only supports
  // filtering to exactly one kind, while SessionTimeline.tsx's UI is 16
  // opt-out chips over already-loaded rows — kind filtering stays
  // client-side (see that component's own comment). `since`/`until` are
  // inclusive epoch-ms bounds; `cursor` is the previous page's own
  // `nextCursor` (an opaque row id, not a timestamp — see
  // src/services/event-history.ts's querySessionEvents for why).
  listEventHistory: (opts?: {
    sessionId?: number;
    since?: number;
    until?: number;
    limit?: number;
    cursor?: number;
  }) => {
    const params = new URLSearchParams();
    if (opts?.sessionId !== undefined) params.set("sessionId", String(opts.sessionId));
    if (opts?.since !== undefined) params.set("since", String(opts.since));
    if (opts?.until !== undefined) params.set("until", String(opts.until));
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.cursor !== undefined) params.set("cursor", String(opts.cursor));
    const qs = params.toString();
    return request<EventHistoryPage>(`/api/events${qs ? `?${qs}` : ""}`);
  },

  createSession: (
    projectId: number,
    command: string,
    opts?: {
      name?: string;
      cwd?: string;
      kind?: "terminal" | "dock";
      // Issue #271, option 1 — the launcher's opt-in "isolate this session"
      // toggle: create the session inside a fresh worktree instead of `cwd`.
      worktree?: { baseRef: string; branchName?: string } | { branch: string };
      // When true, a preview worktree created for this session is
      // periodically synced to the branch's latest commit.
      worktreeRefresh?: boolean;
      skipPermissions?: boolean;
    },
  ) =>
    request<Session>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ projectId, command, ...opts }),
    }),

  renameSession: (id: number, name: string) =>
    request<Session>(`/api/sessions/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),

  deleteSession: (id: number) => request<void>(`/api/sessions/${id}`, { method: "DELETE" }),

  // Issue #271, option 2 — "promote an existing session": creates a
  // worktree, moves work into a new session there, and kills the source.
  promoteSession: (
    id: number,
    opts: { baseRef: string; branchName?: string; seedPrompt?: string },
  ) =>
    request<Session>(`/api/sessions/${id}/promote`, {
      method: "POST",
      body: JSON.stringify(opts),
    }),

  declinePromote: (id: number, reason?: string) =>
    request<void>(`/api/sessions/${id}/promote/decline`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),

  // Minimal review gate (issue #178) — delivers a human's Approve/Deny
  // decision (NotificationBell.tsx) for a session's pending `review_gate`.
  resolveReviewGate: (id: number, decision: "approved" | "denied", reason?: string) =>
    request<void>(`/api/sessions/${id}/review-gate`, {
      method: "POST",
      body: JSON.stringify({ decision, ...(reason !== undefined ? { reason } : {}) }),
    }),

  // Issue #404 — accepts a plain session's detected dev-server offer: wires
  // the already-running server into the project's devServerUrl + preview
  // (never spawns a second session). `preview` is null when
  // PREVIEW_BASE_HOST isn't configured (previews disabled server-wide).
  acceptDevServerPort: (id: number, port: string) =>
    request<{ devServerUrl: string; preview: Preview | null }>(
      `/api/sessions/${id}/dev-server/accept`,
      { method: "POST", body: JSON.stringify({ port }) },
    ),

  // Issue #404 — dismisses a plain session's detected dev-server offer so
  // the same (session, port) doesn't re-offer.
  dismissDevServerPort: (id: number, port: string) =>
    request<void>(`/api/sessions/${id}/dev-server/dismiss`, {
      method: "POST",
      body: JSON.stringify({ port }),
    }),

  // Issue #68: uploads a pasted/attached image (Blob straight off the
  // clipboard or a file input — never re-encoded) so the backend can write
  // it under this session's own cwd and hand back the path to inject into
  // the terminal. request()'s own header logic already sets Content-Type
  // from init.headers when present, overriding its "application/json"
  // default — passing the blob's own type here is enough, no separate
  // raw-body fetch needed.
  uploadSessionImage: (sessionId: number, blob: Blob) =>
    request<{ path: string }>(`/api/sessions/${sessionId}/uploads`, {
      method: "POST",
      body: blob,
      headers: { "Content-Type": blob.type },
    }),
};
