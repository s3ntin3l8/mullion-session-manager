import { describe, it, expect, vi, afterAll, beforeAll, afterEach } from "vitest";
import os from "node:os";
import type * as CheckoutRemoval from "../../src/services/checkout-removal.js";
import type * as TaskBranchDelete from "../../src/services/task-branch-delete.js";
import { plainNodePtyMock } from "../helpers/mock-pty.js";

vi.mock("node-pty", () => plainNodePtyMock());

const removal = vi.hoisted(() => ({ removeCheckoutForced: vi.fn() }));
vi.mock("../../src/services/checkout-removal.js", async (importActual) => ({
  ...(await importActual<typeof CheckoutRemoval>()),
  removeCheckoutForced: removal.removeCheckoutForced,
}));
const branch = vi.hoisted(() => ({ deleteTaskBranch: vi.fn() }));
vi.mock("../../src/services/task-branch-delete.js", async (importActual) => ({
  ...(await importActual<typeof TaskBranchDelete>()),
  deleteTaskBranch: branch.deleteTaskBranch,
}));

const { buildApp } = await import("../../src/app.js");
const { tasks } = await import("../../src/db/schema.js");
const { HostOutcomeUnknownError } = await import("../../src/services/remote-host-errors.js");
const { MutationOutcomeUnknownError } = await import("../../src/services/session-backend.js");

// Abandon (DELETE /api/tasks/:id?force=true) deletes the row first and then
// cleans up on the host. When that cleanup's connection drops after the request
// was sent, the worktree removal or the branch delete may or may not have run:
// the response says so (200 with the sentence) instead of a bare 204 (#2723).
describe("Abandon with an unknown cleanup outcome", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let projectId: number;

  beforeAll(async () => {
    app = await buildApp();
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, name: "abandon-unknown", cwd: os.tmpdir() },
    });
    projectId = project.json().id;
  });

  afterAll(async () => {
    await app?.close();
  });

  afterEach(() => {
    removal.removeCheckoutForced.mockReset();
    branch.deleteTaskBranch.mockReset();
  });

  function failedTask(title: string) {
    const [row] = app.db
      .insert(tasks)
      .values({
        projectId,
        title,
        status: "failed",
        failureReason: "session exited unexpectedly",
        worktreePath: "/work/trees/abandon-me",
        branchName: "mullion/task-abandon-me",
      })
      .returning()
      .all();
    return row!;
  }

  const lost = () =>
    new MutationOutcomeUnknownError(
      "h",
      "removeWorktree",
      new HostOutcomeUnknownError("h", new Error("link dropped")),
    );

  it("answers 204 when the cleanup is clean", async () => {
    removal.removeCheckoutForced.mockResolvedValue(true);
    branch.deleteTaskBranch.mockResolvedValue({ deleted: true });
    const row = failedTask("clean");
    const res = await app.inject({ method: "DELETE", url: `/api/tasks/${row.id}?force=true` });
    expect(res.statusCode).toBe(204);
  });

  it("says the worktree removal may have been delivered", async () => {
    removal.removeCheckoutForced.mockRejectedValue(lost());
    branch.deleteTaskBranch.mockResolvedValue({ deleted: true });
    const row = failedTask("worktree unknown");
    const res = await app.inject({ method: "DELETE", url: `/api/tasks/${row.id}?force=true` });
    expect(res.statusCode).toBe(200);
    expect(res.json().outcomeUnknown).toEqual(["the worktree removal"]);
    expect(res.json().message).toMatch(/the worktree removal MAY HAVE BEEN DELIVERED/);
  });

  it("says the branch delete may have been delivered, and both when both were", async () => {
    removal.removeCheckoutForced.mockRejectedValue(lost());
    branch.deleteTaskBranch.mockResolvedValue({
      deleted: false,
      reason: "outcome-unknown",
      detail: "link dropped",
    });
    const row = failedTask("both unknown");
    const res = await app.inject({ method: "DELETE", url: `/api/tasks/${row.id}?force=true` });
    expect(res.statusCode).toBe(200);
    expect(res.json().outcomeUnknown).toEqual(["the worktree removal", "the branch delete"]);
    expect(res.json().message).toMatch(
      /the worktree removal and the branch delete MAY HAVE BEEN DELIVERED/,
    );
  });

  it("does not call an ordinary cleanup failure an unknown outcome", async () => {
    removal.removeCheckoutForced.mockResolvedValue(false);
    branch.deleteTaskBranch.mockResolvedValue({ deleted: false, reason: "not-found" });
    const row = failedTask("plain failure");
    const res = await app.inject({ method: "DELETE", url: `/api/tasks/${row.id}?force=true` });
    expect(res.statusCode).toBe(204);
  });
});
