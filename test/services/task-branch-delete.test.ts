import { describe, it, expect, vi, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import * as sessionBackend from "../../src/services/session-backend.js";
import { HostOutcomeUnknownError } from "../../src/services/remote-host-errors.js";
import { deleteTaskBranch } from "../../src/services/task-branch-delete.js";

// #2703 — a branch delete whose connection was lost after it was sent is an
// UNKNOWN outcome, reported as such (not as a plain delete-failed).
const app = { log: { warn: vi.fn() } } as unknown as FastifyInstance;
const project = { hostId: "h", cwd: "/repo" };

function backendDeleting(result: () => Promise<unknown>) {
  vi.spyOn(sessionBackend, "resolveBackend").mockReturnValue({
    deleteBranch: vi.fn(result),
  } as unknown as ReturnType<typeof sessionBackend.resolveBackend>);
}

describe("deleteTaskBranch (#2703)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports a delete", async () => {
    backendDeleting(() => Promise.resolve({ deleted: true }));
    expect(await deleteTaskBranch(app, project, "b")).toEqual({
      deleted: true,
      reason: undefined,
    });
  });

  it("passes the backend's own reason through", async () => {
    backendDeleting(() => Promise.resolve({ deleted: false, reason: "no-such-branch" }));
    expect(await deleteTaskBranch(app, project, "b")).toMatchObject({
      deleted: false,
      reason: "no-such-branch",
    });
  });

  it("reports an unknown outcome with the shared wording, not a plain delete-failed", async () => {
    backendDeleting(() =>
      Promise.reject(
        new sessionBackend.MutationOutcomeUnknownError(
          "h",
          "deleteBranch",
          new HostOutcomeUnknownError("h", new Error("closed")),
        ),
      ),
    );
    const result = await deleteTaskBranch(app, project, "b");
    expect(result).toMatchObject({ deleted: false, reason: "outcome-unknown" });
    expect(result.detail).toContain("MAY HAVE BEEN DELIVERED");
  });

  it("keeps delete-failed for any other failure", async () => {
    backendDeleting(() => Promise.reject(new Error("boom")));
    expect(await deleteTaskBranch(app, project, "b")).toEqual({
      deleted: false,
      reason: "delete-failed",
    });
  });
});
