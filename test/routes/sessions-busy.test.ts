import { describe, it, expect, vi } from "vitest";
import os from "node:os";
import { hosts, projects, sessions } from "../../src/db/schema.js";
import { buildApp } from "../../src/app.js";
import { HostBusyError } from "../../src/services/remote-host-errors.js";

describe("sessions route on a busy host", () => {
  it("GET /api/sessions reports suspended with busy detail for sessions on a busy host", async () => {
    const app = await buildApp();
    try {
      app.db
        .insert(hosts)
        .values({ id: "busy-sessions-host", name: "busy", baseUrl: "http://127.0.0.1:1" })
        .run();
      const projectId = app.db
        .insert(projects)
        .values({ name: "p-sessions-busy", cwd: os.tmpdir(), hostId: "busy-sessions-host" })
        .returning({ id: projects.id })
        .get().id;
      const row = app.db
        .insert(sessions)
        .values({ projectId, command: "bash", status: "active", hostId: "busy-sessions-host" })
        .returning()
        .get();

      const sessionBackendModule = await import("../../src/services/session-backend.js");
      const resolveBackendSpy = vi.spyOn(sessionBackendModule, "resolveBackend").mockReturnValue({
        liveStatus: vi
          .fn()
          .mockRejectedValue(new HostBusyError("busy-sessions-host", new Error("slot cap"))),
      } as never);

      try {
        const list = await app.inject({
          method: "GET",
          url: `/api/sessions?projectId=${projectId}`,
        });
        expect(list.statusCode).toBe(200);
        const session = list.json().find((s: { id: number }) => s.id === row.id);
        expect(session).toBeDefined();
        expect(session.sessionStatus).toBe("suspended");
        expect(session.sessionStatusDetail).toBe("host busy — may still be running");
      } finally {
        resolveBackendSpy.mockRestore();
      }
    } finally {
      await app.close();
    }
  });

  it("POST /api/sessions/:id/promote 503s retryable when createWorktree fails because host is busy", async () => {
    const app = await buildApp();
    try {
      app.db
        .insert(hosts)
        .values({ id: "busy-promote-host", name: "busy-promote", baseUrl: "http://127.0.0.1:1" })
        .run();
      const projectId = app.db
        .insert(projects)
        .values({ name: "p-promote-busy", cwd: os.tmpdir(), hostId: "busy-promote-host" })
        .returning({ id: projects.id })
        .get().id;
      const row = app.db
        .insert(sessions)
        .values({
          projectId,
          command: "bash",
          status: "active",
          hostId: "busy-promote-host",
          cwd: os.tmpdir(),
        })
        .returning()
        .get();

      const lifecycle = await import("../../src/services/session-lifecycle.js");
      const resolveSpy = vi.spyOn(lifecycle, "resolveWorktreeCwd").mockResolvedValue({
        created: false,
        reason: "host-busy",
        detail: "Host busy-promote-host is busy",
      });

      try {
        const res = await app.inject({
          method: "POST",
          url: `/api/sessions/${row.id}/promote`,
          payload: { baseRef: "main" },
        });
        expect(res.statusCode).toBe(503);
        expect(res.json()).toMatchObject({
          retryable: true,
          message: "Host busy-promote-host is busy",
        });
      } finally {
        resolveSpy.mockRestore();
      }
    } finally {
      await app.close();
    }
  });
});
