// Which browser a session (or a project-only caller) gets (issue #2448). The
// browser pool is keyed by an execution target — project + host + checkout —
// resolved through the shared execution-context resolver, the same one the
// session-scoped git routes and previews use, so the browser panel, the
// agent's automation and the preview all agree on where the session's
// application runs. Nothing here falls back to the project's host or default
// checkout when a session's own target cannot be resolved: inspecting the
// wrong application is worse than a refusal.
import type { FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { and, asc, eq, isNull } from "drizzle-orm";
import { previews, projects, sessionBrowsers } from "../db/schema.js";
import type { BrowserTarget } from "./browser-manager.js";
import {
  executionContextErrorStatus,
  resolveExecutionContext,
  type ExecutionContext,
} from "./execution-context.js";
import { LOCAL_HOST_ID, getHostRow } from "./host-registry.js";
import { hostSupports, requireOperation } from "./host-agents.js";
import { getRemoteHostClient } from "./remote-host-client.js";
import { getOrBindEndpoint, listSessionBrowserBindings } from "./session-browsers.js";
import { parseHostCwds, projectCwdOnHost } from "./placement.js";

/** The negotiated agent operation that understands a per-target browser. An
 * agent without it would key its browser by project alone and share state
 * across checkouts, so it is refused rather than used. */
export const BROWSER_TARGETS_OPERATION = "browser-targets";

/** The negotiated agent operation that keys a browser by preview endpoint and
 * accepts a session's target after spawn (issue #2688). Against an agent
 * without it the primary sends the legacy (empty) endpoint on every path. */
export const BROWSER_ENDPOINTS_OPERATION = "browser-endpoints";

// When a session's endpoint is fixed (issue #2688)
// -----------------------------------------------
// A session's browser endpoint is decided ONCE, when the session first binds a
// browser (the panel opens, or `use_browser`/the REST API drives it), from the
// preview row the session is serving at that moment, and is never changed
// afterwards: the binding row (`session_browsers.target_endpoint`) is the
// record. A session with no preview then keeps the legacy value ("") and the
// legacy storage file. A remote session's binding exists from spawn (so the
// session end can close its browser) but starts UNFIXED (NULL); the endpoint
// is resolved when the primary first serves the browser and is then pushed to
// the agent, which has no database of its own. If the agent already runs a
// context for the session it keeps that one and the primary adopts it, so a
// race can never leave two contexts.

/** `target` as an agent of `target.hostId` can use it: without its endpoint
 * when that agent does not negotiate `browser-endpoints`. */
export function agentBrowserTarget(app: FastifyInstance, target: BrowserTarget): BrowserTarget {
  if (!target.endpoint || target.hostId === LOCAL_HOST_ID) return target;
  if (hostSupports(app, target.hostId, BROWSER_ENDPOINTS_OPERATION)) return target;
  const { endpoint: _endpoint, ...rest } = target;
  return rest;
}

export type BrowserTargetResult =
  | { ok: true; target: BrowserTarget }
  | {
      ok: false;
      status: 400 | 501 | 503;
      message: string;
      /** `binding_unavailable`: the session's recorded target can no longer be
       * used and the session must unbind (DELETE /api/sessions/:id/browser;
       * the browser pane's "Re-bind"/"Unbind" and `mullion browser unbind`
       * call it) to re-bind to its current host and checkout. */
      code?: "binding_unavailable";
    };

/** Target for an already-resolved execution context. `legacy` marks the
 * project's default checkout on its default host, which keeps the storage
 * state the project's browser had before targets existed. */
export function browserTargetFromContext(
  project: typeof projects.$inferSelect,
  context: ExecutionContext,
  endpoint?: string,
): BrowserTarget {
  const root = projectCwdOnHost(project, context.hostId, parseHostCwds(project.hostCwds));
  return {
    projectId: context.projectId,
    hostId: context.hostId,
    checkoutRoot: context.checkoutRoot,
    ...(endpoint ? { endpoint } : {}),
    legacy: context.hostId === project.hostId && root !== null && context.checkoutRoot === root,
  };
}

/** The preview endpoint a session is serving (issues #2672, #2688): the slug of
 * the preview row bound to it, which names one preview of the checkout, so two
 * previews in one checkout get separate browser contexts. A branch preview
 * binds the dock session that runs it, in its own worktree, so it resolves its
 * own target; a project-wide checkout preview names its most recent accepter.
 * Undefined when the session has no preview, which is the legacy (empty)
 * endpoint. */
export function sessionPreviewEndpoint(
  app: FastifyInstance,
  sessionId: number,
  projectId?: number,
): string | undefined {
  const [row] = app.db
    .select({ slug: previews.slug })
    .from(previews)
    .where(
      projectId === undefined
        ? eq(previews.sessionId, sessionId)
        : and(eq(previews.sessionId, sessionId), eq(previews.projectId, projectId)),
    )
    .orderBy(asc(previews.id))
    .limit(1)
    .all();
  return row?.slug;
}

/** Fixes a remote session's endpoint: pushes `endpoint` to the agent, which
 * answers with the target it will serve (its own, when a context already runs
 * for the session). Null when the agent could not be reached. */
async function pushRemoteEndpoint(
  app: FastifyInstance,
  sessionId: number,
  target: BrowserTarget,
  endpoint: string,
): Promise<BrowserTarget | null> {
  try {
    const next = { ...target, endpoint };
    const answer = (await getRemoteHostClient(app, target.hostId).postBrowser(
      `/internal/sessions/${sessionId}/browser-target`,
      next,
      next,
    )) as { target?: BrowserTarget } | undefined;
    const kept = answer?.target;
    if (
      kept &&
      kept.hostId === target.hostId &&
      kept.checkoutRoot === target.checkoutRoot &&
      kept.projectId === target.projectId
    ) {
      const { endpoint: keptEndpoint, ...rest } = kept;
      return keptEndpoint ? { ...rest, endpoint: keptEndpoint } : rest;
    }
    return { ...target, endpoint };
  } catch (err) {
    app.log.warn({ err, sessionId, hostId: target.hostId }, "could not send the browser endpoint");
    return null;
  }
}

/** The endpoint of a REMOTE session's target at its first bind: the preview
 * the session serves, sent to the agent. Without agent support, or without a
 * preview, the legacy value. `fixed` is false when the agent was unreachable:
 * the caller must not record the legacy value as the session's final one. */
async function resolveRemoteEndpoint(
  app: FastifyInstance,
  sessionId: number,
  target: BrowserTarget,
): Promise<{ target: BrowserTarget; fixed: boolean }> {
  const { endpoint: _drop, ...legacy } = target;
  if (!hostSupports(app, target.hostId, BROWSER_ENDPOINTS_OPERATION)) {
    return { target: legacy, fixed: true };
  }
  const endpoint = sessionPreviewEndpoint(app, sessionId, target.projectId);
  if (!endpoint) return { target: legacy, fixed: true };
  const pushed = await pushRemoteEndpoint(app, sessionId, legacy, endpoint);
  return pushed ? { target: pushed, fixed: true } : { target: legacy, fixed: false };
}

async function resolveTarget(
  app: FastifyInstance,
  ref: Parameters<typeof resolveExecutionContext>[1],
): Promise<BrowserTargetResult> {
  const result = await resolveExecutionContext(app, ref);
  if (!result.ok) {
    return {
      ok: false,
      status: executionContextErrorStatus(result.error.code),
      message: result.error.message,
    };
  }
  const [project] = app.db
    .select()
    .from(projects)
    .where(eq(projects.id, result.context.projectId))
    .all();
  if (!project) return { ok: false, status: 400, message: "Project not found" };
  const gate = requireOperation(app, result.context.hostId, BROWSER_TARGETS_OPERATION);
  if (!gate.ok) return { ok: false, status: 501, message: gate.message };
  const sessionId = "sessionId" in ref && typeof ref.sessionId === "number" ? ref.sessionId : null;
  if (sessionId === null) {
    return { ok: true, target: browserTargetFromContext(project, result.context) };
  }
  if (result.context.hostId !== LOCAL_HOST_ID) {
    const base = browserTargetFromContext(project, result.context);
    const { target } = await resolveRemoteEndpoint(app, sessionId, base);
    return { ok: true, target };
  }
  const endpoint = sessionPreviewEndpoint(app, sessionId, project.id);
  return { ok: true, target: browserTargetFromContext(project, result.context, endpoint) };
}

/** Why a recorded binding can no longer be used, or null when it still can.
 * Only what the primary can know without a round trip: a host that is gone
 * from the registry, or a local checkout whose directory was deleted. A remote
 * host that is merely offline is NOT a reason — it reports unavailable on use
 * and the binding survives its return. */
function bindingUnavailableReason(app: FastifyInstance, target: BrowserTarget): string | null {
  if (target.hostId === LOCAL_HOST_ID) {
    return existsSync(target.checkoutRoot)
      ? null
      : `The browser's checkout ${target.checkoutRoot} no longer exists`;
  }
  const host = getHostRow(app, target.hostId);
  if (!host || (!host.baseUrl && !host.machineCredentialEnc)) {
    return `The browser's host ${target.hostId} is no longer available`;
  }
  return null;
}

/** The browser target of a session. An existing binding that still resolves
 * wins: a panel or automation that already opened a browser stays on that
 * target even if the session's placement changed since, so the pool entry, the
 * stored binding and the cleanup on session exit all name the same target. A
 * binding whose checkout or host is gone is reported unavailable (with the way
 * out) instead of failing until the session ends. Only a session with no
 * binding yet resolves its current host and checkout. */
export async function resolveSessionBrowserTarget(
  app: FastifyInstance,
  projectId: number,
  sessionId: number,
): Promise<BrowserTargetResult> {
  if (app.hasDecorator("db")) {
    const [binding] = listSessionBrowserBindings(app, sessionId);
    if (binding) {
      const [project] = app.db
        .select()
        .from(projects)
        .where(eq(projects.id, binding.projectId))
        .all();
      const target = project ? bindingBrowserTarget(project, binding) : null;
      if (target) {
        const gone = bindingUnavailableReason(app, target);
        if (gone) {
          return {
            ok: false,
            status: 400,
            code: "binding_unavailable",
            message: `${gone}. Unbind this session's browser to re-bind it to its current host and checkout: run \`mullion browser unbind\`, use "Re-bind" in the browser pane, or DELETE /api/sessions/${sessionId}/browser.`,
          };
        }
        const gate = requireOperation(app, target.hostId, BROWSER_TARGETS_OPERATION);
        if (!gate.ok) return { ok: false, status: 501, message: gate.message };
        if (target.hostId === LOCAL_HOST_ID) return { ok: true, target };
        if (binding.targetEndpoint === null) {
          // Not fixed yet (a spawn-time binding): decide it now, once.
          const fixed = await resolveRemoteEndpoint(app, sessionId, target);
          if (fixed.fixed) {
            app.db
              .update(sessionBrowsers)
              .set({ targetEndpoint: fixed.target.endpoint ?? "" })
              .where(
                and(
                  eq(sessionBrowsers.sessionId, sessionId),
                  isNull(sessionBrowsers.targetEndpoint),
                ),
              )
              .run();
            // A concurrent resolve may have fixed it first: that value wins.
            const [now] = listSessionBrowserBindings(app, sessionId);
            const winner = project && now ? bindingBrowserTarget(project, now) : null;
            if (winner) return { ok: true, target: agentBrowserTarget(app, winner) };
          }
          return { ok: true, target: fixed.target };
        }
        return { ok: true, target: agentBrowserTarget(app, target) };
      }
    }
  }
  const resolved = await resolveTarget(app, { projectId, sessionId });
  // A local session's endpoint is fixed here, once (issue #2701): the panel
  // and `use_browser` both come through this function before anything is
  // opened, and whichever binds first decides for both.
  if (resolved.ok && resolved.target.hostId === LOCAL_HOST_ID && app.hasDecorator("db")) {
    return { ok: true, target: getOrBindEndpoint(app, sessionId, resolved.target) };
  }
  return resolved;
}

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
