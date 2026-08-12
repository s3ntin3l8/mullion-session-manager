import type { FastifyInstance } from "fastify";
import { eq, and, ne } from "drizzle-orm";
import { sessionBrowsers } from "../db/schema.js";

// Phase 3, issue #182 — the sessionId<->projectId binding table itself
// (schema.ts) has the full rationale for why this is one row per session
// rather than the roadmap's literal "multiple browser panes per session":
// BrowserManager (#179) pools one Chromium instance per *project*, shared
// across every session in it, so there's nothing distinct for a second
// binding to point at yet.

/** Upserts the (sessionId, projectId) binding — called from
 * attachSocketToBrowser (routes/browser.ts) on every successful connect, so
 * `lastAttachedAt` also tracks "was this session's browser recently used." */
export function recordSessionBrowserBinding(
  app: FastifyInstance,
  sessionId: number,
  projectId: number,
): void {
  const now = new Date();
  app.db
    .insert(sessionBrowsers)
    .values({ sessionId, projectId, createdAt: now, lastAttachedAt: now })
    .onConflictDoUpdate({
      target: sessionBrowsers.sessionId,
      // projectId isn't re-set here: a session's projectId is immutable
      // (routes/browser.ts always resolves it fresh from the session's own
      // row), so re-writing it on every reconnect would only ever write
      // back the same value it already has — this way the upsert's
      // *actual* effect (bump lastAttachedAt) is unambiguous.
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

    const projectIds = new Set(bindings.map((b) => b.projectId));
    for (const projectId of projectIds) {
      const [stillBound] = app.db
        .select()
        .from(sessionBrowsers)
        .where(
          and(eq(sessionBrowsers.projectId, projectId), ne(sessionBrowsers.sessionId, sessionId)),
        )
        .limit(1)
        .all();
      if (stillBound) continue; // another session still uses this project's browser

      app.browser.closeForProject(projectId).catch((err) => {
        app.log.warn({ err, projectId, sessionId }, "failed to close session's project browser");
      });
    }
  } catch (err) {
    app.log.warn({ err, sessionId }, "failed to tear down session's browser binding");
  }
}
