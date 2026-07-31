import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { closeDb } from "../../src/db/client.js";

const tmpDb = path.join(os.tmpdir(), `skills-test-${process.pid}.db`);
process.env.DATABASE_URL = `file:${tmpDb}`;

const { buildApp } = await import("../../src/app.js");

// Every global/builtin dir resolves off os.homedir() — redirected the same
// way test/services/skills.test.ts and agent-rules.test.ts's route tests do.
describe("skills routes", () => {
  let fakeHome: string;
  let projectCwd: string;
  const originalHome = process.env.HOME;

  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
  });

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-skills-route-home-"));
    projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-skills-route-project-"));
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    fs.rmSync(fakeHome, { recursive: true, force: true });
    fs.rmSync(projectCwd, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  function writeSkill(dir: string, name: string, description: string) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${description}\n---\n`,
    );
  }

  async function createProject() {
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "skills-test", cwd: projectCwd },
    });
    return { app, projectId: created.json().id as number };
  }

  describe("GET /api/skills", () => {
    it("returns an empty array when no global/builtin skills exist", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/skills" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
      await app.close();
    });

    it("returns a global skill and excludes project-scope ones", async () => {
      writeSkill(
        path.join(fakeHome, ".claude", "skills", "global-one"),
        "global-one",
        "a global skill",
      );
      writeSkill(
        path.join(projectCwd, ".claude", "skills", "project-one"),
        "project-one",
        "a project skill",
      );
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/skills" });
      const names = res.json().map((s: { name: string }) => s.name);
      expect(names).toContain("global-one");
      expect(names).not.toContain("project-one");
      await app.close();
    });
  });

  describe("GET /api/projects/:id/skills", () => {
    it("404s for an unknown project", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/projects/999999/skills" });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("400s for a non-integer project id", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/projects/not-a-number/skills" });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("returns an empty array for a fresh project with no skills", async () => {
      const { app, projectId } = await createProject();
      const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/skills` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
      await app.close();
    });

    it("includes both project-scope and global-scope skills for a local project", async () => {
      writeSkill(
        path.join(projectCwd, ".claude", "skills", "proj-skill"),
        "proj-skill",
        "in the repo",
      );
      writeSkill(
        path.join(fakeHome, ".claude", "skills", "home-skill"),
        "home-skill",
        "in the home dir",
      );
      const { app, projectId } = await createProject();
      const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/skills` });
      const byName = Object.fromEntries(
        res.json().map((s: { name: string; scope: string }) => [s.name, s]),
      );
      expect(byName["proj-skill"].scope).toBe("project");
      expect(byName["home-skill"].scope).toBe("global");
      await app.close();
    });
  });

  describe("remote host — full triple parity", () => {
    async function startAgent(projectsRoots: string) {
      const prevEnv: Record<string, string | undefined> = {};
      const agentEnv = {
        MULLION_ROLE: "agent",
        MULLION_AGENT_TOKEN: "skills-remote-token",
        PROJECTS_ROOTS: projectsRoots,
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

    it("proxies a remote-hosted project's skills through /internal/skills", async () => {
      // The agent process's own HOME is this SAME redirected fakeHome (set
      // in beforeEach), since buildApp's os.homedir() calls happen in this
      // same process — a genuinely separate host would have its own HOME,
      // but reusing it here still exercises the real HTTP round trip.
      writeSkill(
        path.join(projectCwd, ".claude", "skills", "remote-proj-skill"),
        "remote-proj-skill",
        "x",
      );
      const { agentApp, port } = await startAgent(os.tmpdir());

      const primary = await buildApp();
      const host = await primary.inject({
        method: "POST",
        url: "/api/hosts",
        payload: {
          name: "skills-remote-host",
          baseUrl: `http://127.0.0.1:${port}`,
          token: "skills-remote-token",
        },
      });
      const project = await primary.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "skills-remote", cwd: projectCwd, hostId: host.json().id },
      });

      const res = await primary.inject({
        method: "GET",
        url: `/api/projects/${project.json().id}/skills`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().map((s: { name: string }) => s.name)).toContain("remote-proj-skill");

      await primary.close();
      await agentApp.close();
    });

    it("folds the agent's 401 (wrong token) into 503, not a raw 401", async () => {
      const { agentApp, port } = await startAgent(os.tmpdir());

      const primary = await buildApp();
      const host = await primary.inject({
        method: "POST",
        url: "/api/hosts",
        payload: {
          name: "skills-wrong-token-host",
          baseUrl: `http://127.0.0.1:${port}`,
          token: "a-completely-different-token",
        },
      });
      const project = await primary.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "skills-wrong-token", cwd: projectCwd, hostId: host.json().id },
      });

      const res = await primary.inject({
        method: "GET",
        url: `/api/projects/${project.json().id}/skills`,
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().message).toBe("Host rejected the request — check its agent token");

      await primary.close();
      await agentApp.close();
    });
  });
});
