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
} from "../helpers/sessions-routes.js";
import { describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import http from "node:http";
import { eq } from "drizzle-orm";
import { projects, sessions } from "../../src/db/schema.js";
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
setupSessionsRouteLifecycle("host-routing");

describe("sessions route: which host owns a session operation", () => {
  // Issue #1727 / roadmap 8.13 — a session on a host that does not answer.
  describe("a session whose host is unreachable (issue #1727)", () => {
    it("reports it as SUSPENDED — not exited, and not the idle fallback", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      // A registered host that cannot be reached: the bulk live-status call
      // to it throws, which IS the "the host did not answer" case.
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "sleepy-laptop", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      expect(host.statusCode).toBe(201);
      const hostId = host.json().id as string;
      // The session row is inserted directly: spawning a session ON a remote
      // host needs that host to be alive, which is exactly what it is not.
      const row = app.db
        .insert(sessions)
        .values({ projectId, command: "bash", status: "active", hostId })
        .returning()
        .get();

      const list = await app.inject({ method: "GET", url: `/api/sessions?projectId=${projectId}` });
      const session = list.json().find((s: { id: number }) => s.id === row.id);
      expect(session).toBeDefined();
      expect(session.sessionStatus).toBe("suspended");
      // "dormant", not "gone" — the work may still be running there.
      expect(session.sessionStatusSeverity).toBe("dormant");
      // The raw column stays null-ish/raw: the EFFECTIVE host is what the
      // badge shows.
      expect(session.resolvedHostId).toBe(hostId);

      await app.close();
    });

    it("says a host that ANSWERED with an error rejected the request, not that it is unreachable (issue #2010)", async () => {
      // One host that is up and refuses (its INTERNAL_RATE_LIMIT answers 429)
      // and one that is down, in the SAME app: each row must be told apart.
      const refusing = http.createServer((_req, res) => {
        res.statusCode = 429;
        res.end("Too Many Requests");
      });
      await new Promise<void>((resolve) => refusing.listen(0, "127.0.0.1", resolve));
      const { port } = refusing.address() as AddressInfo;
      const app = await buildApp();
      try {
        const projectId = await createProject(app);
        const addHost = async (name: string, baseUrl: string) => {
          const res = await app.inject({
            method: "POST",
            url: "/api/hosts",
            payload: { name, baseUrl, token: "t" },
          });
          expect(res.statusCode).toBe(201);
          return res.json().id as string;
        };
        const refusingHostId = await addHost("rate-limited", `http://127.0.0.1:${port}`);
        // A real dead peer: an ephemeral port that was listening and is now
        // closed refuses the connection (port 1 is a fetch "bad port" that is
        // rejected before any socket is opened).
        const closed = http.createServer();
        await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
        const closedPort = (closed.address() as AddressInfo).port;
        await new Promise((resolve) => closed.close(resolve));
        const downHostId = await addHost("sleepy-laptop", `http://127.0.0.1:${closedPort}`);
        const insert = (hostId: string) =>
          app.db
            .insert(sessions)
            .values({ projectId, command: "bash", status: "active", hostId })
            .returning()
            .get();
        const refusedRow = insert(refusingHostId);
        const downRow = insert(downHostId);

        const list = await app.inject({
          method: "GET",
          url: `/api/sessions?projectId=${projectId}`,
        });
        const byId = new Map<number, { sessionStatus: string; sessionStatusDetail: string }>(
          list.json().map((s: { id: number }) => [s.id, s]),
        );
        expect(byId.get(refusedRow.id)?.sessionStatus).toBe("suspended");
        expect(byId.get(refusedRow.id)?.sessionStatusDetail).toBe(
          "host rejected the request (HTTP 429)",
        );
        expect(byId.get(downRow.id)?.sessionStatusDetail).toBe(
          "host unreachable — may still be running",
        );
      } finally {
        await app.close();
        await new Promise((resolve) => refusing.close(resolve));
      }
    });

    it("does NOT suspend a LOCAL session because ANOTHER host is unreachable", async () => {
      // The guard is per-HOST: one dead machine must not make another
      // machine's rows look suspended. With a single host in the app, code
      // that suspended every row on any host failure would still pass —
      // so this case puts a dead remote host AND a live local session in the
      // SAME app.
      const app = await buildApp();
      const projectId = await createProject(app);
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "sleepy-laptop", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const hostId = host.json().id as string;
      const remote = app.db
        .insert(sessions)
        .values({ projectId, command: "bash", status: "active", hostId })
        .returning()
        .get();
      const local = app.db
        .insert(sessions)
        .values({ projectId, command: "bash", status: "active" })
        .returning()
        .get();

      const list = await app.inject({ method: "GET", url: `/api/sessions?projectId=${projectId}` });
      const byId = new Map<number, { sessionStatus: string; resolvedHostId: string }>(
        list.json().map((s: { id: number }) => [s.id, s]),
      );
      expect(byId.get(remote.id)?.sessionStatus).toBe("suspended");
      expect(byId.get(local.id)?.sessionStatus).not.toBe("suspended");
      expect(byId.get(local.id)?.resolvedHostId).toBe("local");

      await app.close();
    });

    it("leaves a session on a HEALTHY host alone", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = created.json().id;

      const list = await app.inject({ method: "GET", url: `/api/sessions?projectId=${projectId}` });
      const session = list.json().find((s: { id: number }) => s.id === sessionId);
      expect(session.sessionStatus).not.toBe("suspended");
      // A local session's effective host is this machine.
      expect(session.resolvedHostId).toBe("local");

      await app.close();
    });
  });

  // Issue #1722 / roadmap 8.8 — a session operation goes to the SESSION's
  // host, not its project's. The route resolves the host BEFORE it talks
  // to any backend, so the assertion is on resolveBackend's own argument:
  // that is the host the operation was routed to.
  describe("the session's own host decides where a session operation goes (issue #1722)", () => {
    /** A remote host row (unreachable — the backend is faked below). */
    async function createRemoteHost(
      app: Awaited<ReturnType<typeof buildApp>>,
      name: string,
    ): Promise<string> {
      const res = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name, baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      return res.json().id as string;
    }

    it("routes a PLACED session's scrollback to the session's host", async () => {
      const app = await buildApp();
      const sessionBackendModule = await import("../../src/services/session-backend.js");
      const remoteHostId = await createRemoteHost(app, "placed-scrollback");
      const projectId = await createProject(app);

      const [placed] = app.db
        .insert(sessions)
        .values({ projectId, command: "bash", hostId: remoteHostId })
        .returning()
        .all();

      const spy = vi.spyOn(sessionBackendModule, "resolveBackend");
      spy.mockReturnValue({
        getScrollback: vi.fn().mockResolvedValue(Buffer.from("remote")),
        getRenderedScrollback: vi.fn().mockResolvedValue(""),
        getTranscript: vi.fn().mockResolvedValue({ ok: false, status: 404, error: "not running" }),
      } as unknown as ReturnType<typeof sessionBackendModule.resolveBackend>);

      const res = await app.inject({
        method: "GET",
        url: `/api/sessions/${placed.id}/scrollback`,
      });
      expect(res.statusCode).toBe(200);
      // The HOSTS the operation was routed to. (Not `toHaveBeenCalledWith`:
      // comparing the Fastify instance itself would deep-walk it, and its
      // `origin` getter reads an address this inject-only app never had.)
      expect(spy.mock.calls.map((call) => call[1])).toContain(remoteHostId);
      await app.close();
    });

    it("routes an INHERITING session's scrollback to its project's host", async () => {
      // Every pre-existing row is NULL here, and must keep resolving
      // exactly as it did before the column existed.
      const app = await buildApp();
      const sessionBackendModule = await import("../../src/services/session-backend.js");
      const projectId = await createProject(app);

      const [inheriting] = app.db
        .insert(sessions)
        .values({ projectId, command: "bash" })
        .returning()
        .all();

      const spy = vi.spyOn(sessionBackendModule, "resolveBackend");
      spy.mockReturnValue({
        getScrollback: vi.fn().mockResolvedValue(Buffer.from("local")),
        getRenderedScrollback: vi.fn().mockResolvedValue(""),
        getTranscript: vi.fn().mockResolvedValue({ ok: false, status: 404, error: "not running" }),
      } as unknown as ReturnType<typeof sessionBackendModule.resolveBackend>);

      const res = await app.inject({
        method: "GET",
        url: `/api/sessions/${inheriting.id}/scrollback`,
      });
      expect(res.statusCode).toBe(200);
      expect(spy.mock.calls.map((call) => call[1])).toContain("local");
      await app.close();
    });

    it("routes a PLACED session's file upload to the session's host", async () => {
      // The upload writes into the SESSION's cwd, and that path is on the
      // host the session runs on.
      const app = await buildApp();
      const sessionBackendModule = await import("../../src/services/session-backend.js");
      const remoteHostId = await createRemoteHost(app, "placed-upload");
      const projectId = await createProject(app);
      // A placed session's directory is the project's checkout ON that host.
      app.db
        .update(projects)
        .set({ hostCwds: JSON.stringify({ [remoteHostId]: "/srv/remote/checkout" }) })
        .where(eq(projects.id, projectId))
        .run();

      const [placed] = app.db
        .insert(sessions)
        .values({ projectId, command: "bash", hostId: remoteHostId })
        .returning()
        .all();

      const spy = vi.spyOn(sessionBackendModule, "resolveBackend");
      spy.mockReturnValue({
        uploadFile: vi.fn().mockResolvedValue(undefined),
      } as unknown as ReturnType<typeof sessionBackendModule.resolveBackend>);

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${placed.id}/uploads`,
        headers: { "content-type": "application/octet-stream", "x-upload-filename": "a.pdf" },
        payload: Buffer.from("data"),
      });
      expect(res.statusCode).toBe(200);
      expect(spy.mock.calls.map((call) => call[1])).toContain(remoteHostId);
      await app.close();
    });

    it("records the host a NEW session was created on (issue #1722)", async () => {
      // The insert is what makes the column meaningful: the row records the
      // host the session was spawned on, written ONCE, so every
      // session-scoped operation can find it again.
      const app = await buildApp();
      const projectId = await createProject(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });

      const [row] = app.db.select().from(sessions).where(eq(sessions.id, created.json().id)).all();
      expect(row?.hostId).toBe("local");
      await app.close();
    });

    it("routes the LIST's live-status call to the session's host too", async () => {
      // The list batches by host — one bulk liveStatus call per distinct
      // host — so the grouping itself has to follow the session's host.
      const app = await buildApp();
      const sessionBackendModule = await import("../../src/services/session-backend.js");
      const remoteHostId = await createRemoteHost(app, "placed-list");
      const projectId = await createProject(app);

      const [placed] = app.db
        .insert(sessions)
        .values({ projectId, command: "bash", status: "active", hostId: remoteHostId })
        .returning()
        .all();

      // Which host was asked for WHICH session ids — the list's batching is
      // per host, so the placement of ONE session has to show up in the
      // right group.
      const idsByHost = new Map<string, string[]>();
      const spy = vi.spyOn(sessionBackendModule, "resolveBackend");
      spy.mockImplementation((_app, hostId: string) => {
        const liveStatus = vi.fn(async (ids: string[]) => {
          idsByHost.set(hostId, ids);
          return {};
        });
        return { liveStatus } as unknown as ReturnType<typeof sessionBackendModule.resolveBackend>;
      });

      const res = await app.inject({ method: "GET", url: "/api/sessions" });
      expect(res.statusCode).toBe(200);
      // The placed session was asked for on ITS host...
      expect(idsByHost.get(remoteHostId)).toContain(String(placed.id));
      // ...and NOT on its project's host, which is where the old
      // project-derived grouping would have put it.
      expect(idsByHost.get("local") ?? []).not.toContain(String(placed.id));
      // ...and the placed session is still listed (its live status came
      // from its own host).
      const listed = (res.json() as Array<{ id: number }>).map((row) => row.id);
      expect(listed).toContain(placed.id);
      await app.close();
    });
  });
});
