import type { FastifyInstance } from "fastify";
import { eq, inArray, sql } from "drizzle-orm";
import { projects, sessions } from "../db/schema.js";
import { LOCAL_HOST_ID } from "./host-registry.js";
import type { SessionInfo } from "./pty-manager.js";
import { deriveSessionStatus } from "./session-status.js";
import { getPreviewWorktree } from "./git-worktree.js";
import { resolveBackend } from "./session-backend.js";
import { HostRequestError } from "./remote-host-client.js";

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
// reason — see SessionInfo.backgroundTasksAt's own doc comment. `agentSessionId`
// (issue #271 follow-up) is excluded the same way: it's read directly off
// `app.pty.get(id)` by the (local-only) promote route's own transfer
// decision, never surfaced to the frontend or consumed by deriveSessionStatus.
// `eventSeqHead` / `agentTurnInFlight` (issue #1962) are excluded likewise:
// the control socket's remote `sessions.wait` / `sessions.prompt` read them
// straight off the host's SessionInfo, they are not part of the session view.
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
  | "agentSessionId"
  | "stateRestored"
  | "staleHooks"
  | "restoredVersion"
  | "hookEmits"
  | "eventSeqHead"
  | "agentTurnInFlight"
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
    // Issue: correlate concurrent permission gates — same live/in-memory,
    // host-tracked-only fallback shape as gateState/gatePrompt/gateAt above.
    gates: info?.gates ?? [],
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
    currentTodo: info?.currentTodo ?? null,
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
    // Issue #1735 — the last turn end that meant "the agent's work is
    // done". The reconciler's worker->review gate reads this one (through
    // the session's live info), so it has to travel the same path as
    // `lastTurnEndedAt`.
    workFinishedAt: info?.workFinishedAt ?? null,
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
  // Issue #1727 — whether the host ANSWERED. `hostReachable: false` means
  // the host was unreachable, so nothing about the session itself could be
  // established (the live info is the idle/no-signal fallback). Optional and
  // defaulting to "reachable", so every existing caller keeps today's
  // behaviour.
  opts: { hostReachable?: boolean } = {},
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
  const derived = deriveSessionStatus({
    dbStatus: row.status,
    hostReachable: opts.hostReachable,
    info: live,
  });
  return {
    ...row,
    ...live,
    browserUrl,
    // Issue #1727 — the session's EFFECTIVE host: its own when it has one,
    // the project's when it inherits. The raw `hostId` column above stays
    // as it is (null = "inherits the project's host"), so both facts are
    // visible and neither is ambiguous. Resolved HERE, on the server, where
    // the rule already lives (resolveSessionHostId) — the frontend does not
    // re-derive it.
    resolvedHostId: hostId,
    // Issue #822 — same "parse the JSON-as-text column back into an object
    // before it reaches the wire" convention as workspaces.ts's own
    // `layout` field; without this override, the `...row` spread above
    // would leak the raw JSON STRING (not the object a caller posted) as
    // this session's `env`.
    env: parseEnvColumn(app, row),
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
 * or genuinely local, keeping every call site's fallback identical.
 *
 * Still the right answer for PROJECT-scoped operations (git ops, project
 * files, a project's worktree, webhooks) — a session's host says where
 * that session runs, not where the project's work lives. */
export function resolveProjectHostId(app: FastifyInstance, projectId: number): string {
  const [project] = app.db
    .select({ hostId: projects.hostId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .all();
  return project?.hostId ?? LOCAL_HOST_ID;
}

/**
 * The host a session lives on: its own recorded host, else its project's.
 *
 * Issue #1722 / roadmap 8.8 — a session records the host it was actually
 * spawned on (`sessions.hostId`, written once at creation), so a placement
 * policy can put some of a project's sessions on one machine and some on
 * another. Every SESSION-scoped operation resolves through here.
 *
 * The row's own value wins when it is set; NULL means "inherit the
 * project's host", which is every pre-existing row (and every row created
 * before the placement wiring lands). The fallback is therefore the only
 * thing that has to be right for old rows — a placed session costs NO
 * query here at all, and an inheriting one costs the same single query
 * its project-scoped sibling always did.
 *
 * `projectId` is deliberately not consulted when the row carries its own
 * host: the project's host is a different fact (where the project's work
 * lives), and reading it would be a query nobody needs.
 */
export function resolveSessionHostId(
  app: FastifyInstance,
  row: { projectId: number; hostId: string | null },
): string {
  if (row.hostId !== null) return row.hostId;
  return resolveProjectHostId(app, row.projectId);
}

/**
 * The host a task's WORKER session runs on — and therefore the host its
 * worktree is on.
 *
 * Issue #1724 / roadmap 8.10: the reviewer and the rebase worker READ the
 * task's worktree, so they must run where that worktree is. The worker's own
 * session row records the host it was placed on (sessions.hostId, issue
 * #1722); the project's host is the fallback for a task whose worker never
 * started (or whose row predates placement).
 *
 * A task's sessions therefore share ONE host — the worker decides it, and
 * the rest join it.
 */
export function resolveTaskWorkerHost(
  app: FastifyInstance,
  task: { sessionId: number | null; projectId: number },
  // The project row, when the caller already has it. It is AUTHORITATIVE
  // for the fallback: re-reading the project from the db would answer for
  // whatever row carries that id — not necessarily the one the caller is
  // working with, and in a test not even a row at all.
  project?: { hostId: string },
): string {
  if (task.sessionId !== null) {
    const [row] = app.db.select().from(sessions).where(eq(sessions.id, task.sessionId)).all();
    if (row !== undefined) return resolveSessionHostId(app, row);
  }
  return project?.hostId ?? resolveProjectHostId(app, task.projectId);
}

// Batch size for the inArray lookup below — same value and same reasoning as
// event-store.ts's own OWNERSHIP_LOOKUP_CHUNK_SIZE (its filterHostOwnership
// is the sibling collision guard for persisted events; this one guards the
// live `cursors`/`seen` relay instead): a numeric sessionId set arriving over
// the wire from an agent is bounded only by how many sessions that host
// tracks, not attacker-controlled the same way, but chunking here too keeps
// this from ever depending on staying under SQLite's ~32,766 bind-parameter
// limit as an invariant a busy host could someday violate.
const SESSION_HOST_LOOKUP_CHUNK_SIZE = 500;

/**
 * Resolves a batch of numeric `sessions.id` values to their owning host.
 *
 * Issue #1722 / roadmap 8.8 — the owning host is the SESSION's own
 * `sessions.hostId` when it has one (a session placed on a host of its
 * own), and the project's host otherwise (`coalesce` over a LEFT JOIN, so
 * a session whose project row is missing still resolves — to "local",
 * exactly as resolveProjectHostId's own fallback does).
 *
 * Issue #1459's collision guard: `relayRemoteEventsHost` (routes/events.ts)
 * uses this to drop a `cursors`/`seen` entry a remote agent reports for a
 * sessionId that doesn't actually resolve to the host reporting it — the
 * same numeric-id-collision hazard event-store.ts's filterHostOwnership
 * guards against for persisted events, just for the live relay instead.
 *
 * A sessionId absent from the returned map means no session row resolves to
 * it at all (already deleted, or simply bogus) — every caller treats that
 * the same as "does not belong to this host" and drops it, mirroring
 * filterHostOwnership's own droppedNotFound case. Batched via `inArray`,
 * chunked at SESSION_HOST_LOOKUP_CHUNK_SIZE, so a `cursors` frame naming many
 * sessions costs one query per chunk, not one per session.
 */
export function resolveSessionHostIds(
  app: FastifyInstance,
  sessionIds: number[],
): Map<number, string> {
  const owners = new Map<number, string>();
  const uniqueIds = [...new Set(sessionIds)];
  for (let i = 0; i < uniqueIds.length; i += SESSION_HOST_LOOKUP_CHUNK_SIZE) {
    const chunk = uniqueIds.slice(i, i + SESSION_HOST_LOOKUP_CHUNK_SIZE);
    const rows = app.db
      .select({
        sessionId: sessions.id,
        // The session's own host when it has one, else its project's — the
        // same rule resolveSessionHostId() applies one row at a time.
        hostId: sql<string>`coalesce(${sessions.hostId}, ${projects.hostId})`,
      })
      .from(sessions)
      .leftJoin(projects, eq(sessions.projectId, projects.id))
      .where(inArray(sessions.id, chunk))
      .all();
    for (const row of rows) owners.set(row.sessionId, row.hostId ?? LOCAL_HOST_ID);
  }
  return owners;
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
  const { info, hostReachable } = await readSessionLiveInfo(app, row, idleThresholdMs, hostId);
  return withLiveInfo(app, row, info, hostId, { hostReachable });
}

/**
 * One session's `SessionInfo` from the host that owns it, plus whether that
 * host ANSWERED — the read `withLiveStatus` builds the session view from, shared
 * so the REST path and the control socket's remote wait (issue #1962) cannot
 * drift apart.
 *
 * `fresh` (a remote host only) bypasses the host client's 1.5 s cache. On any
 * failure `info` is null, `hostReachable` is false, `failure` says which kind
 * (`unreachable` or `refused`) and `error` is what was thrown; callers that
 * only want a view ignore the last two, a caller that must tell "the host is
 * down" from "the host answered and refused" reads `failure`.
 */
export async function readSessionLiveInfo(
  app: FastifyInstance,
  row: typeof sessions.$inferSelect,
  idleThresholdMs: number,
  hostId: string,
  opts: { fresh?: boolean } = {},
): Promise<{
  info: SessionInfo | null;
  hostReachable: boolean;
  /** Why the read failed, classified once here: the host `unreachable` (a
   * network fault, a timeout) or `refused` the request (it ANSWERED with an
   * error: its rate limit, a stale token). Absent when the read succeeded. */
  failure?: "unreachable" | "refused";
  error?: unknown;
}> {
  const id = String(row.id);
  // The one place the result is built, so `hostReachable` and `failure` cannot
  // disagree: a read reached the host exactly when it did not fail.
  const outcome = (
    info: SessionInfo | null,
    failure?: "unreachable" | "refused",
    error?: unknown,
  ) => ({
    info,
    hostReachable: failure === undefined,
    ...(failure === undefined ? {} : { failure, error }),
  });
  try {
    const backend = resolveBackend(app, hostId);
    const map =
      opts.fresh === true
        ? await backend.liveStatus([id], idleThresholdMs, undefined, { fresh: true })
        : await backend.liveStatus([id], idleThresholdMs);
    return outcome(map[id] ?? null);
  } catch (err) {
    // Issue #1727 — the host did not answer. That is not "the session is
    // gone": it is "we cannot tell what is going on there". The session is
    // reported as SUSPENDED (host unreachable — may still be running) rather
    // than as the idle no-signal fallback a quiet session gets.
    // Say which it was: a host that ANSWERED with an error (its rate limit, a
    // stale token) is not a network fault, and a log that blames one sends
    // whoever reads it looking in the wrong place.
    const failure = err instanceof HostRequestError ? "refused" : "unreachable";
    app.log.warn(
      { hostId, sessionId: row.id, err },
      failure === "refused"
        ? "host answered the live-status request with an error, reporting default live status"
        : "host unreachable, reporting default live status",
    );
    return outcome(null, failure, err);
  }
}

// One corrupt `env` column must not 500 GET /api/sessions for every session.
function parseEnvColumn(
  app: FastifyInstance,
  row: { id: number; env: string | null },
): Record<string, string> | null {
  if (!row.env) return null;
  try {
    return JSON.parse(row.env) as Record<string, string>;
  } catch (err) {
    app.log.warn({ sessionId: row.id, err }, "session env column is not valid JSON; ignoring");
    return null;
  }
}
