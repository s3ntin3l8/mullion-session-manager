import type { FastifyInstance } from "fastify";
import { eq, inArray } from "drizzle-orm";
import { projects, sessions, tasks } from "../db/schema.js";
import { LOCAL_HOST_ID } from "./host-registry.js";
import { resolveSessionHostId } from "./session-live-info.js";
import type { SessionInfo } from "./pty-manager.js";

export interface AttachSessionParams {
  id: string;
  cwd: string;
  command: string;
  cols: number;
  rows: number;
  // Issue #822 — see sessions.env's own doc comment (schema.ts). Needed
  // here, not just at spawn time: a re-bootstrap on reattach
  // (Session.spawnInternal, pty-manager.ts) rebuilds the launch plan from
  // whatever this function is handed, and getOrCreate() is a no-op on an
  // already-live session, so this is genuinely only consulted on the
  // respawn path — never touches an already-running session's env.
  env?: Record<string, string>;
}

type SessionRow = typeof sessions.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;

function envFromRow(
  raw: string,
  sessionId: number,
  log: FastifyInstance["log"],
): { env?: Record<string, string> } {
  const env = parseSessionEnv(raw, sessionId, log);
  return env ? { env } : {};
}

function parseSessionEnv(
  raw: string,
  sessionId: number,
  log: FastifyInstance["log"],
): Record<string, string> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // fall through to the warning below
  }
  log.warn({ sessionId }, "ignoring corrupt sessions.env");
  return undefined;
}

/**
 * What `PtyManager.getOrCreate` needs to attach to (or re-bootstrap) a local
 * session, read straight off its DB row. Shared by the terminal attach path
 * and `adoptSurvivingSession` so the two cannot drift.
 */
export function attachParamsFromRow(
  app: FastifyInstance,
  row: SessionRow,
  project: ProjectRow,
  { cols, rows }: { cols: number; rows: number },
): AttachSessionParams {
  return {
    id: String(row.id),
    cwd: row.cwd ?? project.cwd,
    command: row.command,
    cols,
    rows,
    // Issue #822 — row.env is the only source for it (no access to the
    // original create-time opts), same "read straight off the row" posture
    // as cwd/command above.
    ...(row.env !== null ? envFromRow(row.env, row.id, app.log) : {}),
  };
}

export type AdoptOutcome =
  /** Already tracked with a live PTY — nothing to do. */
  | "live"
  /** Its scope was alive and PtyManager now tracks it again. */
  | "adopted"
  /** No such active local session, or its scope is gone. A dead session is never respawned. */
  | "not-running"
  /** The scope's liveness could not be verified (or the reattach did not settle): retry. */
  | "unverifiable";

/** How long adoption waits for the reattach to settle. */
const ADOPT_SETTLE_TIMEOUT_MS = 5000;

/** Size used only when the session never recorded one (a state file from before
 * #2271): dtach applies the attaching client's size to the master, so this is a
 * guess that resizes the program until a real client attaches. */
const FALLBACK_SIZE = { cols: 80, rows: 24 };

const inFlight = new WeakMap<FastifyInstance, Map<string, Promise<AdoptOutcome>>>();

/**
 * Issue #2271 — a session survives a Mullion restart (its dtach master lives
 * in a transient systemd scope), but `PtyManager` only tracks it again when
 * something attaches. Control-socket ops that need a live PTY call this first
 * so a healthy session is not reported "not running" until a dashboard
 * client happens to attach.
 *
 * `PtyManager.getOrCreate` re-bootstraps a fresh program when the dtach
 * socket probes dead, so the scope is checked FIRST and only an `"alive"`
 * answer adopts: a dead session is never respawned, and `"unknown"` is
 * never folded into "dead" (same rule as every other caller of
 * `isMasterAliveState`).
 *
 * Local sessions only — a remote host's agent keeps its own PtyManager.
 * Concurrent calls for one id share a single adoption.
 */
export function adoptSurvivingSession(app: FastifyInstance, id: string): Promise<AdoptOutcome> {
  const pending = inFlight.get(app) ?? new Map<string, Promise<AdoptOutcome>>();
  inFlight.set(app, pending);
  const existing = pending.get(id);
  if (existing) return existing;
  const run = adopt(app, id).finally(() => pending.delete(id));
  pending.set(id, run);
  return run;
}

