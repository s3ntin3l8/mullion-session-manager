// Force-deletes a task's branch on the host that owns the project's clone, for
// the two callers that clean up after a task (Abandon and clear-done). Routed
// through the project's SessionBackend, not the local function directly: a
// remote-hosted project's branch lives on that host's own filesystem.
import type { FastifyInstance } from "fastify";
import type { projects } from "../db/schema.js";
import { resolveBackend, unknownOutcomeMessage } from "./session-backend.js";

export interface TaskBranchDelete {
  deleted: boolean;
  reason?: string;
  /** Set with `reason: "outcome-unknown"`: the shared "may have been delivered" text. */
  detail?: string;
}

/**
 * Never throws. A connection lost after the delete was sent (#2703) is
 * `reason: "outcome-unknown"` with the shared wording in `detail`, NOT a plain
 * `delete-failed`: the branch may already be gone, so the caller must look
 * before trying again.
 */
export async function deleteTaskBranch(
  app: FastifyInstance,
  project: Pick<typeof projects.$inferSelect, "hostId" | "cwd">,
  branch: string,
): Promise<TaskBranchDelete> {
  try {
    const result = await resolveBackend(app, project.hostId).deleteBranch(project.cwd, branch, {
      force: true,
    });
    return {
      deleted: result.deleted,
      reason: result.deleted ? undefined : (result.reason ?? "delete-failed"),
    };
  } catch (err) {
    const unknown = unknownOutcomeMessage(err);
    app.log.warn(
      { err, branch },
      unknown ? "task branch delete: outcome unknown" : "task branch delete: deleteBranch threw",
    );
    return unknown
      ? { deleted: false, reason: "outcome-unknown", detail: unknown }
      : { deleted: false, reason: "delete-failed" };
  }
}
