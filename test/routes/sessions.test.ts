import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import net from "node:net";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import type * as ChildProcess from "node:child_process";

// Session creation spawns real OS processes (systemd-run, dtach) via
// PtyManager — faked here the same way as test/services/pty-manager.test.ts,
// so this file exercises the route/DB layer without depending on a real
// systemd --user session existing in CI. See that file for why.
vi.mock("node-pty", () => ({
  spawn: vi.fn(() => {
    const listeners: Array<(data: string) => void> = [];
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
      payload: { name: "p", cwd: "/tmp" },
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

  describe("POST /api/sessions/:id/uploads (issue #68)", () => {
    async function createProjectWithCwd(app: Awaited<ReturnType<typeof buildApp>>, cwd: string) {
      const res = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "upload-p", cwd },
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

  describe("worktree isolation (issue #271)", () => {
    function git(cwd: string, args: string[]) {
      execFileSync("git", args, { cwd, stdio: "pipe" });
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
        payload: { name: "worktree-p", cwd },
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

        const list = await app.inject({
          method: "GET",
          url: `/api/sessions?projectId=${projectId}`,
        });
        const sourceRow = list.json().find((s: { id: number }) => s.id === sourceId);
        expect(sourceRow.status).toBe("killed");

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
        expect(JSON.parse(await replyPromise)).toEqual({
          additionalContext: "resume the refactor",
        });
        socket.destroy();

        fs.rmSync(cwd, { recursive: true, force: true });
        await app.close();
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
});
