// The effective cap on a task's automatic review rounds.
//
// It lives in its own module because the review spawner needs it
// (services/task-review-spawn.ts) and the reconciler needs it
// (services/task-reconciler.ts), and the spawner used to import the
// reconciler for the sake of one helper — an import cycle between two
// services (issue #2414).
//
// Today's default — a single automatic round for an advisory review agent's
// own findings was a reasonable default; a closed automatic loop (this
// follow-up's whole point) needs more than one chance before it strands a
// task in "reviewing" waiting for a human. Overridable per project via
// `projects.maxAutoReturnRounds` (null = use this default).
export const DEFAULT_MAX_AUTO_RETURN_ROUNDS = 10;

/**
 * The effective round cap for a project: its own `maxAutoReturnRounds` if set,
 * otherwise the install-wide `taskMaster.maxAutoReturnRounds` (default 10).
 * `0` at either level means unlimited and resolves to `Infinity`, so every
 * `rounds >= cap` comparison keeps working unchanged.
 */
export function resolveMaxAutoReturnRounds(
  project: { maxAutoReturnRounds: number | null },
  installCap: number = DEFAULT_MAX_AUTO_RETURN_ROUNDS,
): number {
  const cap = project.maxAutoReturnRounds ?? installCap;
  return cap === 0 ? Infinity : cap;
}
