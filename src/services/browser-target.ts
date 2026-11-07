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
import { eq } from "drizzle-orm";
import { projects, type sessionBrowsers } from "../db/schema.js";
import type { BrowserTarget } from "./browser-manager.js";
import {
  executionContextErrorStatus,
  resolveExecutionContext,
  type ExecutionContext,
} from "./execution-context.js";
import { LOCAL_HOST_ID, getHostRow } from "./host-registry.js";
import { requireOperation } from "./host-agents.js";
import { listSessionBrowserBindings } from "./session-browsers.js";
import { parseHostCwds, projectCwdOnHost } from "./placement.js";

/** The negotiated agent operation that understands a per-target browser. An
 * agent without it would key its browser by project alone and share state
 * across checkouts, so it is refused rather than used. */
export const BROWSER_TARGETS_OPERATION = "browser-targets";

export type BrowserTargetResult =
  | { ok: true; target: BrowserTarget }
  | {
      ok: false;
      status: 400 | 501 | 503;
      message: string;
      /** `binding_unavailable`: the session's recorded target can no longer be
       * used and the session must unbind (DELETE /api/sessions/:id/browser)
       * to re-bind to its current host and checkout. */
      code?: "binding_unavailable";
    };

/** Target for an already-resolved execution context. `legacy` marks the
 * project's default checkout on its default host, which keeps the storage
 * state the project's browser had before targets existed. */
export function browserTargetFromContext(
  project: typeof projects.$inferSelect,
  context: ExecutionContext,
): BrowserTarget {
  const root = projectCwdOnHost(project, context.hostId, parseHostCwds(project.hostCwds));
  return {
    projectId: context.projectId,
    hostId: context.hostId,
    checkoutRoot: context.checkoutRoot,
    legacy: context.hostId === project.hostId && root !== null && context.checkoutRoot === root,
  };
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
  return { ok: true, target: browserTargetFromContext(project, result.context) };
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
            message: `${gone}. Unbind this session's browser (DELETE /api/sessions/${sessionId}/browser) to re-bind it to its current host and checkout.`,
          };
        }
        const gate = requireOperation(app, target.hostId, BROWSER_TARGETS_OPERATION);
        if (!gate.ok) return { ok: false, status: 501, message: gate.message };
        return { ok: true, target };
      }
    }
  }
  return resolveTarget(app, { projectId, sessionId });
}

/** The target a stored binding row points at. A row from before targets
 * existed (both columns NULL) is the explicit legacy mapping to the project's
 * default target. Synchronous: it only reads the row and the project. */
export function bindingBrowserTarget(
  project: typeof projects.$inferSelect,
  binding: Pick<
    typeof sessionBrowsers.$inferSelect,
    "projectId" | "targetHostId" | "targetCheckoutRoot"
  >,
): BrowserTarget | null {
  if (binding.targetHostId !== null && binding.targetCheckoutRoot !== null) {
    const root = projectCwdOnHost(project, binding.targetHostId, parseHostCwds(project.hostCwds));
    return {
      projectId: binding.projectId,
      hostId: binding.targetHostId,
      checkoutRoot: binding.targetCheckoutRoot,
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
