import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { closeDb } from "../../src/db/client.js";

const tmpDb = path.join(os.tmpdir(), `dock-config-test-${process.pid}.db`);
process.env.DATABASE_URL = `file:${tmpDb}`;

// Same "second real buildApp() in `agent` role needs its own SESSIONS_DIR"
// reasoning as test/routes/agent-rules.test.ts's own uniqueSessionsDir.
function uniqueSessionsDir(): string {
  return path.join(
    os.tmpdir(),
    `dock-config-agent-sessions-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
  );
}

const { buildApp } = await import("../../src/app.js");

describe("dock-config routes", () => {
  let projectCwd: string;

  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
  });

  beforeEach(() => {
    projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-dock-config-route-project-"));
  });

  afterEach(() => {
    fs.rmSync(projectCwd, { recursive: true, force: true });
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  async function createProject() {
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "dock-config-test", cwd: projectCwd },
    });
    return { app, projectId: created.json().id as number };
  }

  describe("GET /api/projects/:id/dock/config", () => {
    it("404s for an unknown project", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/projects/999999/dock/config" });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("400s for a non-integer project id", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/projects/not-a-number/dock/config",
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("returns an empty, valid result for a fresh project with no dock.json", async () => {
      const { app, projectId } = await createProject();
      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/dock/config`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ controls: [], invalid: false, reason: null, isSymlink: false });
      await app.close();
    });

    it("reads back the raw, unmerged project-scope file — never the global/docker-merged view", async () => {
      fs.mkdirSync(path.join(projectCwd, ".crs"), { recursive: true });
      fs.writeFileSync(
        path.join(projectCwd, ".crs", "dock.json"),
        JSON.stringify({ controls: [{ id: "logs", title: "Logs", command: "tail -f log" }] }),
      );
      const { app, projectId } = await createProject();
      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/dock/config`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().controls).toEqual([{ id: "logs", title: "Logs", command: "tail -f log" }]);
      await app.close();
    });

    // Hermes fresh-review nit on PR #586 — proves the isSymlink flag
    // actually reaches the HTTP response, not just the service layer
    // (test/services/dock-config.test.ts's own suite already covers
    // readDockConfig directly).
    it("surfaces isSymlink:true for a symlinked dock.json", async () => {
      fs.mkdirSync(path.join(projectCwd, ".crs"), { recursive: true });
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-dock-config-route-symlink-"));
      fs.writeFileSync(
        path.join(outside, "dock.json"),
        JSON.stringify({ controls: [{ id: "x", title: "X", command: "echo x" }] }),
      );
      fs.symlinkSync(path.join(outside, "dock.json"), path.join(projectCwd, ".crs", "dock.json"));
      try {
        const { app, projectId } = await createProject();
        const res = await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/dock/config`,
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().isSymlink).toBe(true);
        expect(res.json().controls).toEqual([{ id: "x", title: "X", command: "echo x" }]);
        await app.close();
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it("200s with invalid:true and a reason for a malformed on-disk dock.json, rather than erroring", async () => {
      fs.mkdirSync(path.join(projectCwd, ".crs"), { recursive: true });
      fs.writeFileSync(path.join(projectCwd, ".crs", "dock.json"), "{ not json");
      const { app, projectId } = await createProject();
      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/dock/config`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        controls: [],
        invalid: true,
        reason: expect.stringMatching(/Not valid JSON/),
        isSymlink: false,
      });
      await app.close();
    });

    it("503s (not 500s) when the file isn't readable", async () => {
      fs.mkdirSync(path.join(projectCwd, ".crs"), { recursive: true });
      fs.writeFileSync(
        path.join(projectCwd, ".crs", "dock.json"),
        JSON.stringify({ controls: [] }),
      );
      fs.chmodSync(path.join(projectCwd, ".crs", "dock.json"), 0o000);
      const { app, projectId } = await createProject();
      try {
        const res = await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/dock/config`,
        });
        expect(res.statusCode).toBe(503);
      } finally {
        fs.chmodSync(path.join(projectCwd, ".crs", "dock.json"), 0o700);
        await app.close();
      }
    });
  });

  describe("PUT /api/projects/:id/dock/config", () => {
    it("writes a new dock.json and returns the read-back result", async () => {
      const { app, projectId } = await createProject();
      const res = await app.inject({
        method: "PUT",
        url: `/api/projects/${projectId}/dock/config`,
        payload: { controls: [{ id: "dev-server", title: "Dev server", command: "make dev" }] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        controls: [{ id: "dev-server", title: "Dev server", command: "make dev" }],
        invalid: false,
        reason: null,
        isSymlink: false,
      });
      expect(
        JSON.parse(fs.readFileSync(path.join(projectCwd, ".crs", "dock.json"), "utf8")),
      ).toEqual({ controls: [{ id: "dev-server", title: "Dev server", command: "make dev" }] });
      await app.close();
    });

    it("404s for an unknown project", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "PUT",
        url: "/api/projects/999999/dock/config",
        payload: { controls: [] },
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("400s on a missing required field, via validateDockConfig, without writing", async () => {
      const { app, projectId } = await createProject();
      const res = await app.inject({
        method: "PUT",
        url: `/api/projects/${projectId}/dock/config`,
        payload: { controls: [{ id: "x", command: "echo x" }] },
      });
      expect(res.statusCode).toBe(400);
      expect(fs.existsSync(path.join(projectCwd, ".crs", "dock.json"))).toBe(false);
      await app.close();
    });

    it("400s with a clear message on malformed JSON in the request body", async () => {
      const { app, projectId } = await createProject();
      const res = await app.inject({
        method: "PUT",
        url: `/api/projects/${projectId}/dock/config`,
        payload: "{ this is not json",
        headers: { "content-type": "application/json" },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("400s on a control carrying the docker-discovery-only source field, without writing", async () => {
      const { app, projectId } = await createProject();
      const res = await app.inject({
        method: "PUT",
        url: `/api/projects/${projectId}/dock/config`,
        payload: { controls: [{ id: "x", title: "X", command: "echo x", source: "docker" }] },
      });
      expect(res.statusCode).toBe(400);
      expect(fs.existsSync(path.join(projectCwd, ".crs", "dock.json"))).toBe(false);
      await app.close();
    });

    it("400s on duplicate ids, via the service-level check the JSON schema can't express", async () => {
      const { app, projectId } = await createProject();
      const res = await app.inject({
        method: "PUT",
        url: `/api/projects/${projectId}/dock/config`,
        payload: {
          controls: [
            { id: "dup", title: "A", command: "echo a" },
            { id: "dup", title: "B", command: "echo b" },
          ],
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/duplicate control id "dup"/);
      await app.close();
    });

    it("400s on oversized content, without writing the file", async () => {
      const { app, projectId } = await createProject();
      const res = await app.inject({
        method: "PUT",
        url: `/api/projects/${projectId}/dock/config`,
        payload: {
          controls: [{ id: "x", title: "X", command: "echo " + "x".repeat(512 * 1024) }],
        },
      });
      expect(res.statusCode).toBe(400);
      expect(fs.existsSync(path.join(projectCwd, ".crs", "dock.json"))).toBe(false);
      await app.close();
    });

    // Discriminating path-safety test: a project's stored cwd is trusted
    // (same posture project-config.ts's own resolveProjectDock already has
    // for the READ side), but the write must still land at EXACTLY
    // `<cwd>/.crs/dock.json` and nowhere else, even when that cwd itself
    // contains no traversal opportunity to begin with — proving
    // resolveDockConfigPath's containment check doesn't accidentally widen
    // where a write can land.
    it("writes to exactly <project.cwd>/.crs/dock.json, never outside it", async () => {
      const { app, projectId } = await createProject();
      await app.inject({
        method: "PUT",
        url: `/api/projects/${projectId}/dock/config`,
        payload: { controls: [{ id: "x", title: "X", command: "echo x" }] },
      });
      const entries = fs.readdirSync(projectCwd);
      expect(entries).toEqual([".crs"]);
      expect(fs.readdirSync(path.join(projectCwd, ".crs"))).toEqual(["dock.json"]);
      await app.close();
    });

    it("503s (not 500s) when .crs/ isn't writable", async () => {
      const { app, projectId } = await createProject();
      fs.chmodSync(projectCwd, 0o500);
      try {
        const res = await app.inject({
          method: "PUT",
          url: `/api/projects/${projectId}/dock/config`,
          payload: { controls: [{ id: "x", title: "X", command: "echo x" }] },
        });
        expect(res.statusCode).toBe(503);
      } finally {
        fs.chmodSync(projectCwd, 0o700);
        await app.close();
      }
    });
  });

  // Same "two real buildApp() instances, real HTTP between them" pattern as
  // test/routes/agent-rules.test.ts's own remote-host describe block — the
  // one thing that's non-negotiable here is that a remote-hosted project's
  // write must land on THAT host's filesystem, never the primary's.
  describe("remote host", () => {
    async function startAgent(token: string) {
      const prevEnv: Record<string, string | undefined> = {};
      const agentEnv = {
        MULLION_ROLE: "agent",
        MULLION_AGENT_TOKEN: token,
        PROJECTS_ROOTS: os.tmpdir(),
        SESSIONS_DIR: uniqueSessionsDir(),
      };
      for (const key of Object.keys(agentEnv)) {
        prevEnv[key] = process.env[key];
        process.env[key] = agentEnv[key as keyof typeof agentEnv];
      }
      const agentApp = await buildApp();
      for (const key of Object.keys(agentEnv)) {
        if (prevEnv[key] === undefined) delete process.env[key];
        else process.env[key] = prevEnv[key];
      }
      await agentApp.listen({ port: 0, host: "127.0.0.1" });
      const address = agentApp.server.address();
      if (address === null || typeof address === "string") {
        throw new Error("expected a real bound address");
      }
      return { agentApp, port: address.port };
    }

    // Note on what this actually proves: the "agent" here runs in the SAME
    // test process, on the SAME real filesystem, as the primary (only
    // `PROJECTS_ROOTS`/port differ) — so unlike agent-rules.test.ts's own
    // global-scope-on-remote-host test (which can distinguish "which
    // filesystem" via a different HOME per role), a bare existsSync can't
    // tell "the primary wrote it directly" apart from "the agent wrote it
    // after an HTTP round trip" when both would land at the identical
    // `projectCwd`. What this test DOES prove: the project's stored
    // `hostId` (not LOCAL_HOST_ID) drives the routing decision end to end —
    // a write against a genuinely non-local hostId only succeeds AT ALL
    // because it reached a second, real, independently-listening HTTP
    // server (the agent) and got a real response back, and the read-back
    // through the SAME route confirms that response was actually persisted,
    // not just echoed.
    it("a remote-hosted project's write round-trips through its own host, not a local no-op", async () => {
      const token = "dock-config-remote-token";
      const { agentApp, port } = await startAgent(token);

      const primary = await buildApp();
      const host = await primary.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "dock-config-remote-host", baseUrl: `http://127.0.0.1:${port}`, token },
      });
      const project = await primary.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "dock-config-remote", cwd: projectCwd, hostId: host.json().id },
      });
      const projectId = project.json().id as number;
      expect(project.json().hostId).toBe(host.json().id);
      expect(project.json().hostId).not.toBe("local");

      const res = await primary.inject({
        method: "PUT",
        url: `/api/projects/${projectId}/dock/config`,
        payload: { controls: [{ id: "x", title: "X", command: "echo x" }] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().controls).toEqual([{ id: "x", title: "X", command: "echo x" }]);
      expect(
        JSON.parse(fs.readFileSync(path.join(projectCwd, ".crs", "dock.json"), "utf8")),
      ).toEqual({ controls: [{ id: "x", title: "X", command: "echo x" }] });

      const readBack = await primary.inject({
        method: "GET",
        url: `/api/projects/${projectId}/dock/config`,
      });
      expect(readBack.statusCode).toBe(200);
      expect(readBack.json().controls).toEqual([{ id: "x", title: "X", command: "echo x" }]);

      await primary.close();
      await agentApp.close();
    });

    it("forwards the agent's real 400 (duplicate ids) instead of a generic 503", async () => {
      const token = "dock-config-remote-token-2";
      const { agentApp, port } = await startAgent(token);

      const primary = await buildApp();
      const host = await primary.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "dock-config-remote-host-2", baseUrl: `http://127.0.0.1:${port}`, token },
      });
      const project = await primary.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "dock-config-remote-2", cwd: projectCwd, hostId: host.json().id },
      });

      const res = await primary.inject({
        method: "PUT",
        url: `/api/projects/${project.json().id}/dock/config`,
        payload: {
          controls: [
            { id: "dup", title: "A", command: "echo a" },
            { id: "dup", title: "B", command: "echo b" },
          ],
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/duplicate control id "dup"/);

      await primary.close();
      await agentApp.close();
    });

    it("folds the agent's real 401 (wrong token) into 503, not a raw 401", async () => {
      const { agentApp, port } = await startAgent("the-real-agent-token");

      const primary = await buildApp();
      const host = await primary.inject({
        method: "POST",
        url: "/api/hosts",
        payload: {
          name: "dock-config-wrong-token-host",
          baseUrl: `http://127.0.0.1:${port}`,
          token: "a-completely-different-token",
        },
      });
      const project = await primary.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "dock-config-wrong-token", cwd: projectCwd, hostId: host.json().id },
      });

      const res = await primary.inject({
        method: "PUT",
        url: `/api/projects/${project.json().id}/dock/config`,
        payload: { controls: [{ id: "x", title: "X", command: "echo x" }] },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().message).toBe("Host rejected the request — check its agent token");

      await primary.close();
      await agentApp.close();
    });

    // A genuinely unreachable host (nothing listening) — distinct from the
    // two tests above, which both got a real HTTP response back (just an
    // unwelcome one). No agent process at all here.
    it("503s with a host-unreachable message when the host can't be reached", async () => {
      const primary = await buildApp();
      const host = await primary.inject({
        method: "POST",
        url: "/api/hosts",
        payload: {
          name: "dock-config-unreachable-host",
          baseUrl: "http://127.0.0.1:1",
          token: "irrelevant",
        },
      });
      const project = await primary.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "dock-config-unreachable", cwd: projectCwd, hostId: host.json().id },
      });

      const res = await primary.inject({
        method: "PUT",
        url: `/api/projects/${project.json().id}/dock/config`,
        payload: { controls: [{ id: "x", title: "X", command: "echo x" }] },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().message).toMatch(/unreachable/);

      await primary.close();
    });
  });
});
