import { randomUUID } from "node:crypto";
import type { RemoveOrphanResult } from "./dev-worktrees.js";
import type { OrphanRemovalStatus } from "../shared/types.js";
export type { OrphanRemovalStatus } from "../shared/types.js";

/** One explicit removal at a time; the last result survives page reloads. */
export function createOrphanRemovalJob() {
  let job: OrphanRemovalStatus = { state: "idle" };
  return {
    status: () => job,
    start(
      projectId: number,
      path: string,
      run: () => Promise<RemoveOrphanResult>,
    ): OrphanRemovalStatus | null {
      if (job.state === "running") return null;
      const current = {
        id: randomUUID(),
        projectId,
        path,
        state: "running" as const,
        startedAt: new Date().toISOString(),
      };
      job = current;
      void Promise.resolve()
        .then(run)
        .catch((): RemoveOrphanResult => ({ removed: false, reason: "unavailable" }))
        .then((result) => {
          job = { ...current, state: "done", finishedAt: new Date().toISOString(), result };
        });
      return current;
    },
  };
}
