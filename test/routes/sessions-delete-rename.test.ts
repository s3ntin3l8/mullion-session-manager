// Must come before any import below that could itself trigger loading
// "node-pty"/"node:child_process" (e.g. the `node:child_process` import a
// few lines down) — see mock-pty.ts's header comment for the
// empirically confirmed hoisting/ordering failure mode.
import { createNodePtyMock } from "../helpers/mock-pty.js";
import {
  createProject,
  mockSpawnModule,
  opencodeTransferMock,
  setupSessionsRouteLifecycle,
  waitUntil,
} from "../helpers/sessions-routes.js";
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { sessions } from "../../src/db/schema.js";
import {
  CONTROL_SOCKET_VIA_HEADER,
  CONTROL_SOCKET_VIA_TOKEN,
} from "../../src/services/internal-request.js";
// Session creation spawns real OS processes (systemd-run, dtach) via
// PtyManager — faked here the same way as test/services/pty-manager.test.ts,
// so these files exercise the route/DB layer without depending on a real
// systemd --user session existing in CI. See that file for why.
//
// Each spawned fake PTY's onData listener array is captured here (not just
// created and discarded) so a scrollback-identity test can push real,
// distinguishable output through a specific session's PTY after the fact —
// see the "returns the base64-encoded scrollback buffer" test in test/routes/sessions-read.test.ts.
// `ptyMock.spawnedPtys[n].emitData(...)` (mock-pty.ts's listener-capturing
// variant) replaces the pre-split file's hand-rolled `fakePtyListeners` array.
const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));

// Issue #1733 — the agent's own argv reaches the dtach MASTER's spawn (the
// child_process one), not the attach client's node-pty spawn, so the mock's
// calls have to be reachable from the test.
vi.mock("node:child_process", async (importOriginal) => mockSpawnModule(await importOriginal()));

// Issue #271 follow-up — the opencode session transfer's own subprocess
// calls would otherwise hang; see mockSpawnModule's and opencodeTransferMock's
// doc comments in test/helpers/sessions-routes.ts.
vi.mock("../../src/services/opencode-session-transfer.js", () => opencodeTransferMock());

const { buildApp } = await import("../../src/app.js");

// This suite's own database, reset between tests — no test in this file can
// see another's rows, and no mock state leaks from one test into the next
// (see test/helpers/sessions-routes.ts).
setupSessionsRouteLifecycle("delete-rename");

