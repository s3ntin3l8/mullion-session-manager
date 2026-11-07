import type { FastifyInstance } from "fastify";
import type { RemoveIfCleanResult } from "./git-worktree.js";
import { resolveBackend } from "./session-backend.js";
import { closeCheckoutBrowsers } from "./session-browsers.js";

// The one way a project worktree is removed (issue #2687). A checkout can have
// browsers running in it (one context per execution target) and stored state
// under the browser data dir; removing the directory without telling the
// browser pool leaves both behind. Every removal goes through here so a new
// removal site gets the browser cleanup by construction, instead of having to
// remember a second call — do not call `backend.removeWorktree*` for a project
// checkout directly.

export interface CheckoutRemovalRef {
  /** The project the checkout belongs to. When unknown there is no browser
   * state to find, and only the worktree is removed. */
  projectId?: number | null;
  /** The host the checkout lives on. */
  hostId: string;
  worktreePath: string;
  /** The repository the worktree was cut from. */
  parentCwd?: string;
}

async function releaseBrowsers(app: FastifyInstance, ref: CheckoutRemovalRef): Promise<void> {
  if (ref.projectId === undefined || ref.projectId === null) return;
  await closeCheckoutBrowsers(app, ref.projectId, ref.hostId, ref.worktreePath);
}

/** Removes a worktree only when it is clean (never `--force`), then closes its
 * browsers and deletes their stored state. A refusal removes nothing, so the
 * browsers stay. */
export async function removeCheckoutIfClean(
  app: FastifyInstance,
  ref: CheckoutRemovalRef,
): Promise<RemoveIfCleanResult> {
  const result = await resolveBackend(app, ref.hostId).removeWorktreeIfClean(
    ref.worktreePath,
    ref.parentCwd,
  );
  if (result.removed) await releaseBrowsers(app, ref);
  return result;
}

/** Force-removes a worktree (discarding whatever is in it), then closes its
 * browsers and deletes their stored state. Resolves false, with the browsers
 * left running, when the removal failed. */
export async function removeCheckoutForced(
  app: FastifyInstance,
  ref: CheckoutRemovalRef,
): Promise<boolean> {
  const removed = await resolveBackend(app, ref.hostId).removeWorktree(
    ref.worktreePath,
    ref.parentCwd,
  );
  if (removed) await releaseBrowsers(app, ref);
  return removed;
}
