import type { FastifyInstance } from "fastify";
import { eq, and, ne } from "drizzle-orm";
import { projects, sessionBrowsers } from "../db/schema.js";
import { browserTargetKey, type BrowserTarget } from "./browser-manager.js";
import { BROWSER_TARGETS_OPERATION, bindingBrowserTarget } from "./browser-target.js";
import { requireOperation } from "./host-agents.js";
import { LOCAL_HOST_ID } from "./host-registry.js";
import { getRemoteHostClient } from "./remote-host-client.js";

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
): void {
  const now = new Date();
  app.db
    .insert(sessionBrowsers)
    .values({
      sessionId,
      projectId: target.projectId,
      targetHostId: target.hostId,
      targetCheckoutRoot: target.checkoutRoot,
      createdAt: now,
      lastAttachedAt: now,
    })
    .onConflictDoUpdate({
      target: sessionBrowsers.sessionId,
      set: { lastAttachedAt: now },
    })
    .run();
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

/** Tears down a session's browser binding (#182: "session close kills
 * associated browser instances") — called from both killSession
 * (session-lifecycle.ts, reached via routes/sessions.ts's user-initiated
 * DELETE) and reconcileExitedSessions
 * (session-reconciler.ts, program-exited-on-its-own), in both cases *after*
 * the session's row has already been updated to killed/exited. Deletes this
 * session's own binding row(s) first, then closes the underlying project
 * browser ONLY if no other session still holds a binding to that same
 * project — BrowserManager's per-project pool means a sibling session in
 * the same project may still be using it. A no-op when the session had no
 * binding (the common case: most sessions never open a browser pane).
 *
 * Never throws: both callers have already committed the session's
 * killed/exited status by the time this runs, so a DB error here must not
 * surface as an HTTP 500 on an otherwise-successful kill (session-lifecycle.ts)
 * or abort reconcileExitedSessions' per-session loop partway through a host
 * group (session-reconciler.ts) — logged and swallowed instead, same
 * defensive posture as closeForProject's own .catch() below. */
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
      const key = `${target.hostId}\0${browserTargetKey(target)}`;
      const stillBound = app.db
        .select()
        .from(sessionBrowsers)
        .where(
          and(
            eq(sessionBrowsers.projectId, binding.projectId),
            ne(sessionBrowsers.sessionId, sessionId),
          ),
        )
        .all()
        .some((other) => {
          const otherTarget = bindingBrowserTarget(project, other);
          return (
            otherTarget !== null &&
            `${otherTarget.hostId}\0${browserTargetKey(otherTarget)}` === key
          );
        });
      if (stillBound) continue; // another session still uses this target's browser

      closeBrowserTarget(app, target).catch((err) => {
        app.log.warn({ err, target, sessionId }, "failed to close session's browser target");
      });
    }
  } catch (err) {
    app.log.warn({ err, sessionId }, "failed to tear down session's browser binding");
  }
}

/** Closes one target's browser on the host that runs it: this process for the
 * local host, the owning agent otherwise. A host that cannot be reached or
 * predates per-target browsers keeps its browser until it restarts. */
async function closeBrowserTarget(app: FastifyInstance, target: BrowserTarget): Promise<void> {
  if (target.hostId === LOCAL_HOST_ID) {
    await app.browser.closeTarget(target);
    return;
  }
  if (!requireOperation(app, target.hostId, BROWSER_TARGETS_OPERATION).ok) return;
  await getRemoteHostClient(app, target.hostId).postBrowser("/internal/browser/close", target);
}
