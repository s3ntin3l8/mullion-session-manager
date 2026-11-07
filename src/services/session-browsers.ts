import type { FastifyInstance } from "fastify";
import { eq, and, ne, isNull, isNotNull, lte } from "drizzle-orm";
import { pendingBrowserCloses, projects, sessionBrowsers } from "../db/schema.js";
import { browserTargetKey, type BrowserTarget } from "./browser-manager.js";
import {
  BROWSER_TARGETS_OPERATION,
  agentBrowserTarget,
  bindingBrowserTarget,
} from "./browser-target.js";
import { requireOperation } from "./host-agents.js";
import { LOCAL_HOST_ID, getHostRow } from "./host-registry.js";
import { getRemoteHostClient } from "./remote-host-client.js";
import { parseHostCwds, projectCwdOnHost } from "./placement.js";

// Phase 3, issue #182 — the sessionId<->projectId binding table itself
// (schema.ts) has the full rationale for why this is one row per session
// rather than the roadmap's literal "multiple browser panes per session":
// BrowserManager (#179) pools one Chromium instance per *project*, shared
// across every session in it, so there's nothing distinct for a second
// binding to point at yet.

/** Upserts the (sessionId, projectId, target) binding — called whenever a
 * session's browser is attached or driven, so `lastAttachedAt` also tracks
 * "was this session's browser recently used." The target is written once and
 * never re-set: an open panel stays on its original target even if the
 * session's placement or the user's focus later changes. */
export function recordSessionBrowserBinding(
  app: FastifyInstance,
  sessionId: number,
  target: BrowserTarget,
  opts: { endpointUnfixed?: boolean } = {},
): void {
  const now = new Date();
  app.db
    .insert(sessionBrowsers)
    .values({
      sessionId,
      projectId: target.projectId,
      targetHostId: target.hostId,
      targetCheckoutRoot: target.checkoutRoot,
      // "" = fixed with no endpoint; NULL = decided at first use (issue #2688).
      targetEndpoint: opts.endpointUnfixed ? null : (target.endpoint ?? ""),
      createdAt: now,
      lastAttachedAt: now,
    })
    .onConflictDoUpdate({
      target: sessionBrowsers.sessionId,
      set: { lastAttachedAt: now },
    })
    .run();
}

/** Records the binding of an attach that already launched (or proxied to) the
 * target, ending the attach window either way. When the insert fails — the
 * session row was deleted mid-launch and the foreign key rejects it, say — the
 * target is released (closed if nothing else uses it) and `false` is returned
 * so the caller can tell the panel. Never throws. */
export function recordBindingOrRelease(
  app: FastifyInstance,
  sessionId: number,
  target: BrowserTarget,
  attachDone: () => void,
): boolean {
  try {
    recordSessionBrowserBinding(app, sessionId, target);
    attachDone();
    return true;
  } catch (err) {
    app.log.warn({ err, sessionId, target }, "failed to record the session's browser binding");
    attachDone();
    void closeTargetIfUnused(app, target);
    return false;
  }
}

/** GET /api/sessions/:id/browser's data source — an array since the schema
 * (and the roadmap's own wording) leaves room for more than one binding per
 * session later; today this is always length 0 or 1. */
export function listSessionBrowserBindings(
  app: FastifyInstance,
  sessionId: number,
): Array<typeof sessionBrowsers.$inferSelect> {
  return app.db
    .select()
    .from(sessionBrowsers)
    .where(eq(sessionBrowsers.sessionId, sessionId))
    .all();
}

/** Stable key of a target across hosts: the pool key only names the target
 * within one machine's pool. */
function targetKey(target: BrowserTarget): string {
  return `${target.hostId}\0${browserTargetKey(target)}`;
}

// Attaches in flight, by target. A browser is launched (or a remote WS
// proxied) BEFORE the session's binding is recorded, so for that window the
// target has no binding yet; without this a session ending right then would
// close the browser out from under the viewer that is attaching (#2641).
const attachesInFlight = new Map<string, number>();

/** Marks an attach to `target` as in progress; call the returned function once
 * the binding is recorded or the attach failed. Idempotent. */
