import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { closeDb } from "../../src/db/client.js";

const tmpDb = path.join(os.tmpdir(), `project-files-test-${process.pid}.db`);
process.env.DATABASE_URL = `file:${tmpDb}`;

// Same two-real-app-instances setup as agent-rules.test.ts: the agent gets
// its own SESSIONS_DIR so its hooks.sock doesn't collide with the primary's.
function uniqueSessionsDir(): string {
  return path.join(
    os.tmpdir(),
    `project-files-agent-sessions-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
  );
}

const { buildApp } = await import("../../src/app.js");

describe("project-files routes", () => {
  let projectCwd: string;

  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
  });

  beforeEach(() => {
    projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-project-files-route-"));
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
      payload: { createDir: true, name: "project-files-test", cwd: projectCwd },
    });
    return { app, projectId: created.json().id as number };
  }

  it("404s for an unknown project and 400s for a bad id", async () => {
    const app = await buildApp();
    expect(
      (await app.inject({ method: "GET", url: "/api/projects/999999/files" })).statusCode,
    ).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/projects/abc/files" })).statusCode).toBe(
      400,
    );
    expect(
      (await app.inject({ method: "GET", url: "/api/projects/999999/file?path=a" })).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/projects/999999/file",
          payload: { path: "a", content: "" },
        })
      ).statusCode,
    ).toBe(404);
    await app.close();
  });

  it("lists, reads, creates, updates and detects conflicts end to end", async () => {
    fs.writeFileSync(path.join(projectCwd, ".env"), "A=1\n");
    const { app, projectId } = await createProject();

    const list = await app.inject({ method: "GET", url: `/api/projects/${projectId}/files` });
    expect(list.statusCode).toBe(200);
    expect(list.json().entries.map((e: { name: string }) => e.name)).toContain(".env");

    const read = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/file?path=.env`,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ path: ".env", content: "A=1\n" });
    const { mtimeMs } = read.json();

    const put = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/file`,
      payload: { path: ".env", content: "A=2\n", expectedMtimeMs: mtimeMs },
    });
    expect(put.statusCode).toBe(200);
    expect(fs.readFileSync(path.join(projectCwd, ".env"), "utf8")).toBe("A=2\n");

    const stale = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/file`,
      payload: { path: ".env", content: "A=3\n", expectedMtimeMs: mtimeMs - 5000 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe("conflict");

    const created = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/file`,
      payload: { path: "new.txt", content: "hi", create: true },
    });
    expect(created.statusCode).toBe(200);
    const again = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/file`,
      payload: { path: "new.txt", content: "hi", create: true },
    });
    expect(again.statusCode).toBe(409);
    await app.close();
  });

  it("maps service errors to their http status", async () => {
    fs.writeFileSync(path.join(projectCwd, "bin"), Buffer.from([0, 1, 2]));
    const { app, projectId } = await createProject();
    const get = (p: string) =>
      app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/file?path=${encodeURIComponent(p)}`,
      });
    expect((await get("../etc/passwd")).statusCode).toBe(400);
    expect((await get("missing")).statusCode).toBe(404);
    const missing = await get("missing");
    expect(missing.json().code).toBe("not_found");
    expect((await get("bin")).statusCode).toBe(415);
    const noPath = await app.inject({ method: "GET", url: `/api/projects/${projectId}/file` });
    expect(noPath.statusCode).toBe(400);
    const big = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/file`,
      payload: { path: "big", content: "x".repeat(1024 * 1024 + 1), create: true },
    });
    expect(big.statusCode).toBe(413);
    await app.close();
  });

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

    async function remoteProject(port: number, token: string, cwd: string) {
      const primary = await buildApp();
      const host = await primary.inject({
        method: "POST",
        url: "/api/hosts",
        payload: {
          name: `pf-remote-${crypto.randomBytes(3).toString("hex")}`,
          baseUrl: `http://127.0.0.1:${port}`,
          token,
        },
      });
      const project = await primary.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "pf-remote", cwd, hostId: host.json().id },
      });
      return { primary, projectId: project.json().id as number };
    }

    it("round-trips list/read/write and forwards coded errors", async () => {
      fs.writeFileSync(path.join(projectCwd, ".env"), "R=1\n");
      const { agentApp, port } = await startAgent("pf-token");
      const { primary, projectId } = await remoteProject(port, "pf-token", projectCwd);

      const list = await primary.inject({ method: "GET", url: `/api/projects/${projectId}/files` });
      expect(list.statusCode).toBe(200);
      expect(list.json().entries.map((e: { name: string }) => e.name)).toContain(".env");

      const read = await primary.inject({
        method: "GET",
        url: `/api/projects/${projectId}/file?path=.env`,
      });
      expect(read.json().content).toBe("R=1\n");

      const put = await primary.inject({
        method: "PUT",
        url: `/api/projects/${projectId}/file`,
        payload: { path: ".env", content: "R=2\n", expectedMtimeMs: read.json().mtimeMs },
      });
      expect(put.statusCode).toBe(200);
      expect(fs.readFileSync(path.join(projectCwd, ".env"), "utf8")).toBe("R=2\n");

      // genuinely missing file: coded 404 is forwarded as 404, NOT 501
      const missing = await primary.inject({
        method: "GET",
        url: `/api/projects/${projectId}/file?path=nope`,
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().code).toBe("not_found");

      const stale = await primary.inject({
        method: "PUT",
        url: `/api/projects/${projectId}/file`,
        payload: { path: ".env", content: "x", expectedMtimeMs: 1 },
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().code).toBe("conflict");

      await primary.close();
      await agentApp.close();
    });

    it("400s when the project cwd is outside the agent's PROJECTS_ROOTS", async () => {
      const { agentApp, port } = await startAgent("pf-token-2");
      const { primary, projectId } = await remoteProject(port, "pf-token-2", "/");
      const res = await primary.inject({ method: "GET", url: `/api/projects/${projectId}/files` });
      expect(res.statusCode).toBe(400);
      await primary.close();
      await agentApp.close();
    });

    it("folds a wrong agent token into 503", async () => {
      const { agentApp, port } = await startAgent("the-real-token");
      const { primary, projectId } = await remoteProject(port, "wrong-token", projectCwd);
      const res = await primary.inject({ method: "GET", url: `/api/projects/${projectId}/files` });
      expect(res.statusCode).toBe(503);
      await primary.close();
      await agentApp.close();
    });

    it("replies 501 when the agent lacks the routes (bare 404)", async () => {
      const bare = (await import("fastify")).default();
      bare.setNotFoundHandler((_req, reply) => reply.code(404).send({ message: "Not Found" }));
      await bare.listen({ port: 0, host: "127.0.0.1" });
      const address = bare.server.address();
      if (address === null || typeof address === "string") throw new Error("no address");
      const { primary, projectId } = await remoteProject(address.port, "any", projectCwd);
      const res = await primary.inject({ method: "GET", url: `/api/projects/${projectId}/files` });
      expect(res.statusCode).toBe(501);
      expect(res.json().message).toMatch(/too old/);
      await primary.close();
      await bare.close();
    });

    it("503s when the host is unreachable", async () => {
      const { agentApp, port } = await startAgent("pf-token-3");
      const { primary, projectId } = await remoteProject(port, "pf-token-3", projectCwd);
      await agentApp.close();
      const res = await primary.inject({ method: "GET", url: `/api/projects/${projectId}/files` });
      expect(res.statusCode).toBe(503);
      await primary.close();
    });
  });
});