async function adopt(app: FastifyInstance, id: string): Promise<AdoptOutcome> {
  if (app.pty.get(id)?.isAlive) return "live";

  const sessionId = Number(id);
  if (!Number.isInteger(sessionId)) return "not-running";
  const [row] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
  if (!row || row.status !== "active") return "not-running";
  if (resolveSessionHostId(app, row) !== LOCAL_HOST_ID) return "not-running";
  const [project] = app.db.select().from(projects).where(eq(projects.id, row.projectId)).all();
  if (!project) return "not-running";

  const liveness = await app.pty.isMasterAliveState(id);
  if (liveness === "dead") return "not-running";
  if (liveness !== "alive") return "unverifiable";

  // A terminal attach may have won the race while liveness was being read.
  if (app.pty.get(id)?.isAlive) return "live";

  // Reattach at the size the session already has: dtach gives the attaching
  // client's window size to the master, so a guessed one would reflow it.
  const session = app.pty.getOrCreate(
    attachParamsFromRow(app, row, project, app.pty.storedPtySize(id) ?? FALLBACK_SIZE),
  );

  // spawnOutcome() is the attach attempt's own result: a genuine failure
  // (missing dtach, vanished cwd) rejects with its real cause instead of
  // reading as a retryable "unverifiable" forever.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ADOPT_SETTLE_TIMEOUT_MS);
  });
  try {
    const settled = await Promise.race([
      session.spawnOutcome().then(() => "settled" as const),
      timedOut,
    ]);
    if (settled === "timeout") return "unverifiable";
  } finally {
    clearTimeout(timer);
  }
  return app.pty.get(id)?.isAlive ? "adopted" : "unverifiable";
}

/** Task statuses whose sessions are headless: nothing opens their terminal. */
const TASK_SESSION_STATUSES = ["claimed", "in_progress", "reviewing"] as const;

/**
 * Issue #2929 — after a restart `PtyManager`'s map is empty. A browser
 * re-attaches a session someone opens; a Task Master worker (and its review
 * session) has no browser, so its Stop hook is rejected and the reconciler
 * never sees "finished". Adopt those active local sessions at boot.
 * `adoptSurvivingSession` already refuses a non-local, non-active, or dead
 * scope, and never respawns one.
 */
export async function adoptActiveTaskSessions(app: FastifyInstance): Promise<void> {
  const rows = app.db
    .select({ sessionId: tasks.sessionId, reviewSessionId: tasks.reviewSessionId })
    .from(tasks)
    .where(inArray(tasks.status, [...TASK_SESSION_STATUSES]))
    .all();
  const ids = new Set<number>();
  for (const row of rows) {
    if (row.sessionId !== null) ids.add(row.sessionId);
    if (row.reviewSessionId !== null) ids.add(row.reviewSessionId);
  }
  await Promise.all([...ids].map((id) => adoptTaskSession(app, id)));
}

async function adoptTaskSession(app: FastifyInstance, id: number): Promise<void> {
  try {
    const outcome = await adoptSurvivingSession(app, String(id));
    if (outcome === "adopted") {
      app.log.info({ sessionId: id }, "adopted surviving task session");
    } else if (outcome === "unverifiable") {
      app.log.warn({ sessionId: id }, "task session adoption unverifiable; will retry");
    }
  } catch (err) {
    app.log.warn({ err, sessionId: id }, "task session adoption failed");
  }
}

/**
 * Issue #2929 — `LocalBackend.liveStatus` reports `null` for a session this
 * process does not track. On the local host that means "not adopted yet",
 * not "idle". Adopt and replace the null entry before the caller decides
 * (budget, handoff, review ingest).
 *
 * Returns true when this tick should skip the task: liveness could not be
 * verified, or the reattach threw. A dead scope stays `null` (returns false)
 * so the existing idle/budget path runs. A remote host is left alone — its
 * agent owns that PtyManager, and an omitted key (`undefined`) is not null.
 */
export async function healUntrackedLocalSession(
  app: FastifyInstance,
  hostId: string,
  sessionId: string,
  liveMap: Record<string, SessionInfo | null>,
  idleThresholdMs: number,
  backend: {
    liveStatus(ids: string[], idleThresholdMs: number): Promise<Record<string, SessionInfo | null>>;
  },
): Promise<boolean> {
  if (hostId !== LOCAL_HOST_ID || liveMap[sessionId] !== null) return false;
  let outcome: AdoptOutcome;
  try {
    outcome = await adoptSurvivingSession(app, sessionId);
  } catch (err) {
    app.log.warn({ err, sessionId }, "task reconcile: session adoption failed");
    return true;
  }
  if (outcome === "unverifiable") return true;
  if (outcome !== "adopted" && outcome !== "live") return false;
  try {
    const again = await backend.liveStatus([sessionId], idleThresholdMs);
    if (!(sessionId in again) || again[sessionId] === undefined) return true;
    liveMap[sessionId] = again[sessionId];
  } catch (err) {
    app.log.warn({ err, sessionId }, "task reconcile: live status after adoption failed");
    return true;
  }
  return false;
}
