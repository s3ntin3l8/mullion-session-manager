import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { SessionBackend } from "../../src/services/session-backend.js";

vi.mock("../../src/services/task-github-sync.js", () => ({
  syncTaskTransition: vi.fn().mockResolvedValue(undefined),
}));

const { buildApp } = await import("../../src/app.js");
const { retryTask, failQueuedTask } = await import("../../src/services/task-claim.js");
const { tasks, projects } = await import("../../src/db/schema.js");
const sessionBackendModule = await import("../../src/services/session-backend.js");
const { HostRequestError } = await import("../../src/services/remote-host-client.js");

// A failed task carries a failure-diagnostics snapshot from the run that
// failed; a retry that fails again for a different reason must not present
// that old snapshot as the new failure's diagnostics.
describe("retryTask clears the failure diagnostics snapshot", () => {
  it("when the retry releases back to failed on an unresumable branch", async () => {
    const app = await buildApp();
    const [project] = app.db
      .insert(projects)
      .values({ name: "diag-retry-p", cwd: "/remote/project", hostId: "remote-host-1" })
      .returning()
      .all();
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId: project.id,
        title: "t",
        status: "failed",
        failureReason: "agent ended its turn with no commits",
        failureDiagnostics: "Terminal tail (last 40 lines):\nOLD RUN OUTPUT",
        branchName: "mullion/task-10",
        worktreePath: "/remote/project/.mullion-worktrees/mullion-task-10",
      })
      .returning()
      .all();
    const backend = {
      resumeTaskWorktree: vi.fn().mockRejectedValue(new HostRequestError("remote-host-1", 404, "")),
      terminate: vi.fn().mockResolvedValue(undefined),
      liveStatus: vi.fn().mockResolvedValue({}),
      liveness: vi.fn().mockResolvedValue({}),
      removeWorktreeIfClean: vi.fn().mockResolvedValue({ removed: false, reason: "not-a-repo" }),
      clearOrphanedTaskWorktree: vi.fn().mockResolvedValue({ cleared: true }),
    } as unknown as SessionBackend;
    vi.spyOn(sessionBackendModule, "resolveBackend").mockReturnValue(backend);

    const outcome = await retryTask(app, task.id);

    expect(outcome.ok).toBe(false);
    const [row] = app.db.select().from(tasks).where(eq(tasks.id, task.id)).all();
    expect(row.status).toBe("failed");
    expect(row.failureDiagnostics).toBeNull();
    await app.close();
  });
});

// failQueuedTask rewrites failureReason on a claimed row; a snapshot left on
// the row by an earlier failed run must not survive that rewrite.
describe("failQueuedTask clears the failure diagnostics snapshot", () => {
  it("when it fails a claimed task with a new reason", async () => {
    const app = await buildApp();
    const [project] = app.db
      .insert(projects)
      .values({ name: "diag-queued-p", cwd: "/tmp/diag-queued" })
      .returning()
      .all();
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId: project.id,
        title: "t",
        status: "claimed",
        failureReason: "old",
        failureDiagnostics: "Terminal tail (last 40 lines):\nOLD RUN OUTPUT",
      })
      .returning()
      .all();

    const failed = failQueuedTask(app, task.id, {
      detail: "placement refused",
      via: "placement-refusal",
      hostId: null,
    });

    expect(failed).toBe(true);
    const [row] = app.db.select().from(tasks).where(eq(tasks.id, task.id)).all();
    expect(row.status).toBe("failed");
    expect(row.failureReason).toBe("placement refused");
    expect(row.failureDiagnostics).toBeNull();
    await app.close();
  });
});
