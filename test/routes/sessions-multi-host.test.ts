// Must come before any import below that could itself trigger loading
// "node-pty"/"node:child_process" (e.g. the `node:child_process` import a
// few lines down) — see mock-pty.ts's header comment for the
// empirically confirmed hoisting/ordering failure mode.
import { createNodePtyMock } from "../helpers/mock-pty.js";
import {
  PNG_BYTES,
  createProject,
  mockSpawnModule,
  opencodeTransferMock,
  setupSessionsRouteLifecycle,
  waitUntil,
} from "../helpers/sessions-routes.js";
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { sessions } from "../../src/db/schema.js";
import { seedHostResponse } from "../helpers/hosts.js";
// Session creation spawns real OS processes (systemd-run, dtach) via
// PtyManager — faked here the same way as test/helpers/pty-manager-harness.ts,
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
setupSessionsRouteLifecycle("multi-host");

describe("sessions route: multi-host", () => {
  describe("multi-host (issue #26)", () => {
    async function createRemoteProject(app: Awaited<ReturnType<typeof buildApp>>) {
      const host = await seedHostResponse(app, {
        name: "unreachable",
        baseUrl: "http://127.0.0.1:1",
        token: "t",
      });
      const hostId = host.json().id as string;
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { allowDuplicate: true, name: "remote-p", cwd: "/remote/path", hostId },
      });
      return project.json().id as number;
    }

    it("rolls back the session row when spawning on an unreachable remote host fails", async () => {
      const app = await buildApp();
      const projectId = await createRemoteProject(app);

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      expect(res.statusCode).toBe(502);

      const list = await app.inject({ method: "GET", url: `/api/sessions?projectId=${projectId}` });
      expect(list.json()).toEqual([]);

      await app.close();
    });

    it("reports default live status for a session whose host is unreachable, without 500ing", async () => {
      const app = await buildApp();

      const projectId = await createProject(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = created.json().id;

      const badHost = await seedHostResponse(app, {
        name: "goes-down",
        baseUrl: "http://127.0.0.1:1",
        token: "t",
      });
      const remoteProject = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          name: "remote-list",
          cwd: "/x",
          hostId: badHost.json().id,
        },
      });
      // Insert a session row directly (bypassing POST /api/sessions' spawn
      // step, which would fail/rollback for this unreachable host — see
      // the rollback test above) to exercise "list a session whose host is
      // currently unreachable" in isolation.
      const [orphan] = app.db
        .insert(sessions)
        .values({ projectId: remoteProject.json().id, command: "bash" })
        .returning()
        .all();

      const listRes = await app.inject({
        method: "GET",
        url: `/api/sessions?projectId=${remoteProject.json().id}`,
      });
      expect(listRes.statusCode).toBe(200);
      expect(listRes.json()).toEqual([
        expect.objectContaining({ id: orphan.id, alive: false, activity: "idle" }),
      ]);

      // The original local session is unaffected by the other host's
      // unreachability.
      const localList = await app.inject({
        method: "GET",
        url: `/api/sessions?projectId=${projectId}`,
      });
      expect(localList.json()).toEqual([expect.objectContaining({ id: sessionId })]);

      await app.close();
    });

    it("marks a session killed instead of 500ing when its host's terminate call fails (Hermes review, PR #34)", async () => {
      const app = await buildApp();

      const badHost = await seedHostResponse(app, {
        name: "goes-down-2",
        baseUrl: "http://127.0.0.1:1",
        token: "t",
      });
      const remoteProject = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          name: "remote-delete",
          cwd: "/x",
          hostId: badHost.json().id,
        },
      });
      const [orphan] = app.db
        .insert(sessions)
        .values({ projectId: remoteProject.json().id, command: "bash" })
        .returning()
        .all();

      const deleted = await app.inject({ method: "DELETE", url: `/api/sessions/${orphan.id}` });
      expect(deleted.statusCode).toBe(204);

      const list = await app.inject({
        method: "GET",
        url: `/api/sessions?projectId=${remoteProject.json().id}`,
      });
      expect(list.json()).toEqual([expect.objectContaining({ id: orphan.id, status: "killed" })]);

      await app.close();
    });

    // A9 — kill/attach TOCTOU: the row must read non-"active" BEFORE this
    // route awaits the host-side terminate() call, not only after it
    // resolves. Before the fix, a `/ws/terminal` upgrade landing in that
    // window would still see "active" (preValidation and the attach
    // re-check in terminal.ts both just read that column) and spawn a
    // brand-new systemd-run scope for a session this same request is in the
    // middle of tearing down — orphaning it the moment this request then
    // flips the row to "killed" underneath it. See
    // test/routes/terminal.test.ts's existing preValidation-rejects-
    // non-active coverage for the other half of this invariant (a
    // non-"active" row is refused reattachment) — this test proves the row
    // reaches that state before terminate() settles, closing the window
    // between the two.
    it("flips the row to killed BEFORE the host-side terminate() call resolves, not after (A9)", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = created.json().id as number;
      await waitUntil(async () => {
        const list = await app.inject({
          method: "GET",
          url: `/api/sessions?projectId=${projectId}`,
        });
        return list.json()[0]?.alive === true;
      });

      const sessionBackendModule = await import("../../src/services/session-backend.js");
      const realResolveBackend = sessionBackendModule.resolveBackend;
      let resolveTerminate!: () => void;
      const terminatePromise = new Promise<void>((resolve) => {
        resolveTerminate = resolve;
      });
      const resolveBackendSpy = vi
        .spyOn(sessionBackendModule, "resolveBackend")
        .mockImplementation((appArg, hostId) => {
          const real = realResolveBackend(appArg, hostId);
          return new Proxy(real, {
            get(target, prop, receiver) {
              if (prop === "terminate") return () => terminatePromise;
              const value = Reflect.get(target, prop, receiver);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        });

      const deletePromise = app.inject({ method: "DELETE", url: `/api/sessions/${sessionId}` });

      await waitUntil(() => {
        const [row] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
        return row?.status === "killed";
      });

      // The terminate() call is still pending (deliberately never resolved
      // yet) — proving the row already reads "killed" WHILE it's in flight,
      // not only once it settles.
      const [midFlightRow] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
      expect(midFlightRow.status).toBe("killed");

      resolveTerminate();
      const deleted = await deletePromise;
      expect(deleted.statusCode).toBe(204);

      resolveBackendSpy.mockRestore();
      await app.close();
    });

    it("502s an image upload for a session whose remote host is unreachable (issue #68)", async () => {
      const app = await buildApp();

      const projectId = await createRemoteProject(app);
      const [orphan] = app.db
        .insert(sessions)
        .values({ projectId, command: "bash" })
        .returning()
        .all();

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${orphan.id}/uploads`,
        headers: { "content-type": "image/png" },
        payload: PNG_BYTES,
      });
      expect(res.statusCode).toBe(502);

      await app.close();
    });

    it("502s a review-gate decision for a session whose remote host is unreachable (issue #178)", async () => {
      const app = await buildApp();

      const projectId = await createRemoteProject(app);
      const [orphan] = app.db
        .insert(sessions)
        .values({ projectId, command: "bash" })
        .returning()
        .all();

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${orphan.id}/review-gate`,
        payload: { decision: "approved" },
      });
      expect(res.statusCode).toBe(502);

      await app.close();
    });

    it("502s an attention ack for a session whose remote host is unreachable (issue #1472)", async () => {
      const app = await buildApp();

      const projectId = await createRemoteProject(app);
      const [orphan] = app.db
        .insert(sessions)
        .values({ projectId, command: "bash" })
        .returning()
        .all();

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${orphan.id}/attention/ack`,
      });
      expect(res.statusCode).toBe(502);

      await app.close();
    });

    // Issue #1472 — routes a remote-hosted session's attention/ack through
    // resolveBackend/SessionBackend, the same way review-gate/promote
    // already do; mocks resolveBackend (rather than a real host) to
    // exercise the route's own ok:true/ok:false/thrown-error branches
    // directly, mirroring option 2's own makeFakeBackend pattern above.
    describe("POST /api/sessions/:id/attention/ack (issue #1472)", () => {
      async function createRemoteAttentionProject(app: Awaited<ReturnType<typeof buildApp>>) {
        const host = await seedHostResponse(app, {
          name: "attention-ack-remote",
          baseUrl: "http://127.0.0.1:1",
          token: "t",
        });
        const hostId = host.json().id as string;
        const project = await app.inject({
          method: "POST",
          url: "/api/projects",
          payload: {
            allowDuplicate: true,
            name: "remote-attention-ack-p",
            cwd: "/remote/project",
            hostId,
          },
        });

        const [row] = app.db
          .insert(sessions)
          .values({ projectId: project.json().id as number, command: "bash" })
          .returning()
          .all();
        return row.id as number;
      }

      function makeFakeBackend(acknowledgeAttention: ReturnType<typeof vi.fn>) {
        return { acknowledgeAttention };
      }

      it("204s when the owning host reports ok: true", async () => {
        const app = await buildApp();
        const sessionBackendModule = await import("../../src/services/session-backend.js");
        const sessionId = await createRemoteAttentionProject(app);

        const fakeBackend = makeFakeBackend(vi.fn().mockResolvedValue(true));
        const resolveBackendSpy = vi
          .spyOn(sessionBackendModule, "resolveBackend")
          .mockReturnValue(fakeBackend as never);

        const res = await app.inject({
          method: "POST",
          url: `/api/sessions/${sessionId}/attention/ack`,
        });
        expect(res.statusCode).toBe(204);
        expect(fakeBackend.acknowledgeAttention).toHaveBeenCalledWith(String(sessionId));

        resolveBackendSpy.mockRestore();
        await app.close();
      });

      it("409s when the owning host reports ok: false (still blocked, or not tracked there either)", async () => {
        const app = await buildApp();
        const sessionBackendModule = await import("../../src/services/session-backend.js");
        const sessionId = await createRemoteAttentionProject(app);

        const fakeBackend = makeFakeBackend(vi.fn().mockResolvedValue(false));
        const resolveBackendSpy = vi
          .spyOn(sessionBackendModule, "resolveBackend")
          .mockReturnValue(fakeBackend as never);

        const res = await app.inject({
          method: "POST",
          url: `/api/sessions/${sessionId}/attention/ack`,
        });
        expect(res.statusCode).toBe(409);

        resolveBackendSpy.mockRestore();
        await app.close();
      });

      it("502s when delivering the ack throws (HostRequestError, e.g. a 404 from an agent build that predates this route)", async () => {
        const app = await buildApp();
        const sessionBackendModule = await import("../../src/services/session-backend.js");
        const { HostRequestError } = await import("../../src/services/remote-host-client.js");
        const sessionId = await createRemoteAttentionProject(app);

        const fakeBackend = makeFakeBackend(
          vi.fn().mockRejectedValue(new HostRequestError("attention-ack-remote", 404, "not found")),
        );
        const resolveBackendSpy = vi
          .spyOn(sessionBackendModule, "resolveBackend")
          .mockReturnValue(fakeBackend as never);

        const res = await app.inject({
          method: "POST",
          url: `/api/sessions/${sessionId}/attention/ack`,
        });
        expect(res.statusCode).toBe(502);

        resolveBackendSpy.mockRestore();
        await app.close();
      });

      it("502s when delivering the ack throws (HostUnreachableError)", async () => {
        const app = await buildApp();
        const sessionBackendModule = await import("../../src/services/session-backend.js");
        const { HostUnreachableError } = await import("../../src/services/remote-host-client.js");
        const sessionId = await createRemoteAttentionProject(app);

        const fakeBackend = makeFakeBackend(
          vi.fn().mockRejectedValue(new HostUnreachableError("attention-ack-remote", "refused")),
        );
        const resolveBackendSpy = vi
          .spyOn(sessionBackendModule, "resolveBackend")
          .mockReturnValue(fakeBackend as never);

        const res = await app.inject({
          method: "POST",
          url: `/api/sessions/${sessionId}/attention/ack`,
        });
        expect(res.statusCode).toBe(502);

        resolveBackendSpy.mockRestore();
        await app.close();
      });
    });
  });
});
