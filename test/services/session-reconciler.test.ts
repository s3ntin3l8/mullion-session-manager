import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";

// Session creation still spawns real OS processes (systemd-run, dtach) via
// PtyManager — faked the same way as test/routes/sessions.test.ts, since
// this test drives real create/list through the actual app + DB rather
// than hand-faking drizzle's query builder.
vi.mock("node-pty", () => ({
  spawn: vi.fn(() => ({
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      const ee = new EventEmitter();
      setImmediate(() => ee.emit("exit", 0));
      return ee;
    }),
  };
});

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { reconcileExitedSessions } = await import("../../src/services/session-reconciler.js");

const tmpDb = path.join(os.tmpdir(), `session-reconciler-test-${process.pid}.db`);

describe("reconcileExitedSessions", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function createSession(app: Awaited<ReturnType<typeof buildApp>>) {
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "p", cwd: "/tmp" },
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId: project.json().id, command: "bash" },
    });
    return created.json().id as number;
  }

  // Runs first, deliberately, while the shared test-file DB still has zero
  // rows — later tests create sessions whose active/exited state would
  // otherwise make "no active sessions at all" untrue by the time this ran.
  it("is a no-op when there are no active sessions", async () => {
    const app = await buildApp();
    const isMasterAliveSpy = vi.spyOn(app.pty, "isMasterAlive").mockResolvedValue(true);

    await expect(reconcileExitedSessions(app)).resolves.toBeUndefined();
    expect(isMasterAliveSpy).not.toHaveBeenCalled();

    await app.close();
  });

  it("leaves an active session alone when its scope is still alive", async () => {
    const app = await buildApp();
    const sessionId = await createSession(app);
    vi.spyOn(app.pty, "isMasterAlive").mockResolvedValue(true);

    await reconcileExitedSessions(app);

    const res = await app.inject({ method: "GET", url: "/api/sessions" });
    const row = (res.json() as Array<{ id: number; status: string }>).find(
      (s) => s.id === sessionId,
    );
    expect(row?.status).toBe("active");

    await app.close();
  });

  it("flips an active session to exited once its scope is no longer alive", async () => {
    const app = await buildApp();
    const sessionId = await createSession(app);
    vi.spyOn(app.pty, "isMasterAlive").mockResolvedValue(false);

    await reconcileExitedSessions(app);

    const res = await app.inject({ method: "GET", url: "/api/sessions" });
    const row = (res.json() as Array<{ id: number; status: string }>).find(
      (s) => s.id === sessionId,
    );
    expect(row?.status).toBe("exited");

    await app.close();
  });

  it("does not touch an already-killed session", async () => {
    const app = await buildApp();
    const sessionId = await createSession(app);
    await app.inject({ method: "DELETE", url: `/api/sessions/${sessionId}` });

    const isMasterAliveSpy = vi.spyOn(app.pty, "isMasterAlive").mockResolvedValue(false);
    await reconcileExitedSessions(app);

    // The row was already "killed" (not "active"), so it's outside the
    // query the reconciler selects — isMasterAlive should never be asked
    // about it at all.
    expect(isMasterAliveSpy).not.toHaveBeenCalledWith(String(sessionId));

    const res = await app.inject({ method: "GET", url: "/api/sessions" });
    const row = (res.json() as Array<{ id: number; status: string }>).find(
      (s) => s.id === sessionId,
    );
    expect(row?.status).toBe("killed");

    await app.close();
  });

  describe("multi-host (issue #26)", () => {
    it("skips an unreachable remote host's sessions entirely, never flipping them to exited", async () => {
      const app = await buildApp();
      // A local session, alive, alongside a remote one on an unreachable
      // host — the whole point of this test is that the *local* group must
      // still reconcile normally even while the remote group's host is
      // down (grouped-by-host, one failure doesn't abort the other group).
      const localSessionId = await createSession(app);
      vi.spyOn(app.pty, "isMasterAlive").mockResolvedValue(true);

      const badHost = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "goes-down", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const remoteProject = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "remote-p", cwd: "/x", hostId: badHost.json().id },
      });
      const { sessions } = await import("../../src/db/schema.js");
      const [remoteRow] = app.db
        .insert(sessions)
        .values({ projectId: remoteProject.json().id, command: "bash" })
        .returning()
        .all();

      await reconcileExitedSessions(app);

      const res = await app.inject({ method: "GET", url: "/api/sessions" });
      const rows = res.json() as Array<{ id: number; status: string }>;
      // Local session still reconciles (still active — its scope reports
      // alive above), and the remote one is left untouched at "active"
      // rather than being wrongly flipped to "exited" for a host that's
      // merely unreachable right now.
      expect(rows.find((s) => s.id === localSessionId)?.status).toBe("active");
      expect(rows.find((s) => s.id === remoteRow.id)?.status).toBe("active");

      await app.close();
    });

    it("does not exit a session a reachable host's liveness response omits (Hermes review, PR #34)", async () => {
      const app = await buildApp();
      // Earlier tests in this describe block leave "active" LOCAL sessions
      // behind in this file's shared on-disk DB (no per-test cleanup) —
      // reconcileExitedSessions groups those into a "local" host group too,
      // and this file's child_process mock only ever emits "exit" (never
      // "close"), which real isMasterAlive() waits on — so any test that
      // doesn't stub it hangs forever on that leftover group. Every other
      // test here either stubs this or never leaves an active local
      // session; this one only cares about the remote group below.
      vi.spyOn(app.pty, "isMasterAlive").mockResolvedValue(true);
      let omittedId: string | null = null;

      const server = http.createServer((req, res) => {
        if (req.url !== "/internal/sessions/liveness") {
          res.writeHead(404);
          res.end();
          return;
        }
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          const { ids } = JSON.parse(body) as { ids: string[] };
          const result: Record<string, boolean> = {};
          // Simulate agent version skew / a partial response: every
          // requested id gets an answer EXCEPT `omittedId`.
          for (const id of ids) {
            if (id !== omittedId) result[id] = true;
          }
          const payload = JSON.stringify(result);
          res.writeHead(200, {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload),
          });
          res.end(payload);
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("expected a bound port");

      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: {
          name: "partial-liveness",
          baseUrl: `http://127.0.0.1:${address.port}`,
          token: "t",
        },
      });
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "p", cwd: "/x", hostId: host.json().id },
      });
      const { sessions } = await import("../../src/db/schema.js");
      const [omitted] = app.db
        .insert(sessions)
        .values({ projectId: project.json().id, command: "bash" })
        .returning()
        .all();
      const [included] = app.db
        .insert(sessions)
        .values({ projectId: project.json().id, command: "bash" })
        .returning()
        .all();
      omittedId = String(omitted.id);

      await reconcileExitedSessions(app);

      const res = await app.inject({ method: "GET", url: "/api/sessions" });
      const rows = res.json() as Array<{ id: number; status: string }>;
      // Omitted key -> "unknown," must be skipped, never treated as "not
      // alive" -> exited (the exact landmine this fix closes).
      expect(rows.find((s) => s.id === omitted.id)?.status).toBe("active");
      expect(rows.find((s) => s.id === included.id)?.status).toBe("active");

      // server.close()'s callback otherwise hangs until every keep-alive
      // connection closes on its own — fetch()'s undici client holds one
      // open well past this test's assertions.
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await app.close();
    });
  });
});
