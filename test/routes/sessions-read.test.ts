// Must come before any import below that could itself trigger loading
// "node-pty"/"node:child_process" (e.g. the `node:child_process` import a
// few lines down) — see mock-pty.ts's header comment for the
// empirically confirmed hoisting/ordering failure mode.
import { createNodePtyMock } from "../helpers/mock-pty.js";
import {
  createProject,
  fakeSessionBackend,
  mockSpawnModule,
  opencodeTransferMock,
  setupSessionsRouteLifecycle,
  waitUntil,
} from "../helpers/sessions-routes.js";
import { describe, expect, it, vi } from "vitest";
import { spawn as spawnChildProcess } from "node:child_process";
import { sessions } from "../../src/db/schema.js";
// Session creation spawns real OS processes (systemd-run, dtach) via
// PtyManager — faked here the same way as test/services/pty-manager.test.ts,
// so these files exercise the route/DB layer without depending on a real
// systemd --user session existing in CI. See that file for why.
//
// Each spawned fake PTY's onData listener array is captured here (not just
// created and discarded) so a scrollback-identity test can push real,
// distinguishable output through a specific session's PTY after the fact —
// see the "returns the base64-encoded scrollback buffer" test below.
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
setupSessionsRouteLifecycle("read");

describe("sessions route: reading a session's row, transcript and scrollback", () => {
  describe("GET /api/sessions/:id (Phase 4, #187)", () => {
    it("returns the row merged with live status", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = created.json().id;

      const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: sessionId, projectId, command: "bash" });

      await app.close();
    });

    it("404s for an unknown session id", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/sessions/999999" });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("400s for a non-integer session id", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/sessions/not-a-number" });
      expect(res.statusCode).toBe(400);
      await app.close();
    });
  });

  // Issue #1733 — the row is not the end of the story: the child's CLI has
  // to actually RECEIVE the skip-permissions flag. This asserts the join
  // end to end — the POST body through the spawn to the argv the agent is
  // launched with — rather than the row alone.
  describe("POST /api/sessions — skipPermissions reaches the launched argv", () => {
    let app: Awaited<ReturnType<typeof buildApp>>;

    beforeEach(async () => {
      app = await buildApp();
    });

    // The app MUST be closed even when an assertion throws — this file's
    // other tests share the node-pty mock and the session/socket paths, so
    // an app left open by a failed assertion cascades into every test after
    // it.
    afterEach(async () => {
      await app.close();
    });

    it("launches with the agent's skip-permissions flag when the row says so", async () => {
      const projectId = await createProject(app);
      const before = vi.mocked(spawnChildProcess).mock.calls.length;

      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "claude", skipPermissions: true },
      });
      expect(created.statusCode).toBe(201);

      await waitUntil(() => vi.mocked(spawnChildProcess).mock.calls.length > before);
      const spawnCall =
        vi.mocked(spawnChildProcess).mock.calls[vi.mocked(spawnChildProcess).mock.calls.length - 1];
      const argv = [spawnCall[0], ...(spawnCall[1] ?? [])].join(" ");
      expect(argv).toContain("--dangerously-skip-permissions");
    });

    it("launches WITHOUT the flag when the row says so", async () => {
      const projectId = await createProject(app);
      const before = vi.mocked(spawnChildProcess).mock.calls.length;

      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "claude", skipPermissions: false },
      });
      expect(created.statusCode).toBe(201);

      await waitUntil(() => vi.mocked(spawnChildProcess).mock.calls.length > before);
      const spawnCall =
        vi.mocked(spawnChildProcess).mock.calls[vi.mocked(spawnChildProcess).mock.calls.length - 1];
      const argv = [spawnCall[0], ...(spawnCall[1] ?? [])].join(" ");
      expect(argv).not.toContain("--dangerously-skip-permissions");
    });
  });

  describe("GET /api/sessions/:id/transcript (issue #2268)", () => {
    async function activeSession(app: Awaited<ReturnType<typeof buildApp>>) {
      const projectId = await createProject(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      return created.json().id as number;
    }

    it("404s an unknown session and 400s a bad query", async () => {
      const app = await buildApp();
      const missing = await app.inject({ method: "GET", url: "/api/sessions/999999/transcript" });
      expect(missing.statusCode).toBe(404);
      const bad = await app.inject({
        method: "GET",
        url: "/api/sessions/999999/transcript?limit=9999",
      });
      expect(bad.statusCode).toBe(400);
      await app.close();
    });

    it("says a shell session has no transcript instead of returning an empty body", async () => {
      const app = await buildApp();
      const sessionId = await activeSession(app);
      const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/transcript` });
      expect(res.statusCode).toBe(501);
      expect(res.json().error).toContain("not-supported");
      await app.close();
    });

    it("passes the query to the host's backend and relays its page or its refusal", async () => {
      const app = await buildApp();
      const sessionId = await activeSession(app);
      const getTranscript = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, entries: [], nextSeq: 1999, more: false })
        .mockResolvedValueOnce({ ok: false, status: 409, error: "not reported yet" })
        .mockRejectedValueOnce(new Error("host down"));
      const sessionBackendModule = await import("../../src/services/session-backend.js");
      const spy = vi
        .spyOn(sessionBackendModule, "resolveBackend")
        .mockReturnValue(fakeSessionBackend({ getTranscript }));

      const page = await app.inject({
        method: "GET",
        url: `/api/sessions/${sessionId}/transcript?afterSeq=5&limit=7&tools=1`,
      });
      expect(page.statusCode).toBe(200);
      expect(page.json()).toEqual({ ok: true, entries: [], nextSeq: 1999, more: false });
      expect(getTranscript).toHaveBeenCalledWith(String(sessionId), {
        afterSeq: 5,
        limit: 7,
        fullTools: true,
      });

      const refused = await app.inject({
        method: "GET",
        url: `/api/sessions/${sessionId}/transcript`,
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toEqual({ error: "not reported yet" });

      const down = await app.inject({
        method: "GET",
        url: `/api/sessions/${sessionId}/transcript`,
      });
      expect(down.statusCode).toBe(503);
      spy.mockRestore();
      await app.close();
    });
  });

  describe("GET /api/sessions/:id/scrollback (Phase 4, #187)", () => {
    it("returns the base64-encoded scrollback buffer for a tracked session, containing that session's own output", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = created.json().id;
      await waitUntil(async () => {
        const list = await app.inject({
          method: "GET",
          url: `/api/sessions?projectId=${projectId}`,
        });
        return list.json()[0]?.alive === true;
      });

      // Push real, distinguishable output through this specific session's
      // FakePty (captured by ptyMock.spawnedPtys at spawn time — see this
      // file's node-pty mock) so this test verifies actual scrollback
      // *content*, not just that some non-empty base64 string comes back
      // (which the preamble alone would already satisfy — see
      // pty-manager.ts's getScrollback doc comment).
      const marker = `scrollback-marker-${sessionId}`;
      ptyMock.spawnedPtys[ptyMock.spawnedPtys.length - 1].emitData(`${marker}\r\n`);

      const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/scrollback` });
      expect(res.statusCode).toBe(200);
      const { b64 } = res.json();
      expect(typeof b64).toBe("string");
      expect(Buffer.from(b64, "base64").toString("utf8")).toContain(marker);

      await app.close();
    });

    it("?mode=rendered returns the screen as plain text, with repaints resolved (issue #2112)", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = created.json().id;
      await waitUntil(async () => {
        const list = await app.inject({
          method: "GET",
          url: `/api/sessions?projectId=${projectId}`,
        });
        return list.json()[0]?.alive === true;
      });
      const pty = ptyMock.spawnedPtys[ptyMock.spawnedPtys.length - 1];
      pty.emitData("\r\x1b[2K| thinking");
      pty.emitData("\r\x1b[2K/ thinking");
      pty.emitData("\r\x1b[2Kfinal answer\r\n");

      const res = await app.inject({
        method: "GET",
        url: `/api/sessions/${sessionId}/scrollback?mode=rendered`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ text: "final answer" });

      await app.close();
    });

    it("?mode=rendered keeps the whole history for a session that is LIVE on the alternate screen (issue #2112)", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = created.json().id;
      await waitUntil(async () => {
        const list = await app.inject({
          method: "GET",
          url: `/api/sessions?projectId=${projectId}`,
        });
        return list.json()[0]?.alive === true;
      });
      const pty = ptyMock.spawnedPtys[ptyMock.spawnedPtys.length - 1];
      // Shell output, then a TUI that enters the alternate screen and stays there:
      // getScrollback()'s preamble now opens with ESC[?1049h, which would put the
      // whole replay into the (scrollback-less) alternate buffer.
      pty.emitData(`${Array.from({ length: 60 }, (_, i) => `shell line ${i}`).join("\r\n")}\r\n`);
      pty.emitData("\x1b[?1049h\x1b[HTUI screen\r\n");

      const res = await app.inject({
        method: "GET",
        url: `/api/sessions/${sessionId}/scrollback?mode=rendered`,
      });
      const { text } = res.json() as { text: string };
      expect(text).toContain("shell line 0");
      expect(text).toContain("shell line 59");
      expect(text).toContain("--- alternate screen ---\n(a full-screen program keeps no history;");
      expect(text.endsWith("TUI screen")).toBe(true);

      await app.close();
    });

    it("?mode=rendered answers an empty text for an untracked session, and 400s an unknown mode", async () => {
      const app = await buildApp();

      const projectId = await createProject(app);
      const [row] = app.db
        .insert(sessions)
        .values({ projectId, command: "bash" })
        .returning()
        .all();
      const rendered = await app.inject({
        method: "GET",
        url: `/api/sessions/${row.id}/scrollback?mode=rendered`,
      });
      expect(rendered.json()).toEqual({ text: "" });
      const bad = await app.inject({
        method: "GET",
        url: `/api/sessions/${row.id}/scrollback?mode=pretty`,
      });
      expect(bad.statusCode).toBe(400);
      await app.close();
    });

    it("returns an empty buffer, not 404, for a session not currently tracked in memory", async () => {
      const app = await buildApp();

      const projectId = await createProject(app);
      // Inserted directly, bypassing spawn — never tracked by app.pty.
      const [row] = app.db
        .insert(sessions)
        .values({ projectId, command: "bash" })
        .returning()
        .all();

      const res = await app.inject({ method: "GET", url: `/api/sessions/${row.id}/scrollback` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ b64: "" });

      await app.close();
    });

    it("404s for an unknown session id", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/sessions/999999/scrollback" });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("400s for a non-integer session id", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/sessions/not-a-number/scrollback" });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("reports an empty buffer instead of 500ing when the session's remote host is unreachable", async () => {
      const app = await buildApp();

      const badHost = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "goes-down-scrollback", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const remoteProject = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          name: "remote-scrollback",
          cwd: "/x",
          hostId: badHost.json().id,
        },
      });
      const [orphan] = app.db
        .insert(sessions)
        .values({ projectId: remoteProject.json().id, command: "bash" })
        .returning()
        .all();

      const res = await app.inject({ method: "GET", url: `/api/sessions/${orphan.id}/scrollback` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ b64: "" });

      await app.close();
    });
  });
});
