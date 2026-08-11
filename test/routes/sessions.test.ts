import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import net from "node:net";
import { EventEmitter } from "node:events";
import { execFileSync, spawn as spawnChildProcess } from "node:child_process";
import type * as ChildProcess from "node:child_process";
import { eq } from "drizzle-orm";
import { projects } from "../../src/db/schema.js";
import { gitEnv } from "../../src/services/git-env.js";

// Session creation spawns real OS processes (systemd-run, dtach) via
// PtyManager — faked here the same way as test/services/pty-manager.test.ts,
// so this file exercises the route/DB layer without depending on a real
// systemd --user session existing in CI. See that file for why.
//
// Each spawned fake PTY's onData listener array is captured here (not just
// created and discarded) so a scrollback-identity test can push real,
// distinguishable output through a specific session's PTY after the fact —
// see the "returns the base64-encoded scrollback buffer" test below.
const fakePtyListeners: Array<Array<(data: string) => void>> = [];
vi.mock("node-pty", () => ({
  spawn: vi.fn(() => {
    const listeners: Array<(data: string) => void> = [];
    fakePtyListeners.push(listeners);
    return {
      onData: (cb: (data: string) => void) => {
        listeners.push(cb);
        return { dispose: () => {} };
      },
      onExit: () => ({ dispose: () => {} }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    };
  }),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn((command: string, args?: readonly string[], options?: object) => {
      // Issue #271's worktree tests need real `git` subprocesses (git-worktree.ts's
      // createWorktree, invoked via routes/sessions.ts) — only the
      // systemd-run/dtach bootstrap child_process.spawn call (pty-manager.ts's
      // bootstrapMaster) is faked, same reasoning as node-pty's mock above.
      if (command === "git") return actual.spawn(command, args, options);
      const ee = new EventEmitter();
      setImmediate(() => ee.emit("exit", 0));
      return ee;
    }),
  };
});

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { buildAgentGuidePointer } = await import("../../src/plugins/hooks.js");
const { sessionAgentGuidePath } = await import("../../src/services/agent-guide.js");

const tmpDb = path.join(os.tmpdir(), `sessions-test-${process.pid}.db`);

// Real PNG signature bytes — POST /api/sessions/:id/uploads now checks the
// body's actual magic bytes against the declared mime (issue #68
// hardening), not just the Content-Type header, so a happy-path upload test
// needs a real signature, not an arbitrary string.
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

async function waitUntil(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 50; i++) {
    if (await check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition never became true");
}

describe("sessions route", () => {
  // SESSIONS_DIR is already isolated per test file by test/setup.ts.
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  async function createProject(app: Awaited<ReturnType<typeof buildApp>>) {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, name: "p", cwd: "/tmp" },
    });
    return res.json().id as number;
  }

  it("creates a session, spawns it, and lists it as alive", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      projectId,
      command: "bash",
      status: "active",
      kind: "terminal",
      nameLocked: false,
    });
    const sessionId = created.json().id;

    await waitUntil(async () => {
      const list = await app.inject({ method: "GET", url: `/api/sessions?projectId=${projectId}` });
      return list.json()[0]?.alive === true;
    });

    const list = await app.inject({ method: "GET", url: `/api/sessions?projectId=${projectId}` });
    expect(list.json()).toEqual([expect.objectContaining({ id: sessionId, alive: true })]);

    await app.close();
  });

  // Regression test for the bug that shipped in PR #300: SessionInfo grew
  // permissionState/planState/errorState/endedReason, but withLiveInfo
  // (routes/sessions.ts) hand-enumerated which live fields to copy onto each
  // row and was never updated, leaving those four permanently absent from
  // every REST response — which in turn left Sidebar.tsx's "Needs
  // permission"/"Plan ready"/"API error"/"Tool failure" branches unreachable
  // even though the backend hook plumbing behind them worked correctly. This
  // asserts the FULL live-info field set is present (with its documented
  // idle/no-signal defaults) so a future field added to SessionInfo without
  // being wired into buildLiveInfo is caught by a failing assertion here, in
  // addition to the `LiveInfoKey` exhaustiveness check `make typecheck` now
  // enforces at the type level.
  it("includes every live-only SessionInfo field in the session list response", async () => {
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

    const list = await app.inject({ method: "GET", url: `/api/sessions?projectId=${projectId}` });
    expect(list.json()).toEqual([
      expect.objectContaining({
        id: sessionId,
        alive: true,
        subscriberCount: 0,
        activity: "idle",
        lastActivityAt: null,
        liveCwd: null,
        attention: false,
        attentionAt: null,
        lastTitle: null,
        liveBranch: null,
        gateState: "idle",
        gatePrompt: null,
        promoteState: "idle",
        promoteSummary: null,
        promoteSuggestedBaseRef: null,
        permissionState: "idle",
        planState: "idle",
        errorState: "idle",
        endedReason: null,
        exitCode: null,
        // Rich statuses (issue: extend surfaced session statuses).
        attentionKind: null,
        errorDetail: null,
        lastAssistantMessage: null,
        compactState: "idle",
        subagentCount: 0,
        elicitationState: "idle",
        elicitationServer: null,
        lastTurnEndedAt: null,
        hookEmits: [],
        sessionStatus: "idle",
        sessionStatusSeverity: "dormant",
        sessionStatusDetail: null,
        sessionStatusAttentionRequired: false,
      }),
    ]);

    // POST /api/sessions' own response shares the same withLiveInfo via
    // withLiveStatus (routes/sessions.ts) — assert it isn't a second,
    // possibly-drifting copy of the field list.
    expect(created.json()).toMatchObject({
      permissionState: "idle",
      planState: "idle",
      errorState: "idle",
      endedReason: null,
      sessionStatus: "idle",
      sessionStatusSeverity: "dormant",
    });

    await app.close();
  });

  it("accepts an optional cwd override distinct from the project's cwd", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash", cwd: "/tmp/subdir" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ projectId, command: "bash", cwd: "/tmp/subdir" });

    await app.close();
  });

  it("accepts skipPermissions flag and passes it through", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash", skipPermissions: true },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ projectId, command: "bash", skipPermissions: true });

    await app.close();
  });

  it("creates a dock-kind session and filters it via ?kind=dock (WS-5)", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" }, // default kind: terminal
    });
    const dockCreated = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "npm run dev", kind: "dock" },
    });
    expect(dockCreated.json()).toMatchObject({ kind: "dock" });

    const dockOnly = await app.inject({
      method: "GET",
      url: `/api/sessions?projectId=${projectId}&kind=dock`,
    });
    expect(dockOnly.json()).toEqual([expect.objectContaining({ kind: "dock" })]);

    const terminalOnly = await app.inject({
      method: "GET",
      url: `/api/sessions?projectId=${projectId}&kind=terminal`,
    });
    expect(
      (terminalOnly.json() as Array<{ kind: string }>).every((s) => s.kind === "terminal"),
    ).toBe(true);

    await app.close();
  });

  it("rejects an invalid kind querystring value", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/sessions?kind=bogus" });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  // Perf audit finding A6 — GET /api/sessions had no status filter at all,
  // so every 4s poll tick paid for every `killed` tombstone ever created
  // (nothing purges them). This asserts the new filter actually narrows the
  // result set, same pattern as the ?kind= test above.
  it("filters the session list by ?status=", async () => {
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

    const activeOnly = await app.inject({
      method: "GET",
      url: `/api/sessions?projectId=${projectId}&status=active`,
    });
    expect(activeOnly.json()).toEqual([]);

    const killedOnly = await app.inject({
      method: "GET",
      url: `/api/sessions?projectId=${projectId}&status=killed`,
    });
    expect(killedOnly.json()).toEqual([
      expect.objectContaining({ id: sessionId, status: "killed" }),
    ]);

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

  // Perf audit finding A6 — withLiveInfo (routes/sessions.ts) used to call
  // resolveProjectHostId(app, row.projectId) itself, re-running the exact
  // per-project SELECT the route handler had already batched into
  // `projectHostIds` just above it — one redundant synchronous
  // better-sqlite3 query *per session row*, on every request. Pinned by
  // counting `app.db.select` invocations for a 1-row vs. a 5-row list:
  // before the fix this call count scaled with row count; after, GET
  // /api/sessions issues the same fixed number of `select`s regardless of
  // how many sessions it returns.
  it("does not issue a per-row DB query for host resolution in the session list (no N+1)", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" },
    });

    const selectSpy = vi.spyOn(app.db, "select");
    selectSpy.mockClear();
    const oneRow = await app.inject({ method: "GET", url: `/api/sessions?projectId=${projectId}` });
    expect(oneRow.json()).toHaveLength(1);
    const callsForOneRow = selectSpy.mock.calls.length;

    for (let i = 0; i < 4; i++) {
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
    }

    selectSpy.mockClear();
    const fiveRows = await app.inject({
      method: "GET",
      url: `/api/sessions?projectId=${projectId}`,
    });
    expect(fiveRows.json()).toHaveLength(5);
    const callsForFiveRows = selectSpy.mock.calls.length;

    // Constant, not scaling with row count — an N+1 here would show
    // callsForFiveRows == callsForOneRow + 4.
    expect(callsForFiveRows).toBe(callsForOneRow);

    selectSpy.mockRestore();
    await app.close();
  });

  // Perf audit finding A4 — @fastify/compress is registered via app.ts's
  // onRoute hook before routes/sessions.ts's routes are registered, so it
  // must cover this API route too, not just @fastify/static's assets (see
  // test/plugins/static.test.ts's equivalent assertion). This is the
  // biggest single win in A4 (a poll-heavy JSON payload hit every 4s from
  // every open tab), so it's pinned directly rather than just assumed from
  // registration order — the preview-proxy path in
  // test/plugins/preview-proxy.test.ts is the one route that does NOT get
  // this coverage, and is asserted separately as a documented exception.
  it("compresses a large GET /api/sessions response when the client accepts gzip", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    // Pad well past @fastify/compress's default 1024-byte threshold — a
    // single session row is small, so create enough of them.
    for (let i = 0; i < 10; i++) {
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash", name: `session-${i}-with-a-somewhat-longer-name` },
      });
    }

    const uncompressedCheck = await app.inject({
      method: "GET",
      url: `/api/sessions?projectId=${projectId}`,
    });
    expect(uncompressedCheck.rawPayload.length).toBeGreaterThan(1024);

    const response = await app.inject({
      method: "GET",
      url: `/api/sessions?projectId=${projectId}`,
      headers: { "accept-encoding": "gzip" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-encoding"]).toBe("gzip");

    await app.close();
  });

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
      // FakePty (captured by fakePtyListeners at spawn time — see this
      // file's node-pty mock) so this test verifies actual scrollback
      // *content*, not just that some non-empty base64 string comes back
      // (which the preamble alone would already satisfy — see
      // pty-manager.ts's getScrollback doc comment).
      const marker = `scrollback-marker-${sessionId}`;
      for (const cb of fakePtyListeners[fakePtyListeners.length - 1]) cb(`${marker}\r\n`);

      const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/scrollback` });
      expect(res.statusCode).toBe(200);
      const { b64 } = res.json();
      expect(typeof b64).toBe("string");
      expect(Buffer.from(b64, "base64").toString("utf8")).toContain(marker);

      await app.close();
    });

    it("returns an empty buffer, not 404, for a session not currently tracked in memory", async () => {
      const app = await buildApp();
      const { sessions } = await import("../../src/db/schema.js");
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
      const { sessions } = await import("../../src/db/schema.js");
      const badHost = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "goes-down-scrollback", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const remoteProject = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "remote-scrollback", cwd: "/x", hostId: badHost.json().id },
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

  describe("GET /api/sessions/:id/browser (issue #182)", () => {
    it("404s for an unknown session id", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/sessions/999999/browser" });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("400s for a non-integer session id", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/sessions/not-a-number/browser" });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("returns an empty array for a session with no browser binding", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/sessions/${created.json().id}/browser`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);

      await app.close();
    });

    it("returns the recorded binding once one exists", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = created.json().id as number;
      const { recordSessionBrowserBinding } =
        await import("../../src/services/session-browsers.js");
      recordSessionBrowserBinding(app, sessionId, projectId);

      const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/browser` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([expect.objectContaining({ sessionId, projectId })]);

      await app.close();
    });

    it("DELETE /api/sessions/:id closes the session's project browser (issue #182)", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = created.json().id as number;
      const { recordSessionBrowserBinding } =
        await import("../../src/services/session-browsers.js");
      recordSessionBrowserBinding(app, sessionId, projectId);
      const closeForProjectSpy = vi
        .spyOn(app.browser, "closeForProject")
        .mockResolvedValue(undefined);

      const killed = await app.inject({ method: "DELETE", url: `/api/sessions/${sessionId}` });
      expect(killed.statusCode).toBe(204);
      expect(closeForProjectSpy).toHaveBeenCalledWith(projectId);

      const after = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/browser` });
      expect(after.json()).toEqual([]);

      await app.close();
    });
  });

  describe("POST /api/sessions/:id/uploads (issue #68)", () => {
    async function createProjectWithCwd(app: Awaited<ReturnType<typeof buildApp>>, cwd: string) {
      const res = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "upload-p", cwd },
      });
      return res.json().id as number;
    }

    it("writes the image under the session's cwd and returns its absolute path", async () => {
      const app = await buildApp();
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sessions-upload-"));
      const projectId = await createProjectWithCwd(app, cwd);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = created.json().id;
      const buffer = PNG_BYTES;

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/uploads`,
        headers: { "content-type": "image/png" },
        payload: buffer,
      });

      expect(res.statusCode).toBe(200);
      const { path: uploadPath } = res.json();
      expect(uploadPath.startsWith(path.join(cwd, ".mullion-uploads"))).toBe(true);
      expect(fs.readFileSync(uploadPath)).toEqual(buffer);

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("accepts a Content-Type with a charset parameter (Hermes review, PR #106)", async () => {
      const app = await buildApp();
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sessions-upload-charset-"));
      const projectId = await createProjectWithCwd(app, cwd);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = created.json().id;

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/uploads`,
        headers: { "content-type": "image/png; charset=binary" },
        payload: PNG_BYTES,
      });

      expect(res.statusCode).toBe(200);
      const { path: uploadPath } = res.json();
      expect(uploadPath.endsWith(".png")).toBe(true);

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("404s for an unknown session id", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/999999/uploads",
        headers: { "content-type": "image/png" },
        payload: Buffer.from("x"),
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("rejects an image type outside the allow-list (matched by the content-type parser but not extensionForMime)", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = created.json().id;

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/uploads`,
        headers: { "content-type": "image/svg+xml" },
        payload: Buffer.from("<svg/>"),
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("rejects a body whose bytes don't match the declared mime, even with an allow-listed Content-Type", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = created.json().id;

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/uploads`,
        headers: { "content-type": "image/png" },
        payload: Buffer.from("<html><script>alert(1)</script></html>"),
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("415s a non-image content type (no matching content-type parser)", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = created.json().id;

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/uploads`,
        headers: { "content-type": "application/pdf" },
        payload: Buffer.from("x"),
      });
      expect(res.statusCode).toBe(415);
      await app.close();
    });
  });

  describe("POST /api/sessions/:id/review-gate (issue #178)", () => {
    /** Opens a real socket against app.pty.hookSocketPath, handshakes, and
     * sends a `review_gate: waiting` message — the same round-trip
     * forwarder.mjs's runGate() does — then waits for it to actually land
     * (session.gateState flips to "waiting") before returning the raw
     * socket, so the route under test has a real pending gate to resolve. */
    async function openPendingGate(
      app_: Awaited<ReturnType<typeof buildApp>>,
      sessionId: number,
      prompt: string,
    ): Promise<net.Socket> {
      const session = app_.pty.get(String(sessionId));
      if (!session) throw new Error("session not tracked");
      const socket = await new Promise<net.Socket>((resolve, reject) => {
        const s = net.createConnection(app_.pty.hookSocketPath);
        s.once("connect", () => resolve(s));
        s.once("error", reject);
      });
      socket.write(`${JSON.stringify({ token: session.hookToken })}\n`);
      socket.write(`${JSON.stringify({ kind: "review_gate", state: "waiting", prompt })}\n`);
      await waitUntil(() => session.toInfo().gateState === "waiting");
      return socket;
    }

    it("400s an invalid session id", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/not-a-number/review-gate",
        payload: { decision: "approved" },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("404s an unknown session id", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/999999/review-gate",
        payload: { decision: "approved" },
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("409s when no review is currently pending for a real session", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = created.json().id;

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/review-gate`,
        payload: { decision: "approved" },
      });
      expect(res.statusCode).toBe(409);
      await app.close();
    });

    it("delivers an approve decision to the pending gate connection and flips gateState", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = created.json().id;

      const socket = await openPendingGate(app, sessionId, "rm -rf /tmp/scratch");
      const replyPromise = new Promise<string>((resolve) => {
        socket.on("data", (chunk: Buffer) => resolve(chunk.toString("utf8").trim()));
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/review-gate`,
        payload: { decision: "approved" },
      });
      expect(res.statusCode).toBe(204);

      expect(JSON.parse(await replyPromise)).toEqual({ decision: "approved" });
      const list = await app.inject({ method: "GET", url: `/api/sessions?projectId=${projectId}` });
      expect(list.json()).toEqual([
        expect.objectContaining({ id: sessionId, gateState: "approved", gatePrompt: null }),
      ]);

      socket.destroy();
      await app.close();
    });

    it("delivers a deny decision with a reason", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = created.json().id;

      const socket = await openPendingGate(app, sessionId, "curl http://evil.example");
      const replyPromise = new Promise<string>((resolve) => {
        socket.on("data", (chunk: Buffer) => resolve(chunk.toString("utf8").trim()));
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/review-gate`,
        payload: { decision: "denied", reason: "looks unsafe" },
      });
      expect(res.statusCode).toBe(204);
      expect(JSON.parse(await replyPromise)).toEqual({
        decision: "denied",
        reason: "looks unsafe",
      });

      socket.destroy();
      await app.close();
    });

    it("400s an unrecognized decision value", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = created.json().id;

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/review-gate`,
        payload: { decision: "maybe" },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });
  });

  // Issue #404 — accept/dismiss for a plain session's detected dev-server
  // offer. Detection itself is driven by a fixed 10s timer in
  // src/plugins/pty.ts (see that file's DEV_SERVER_DETECT_INTERVAL_MS), too
  // slow to wait on in a unit test — these tests manufacture the "pending"
  // state directly via app.pty.sweepDevServerDetection(...), the exact
  // entry point that timer calls, rather than waiting on the real interval
  // or re-testing the detection/dedup logic itself (already covered
  // directly in test/services/pty-manager.test.ts).
  describe("POST /api/sessions/:id/dev-server/accept and /dismiss (issue #404)", () => {
    async function createSessionWithPendingPort(
      app: Awaited<ReturnType<typeof buildApp>>,
      port = "5173",
    ): Promise<{ projectId: number; sessionId: number }> {
      const projectId = await createProject(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = created.json().id;
      await waitUntil(() => app.pty.get(String(sessionId))?.isAlive === true);

      const marker = `  ➜  Local:   http://localhost:${port}/\r\n`;
      for (const cb of fakePtyListeners[fakePtyListeners.length - 1]) cb(marker);

      const detected = app.pty.sweepDevServerDetection(new Map([[String(sessionId), projectId]]));
      if (detected.length === 0) throw new Error("expected a dev-server detection to land");
      return { projectId, sessionId };
    }

    describe("accept", () => {
      it("400s an invalid session id", async () => {
        const app = await buildApp();
        const res = await app.inject({
          method: "POST",
          url: "/api/sessions/not-a-number/dev-server/accept",
          payload: { port: "5173" },
        });
        expect(res.statusCode).toBe(400);
        await app.close();
      });

      it("404s an unknown session id", async () => {
        const app = await buildApp();
        const res = await app.inject({
          method: "POST",
          url: "/api/sessions/999999/dev-server/accept",
          payload: { port: "5173" },
        });
        expect(res.statusCode).toBe(404);
        await app.close();
      });

      it("409s when no dev-server offer is currently pending for this session", async () => {
        const app = await buildApp();
        const projectId = await createProject(app);
        const created = await app.inject({
          method: "POST",
          url: "/api/sessions",
          payload: { projectId, command: "bash" },
        });
        const res = await app.inject({
          method: "POST",
          url: `/api/sessions/${created.json().id}/dev-server/accept`,
          payload: { port: "5173" },
        });
        expect(res.statusCode).toBe(409);
        await app.close();
      });

      it("409s a wrong/stale port that doesn't match the actually-detected one", async () => {
        const app = await buildApp();
        const { sessionId } = await createSessionWithPendingPort(app, "5173");
        const res = await app.inject({
          method: "POST",
          url: `/api/sessions/${sessionId}/dev-server/accept`,
          payload: { port: "9999" },
        });
        expect(res.statusCode).toBe(409);
        await app.close();
      });

      it("400s a port outside the valid 1-65535 range even when it matches the schema and is somehow pending, WITHOUT clearing the pending state", async () => {
        // "99999" passes the route schema's ^\d{1,5}$ pattern but fails
        // isValidDevServerUrl's range check — validated before
        // acceptDevServerPort mutates anything, so a rejected request must
        // leave the real pending offer intact for a later, valid accept.
        const app = await buildApp();
        const { sessionId } = await createSessionWithPendingPort(app, "5173");
        const res = await app.inject({
          method: "POST",
          url: `/api/sessions/${sessionId}/dev-server/accept`,
          payload: { port: "99999" },
        });
        expect(res.statusCode).toBe(400);

        // The real pending offer (from createSessionWithPendingPort's "5173")
        // must still be acceptable afterward.
        const retry = await app.inject({
          method: "POST",
          url: `/api/sessions/${sessionId}/dev-server/accept`,
          payload: { port: "5173" },
        });
        expect(retry.statusCode).toBe(200);
        await app.close();
      });

      it("patches the project's devServerUrl to the bare port and returns preview: null when PREVIEW_BASE_HOST is unset (previews-disabled no-op)", async () => {
        const app = await buildApp();
        const { projectId, sessionId } = await createSessionWithPendingPort(app, "5173");

        const res = await app.inject({
          method: "POST",
          url: `/api/sessions/${sessionId}/dev-server/accept`,
          payload: { port: "5173" },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ devServerUrl: "5173", preview: null });

        const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
        expect(project.devServerUrl).toBe("5173");
        await app.close();
      });

      it("creates/reuses a project preview when PREVIEW_BASE_HOST is configured", async () => {
        process.env.PREVIEW_BASE_HOST = "preview.example.com";
        try {
          const app = await buildApp();
          const { sessionId } = await createSessionWithPendingPort(app, "5173");

          const res = await app.inject({
            method: "POST",
            url: `/api/sessions/${sessionId}/dev-server/accept`,
            payload: { port: "5173" },
          });
          expect(res.statusCode).toBe(200);
          const body = res.json();
          expect(body.devServerUrl).toBe("5173");
          expect(body.preview).toMatchObject({ kind: "project" });
          expect(typeof body.preview.slug).toBe("string");
          await app.close();
        } finally {
          delete process.env.PREVIEW_BASE_HOST;
        }
      });

      it("accepting the SAME offer twice 409s the second time (already resolved)", async () => {
        const app = await buildApp();
        const { sessionId } = await createSessionWithPendingPort(app, "5173");

        const first = await app.inject({
          method: "POST",
          url: `/api/sessions/${sessionId}/dev-server/accept`,
          payload: { port: "5173" },
        });
        expect(first.statusCode).toBe(200);

        const second = await app.inject({
          method: "POST",
          url: `/api/sessions/${sessionId}/dev-server/accept`,
          payload: { port: "5173" },
        });
        expect(second.statusCode).toBe(409);
        await app.close();
      });

      it("409s a second offer on the SAME project instead of clobbering the first accepted devServerUrl (two plain sessions, e.g. a monorepo)", async () => {
        // Eligibility for detection is per-PROJECT (devServerUrl IS NULL),
        // but pending-offer/dedup state is per-SESSION — so two plain
        // sessions on one project can each independently latch a pending
        // offer before either is accepted. Regression test: accepting the
        // second must not silently overwrite the first accept's write.
        const app = await buildApp();
        const projectId = await createProject(app);

        const createSecondSessionWithPendingPort = async (port: string) => {
          const created = await app.inject({
            method: "POST",
            url: "/api/sessions",
            payload: { projectId, command: "bash" },
          });
          const sessionId = created.json().id;
          await waitUntil(() => app.pty.get(String(sessionId))?.isAlive === true);
          const marker = `  ➜  Local:   http://localhost:${port}/\r\n`;
          for (const cb of fakePtyListeners[fakePtyListeners.length - 1]) cb(marker);
          const detected = app.pty.sweepDevServerDetection(
            new Map([[String(sessionId), projectId]]),
          );
          if (detected.length === 0) throw new Error("expected a dev-server detection to land");
          return sessionId;
        };

        const firstSessionId = await createSecondSessionWithPendingPort("5173");
        const secondSessionId = await createSecondSessionWithPendingPort("3000");

        const first = await app.inject({
          method: "POST",
          url: `/api/sessions/${firstSessionId}/dev-server/accept`,
          payload: { port: "5173" },
        });
        expect(first.statusCode).toBe(200);

        const second = await app.inject({
          method: "POST",
          url: `/api/sessions/${secondSessionId}/dev-server/accept`,
          payload: { port: "3000" },
        });
        expect(second.statusCode).toBe(409);

        const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
        expect(project.devServerUrl).toBe("5173");
        await app.close();
      });
    });

    describe("dismiss", () => {
      it("400s an invalid session id", async () => {
        const app = await buildApp();
        const res = await app.inject({
          method: "POST",
          url: "/api/sessions/not-a-number/dev-server/dismiss",
          payload: { port: "5173" },
        });
        expect(res.statusCode).toBe(400);
        await app.close();
      });

      it("404s an unknown session id", async () => {
        const app = await buildApp();
        const res = await app.inject({
          method: "POST",
          url: "/api/sessions/999999/dev-server/dismiss",
          payload: { port: "5173" },
        });
        expect(res.statusCode).toBe(404);
        await app.close();
      });

      it("409s when no dev-server offer is currently pending", async () => {
        const app = await buildApp();
        const projectId = await createProject(app);
        const created = await app.inject({
          method: "POST",
          url: "/api/sessions",
          payload: { projectId, command: "bash" },
        });
        const res = await app.inject({
          method: "POST",
          url: `/api/sessions/${created.json().id}/dev-server/dismiss`,
          payload: { port: "5173" },
        });
        expect(res.statusCode).toBe(409);
        await app.close();
      });

      it("409s a wrong/stale port", async () => {
        const app = await buildApp();
        const { sessionId } = await createSessionWithPendingPort(app, "5173");
        const res = await app.inject({
          method: "POST",
          url: `/api/sessions/${sessionId}/dev-server/dismiss`,
          payload: { port: "9999" },
        });
        expect(res.statusCode).toBe(409);
        await app.close();
      });

      it("204s and suppresses re-offering the same (session, port) — does NOT patch devServerUrl", async () => {
        const app = await buildApp();
        const { projectId, sessionId } = await createSessionWithPendingPort(app, "5173");

        const res = await app.inject({
          method: "POST",
          url: `/api/sessions/${sessionId}/dev-server/dismiss`,
          payload: { port: "5173" },
        });
        expect(res.statusCode).toBe(204);

        const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
        expect(project.devServerUrl).toBeNull();

        // A re-printed banner for the SAME port must not re-offer.
        for (const cb of fakePtyListeners[fakePtyListeners.length - 1]) {
          cb("  ➜  Local:   http://localhost:5173/\r\n");
        }
        const detected = app.pty.sweepDevServerDetection(new Map([[String(sessionId), projectId]]));
        expect(detected).toEqual([]);
        await app.close();
      });
    });
  });

  describe("worktree isolation (issue #271)", () => {
    // env: gitEnv() (issue #205) — this test file runs as a subprocess of
    // `npm test`, itself sometimes invoked from inside a git hook (e.g. the
    // pre-push hook that runs this very suite): a leaked GIT_DIR/
    // GIT_INDEX_FILE/etc. from that outer git operation would otherwise
    // redirect these fixture-repo commands onto the REAL repo's .git
    // instead of the temp dir passed via `cwd` — exactly the corruption
    // class gitEnv() exists to prevent (see git-refs.test.ts's identical
    // guard on its own git() helper).
    function git(cwd: string, args: string[]) {
      execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
    }

    function createGitRepo(): string {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sessions-worktree-test-"));
      git(cwd, ["init", "-b", "main"]);
      git(cwd, ["config", "user.email", "test@example.com"]);
      git(cwd, ["config", "user.name", "Test"]);
      fs.writeFileSync(path.join(cwd, "a.txt"), "a");
      git(cwd, ["add", "-A"]);
      git(cwd, ["commit", "-m", "initial", "--no-verify"]);
      return cwd;
    }

    async function createProjectWithGitRepo(
      app: Awaited<ReturnType<typeof buildApp>>,
      cwd: string,
    ) {
      const res = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "worktree-p", cwd },
      });
      return res.json().id as number;
    }

    describe("option 1 — launcher worktree toggle", () => {
      it("spawns the session inside a fresh worktree when a worktree intent is given", async () => {
        const app = await buildApp();
        const cwd = createGitRepo();
        const projectId = await createProjectWithGitRepo(app, cwd);

        const created = await app.inject({
          method: "POST",
          url: "/api/sessions",
          payload: {
            projectId,
            command: "bash",
            worktree: { baseRef: "main", branchName: "feature/toggle" },
          },
        });

        expect(created.statusCode).toBe(201);
        const sessionCwd = created.json().cwd as string;
        expect(sessionCwd).toBe(path.join(cwd, ".mullion-worktrees", "feature-toggle"));
        expect(fs.existsSync(sessionCwd)).toBe(true);

        fs.rmSync(cwd, { recursive: true, force: true });
        await app.close();
      });

      it("502s and creates no session row when the worktree fails to create (bad baseRef)", async () => {
        const app = await buildApp();
        const cwd = createGitRepo();
        const projectId = await createProjectWithGitRepo(app, cwd);

        const created = await app.inject({
          method: "POST",
          url: "/api/sessions",
          payload: { projectId, command: "bash", worktree: { baseRef: "no-such-ref" } },
        });
        expect(created.statusCode).toBe(502);

        const list = await app.inject({
          method: "GET",
          url: `/api/sessions?projectId=${projectId}`,
        });
        expect(list.json()).toEqual([]);

        fs.rmSync(cwd, { recursive: true, force: true });
        await app.close();
      });

      it("plain session creation (no worktree intent) is unaffected", async () => {
        const app = await buildApp();
        const cwd = createGitRepo();
        const projectId = await createProjectWithGitRepo(app, cwd);

        const created = await app.inject({
          method: "POST",
          url: "/api/sessions",
          payload: { projectId, command: "bash" },
        });
        expect(created.statusCode).toBe(201);
        expect(created.json().cwd).toBeNull();

        fs.rmSync(cwd, { recursive: true, force: true });
        await app.close();
      });

      // B6 — a failed LOCAL spawn used to return 201 with a live-looking
      // row and a created-but-never-cleaned-up worktree, because
      // LocalBackend.spawn() never actually rejected (see
      // session-backend.ts/pty-manager.ts's Session.spawn()). Forcing the
      // underlying `systemd-run` bootstrap to fail here proves the fix: the
      // spawn now genuinely rejects, this route's existing rollback catch
      // block (createSessionRecord, routes/sessions.ts) actually runs, and
      // nothing — row or worktree — is left behind.
      it("rolls back the DB row and the worktree when the local spawn genuinely fails (B6)", async () => {
        const app = await buildApp();
        const cwd = createGitRepo();
        const projectId = await createProjectWithGitRepo(app, cwd);

        const originalSpawnImpl = vi.mocked(spawnChildProcess).getMockImplementation();
        vi.mocked(spawnChildProcess).mockImplementation(
          (command: string, args?: readonly string[], options?: object) => {
            // Simulate a real local-spawn failure — missing systemd-run, a
            // scope-name collision, whatever the real cause — by making the
            // master-bootstrap subprocess exit non-zero. Everything else
            // (git for the worktree, systemctl elsewhere) behaves normally.
            if (command === "systemd-run") {
              const ee = new EventEmitter();
              setImmediate(() => ee.emit("exit", 1));
              return ee;
            }
            return originalSpawnImpl!(command, args, options);
          },
        );

        try {
          const created = await app.inject({
            method: "POST",
            url: "/api/sessions",
            payload: {
              projectId,
              command: "bash",
              worktree: { baseRef: "main", branchName: "feature/spawn-fail" },
            },
          });

          // Not 201 with a dead session — the route surfaces the failure.
          expect(created.statusCode).toBe(502);

          // No orphaned DB row.
          const list = await app.inject({
            method: "GET",
            url: `/api/sessions?projectId=${projectId}`,
          });
          expect(list.json()).toEqual([]);

          // No orphaned worktree directory either — rolled back alongside
          // the row, not left registered nowhere for cleanup.
          const worktreePath = path.join(cwd, ".mullion-worktrees", "feature-spawn-fail");
          expect(fs.existsSync(worktreePath)).toBe(false);
        } finally {
          vi.mocked(spawnChildProcess).mockImplementation(originalSpawnImpl!);
          fs.rmSync(cwd, { recursive: true, force: true });
          await app.close();
        }
      });

      // Fresh-review finding (Hermes, this PR): the DB-row rollback above
      // (B6) isn't the only thing this catch block needs to undo —
      // PtyManager.getOrCreate() (called internally by LocalBackend.spawn()
      // before the spawn it awaits) already inserted a Session into its own
      // in-memory `sessions`/`hookTokens` maps by the time spawn() rejects.
      // Without an explicit eviction, that Session object (and its
      // hookToken -> id entry, which resolveToken() could still match
      // against) leaks for the lifetime of the process — the DB row is gone
      // but PtyManager still half-believes this session exists.
      it("evicts the failed session from PtyManager's in-memory map, not just the DB row", async () => {
        const app = await buildApp();
        const cwd = createGitRepo();
        const projectId = await createProjectWithGitRepo(app, cwd);

        // A throwaway successful session first, purely to learn what id
        // SQLite will assign the NEXT inserted row — autoincrement rowids
        // only ever go up within this DB connection, and nothing else
        // writes to the `sessions` table between these two requests.
        const control = await app.inject({
          method: "POST",
          url: "/api/sessions",
          payload: { projectId, command: "bash" },
        });
        expect(control.statusCode).toBe(201);
        const nextId = (control.json().id as number) + 1;

        const originalSpawnImpl = vi.mocked(spawnChildProcess).getMockImplementation();
        vi.mocked(spawnChildProcess).mockImplementation(
          (command: string, args?: readonly string[], options?: object) => {
            if (command === "systemd-run") {
              const ee = new EventEmitter();
              setImmediate(() => ee.emit("exit", 1));
              return ee;
            }
            return originalSpawnImpl!(command, args, options);
          },
        );

        try {
          const created = await app.inject({
            method: "POST",
            url: "/api/sessions",
            payload: { projectId, command: "bash" },
          });
          expect(created.statusCode).toBe(502);

          // Not just "no DB row" (already covered above) — no leaked
          // in-memory Session either.
          expect(app.pty.get(String(nextId))).toBeUndefined();
        } finally {
          vi.mocked(spawnChildProcess).mockImplementation(originalSpawnImpl!);
          fs.rmSync(cwd, { recursive: true, force: true });
          await app.close();
        }
      });

      // B9 — this catch block's app.pty.kill() eviction (above) deliberately
      // does NOT clear a stashed promote seed on its own (kill() is also
      // reached via killAll() on a redeploy, where that would be wrong — see
      // PtyManager.discardPendingSeed's own doc comment); this rollback path
      // is one of the genuinely-terminal callers that explicitly discards
      // it, alongside deleting the row. A real seed wouldn't normally exist
      // yet for a session that never spawned successfully, but the map key
      // is independent of whether a Session object exists — stash directly
      // against the predicted next id to exercise the same cleanup call.
      it("also discards any (defensively) stashed seed for the failed session's id", async () => {
        const app = await buildApp();
        const cwd = createGitRepo();
        const projectId = await createProjectWithGitRepo(app, cwd);

        const control = await app.inject({
          method: "POST",
          url: "/api/sessions",
          payload: { projectId, command: "bash" },
        });
        expect(control.statusCode).toBe(201);
        const nextId = (control.json().id as number) + 1;
        app.pty.stashSeed(String(nextId), "some initial prompt");

        const originalSpawnImpl = vi.mocked(spawnChildProcess).getMockImplementation();
        vi.mocked(spawnChildProcess).mockImplementation(
          (command: string, args?: readonly string[], options?: object) => {
            if (command === "systemd-run") {
              const ee = new EventEmitter();
              setImmediate(() => ee.emit("exit", 1));
              return ee;
            }
            return originalSpawnImpl!(command, args, options);
          },
        );

        try {
          const created = await app.inject({
            method: "POST",
            url: "/api/sessions",
            payload: { projectId, command: "bash" },
          });
          expect(created.statusCode).toBe(502);
          expect(app.pty.consumeSeed(String(nextId))).toBeNull();
        } finally {
          vi.mocked(spawnChildProcess).mockImplementation(originalSpawnImpl!);
          fs.rmSync(cwd, { recursive: true, force: true });
          await app.close();
        }
      });
    });

    describe("option 2 — POST /:id/promote", () => {
      async function createActiveSession(
        app: Awaited<ReturnType<typeof buildApp>>,
        projectId: number,
      ) {
        const created = await app.inject({
          method: "POST",
          url: "/api/sessions",
          payload: { projectId, command: "bash" },
        });
        return created.json().id as number;
      }

      it("creates a worktree, spawns a new session there, and kills the source", async () => {
        const app = await buildApp();
        const cwd = createGitRepo();
        const projectId = await createProjectWithGitRepo(app, cwd);
        const sourceId = await createActiveSession(app, projectId);

        const res = await app.inject({
          method: "POST",
          url: `/api/sessions/${sourceId}/promote`,
          payload: { baseRef: "main", branchName: "feature/promoted", seedPrompt: "pick up here" },
        });

        expect(res.statusCode).toBe(201);
        const newSession = res.json();
        expect(newSession.id).not.toBe(sourceId);
        expect(newSession.command).toBe("bash");
        expect(newSession.cwd).toBe(path.join(cwd, ".mullion-worktrees", "feature-promoted"));
        expect(fs.existsSync(newSession.cwd)).toBe(true);
        // Phase 5 (Track B, issue #193 5.3b) — promote is a REPLACEMENT
        // (creates then kills the source), never a child; a promoted
        // session must not carry parentSessionId.
        expect(newSession.parentSessionId).toBe(null);

        const list = await app.inject({
          method: "GET",
          url: `/api/sessions?projectId=${projectId}`,
        });
        const sourceRow = list.json().find((s: { id: number }) => s.id === sourceId);
        expect(sourceRow.status).toBe("killed");

        fs.rmSync(cwd, { recursive: true, force: true });
        await app.close();
      });

      it("inherits skipPermissions from the source session", async () => {
        const app = await buildApp();
        const cwd = createGitRepo();
        const projectId = await createProjectWithGitRepo(app, cwd);

        const created = await app.inject({
          method: "POST",
          url: "/api/sessions",
          payload: { projectId, command: "bash", skipPermissions: true },
        });
        const sourceId = created.json().id as number;

        const res = await app.inject({
          method: "POST",
          url: `/api/sessions/${sourceId}/promote`,
          payload: { baseRef: "main", branchName: "feature/promoted-skip" },
        });

        expect(res.statusCode).toBe(201);
        expect(res.json()).toMatchObject({
          command: "bash",
          skipPermissions: true,
        });
        expect(res.json().id).not.toBe(sourceId);

        fs.rmSync(cwd, { recursive: true, force: true });
        await app.close();
      });

      it("409s promoting a session that isn't active", async () => {
        const app = await buildApp();
        const cwd = createGitRepo();
        const projectId = await createProjectWithGitRepo(app, cwd);
        const sourceId = await createActiveSession(app, projectId);
        await app.inject({ method: "DELETE", url: `/api/sessions/${sourceId}` });

        const res = await app.inject({
          method: "POST",
          url: `/api/sessions/${sourceId}/promote`,
          payload: { baseRef: "main" },
        });
        expect(res.statusCode).toBe(409);

        fs.rmSync(cwd, { recursive: true, force: true });
        await app.close();
      });

      it("404s promoting an unknown session", async () => {
        const app = await buildApp();
        const res = await app.inject({
          method: "POST",
          url: "/api/sessions/999999/promote",
          payload: { baseRef: "main" },
        });
        expect(res.statusCode).toBe(404);
        await app.close();
      });

      it("502s and leaves the source session alive when the worktree fails to create", async () => {
        const app = await buildApp();
        const cwd = createGitRepo();
        const projectId = await createProjectWithGitRepo(app, cwd);
        const sourceId = await createActiveSession(app, projectId);

        const res = await app.inject({
          method: "POST",
          url: `/api/sessions/${sourceId}/promote`,
          payload: { baseRef: "no-such-ref" },
        });
        expect(res.statusCode).toBe(502);

        const list = await app.inject({
          method: "GET",
          url: `/api/sessions?projectId=${projectId}`,
        });
        const sourceRow = list.json().find((s: { id: number }) => s.id === sourceId);
        expect(sourceRow.status).toBe("active");

        fs.rmSync(cwd, { recursive: true, force: true });
        await app.close();
      });

      it("delivers the seed prompt to the new session's SessionStart hook", async () => {
        const app = await buildApp();
        const cwd = createGitRepo();
        const projectId = await createProjectWithGitRepo(app, cwd);
        const sourceId = await createActiveSession(app, projectId);

        const res = await app.inject({
          method: "POST",
          url: `/api/sessions/${sourceId}/promote`,
          payload: { baseRef: "main", seedPrompt: "resume the refactor" },
        });
        const newSessionId = res.json().id as number;

        const session = app.pty.get(String(newSessionId));
        expect(session).toBeDefined();
        const socket = await new Promise<net.Socket>((resolve, reject) => {
          const s = net.createConnection(app.pty.hookSocketPath);
          s.once("connect", () => resolve(s));
          s.once("error", reject);
        });
        socket.write(`${JSON.stringify({ token: session!.hookToken })}\n`);
        const replyPromise = new Promise<string>((resolve) => {
          let buffer = "";
          socket.on("data", (chunk: Buffer) => {
            buffer += chunk.toString("utf8");
            const idx = buffer.indexOf("\n");
            if (idx !== -1) resolve(buffer.slice(0, idx));
          });
        });
        socket.write(`${JSON.stringify({ kind: "session_start" })}\n`);
        // Issue #405 — composed with the guide pointer (default settings,
        // and this repo checkout ships docs/agent-guide.md), never in place
        // of the seed itself.
        const guidePath = sessionAgentGuidePath(
          path.dirname(app.pty.hookSocketPath),
          String(newSessionId),
        );
        expect(JSON.parse(await replyPromise)).toEqual({
          additionalContext: `resume the refactor\n\n${buildAgentGuidePointer(guidePath, false)}`,
        });
        socket.destroy();

        fs.rmSync(cwd, { recursive: true, force: true });
        await app.close();
      });
    });

    describe("option 3 — dock preview worktree", () => {
      it("creates a dock preview worktree and starts a session inside it", async () => {
        const app = await buildApp();
        const cwd = createGitRepo();
        const projectId = await createProjectWithGitRepo(app, cwd);

        const created = await app.inject({
          method: "POST",
          url: "/api/sessions",
          payload: {
            projectId,
            command: "bash",
            worktree: { branch: "main" },
            worktreeRefresh: true,
          },
        });

        expect(created.statusCode).toBe(201);
        const session = created.json();
        // Dock preview worktrees live under .mullion-worktrees/dock-preview-*
        expect(session.cwd).toMatch(/\.mullion-worktrees\/dock-preview-main-/);
        expect(fs.existsSync(session.cwd)).toBe(true);
        // Detached preview worktrees don't tell the frontend which branch
        // they preview via `cwd` or git — this field is the only seam
        // (Dock.tsx's selector resolves a running preview session through it).
        expect(session.previewBranch).toBe("main");

        fs.rmSync(cwd, { recursive: true, force: true });
        await app.close();
      });

      it("exposes previewBranch on a GET /api/sessions re-fetch too, and null for a plain session", async () => {
        const app = await buildApp();
        const cwd = createGitRepo();
        const projectId = await createProjectWithGitRepo(app, cwd);

        const preview = await app.inject({
          method: "POST",
          url: "/api/sessions",
          payload: { projectId, command: "bash", worktree: { branch: "main" } },
        });
        expect(preview.statusCode).toBe(201);
        const previewId = preview.json().id as number;

        const plain = await app.inject({
          method: "POST",
          url: "/api/sessions",
          payload: { projectId, command: "bash" },
        });
        expect(plain.statusCode).toBe(201);
        const plainId = plain.json().id as number;
        expect(plain.json().previewBranch).toBeNull();

        // This is what makes the Dock's <select> resolve correctly after a
        // page reload, where the frontend's own worktreePaths state is gone
        // — the list endpoint must carry the same field the POST response did.
        const listed = await app.inject({ method: "GET", url: "/api/sessions" });
        const rows = listed.json() as Array<{ id: number; previewBranch: string | null }>;
        expect(rows.find((s) => s.id === previewId)?.previewBranch).toBe("main");
        expect(rows.find((s) => s.id === plainId)?.previewBranch).toBeNull();

        fs.rmSync(cwd, { recursive: true, force: true });
        await app.close();
      });

      it("cleans up the preview worktree on DELETE /:id without disturbing the primary checkout", async () => {
        const app = await buildApp();
        const cwd = createGitRepo();
        const projectId = await createProjectWithGitRepo(app, cwd);
        const headBefore = execFileSync("git", ["rev-parse", "HEAD"], {
          cwd,
          env: gitEnv(),
        }).toString();
        const statusBefore = execFileSync("git", ["status", "--porcelain"], {
          cwd,
          env: gitEnv(),
        }).toString();

        const created = await app.inject({
          method: "POST",
          url: "/api/sessions",
          payload: { projectId, command: "bash", worktree: { branch: "main" } },
        });
        expect(created.statusCode).toBe(201);
        const sessionId = created.json().id as number;
        const worktreePath = created.json().cwd as string;
        expect(fs.existsSync(worktreePath)).toBe(true);

        await app.inject({ method: "DELETE", url: `/api/sessions/${sessionId}` });

        // After kill, the preview worktree directory should be removed
        expect(fs.existsSync(worktreePath)).toBe(false);
        // The primary checkout — which shares "main" with the (now-removed)
        // detached preview — must be completely unaffected throughout.
        expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd, env: gitEnv() }).toString()).toBe(
          headBefore,
        );
        expect(
          execFileSync("git", ["status", "--porcelain"], { cwd, env: gitEnv() }).toString(),
        ).toBe(statusBefore);

        fs.rmSync(cwd, { recursive: true, force: true });
        await app.close();
      });

      it("refuses an empty worktree intent with no branch or baseRef", async () => {
        const app = await buildApp();
        const cwd = createGitRepo();
        const projectId = await createProjectWithGitRepo(app, cwd);

        const created = await app.inject({
          method: "POST",
          url: "/api/sessions",
          payload: { projectId, command: "bash", worktree: {} },
        });

        // oneOf validation in worktreeIntentSchema should reject this
        expect(created.statusCode).toBe(400);

        fs.rmSync(cwd, { recursive: true, force: true });
        await app.close();
      });

      describe("on a remote-hosted project (issue #345)", () => {
        async function createRemotePreviewProject(app: Awaited<ReturnType<typeof buildApp>>) {
          const host = await app.inject({
            method: "POST",
            url: "/api/hosts",
            // Deliberately unreachable — resolveBackend is spied per-test to
            // return a fake backend, so this baseUrl is never actually hit.
            payload: { name: "preview-remote", baseUrl: "http://127.0.0.1:1", token: "t" },
          });
          const hostId = host.json().id as string;
          const project = await app.inject({
            method: "POST",
            url: "/api/projects",
            payload: { name: "remote-preview-p", cwd: "/remote/project", hostId },
          });
          return { projectId: project.json().id as number, hostId };
        }

        it("checks out the branch through the backend and starts the session, instead of the old 502 refusal", async () => {
          const app = await buildApp();
          const sessionBackendModule = await import("../../src/services/session-backend.js");
          const { projectId } = await createRemotePreviewProject(app);

          const fakeBackend = {
            spawn: vi.fn().mockResolvedValue({}),
            liveStatus: vi.fn().mockResolvedValue({}),
            terminate: vi.fn().mockResolvedValue(undefined),
            checkoutBranchWorktree: vi.fn().mockResolvedValue({
              path: "/remote/project/.mullion-worktrees/dock-preview-main-abc123",
              branch: "main",
            }),
            removeWorktree: vi.fn().mockResolvedValue(true),
            syncWorktree: vi.fn().mockResolvedValue(true),
          };
          const resolveBackendSpy = vi
            .spyOn(sessionBackendModule, "resolveBackend")
            .mockReturnValue(fakeBackend);

          const created = await app.inject({
            method: "POST",
            url: "/api/sessions",
            payload: { projectId, command: "bash", worktree: { branch: "main" } },
          });

          // Before #345 this hit the `project.hostId !== LOCAL_HOST_ID`
          // guard and 502'd with reason "worktree-failed" — the same
          // reason a genuine checkoutBranchWorktree failure returns, so
          // asserting on the fake backend's own call (not just the status
          // code) is what actually distinguishes "guard removed" from
          // "guard replaced by a coincidentally-passing failure."
          expect(created.statusCode).toBe(201);
          expect(fakeBackend.checkoutBranchWorktree).toHaveBeenCalledWith(
            "/remote/project",
            "main",
          );
          expect(fakeBackend.spawn).toHaveBeenCalled();
          const body = created.json();
          expect(body.cwd).toBe("/remote/project/.mullion-worktrees/dock-preview-main-abc123");
          expect(body.previewBranch).toBe("main");

          resolveBackendSpy.mockRestore();
          await app.close();
        });

        it("wires a sync closure that routes worktreeRefresh through the backend's syncWorktree, not local git", async () => {
          const app = await buildApp();
          const sessionBackendModule = await import("../../src/services/session-backend.js");
          const gitWorktreeModule = await import("../../src/services/git-worktree.js");
          const { projectId } = await createRemotePreviewProject(app);
          const worktreePath = "/remote/project/.mullion-worktrees/dock-preview-main-abc123";

          const fakeBackend = {
            spawn: vi.fn().mockResolvedValue({}),
            liveStatus: vi.fn().mockResolvedValue({}),
            terminate: vi.fn().mockResolvedValue(undefined),
            checkoutBranchWorktree: vi
              .fn()
              .mockResolvedValue({ path: worktreePath, branch: "main" }),
            removeWorktree: vi.fn().mockResolvedValue(true),
            syncWorktree: vi.fn().mockResolvedValue(true),
          };
          const resolveBackendSpy = vi
            .spyOn(sessionBackendModule, "resolveBackend")
            .mockReturnValue(fakeBackend);

          const created = await app.inject({
            method: "POST",
            url: "/api/sessions",
            payload: {
              projectId,
              command: "bash",
              worktree: { branch: "main" },
              worktreeRefresh: true,
            },
          });
          expect(created.statusCode).toBe(201);
          const sessionId = created.json().id as number;

          // The 5s sync tick itself isn't exercised here (too slow for a
          // unit test — see git-worktree.ts's SYNC_INTERVAL_MS) but the
          // closure it would call is: this is the wiring Hermes/a reviewer
          // would otherwise have to trust unverified.
          const info = gitWorktreeModule.getPreviewWorktree(sessionId);
          expect(info?.sync).toBeDefined();
          await expect(info!.sync!()).resolves.toBe(true);
          expect(fakeBackend.syncWorktree).toHaveBeenCalledWith(worktreePath, "main");

          resolveBackendSpy.mockRestore();
          await app.close();
        });

        it("the remove/sync closures resolve false and still log a diagnostic when the backend call throws SYNCHRONOUSLY, not just on a rejection (independent review, this PR)", async () => {
          const app = await buildApp();
          const sessionBackendModule = await import("../../src/services/session-backend.js");
          const gitWorktreeModule = await import("../../src/services/git-worktree.js");
          const { projectId, hostId } = await createRemotePreviewProject(app);
          const worktreePath = "/remote/project/.mullion-worktrees/dock-preview-main-abc123";

          // Same shape as RemoteBackend.removeWorktree/syncWorktree's real
          // failure mode: their `client` getter can throw synchronously
          // (e.g. a hosts row deleted mid-lifetime) rather than returning a
          // rejected promise. A `.catch()` chained on the bare call can't
          // rescue that — only a try/catch wrapping the call itself can,
          // which is also what makes logPreviewWorktreeHostError still run.
          const removeWorktree = vi.fn(() => {
            throw new Error("host row deleted mid-request");
          });
          const syncWorktree = vi.fn(() => {
            throw new Error("host row deleted mid-request");
          });
          const fakeBackend = {
            spawn: vi.fn().mockResolvedValue({}),
            liveStatus: vi.fn().mockResolvedValue({}),
            terminate: vi.fn().mockResolvedValue(undefined),
            checkoutBranchWorktree: vi
              .fn()
              .mockResolvedValue({ path: worktreePath, branch: "main" }),
            removeWorktree,
            syncWorktree,
          };
          const resolveBackendSpy = vi
            .spyOn(sessionBackendModule, "resolveBackend")
            .mockReturnValue(fakeBackend);
          const warnSpy = vi.spyOn(app.log, "warn");

          const created = await app.inject({
            method: "POST",
            url: "/api/sessions",
            payload: {
              projectId,
              command: "bash",
              worktree: { branch: "main" },
              worktreeRefresh: true,
            },
          });
          expect(created.statusCode).toBe(201);
          const sessionId = created.json().id as number;
          const info = gitWorktreeModule.getPreviewWorktree(sessionId);

          await expect(info!.remove!()).resolves.toBe(false);
          await expect(info!.sync!()).resolves.toBe(false);
          expect(warnSpy).toHaveBeenCalledWith(
            expect.objectContaining({ hostId, worktreePath }),
            expect.stringContaining("preview worktree remove: host unreachable"),
          );
          expect(warnSpy).toHaveBeenCalledWith(
            expect.objectContaining({ hostId, worktreePath }),
            expect.stringContaining("preview worktree sync: host unreachable"),
          );

          resolveBackendSpy.mockRestore();
          await app.close();
        });

        it("routes DELETE cleanup through the backend's removeWorktree, not local git", async () => {
          const app = await buildApp();
          const sessionBackendModule = await import("../../src/services/session-backend.js");
          const { projectId } = await createRemotePreviewProject(app);
          const worktreePath = "/remote/project/.mullion-worktrees/dock-preview-main-abc123";

          const fakeBackend = {
            spawn: vi.fn().mockResolvedValue({}),
            liveStatus: vi.fn().mockResolvedValue({}),
            terminate: vi.fn().mockResolvedValue(undefined),
            checkoutBranchWorktree: vi
              .fn()
              .mockResolvedValue({ path: worktreePath, branch: "main" }),
            removeWorktree: vi.fn().mockResolvedValue(true),
            syncWorktree: vi.fn().mockResolvedValue(true),
          };
          const resolveBackendSpy = vi
            .spyOn(sessionBackendModule, "resolveBackend")
            .mockReturnValue(fakeBackend);

          const created = await app.inject({
            method: "POST",
            url: "/api/sessions",
            payload: { projectId, command: "bash", worktree: { branch: "main" } },
          });
          expect(created.statusCode).toBe(201);
          const sessionId = created.json().id as number;

          await app.inject({ method: "DELETE", url: `/api/sessions/${sessionId}` });

          expect(fakeBackend.removeWorktree).toHaveBeenCalledWith(worktreePath, "/remote/project");

          resolveBackendSpy.mockRestore();
          await app.close();
        });

        it("502s (not 500) when the remote host is genuinely unreachable, no resolveBackend mock", async () => {
          const app = await buildApp();
          // No fake backend this time — the real RemoteBackend hits the
          // unreachable baseUrl and rejects (HostUnreachableError). Before
          // this was wrapped in try/catch, that rejection escaped
          // createSessionRecord and Fastify's default error handler turned
          // it into a 500 — this was unreachable before #345 removed the
          // local-only guard, since the guard rejected first for every
          // remote host.
          const { projectId } = await createRemotePreviewProject(app);

          const created = await app.inject({
            method: "POST",
            url: "/api/sessions",
            payload: { projectId, command: "bash", worktree: { branch: "main" } },
          });

          expect(created.statusCode).toBe(502);

          await app.close();
        });

        it("502s (not 500) and still deletes the DB row when the spawn-failure worktree rollback itself throws SYNCHRONOUSLY (independent review, this PR)", async () => {
          const app = await buildApp();
          const sessionBackendModule = await import("../../src/services/session-backend.js");
          const { projectId } = await createRemotePreviewProject(app);
          const worktreePath = "/remote/project/.mullion-worktrees/dock-preview-main-abc123";

          // Simulates RemoteBackend.removeWorktree's real failure mode: its
          // `client` getter (getRemoteHostClient) can throw SYNCHRONOUSLY
          // (e.g. a hosts row deleted mid-request) before ever returning a
          // promise — `.catch(() => {})` chained on the call can't rescue
          // that, only a real try/catch around the call itself can. A
          // `vi.fn()` that throws (not rejects) reproduces exactly that
          // shape without needing a real deleted-host race.
          const removeWorktree = vi.fn(() => {
            throw new Error("host row deleted mid-request");
          });
          const fakeBackend = {
            liveStatus: vi.fn().mockResolvedValue({}),
            terminate: vi.fn().mockResolvedValue(undefined),
            checkoutBranchWorktree: vi
              .fn()
              .mockResolvedValue({ path: worktreePath, branch: "main" }),
            spawn: vi.fn().mockRejectedValue(new Error("spawn failed")),
            removeWorktree,
            syncWorktree: vi.fn().mockResolvedValue(true),
          };
          const resolveBackendSpy = vi
            .spyOn(sessionBackendModule, "resolveBackend")
            .mockReturnValue(fakeBackend);

          const created = await app.inject({
            method: "POST",
            url: "/api/sessions",
            payload: { projectId, command: "bash", worktree: { branch: "main" } },
          });

          // The clean spawn-failed contract, not an unhandled-rejection 500
          // — proves createSessionRecord's own rollback try/catch (not just
          // the outer spawn try/catch) survives the synchronous throw.
          expect(created.statusCode).toBe(502);
          expect(removeWorktree).toHaveBeenCalledWith(worktreePath, "/remote/project");

          // The rest of the catch block after the throwing rollback call
          // still ran — no orphaned "active" row for a session that was
          // never actually spawned anywhere.
          const list = await app.inject({
            method: "GET",
            url: `/api/sessions?projectId=${projectId}`,
          });
          expect(list.json()).toEqual([]);

          resolveBackendSpy.mockRestore();
          await app.close();
        });
      });
    });

    describe("POST /:id/promote/decline", () => {
      it("resolves a pending promote_request as declined and unblocks the model's tool call", async () => {
        const app = await buildApp();
        const cwd = createGitRepo();
        const projectId = await createProjectWithGitRepo(app, cwd);
        const sourceId = await (async () => {
          const created = await app.inject({
            method: "POST",
            url: "/api/sessions",
            payload: { projectId, command: "bash" },
          });
          return created.json().id as number;
        })();
        const session = app.pty.get(String(sourceId))!;

        const socket = await new Promise<net.Socket>((resolve, reject) => {
          const s = net.createConnection(app.pty.hookSocketPath);
          s.once("connect", () => resolve(s));
          s.once("error", reject);
        });
        socket.write(`${JSON.stringify({ token: session.hookToken })}\n`);
        socket.write(`${JSON.stringify({ kind: "promote_request", summary: "start work" })}\n`);
        await waitUntil(() => session.toInfo().promoteState === "pending");

        const res = await app.inject({
          method: "POST",
          url: `/api/sessions/${sourceId}/promote/decline`,
          payload: { reason: "not yet" },
        });
        expect(res.statusCode).toBe(204);
        expect(session.toInfo().promoteState).toBe("declined");

        // The source session is untouched — declining doesn't kill it.
        const list = await app.inject({
          method: "GET",
          url: `/api/sessions?projectId=${projectId}`,
        });
        expect(list.json().find((s: { id: number }) => s.id === sourceId).status).toBe("active");

        socket.destroy();
        fs.rmSync(cwd, { recursive: true, force: true });
        await app.close();
      });

      it("409s when nothing is pending", async () => {
        const app = await buildApp();
        const cwd = createGitRepo();
        const projectId = await createProjectWithGitRepo(app, cwd);
        const created = await app.inject({
          method: "POST",
          url: "/api/sessions",
          payload: { projectId, command: "bash" },
        });
        const sourceId = created.json().id as number;

        const res = await app.inject({
          method: "POST",
          url: `/api/sessions/${sourceId}/promote/decline`,
          payload: {},
        });
        expect(res.statusCode).toBe(409);

        fs.rmSync(cwd, { recursive: true, force: true });
        await app.close();
      });
    });
  });

  describe("multi-host (issue #26)", () => {
    async function createRemoteProject(app: Awaited<ReturnType<typeof buildApp>>) {
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        // Deliberately unreachable (port 1 refuses immediately) rather than
        // mocked — exercises the real HostUnreachableError path.
        payload: { name: "unreachable", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const hostId = host.json().id as string;
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "remote-p", cwd: "/remote/path", hostId },
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
      const { sessions } = await import("../../src/db/schema.js");
      const projectId = await createProject(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = created.json().id;

      const badHost = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "goes-down", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const remoteProject = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "remote-list", cwd: "/x", hostId: badHost.json().id },
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
      const { sessions } = await import("../../src/db/schema.js");
      const badHost = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "goes-down-2", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const remoteProject = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "remote-delete", cwd: "/x", hostId: badHost.json().id },
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

      const { sessions } = await import("../../src/db/schema.js");
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
      const { sessions } = await import("../../src/db/schema.js");
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
      const { sessions } = await import("../../src/db/schema.js");
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
  });

  // Phase 5 (Track B, issue #193 5.3b) — parentSessionId validation and the
  // sessions.spawn_child guardrails, exercised at the REST layer
  // (createSessionRecord is shared by POST /api/sessions and the socket op;
  // control-socket.test.ts covers the op-specific resolution/stamping).
  describe("parentSessionId (Phase 5, issue #193 5.3b)", () => {
    async function createActiveSession(
      app: Awaited<ReturnType<typeof buildApp>>,
      projectId: number,
      overrides: Record<string, unknown> = {},
    ) {
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash", ...overrides },
      });
      expect(created.statusCode).toBe(201);
      return created.json().id as number;
    }

    it("spawns a child with parentSessionId set and returns it in the response", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const parentId = await createActiveSession(app, projectId);

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash", parentSessionId: parentId },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().parentSessionId).toBe(parentId);

      await app.close();
    });

    it("400s an unknown parentSessionId", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash", parentSessionId: 999_999 },
      });

      expect(res.statusCode).toBe(400);

      await app.close();
    });

    it("400s a parentSessionId belonging to a different project", async () => {
      const app = await buildApp();
      const projectA = await createProject(app);
      const projectB = await createProject(app);
      const parentInB = await createActiveSession(app, projectB);

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId: projectA, command: "bash", parentSessionId: parentInB },
      });

      expect(res.statusCode).toBe(400);

      await app.close();
    });

    it("400s spawning a child of a session that is ITSELF a child — one level of nesting only", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const grandparentId = await createActiveSession(app, projectId);
      const parentId = await createActiveSession(app, projectId, {
        parentSessionId: grandparentId,
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash", parentSessionId: parentId },
      });

      expect(res.statusCode).toBe(400);

      await app.close();
    });

    it("400s a child spawn whose cwd resolves outside the project directory", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const parentId = await createActiveSession(app, projectId);

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: {
          projectId,
          command: "bash",
          parentSessionId: parentId,
          cwd: "/etc/passwd-adjacent-escape",
        },
      });

      expect(res.statusCode).toBe(400);

      await app.close();
    });

    it("429s once a parent's LIVE child count reaches maxChildSessionsPerParent", async () => {
      const app = await buildApp();
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { sessions: { maxChildSessionsPerParent: 2 } },
      });
      const projectId = await createProject(app);
      const parentId = await createActiveSession(app, projectId);

      await createActiveSession(app, projectId, { parentSessionId: parentId });
      await createActiveSession(app, projectId, { parentSessionId: parentId });

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash", parentSessionId: parentId },
      });

      expect(res.statusCode).toBe(429);

      await app.close();
    });

    it("does not count a killed child against the live cap", async () => {
      const app = await buildApp();
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { sessions: { maxChildSessionsPerParent: 1 } },
      });
      const projectId = await createProject(app);
      const parentId = await createActiveSession(app, projectId);
      const firstChildId = await createActiveSession(app, projectId, {
        parentSessionId: parentId,
      });

      await app.inject({ method: "DELETE", url: `/api/sessions/${firstChildId}` });

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash", parentSessionId: parentId },
      });

      expect(res.statusCode).toBe(201);

      await app.close();
    });
  });

  // Phase 5 (Track B, issue #196 5.6) — killSession's cascade parameter,
  // exercised via the DELETE route's own ?cascade= querystring.
  describe("cascade kill (Phase 5, issue #196 5.6)", () => {
    async function createActiveSession(
      app: Awaited<ReturnType<typeof buildApp>>,
      projectId: number,
      overrides: Record<string, unknown> = {},
    ) {
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash", ...overrides },
      });
      expect(created.statusCode).toBe(201);
      return created.json().id as number;
    }

    it("defaults to detach: a killed parent's live children survive, re-parented to none", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const parentId = await createActiveSession(app, projectId);
      const childId = await createActiveSession(app, projectId, { parentSessionId: parentId });

      const res = await app.inject({ method: "DELETE", url: `/api/sessions/${parentId}` });
      expect(res.statusCode).toBe(204);

      const child = await app.inject({ method: "GET", url: `/api/sessions/${childId}` });
      expect(child.json().status).toBe("active");
      expect(child.json().parentSessionId).toBe(null);

      await app.close();
    });

    it("?cascade=kill kills live children too", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const parentId = await createActiveSession(app, projectId);
      const childId = await createActiveSession(app, projectId, { parentSessionId: parentId });

      const res = await app.inject({
        method: "DELETE",
        url: `/api/sessions/${parentId}?cascade=kill`,
      });
      expect(res.statusCode).toBe(204);

      const child = await app.inject({ method: "GET", url: `/api/sessions/${childId}` });
      expect(child.json().status).toBe("killed");

      await app.close();
    });

    it("rejects an invalid ?cascade= value", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const sessionId = await createActiveSession(app, projectId);

      const res = await app.inject({
        method: "DELETE",
        url: `/api/sessions/${sessionId}?cascade=bogus`,
      });
      expect(res.statusCode).toBe(400);

      await app.close();
    });
  });
});
