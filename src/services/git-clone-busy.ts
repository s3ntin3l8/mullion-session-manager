/**
 * The clones with a git operation in flight, keyed by `<hostId>:<cwd>`.
 *
 * The resource is the CLONE, not the project. Two project rows can point at
 * the same directory, and the background auto-fetch sweep runs `git fetch` on
 * a timer for every auto-fetch project — while the repair runs its own
 * `git fetch origin --prune` and rewrites the index of every worktree of the
 * clone.
 *
 * So the two have to exclude each other: a sweep landing inside a repair's
 * fetch window would fail the ref update, and the repair would report
 * "not whole" for a clone that is perfectly fine.
 *
 * The key is the one the auto-fetch sweep already used, and both now go
 * through this registry — so neither keeps a set the other cannot see.
 *
 * The caller decides what a busy clone means: the sweep SKIPS it (there will
 * be another tick), and the repair REFUSES it (the user is told to try again
 * in a moment). Neither waits.
 */

const busy = new Set<string>();

/** The registry key for a clone on a host. */
export function cloneKey(hostId: string, cwd: string): string {
  return `${hostId}:${cwd}`;
}

/** Whether a git operation on this clone is already running. */
export function isCloneBusy(hostId: string, cwd: string): boolean {
  return busy.has(cloneKey(hostId, cwd));
}

/** Claim a clone. The caller releases it in a `finally`. */
export function markCloneBusy(hostId: string, cwd: string): void {
  busy.add(cloneKey(hostId, cwd));
}

/** Release a clone. */
export function releaseClone(hostId: string, cwd: string): void {
  busy.delete(cloneKey(hostId, cwd));
}