describe("sessions route: deleting and renaming a session", () => {
  describe("DELETE /api/sessions/:id audit log", () => {
    async function withInfoSpy(
      run: (
        app: Awaited<ReturnType<typeof buildApp>>,
        info: ReturnType<typeof vi.spyOn>,
      ) => Promise<void>,
    ) {
      const app = await buildApp();
      const info = vi.spyOn(app.log, "info");
      try {
        await run(app, info);
      } finally {
        info.mockRestore();
        await app.close();
      }
    }

    it("records the caller before and the outcome after the kill", async () => {
      await withInfoSpy(async (app, info) => {
        const projectId = await createProject(app);
        const row = app.db
          .insert(sessions)
          .values({ projectId, command: "bash", status: "exited" })
          .returning()
          .get();
        const res = await app.inject({
          method: "DELETE",
          url: `/api/sessions/${row.id}`,
          headers: { "user-agent": "vitest-ua", referer: "http://x/ui" },
        });
        expect(res.statusCode).toBe(204);
        expect(info).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionId: row.id,
            cascade: "detach",
            via: "http",
            userAgent: "vitest-ua",
            referer: "http://x/ui",
          }),
          "session delete requested",
        );
        expect(info).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: row.id, found: true }),
          "session delete finished",
        );
      });
    });

    it("does not let a forged x-mullion-via header pass as the control socket", async () => {
      await withInfoSpy(async (app, info) => {
        // Same length as the real token, so the timingSafeEqual branch runs.
        const forgedToken = "0".repeat(CONTROL_SOCKET_VIA_TOKEN.length);
        for (const forged of ["control-socket", forgedToken]) {
          const res = await app.inject({
            method: "DELETE",
            url: "/api/sessions/999998",
            headers: { [CONTROL_SOCKET_VIA_HEADER]: forged },
          });
          expect(res.statusCode).toBe(404);
        }
        expect(info).not.toHaveBeenCalledWith(
          expect.objectContaining({ via: "control-socket" }),
          expect.anything(),
        );
        expect(info).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: 999998, via: "http" }),
          "session delete requested",
        );
      });
    });

    it("tags a request carrying the real token and records a miss as found:false", async () => {
      await withInfoSpy(async (app, info) => {
        const res = await app.inject({
          method: "DELETE",
          url: "/api/sessions/999999",
          headers: { [CONTROL_SOCKET_VIA_HEADER]: CONTROL_SOCKET_VIA_TOKEN },
        });
        expect(res.statusCode).toBe(404);
        expect(info).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: 999999, found: false, via: "control-socket" }),
          "session delete finished",
        );
      });
    });
  });

  it("DELETE on an exited session dismisses it (status becomes killed)", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);
    const row = app.db
      .insert(sessions)
      .values({ projectId, command: "bash", status: "exited" })
      .returning()
      .get();

    const res = await app.inject({ method: "DELETE", url: `/api/sessions/${row.id}` });
    expect(res.statusCode).toBe(204);
    const after = app.db.select().from(sessions).where(eq(sessions.id, row.id)).get();
    expect(after?.status).toBe("killed");

    await app.close();
  });

  it("rejects an invalid status querystring value", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/sessions?status=bogus" });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects an invalid kind in the create body", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash", kind: "bogus" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("defaults cwd to null (falls back to the project's cwd) when omitted", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" },
    });
    expect(created.json().cwd).toBeNull();

    await app.close();
  });

  it("rejects creating a session for an unknown project", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId: 999999, command: "bash" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("renames a session and locks the name against live OSC title updates (issue #69)", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" },
    });
    const sessionId = created.json().id;
    expect(created.json().nameLocked).toBe(false);

    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${sessionId}`,
      payload: { name: "my shell" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().name).toBe("my shell");
    expect(renamed.json().nameLocked).toBe(true);

    await app.close();
  });

  it("leaves nameLocked false for a launch-time name (e.g. CommandPalette's name pattern), unlike an explicit rename (issue #69)", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "claude", name: "claude · my-project" },
    });
    expect(created.json()).toMatchObject({ name: "claude · my-project", nameLocked: false });

    await app.close();
  });

  // #9 — settable at creation time, not just via a later PATCH: a caller
  // that wants a name to survive a live OSC title update (issue #69) needs
  // it pinned from the very first spawn, before the agent's own process
  // (and therefore its first title-changing escape sequence) can even
  // start. Task Master's own worker/review spawns are the first real
  // caller of this (task-claim.ts/task-reconciler.ts).
  it("persists nameLocked: true when explicitly passed at creation", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash", name: "Task #7 · worker", nameLocked: true },
    });
    expect(created.json()).toMatchObject({ name: "Task #7 · worker", nameLocked: true });

    await app.close();
  });

  it("404s renaming an unknown session", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/sessions/999999",
      payload: { name: "x" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  // Issue #1255 — #1223's sessions_stack_identity_unique index
  // (`(projectId, name) WHERE kind = 'dock' AND status = 'active' AND name
  // LIKE 'docker-stack:%'`) guards every INSERT-side caller, but this
  // route's raw UPDATE wasn't in #1223's own scope. Renaming an active
  // `kind: "dock"` session onto an already-active `docker-stack:<x>` name
  // in the SAME project must return a clean 409, not an uncaught
  // SqliteError surfacing as a generic 500. The index is scoped per
  // `projectId`, so this deliberately keeps both sessions in one project —
  // a cross-project rename onto the same name is an ordinary, unrelated
  // 200.
  it("409s renaming an active dock session onto an already-active docker-stack:<x> name in the same project (#1255)", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const existing = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: {
        projectId,
        command: "docker compose up",
        kind: "dock",
        name: "docker-stack:demo",
      },
    });
    expect(existing.statusCode).toBe(201);

    const other = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: {
        projectId,
        command: "docker compose logs -f api",
        kind: "dock",
        name: "docker-logs:api",
      },
    });
    const otherId = other.json().id as number;

    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${otherId}`,
      payload: { name: "docker-stack:demo" },
    });
    expect(renamed.statusCode).toBe(409);

    // Neither row was corrupted by the failed rename.
    const list = await app.inject({
      method: "GET",
      url: `/api/sessions?projectId=${projectId}`,
    });
    const rows = list.json() as Array<{ id: number; name: string; nameLocked: boolean }>;
    const otherRow = rows.find((s) => s.id === otherId);
    expect(otherRow?.name).toBe("docker-logs:api");
    expect(otherRow?.nameLocked).toBe(false);
    expect(rows.filter((s) => s.name === "docker-stack:demo")).toHaveLength(1);

    await app.close();
  });

  // Same collision, but the second session isn't `kind: "dock"` at all —
  // the index's own WHERE clause only ever matches a dock session, so this
  // must succeed as an ordinary rename; the catch must not over-trigger on
  // an unrelated session kind.
  it("an ordinary rename that happens to collide only by name, on a non-dock session, still succeeds", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: {
        projectId,
        command: "docker compose up",
        kind: "dock",
        name: "docker-stack:demo",
      },
    });

    const terminal = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" },
    });
    const terminalId = terminal.json().id as number;

    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${terminalId}`,
      payload: { name: "docker-stack:demo" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().name).toBe("docker-stack:demo");

    await app.close();
  });

  it("kills a session: marks it killed and stops reporting alive", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" },
    });
    const sessionId = created.json().id;
    await waitUntil(async () => {
      const list = await app.inject({ method: "GET", url: `/api/sessions?projectId=${projectId}` });
      return list.json()[0]?.alive === true;
    });

    const killed = await app.inject({ method: "DELETE", url: `/api/sessions/${sessionId}` });
    expect(killed.statusCode).toBe(204);

    const list = await app.inject({ method: "GET", url: `/api/sessions?projectId=${projectId}` });
    expect(list.json()).toEqual([
      expect.objectContaining({ id: sessionId, status: "killed", alive: false }),
    ]);

    await app.close();
  });
});
