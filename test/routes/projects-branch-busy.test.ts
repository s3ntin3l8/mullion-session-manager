import { describe, it, expect, vi } from "vitest";
import os from "node:os";
import { hosts, projects } from "../../src/db/schema.js";
import { buildApp } from "../../src/app.js";
import { HostBusyError } from "../../src/services/remote-host-errors.js";

describe("POST /api/projects/:id guarded branch operations on a busy host", () => {
  it("503s retryable when resolveGitBranches fails because the host is busy", async () => {
    const app = await buildApp();
    try {
      app.db
        .insert(hosts)
        .values({ id: "busy-host", name: "busy", baseUrl: "http://127.0.0.1:1" })
        .run();
      const projectId = app.db
        .insert(projects)
        .values({ name: "p-busy", cwd: os.tmpdir(), hostId: "busy-host" })
        .returning({ id: projects.id })
        .get().id;

      const remoteHostClientModule = await import("../../src/services/remote-host-client.js");
      const clientSpy = vi.spyOn(remoteHostClientModule, "getRemoteHostClient").mockReturnValue({
        resolveGitBranches: vi
          .fn()
          .mockRejectedValue(new HostBusyError("busy-host", new Error("slot cap"))),
      } as never);

      try {
        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/git-checkout`,
          payload: { branch: "main" },
        });
        expect(res.statusCode).toBe(503);
        expect(res.json()).toMatchObject({ message: "Host busy-host is busy", retryable: true });
      } finally {
        clientSpy.mockRestore();
      }
    } finally {
      await app.close();
    }
  });

  it("503s retryable when the branch operation itself throws HostBusyError", async () => {
    const app = await buildApp();
    try {
      app.db
        .insert(hosts)
        .values({ id: "busy-host-2", name: "busy-2", baseUrl: "http://127.0.0.1:1" })
        .run();
      const projectId = app.db
        .insert(projects)
        .values({ name: "p-busy-2", cwd: os.tmpdir(), hostId: "busy-host-2" })
        .returning({ id: projects.id })
        .get().id;

      const remoteHostClientModule = await import("../../src/services/remote-host-client.js");
      const clientSpy = vi.spyOn(remoteHostClientModule, "getRemoteHostClient").mockReturnValue({
        resolveGitBranches: vi.fn().mockResolvedValue({ branches: [], worktrees: [] }),
      } as never);
      const sessionBackendModule = await import("../../src/services/session-backend.js");
      const backendSpy = vi.spyOn(sessionBackendModule, "resolveBackend").mockReturnValue({
        rebaseBranch: vi
          .fn()
          .mockRejectedValue(new HostBusyError("busy-host-2", new Error("channel busy"))),
      } as never);

      try {
        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/git-rebase`,
          payload: {},
        });
        expect(res.statusCode).toBe(503);
        expect(res.json()).toMatchObject({ message: "Host busy-host-2 is busy", retryable: true });
      } finally {
        clientSpy.mockRestore();
        backendSpy.mockRestore();
      }
    } finally {
      await app.close();
    }
  });
});
