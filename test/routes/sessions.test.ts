import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
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
    spawn: vi.fn(() => {
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
      expect(uploadPath.startsWith(path.join(cwd, ".tessera-uploads"))).toBe(true);
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
  });
});