export function beginBrowserAttach(target: BrowserTarget): () => void {
  const key = targetKey(target);
  attachesInFlight.set(key, (attachesInFlight.get(key) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const left = (attachesInFlight.get(key) ?? 1) - 1;
    if (left <= 0) attachesInFlight.delete(key);
    else attachesInFlight.set(key, left);
  };
}

/** Whether a session other than `exceptSessionId` is bound to, or is attaching
 * to, `target` — the close path and the attach path agree on this. */
function targetInUse(
  app: FastifyInstance,
  project: typeof projects.$inferSelect,
  target: BrowserTarget,
  exceptSessionId?: number,
): boolean {
  const key = targetKey(target);
  if (attachesInFlight.has(key)) return true;
  return app.db
    .select()
    .from(sessionBrowsers)
    .where(
      exceptSessionId === undefined
        ? eq(sessionBrowsers.projectId, project.id)
        : and(
            eq(sessionBrowsers.projectId, project.id),
            ne(sessionBrowsers.sessionId, exceptSessionId),
          ),
    )
    .all()
    .some((other) => {
      const otherTarget = bindingBrowserTarget(project, other);
      return otherTarget !== null && targetKey(otherTarget) === key;
    });
}

/** Tears down a session's browser binding (#182: "session close kills
 * associated browser instances") — called from both killSession
 * (session-lifecycle.ts, reached via routes/sessions.ts's user-initiated
 * DELETE) and reconcileExitedSessions
 * (session-reconciler.ts, program-exited-on-its-own), in both cases *after*
 * the session's row has already been updated to killed/exited, and from the
 * explicit unbind (DELETE /api/sessions/:id/browser). Deletes this session's
 * own binding row(s) first, then closes the underlying target's browser ONLY
 * if no other session still holds a binding to it or is attaching to it. A
 * no-op when the session had no binding (the common case).
 *
 * Never throws: both callers have already committed the session's
 * killed/exited status by the time this runs, so a DB error here must not
 * surface as an HTTP 500 on an otherwise-successful kill — logged and
 * swallowed instead. The close itself is fire-and-forget; a remote close that
 * fails is recorded as pending and retried (`processPendingBrowserCloses`). */
export function closeSessionBrowserBindings(app: FastifyInstance, sessionId: number): void {
  try {
    const bindings = app.db
      .select()
      .from(sessionBrowsers)
      .where(eq(sessionBrowsers.sessionId, sessionId))
      .all();
    if (bindings.length === 0) return;

    app.db.delete(sessionBrowsers).where(eq(sessionBrowsers.sessionId, sessionId)).run();

    for (const binding of bindings) {
      const [project] = app.db
        .select()
        .from(projects)
        .where(eq(projects.id, binding.projectId))
        .all();
      if (!project) continue;
      const target = bindingBrowserTarget(project, binding);
      if (!target) continue;
      if (targetInUse(app, project, target, sessionId)) continue;
      void closeBrowserTarget(app, target);
    }
  } catch (err) {
    app.log.warn({ err, sessionId }, "failed to tear down session's browser binding");
  }
}

/** Closes `target` unless a session is bound to it or attaching to it. For an
 * attach that failed after it had launched the target, which no binding row
 * would ever close. Never throws. */
export async function closeTargetIfUnused(
  app: FastifyInstance,
  target: BrowserTarget,
): Promise<void> {
  try {
    if (!app.hasDecorator("db")) {
      // An agent host has no bindings: the primary owns them.
      return;
    }
    const [project] = app.db.select().from(projects).where(eq(projects.id, target.projectId)).all();
    if (!project || targetInUse(app, project, target)) return;
    await closeBrowserTarget(app, target);
  } catch (err) {
    app.log.warn({ err, target }, "failed to release an unused browser target");
  }
}

/** A checkout is being removed: closes every browser running in it, drops the
 * bindings that point at it and deletes the stored state of those targets
 * (the project-default target keeps its file). Never throws. */
export async function closeCheckoutBrowsers(
  app: FastifyInstance,
  projectId: number,
  hostId: string,
  checkoutRoot: string,
): Promise<void> {
  try {
    if (!app.hasDecorator("db")) return;
    const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
    if (!project) return;
    for (const binding of app.db
      .select()
      .from(sessionBrowsers)
      .where(eq(sessionBrowsers.projectId, projectId))
      .all()) {
      const bound = bindingBrowserTarget(project, binding);
      if (bound && bound.hostId === hostId && bound.checkoutRoot === checkoutRoot) {
        app.db.delete(sessionBrowsers).where(eq(sessionBrowsers.id, binding.id)).run();
      }
    }
    const root = projectCwdOnHost(project, hostId, parseHostCwds(project.hostCwds));
    // The project's own checkout is not "removed" by deleting a worktree.
    if (root === checkoutRoot) return;
    await closeBrowserTarget(
      app,
      { projectId, hostId, checkoutRoot, legacy: false },
      { forget: true },
    );
  } catch (err) {
    app.log.warn(
      { err, projectId, hostId, checkoutRoot },
      "failed to close removed checkout's browsers",
    );
  }
}

/** Closes one target's browser on the host that runs it: this process for the
 * local host, the owning agent otherwise. `forget` also deletes the target's
 * stored state. A remote close that cannot be delivered (host offline, agent
 * predates per-target browsers, request error) is recorded and retried by
 * `processPendingBrowserCloses` rather than dropped. Never throws. */
async function closeBrowserTarget(
  app: FastifyInstance,
  target: BrowserTarget,
  opts: { forget?: boolean } = {},
): Promise<void> {
  try {
    if (target.hostId === LOCAL_HOST_ID) {
      if (opts.forget)
        await app.browser.forgetCheckout(target.projectId, target.hostId, target.checkoutRoot);
      else await app.browser.closeTarget(target);
      return;
    }
    const failure = await deliverRemoteClose(app, target, opts.forget === true);
    if (failure) recordPendingClose(app, target, opts.forget === true, failure);
  } catch (err) {
    app.log.warn({ err, target }, "failed to close session's browser target");
  }
}

/** `null` when the host took the close, else why it did not. */
async function deliverRemoteClose(
  app: FastifyInstance,
  target: BrowserTarget,
  forget: boolean,
): Promise<string | null> {
  const gate = requireOperation(app, target.hostId, BROWSER_TARGETS_OPERATION);
  if (!gate.ok) return gate.message;
  try {
    await getRemoteHostClient(app, target.hostId).postBrowser(
      forget ? "/internal/browser/forget" : "/internal/browser/close",
      agentBrowserTarget(app, target),
    );
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

// Retry schedule for a close the host could not take: starts at a minute,
// doubles, capped at 15 minutes, and stops chasing after a day — the browser
// is then reported as leaked on that host.
const CLOSE_RETRY_BASE_MS = 60_000;
const CLOSE_RETRY_MAX_MS = 15 * 60_000;
export const CLOSE_RETRY_GIVE_UP_MS = 24 * 60 * 60_000;

function recordPendingClose(
  app: FastifyInstance,
  target: BrowserTarget,
  forget: boolean,
  error: string,
): void {
  const now = new Date();
  // A new close request for a target whose record already gave up re-arms it
  // with a fresh `createdAt` and attempt count, so its first failure does not
  // give up again at once on the old age (and it is no longer reported as
  // leaked while it is being retried). A record still being retried keeps its
  // own schedule.
  app.db
    .update(pendingBrowserCloses)
    .set({
      gaveUpAt: null,
      attempts: 0,
      createdAt: now,
      nextAttemptAt: new Date(now.getTime() + CLOSE_RETRY_BASE_MS),
      ...(forget ? { forget: true } : {}),
    })
    .where(
      and(
        eq(pendingBrowserCloses.projectId, target.projectId),
        eq(pendingBrowserCloses.hostId, target.hostId),
        eq(pendingBrowserCloses.checkoutRoot, target.checkoutRoot),
        eq(pendingBrowserCloses.endpoint, target.endpoint ?? ""),
        isNotNull(pendingBrowserCloses.gaveUpAt),
      ),
    )
    .run();
  app.db
    .insert(pendingBrowserCloses)
    .values({
      projectId: target.projectId,
      hostId: target.hostId,
      checkoutRoot: target.checkoutRoot,
      endpoint: target.endpoint ?? "",
      legacy: target.legacy,
      forget,
      lastError: error,
      nextAttemptAt: new Date(now.getTime() + CLOSE_RETRY_BASE_MS),
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: [
        pendingBrowserCloses.projectId,
        pendingBrowserCloses.hostId,
        pendingBrowserCloses.checkoutRoot,
        pendingBrowserCloses.endpoint,
      ],
      // Escalating to forget keeps the record forget; re-arming a record that
      // already gave up is done by the update above.
      set: {
        lastError: error,
        ...(forget ? { forget: true } : {}),
      },
    })
    .run();
  app.log.warn({ target, error }, "remote browser close not delivered; will retry");
}

/** Drops the pending closes of hosts that are no longer in the registry: no
 * retry can ever reach them, and a leaked count for them would show on no
 * host. Returns how many were dropped. */
export function pruneOrphanedPendingCloses(app: FastifyInstance): number {
  let pruned = 0;
  for (const row of app.db.select().from(pendingBrowserCloses).all()) {
    if (row.hostId === LOCAL_HOST_ID || getHostRow(app, row.hostId)) continue;
    app.db.delete(pendingBrowserCloses).where(eq(pendingBrowserCloses.id, row.id)).run();
    pruned++;
  }
  return pruned;
}

let processingPending = false;

/** Retries the closes the primary could not deliver. Run on a timer; a
 * success deletes the record, a failure backs off, and a record older than
 * `CLOSE_RETRY_GIVE_UP_MS` is kept as leaked (`listLeakedBrowserCloses`). A
 * target that a session has bound to since is left running. Never throws. */
export async function processPendingBrowserCloses(
  app: FastifyInstance,
  now: Date = new Date(),
): Promise<void> {
  if (processingPending || !app.hasDecorator("db")) return;
  processingPending = true;
  try {
    const pruned = pruneOrphanedPendingCloses(app);
    if (pruned > 0) app.log.info({ pruned }, "dropped pending browser closes of removed hosts");
    const due = app.db
      .select()
      .from(pendingBrowserCloses)
      .where(
        and(isNull(pendingBrowserCloses.gaveUpAt), lte(pendingBrowserCloses.nextAttemptAt, now)),
      )
      .all();
    for (const row of due) {
      const target: BrowserTarget = {
        projectId: row.projectId,
        hostId: row.hostId,
        checkoutRoot: row.checkoutRoot,
        legacy: row.legacy,
        ...(row.endpoint ? { endpoint: row.endpoint } : {}),
      };
      const [project] = app.db.select().from(projects).where(eq(projects.id, row.projectId)).all();
      const done = () =>
        app.db.delete(pendingBrowserCloses).where(eq(pendingBrowserCloses.id, row.id)).run();
      // A plain close of a target someone uses again is stale; a forget of a
      // removed checkout never is (its bindings were dropped with it).
      if (!project || (!row.forget && targetInUse(app, project, target))) {
        done();
        continue;
      }
      const failure = await deliverRemoteClose(app, target, row.forget);
      if (failure === null) {
        done();
        continue;
      }
      const attempts = row.attempts + 1;
      const gaveUp = now.getTime() - row.createdAt.getTime() >= CLOSE_RETRY_GIVE_UP_MS;
      app.db
        .update(pendingBrowserCloses)
        .set({
          attempts,
          lastError: failure,
          nextAttemptAt: new Date(
            now.getTime() + Math.min(CLOSE_RETRY_MAX_MS, CLOSE_RETRY_BASE_MS * 2 ** attempts),
          ),
          gaveUpAt: gaveUp ? now : null,
        })
        .where(eq(pendingBrowserCloses.id, row.id))
        .run();
      if (gaveUp)
        app.log.error({ target, failure }, "gave up closing a remote browser; it is leaked");
    }
  } catch (err) {
    app.log.warn({ err }, "retrying pending browser closes failed");
  } finally {
    processingPending = false;
  }
}

/** Remote browsers the primary stopped trying to close: still running on their
 * host until it restarts. For the Hosts view. */
export function listLeakedBrowserCloses(
  app: FastifyInstance,
): Array<typeof pendingBrowserCloses.$inferSelect> {
  // A removed host's rows would count as leaked on no host.
  pruneOrphanedPendingCloses(app);
  return app.db
    .select()
    .from(pendingBrowserCloses)
    .where(isNotNull(pendingBrowserCloses.gaveUpAt))
    .all();
}
