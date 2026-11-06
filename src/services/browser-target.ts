// Which browser a session (or a project-only caller) gets (issue #2448). The
// browser pool is keyed by an execution target — project + host + checkout —
// resolved through the shared execution-context resolver, the same one the
// session-scoped git routes and previews use, so the browser panel, the
// agent's automation and the preview all agree on where the session's
// application runs. Nothing here falls back to the project's host or default
// checkout when a session's own target cannot be resolved: inspecting the
// wrong application is worse than a refusal.
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { projects, type sessionBrowsers } from "../db/schema.js";
import type { BrowserTarget } from "./browser-manager.js";
import {
  executionContextErrorStatus,
  resolveExecutionContext,
  type ExecutionContext,
} from "./execution-context.js";
import { requireOperation } from "./host-agents.js";
import { listSessionBrowserBindings } from "./session-browsers.js";
import { parseHostCwds, projectCwdOnHost } from "./placement.js";

/** The negotiated agent operation that understands a per-target browser. An
 * agent without it would key its browser by project alone and share state
 * across checkouts, so it is refused rather than used. */
export const BROWSER_TARGETS_OPERATION = "browser-targets";

export type BrowserTargetResult =
  { ok: true; target: BrowserTarget } | { ok: false; status: 400 | 501 | 503; message: string };

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

/** The browser target of a session. An existing binding wins: a panel or
 * automation that already opened a browser stays on that target even if the
 * session's placement changed since, so the pool entry, the stored binding and
 * the cleanup on session exit all name the same target. Only a session with no
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
        const gate = requireOperation(app, target.hostId, BROWSER_TARGETS_OPERATION);
        if (!gate.ok) return { ok: false, status: 501, message: gate.message };
        return { ok: true, target };
      }
    }
  }
  return resolveTarget(app, { projectId, sessionId });
}

/** The project-default target. A caller with no session must ask for this
 * explicitly; the pool no longer answers "the project's browser". */
export function resolveProjectDefaultBrowserTarget(
  app: FastifyInstance,
  projectId: number,
): Promise<BrowserTargetResult> {
  return resolveTarget(app, { projectId, projectDefault: true });
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
