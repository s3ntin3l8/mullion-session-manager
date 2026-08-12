import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { projects } from "../db/schema.js";
import type { sessions } from "../db/schema.js";
import { LOCAL_HOST_ID } from "./host-registry.js";
import type { SessionInfo } from "./pty-manager.js";
import { deriveSessionStatus } from "./session-status.js";
import { getPreviewWorktree } from "./git-worktree.js";
import { resolveBackend } from "./session-backend.js";

// Every SessionInfo field EXCEPT the ones `row` (the DB row) already carries
// under the same name (id/cwd/command/createdAt) or that are never exposed
// over REST at all (cols/rows — PTY-internal only; the terminal WS reports
// real dimensions instead — see terminal.ts). Declaring this as an explicit
// exclusion list, rather than hand-picking which fields TO include, is the
// point: TypeScript's excess-property/missing-property check on the object
// literal below is assigned directly to `Record<LiveInfoKey, ...>`, so
// forgetting to add a newly-added SessionInfo field to `buildLiveInfo` is a
// `make typecheck` failure, not silent dead UI. This is the exact bug that
// shipped in PR #300: permissionState/planState/errorState/endedReason were
// added to SessionInfo but never wired into buildLiveInfo, leaving
// Sidebar.tsx's "Needs permission"/"Plan ready"/"API error"/"Tool failure"
// branches unreachable — see the plan doc for the full incident writeup.
// `errorAt` is also excluded: a backend-internal TTL timestamp for the
// session-reconciler's error staleness sweep (issue #320), not something the
// frontend or deriveSessionStatus needs — see SessionInfo.errorAt's own doc
// comment. `backgroundTasksAt` (issue #428) is excluded for the identical
// reason — see SessionInfo.backgroundTasksAt's own doc comment.
type LiveInfoKey = Exclude<
  keyof SessionInfo,
  | "id"
  | "cwd"
  | "command"
  | "cols"
  | "rows"
  | "createdAt"
  | "errorAt"
  | "backgroundTasksAt"
  | "stateRestored"
  | "staleHooks"
  | "restoredVersion"
  | "hookEmits"
>;

// Live-only (in-memory PtyManager state on whichever host owns this session,
// local or remote — see pty-manager.ts's SessionInfo doc comments for what
// each means). Falls back to idle/no-signal defaults for a session this
// process hasn't tracked yet (e.g. right after a restart, before anything has
// re-attached) or whose host is currently unreachable (issue #26 — never a
// 500, just stale defaults).
function buildLiveInfo(info: SessionInfo | null | undefined): Pick<SessionInfo, LiveInfoKey> {
  const live: Pick<SessionInfo, LiveInfoKey> = {
    alive: info?.alive ?? false,
    subscriberCount: info?.subscriberCount ?? 0,
    activity: info?.activity ?? "idle",
    lastActivityAt: info?.lastActivityAt ?? null,
    liveCwd: info?.liveCwd ?? null,
    browserUrl: info?.browserUrl ?? null,
    attention: info?.attention ?? false,
    attentionAt: info?.attentionAt ?? null,
    lastTitle: info?.lastTitle ?? null,
    liveBranch: info?.liveBranch ?? null,
    gateState: info?.gateState ?? "idle",
    gatePrompt: info?.gatePrompt ?? null,
    gateAt: info?.gateAt ?? null,
    // Issue #271 — same live/in-memory, host-tracked-only fallback shape.
    promoteState: info?.promoteState ?? "idle",
    promoteSummary: info?.promoteSummary ?? null,
    promoteSuggestedBaseRef: info?.promoteSuggestedBaseRef ?? null,
    promoteAt: info?.promoteAt ?? null,
    permissionState: info?.permissionState ?? "idle",
    permissionAt: info?.permissionAt ?? null,
    planState: info?.planState ?? "idle",
    planAt: info?.planAt ?? null,
    errorState: info?.errorState ?? "idle",
    endedReason: info?.endedReason ?? null,
    exitCode: info?.exitCode ?? null,
    attentionKind: info?.attentionKind ?? null,
    errorDetail: info?.errorDetail ?? null,
    lastAssistantMessage: info?.lastAssistantMessage ?? null,
    compactState: info?.compactState ?? "idle",
    compactAt: info?.compactAt ?? null,
    subagentCount: info?.subagentCount ?? 0,
    subagentCountAt: info?.subagentCountAt ?? null,
    subagents: info?.subagents ?? [],
    elicitationState: info?.elicitationState ?? "idle",
    elicitationServer: info?.elicitationServer ?? null,
    elicitationAt: info?.elicitationAt ?? null,
    questionState: info?.questionState ?? "idle",
    questionHeader: info?.questionHeader ?? null,
    questionAt: info?.questionAt ?? null,
    lastTurnEndedAt: info?.lastTurnEndedAt ?? null,
    // Issue #428 — same live/in-memory, host-tracked-only fallback shape.
    backgroundTasks: info?.backgroundTasks ?? [],
    outstandingBackgroundTasks: info?.outstandingBackgroundTasks ?? [],
    // Issue #404 — same live/in-memory, host-tracked-only fallback shape as
    // every other field above; null for a session this process hasn't
    // tracked yet (e.g. right after a restart) or that never had one.
    pendingDevServerPort: info?.pendingDevServerPort ?? null,
  };
  return live;
}

