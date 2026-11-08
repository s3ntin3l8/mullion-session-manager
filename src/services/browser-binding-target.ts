// The lowest layer of the browser-binding state (issue #2713): the agent
// operations a per-target browser needs and the pure mapping from a stored
// `session_browsers` row to its target. It imports neither browser-target.ts
// nor session-browsers.ts, so both can read it without closing a cycle.
import type { projects, sessionBrowsers } from "../db/schema.js";
import type { BrowserTarget } from "./browser-manager.js";
import { parseHostCwds, projectCwdOnHost } from "./placement.js";

/** The negotiated agent operation that understands a per-target browser. An
 * agent without it would key its browser by project alone and share state
 * across checkouts, so it is refused rather than used. */
export const BROWSER_TARGETS_OPERATION = "browser-targets";

/** The negotiated agent operation that keys a browser by preview endpoint and
 * accepts a session's target after spawn (issue #2688). Against an agent
 * without it the primary sends the legacy (empty) endpoint on every path. */
export const BROWSER_ENDPOINTS_OPERATION = "browser-endpoints";

/** The target a stored binding row points at. A row from before targets
 * existed (both columns NULL) is the explicit legacy mapping to the project's
 * default target. Synchronous: it only reads the row and the project. */
export function bindingBrowserTarget(
  project: typeof projects.$inferSelect,
  binding: Pick<
    typeof sessionBrowsers.$inferSelect,
    "projectId" | "targetHostId" | "targetCheckoutRoot"
  > &
    Partial<Pick<typeof sessionBrowsers.$inferSelect, "targetEndpoint">>,
): BrowserTarget | null {
  if (binding.targetHostId !== null && binding.targetCheckoutRoot !== null) {
    const root = projectCwdOnHost(project, binding.targetHostId, parseHostCwds(project.hostCwds));
    return {
      projectId: binding.projectId,
      hostId: binding.targetHostId,
      checkoutRoot: binding.targetCheckoutRoot,
      ...(binding.targetEndpoint ? { endpoint: binding.targetEndpoint } : {}),
      legacy: binding.targetHostId === project.hostId && root === binding.targetCheckoutRoot,
    };
  }
  const root = projectCwdOnHost(project, project.hostId, parseHostCwds(project.hostCwds));
  if (root === null) return null;
  return {
    projectId: binding.projectId,
    hostId: project.hostId,
    checkoutRoot: root,
    legacy: true,
  };
}
