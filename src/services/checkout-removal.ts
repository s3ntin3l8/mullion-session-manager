import type { FastifyInstance } from "fastify";
import type {
  ClearOrphanedTaskWorktreeResult,
  PruneWorktreesResult,
  RemoveIfCleanResult,
  RemoveListedWorktreeResult,
} from "./git-worktree.js";
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

/** A listed worktree removed through `removeListedWorktree` (the reclaim and
 * dev-worktree sweeps): `cwd` is the repository it is listed in. A checkout
 * whose directory was already gone counts as removed, so its browsers and
 * stored state go too. */
export async function removeListedCheckout(
  app: FastifyInstance,
  ref: CheckoutRemovalRef & { cwd: string },
  opts: { force?: boolean } = {},
): Promise<RemoveListedWorktreeResult> {
  const result = await resolveBackend(app, ref.hostId).removeListedWorktree(
    ref.cwd,
    ref.worktreePath,
    opts,
  );
  if (result.removed || result.reason === "directory-gone") await releaseBrowsers(app, ref);
  return result;
}

/** Sweeps orphaned task worktrees of one project, then releases the browsers
 * of each one that was removed. */
export async function pruneCheckouts(
  app: FastifyInstance,
  ref: { projectId?: number | null; hostId: string; cwd: string },
  orphanPaths: string[],
): Promise<PruneWorktreesResult> {
  const result = await resolveBackend(app, ref.hostId).pruneWorktrees(ref.cwd, orphanPaths);
  for (const worktreePath of result.removed) {
    await releaseBrowsers(app, { ...ref, worktreePath });
  }
  return result;
}

/** Clears a leftover worktree (and branch) from an earlier attempt at the same
 * path, then releases the browsers keyed to that path: the new worktree reuses
 * it, and a context still keyed to the old one would point at the wrong
 * checkout. */
export async function clearOrphanedCheckout(
  app: FastifyInstance,
  ref: CheckoutRemovalRef & { cwd: string },
  branchName: string,
): Promise<ClearOrphanedTaskWorktreeResult> {
  const result = await resolveBackend(app, ref.hostId).clearOrphanedTaskWorktree(
    ref.cwd,
    ref.worktreePath,
    branchName,
  );
  if (result.cleared) await releaseBrowsers(app, ref);
  return result;
}

/** `removeCheckoutForced` with positional arguments, for call sites that
 * already hold every part of the ref. */
export function forceRemoveCheckout(
  app: FastifyInstance,
  projectId: number | null | undefined,
  hostId: string,
  worktreePath: string,
  parentCwd?: string,
): Promise<boolean> {
  return removeCheckoutForced(app, { projectId, hostId, worktreePath, parentCwd });
}

/** The `remove` closure of a tracked preview worktree (git-worktree.ts's
 * `PreviewWorktreeInfo.remove`): force-removes through the helper on every
 * host, never rejects, and logs a failing host once per outage via `logError`
 * (`alreadyWarned` is whether the previous attempt already logged). */
export function previewRemover(
  app: FastifyInstance,
  ref: { projectId: number; hostId: string; worktreePath: string; parentCwd: string },
  logError: (
    app: FastifyInstance,
    op: "remove",
    hostId: string,
    worktreePath: string,
    err: unknown,
    alreadyWarned: boolean,
  ) => false,
): () => Promise<boolean> {
  let warned = false;
  return async () => {
    try {
      const result = await removeCheckoutForced(app, ref);
      warned = false;
      return result;
    } catch (err) {
      const already = warned;
      warned = true;
      return logError(app, "remove", ref.hostId, ref.worktreePath, err, already);
    }
  };
}