// Perf audit finding A6 — `hostId` is a required parameter, not resolved
// internally: every call site already knows it (either passed in directly,
// as withLiveStatus does, or batched up-front via the projectId->hostId map
// GET /api/sessions (routes/sessions.ts) builds, same reasoning as its own
// bulkLiveStatus batching there). Before this, this function called
// resolveProjectHostId(app, row.projectId) itself — one extra synchronous
// better-sqlite3 SELECT *per session, per request* on top of the list
// route's own already-batched lookup, hit on every 4s poll tick from every
// open tab.
export function withLiveInfo(
  app: FastifyInstance,
  row: typeof sessions.$inferSelect,
  info: SessionInfo | null | undefined,
  hostId: string,
) {
  const live = buildLiveInfo(info);
  let browserUrl = live.browserUrl;

  if (hostId === LOCAL_HOST_ID && app.config.BROWSER_ENABLED) {
    const managed = app.browser.get(row.projectId);
    if (managed && managed.browser.isConnected()) {
      try {
        browserUrl = managed.page.url();
      } catch {
        // Best-effort
      }
    }
  }

  // Rich statuses — the single derivation point (session-status.ts), called
  // here where the liveness axis (row.status, the DB's own intent) and the
  // agent-activity axis (live, already merged with its idle/no-signal
  // fallbacks above) are both available. Exposed under new `sessionStatus*`
  // keys rather than overwriting `row.status` — that raw DB column
  // ("active"/"killed"/"exited") is a separate, narrower concept other code
  // may still read, and collapsing it into the much richer SessionStatus
  // union here would be a silent breaking change for any such reader.
  const derived = deriveSessionStatus({ dbStatus: row.status, info: live });
  return {
    ...row,
    ...live,
    browserUrl,
    // Dock preview sessions (PR #341) run inside a DETACHED-HEAD worktree
    // (git-worktree.ts's checkoutBranchWorktree), so neither `cwd` nor git
    // itself tells the frontend which branch is being previewed — this is
    // the only seam that does. In-memory only: after a server restart this
    // is null for a still-running preview session, the same restart in
    // which its sync tick and cleanup tracking are already lost, so
    // Dock.tsx falls back to the main checkout rather than rendering blank.
    previewBranch: getPreviewWorktree(row.id)?.branch ?? null,
    // Issue #323: static session metadata (not live-updating) — excluded
    // from LiveInfoKey since these never change during a session's lifetime.
    // Included here in the initial REST response for the frontend's
    // state-aware display.
    stateRestored: info?.stateRestored ?? false,
    staleHooks: info?.staleHooks ?? false,
    restoredVersion: info?.restoredVersion ?? null,
    hookEmits: info?.hookEmits ?? [],
    sessionStatus: derived.status,
    sessionStatusSeverity: derived.severity,
    sessionStatusDetail: derived.detail,
    sessionStatusAttentionRequired: derived.attentionRequired,
  };
}

/** hostId of the project a session row belongs to — "local" for any row
 * whose project is missing (shouldn't happen; projectId is a required FK)
 * or genuinely local, keeping every call site's fallback identical. */
export function resolveProjectHostId(app: FastifyInstance, projectId: number): string {
  const [project] = app.db
    .select({ hostId: projects.hostId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .all();
  return project?.hostId ?? LOCAL_HOST_ID;
}

// Exported for routes/tasks.ts's claim endpoint (issue #216) and
// task-claim.ts, which return the same "session row + live status" shape
// every other session-returning endpoint in routes/sessions.ts does.
export async function withLiveStatus(
  app: FastifyInstance,
  row: typeof sessions.$inferSelect,
  idleThresholdMs: number,
  hostId: string,
) {
  let info: SessionInfo | null = null;
  try {
    const map = await resolveBackend(app, hostId).liveStatus([String(row.id)], idleThresholdMs);
    info = map[String(row.id)] ?? null;
  } catch (err) {
    app.log.warn(
      { hostId, sessionId: row.id, err },
      "host unreachable, reporting default live status",
    );
  }
  return withLiveInfo(app, row, info, hostId);
}
