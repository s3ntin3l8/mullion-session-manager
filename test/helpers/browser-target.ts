import type { FastifyInstance } from "fastify";
import type { BrowserTarget } from "../../src/services/browser-manager.js";

/** The browser target a session resolves to (launching its browser); throws when it has none. Imported
 * lazily so a test's env (DATABASE_URL, ...) is set before src/ loads. */
export async function sessionBrowserTarget(
  app: FastifyInstance,
  projectId: number,
  sessionId: number,
): Promise<BrowserTarget> {
  const { resolveSessionBrowserTarget } = await import("../../src/services/browser-target.js");
  const resolved = await resolveSessionBrowserTarget(app, projectId, sessionId);
  if (!resolved.ok) throw new Error(resolved.message);
  await app.browser.getOrLaunch(resolved.target).catch(() => {});
  return resolved.target;
}
