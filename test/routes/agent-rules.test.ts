import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { closeDb } from "../../src/db/client.js";

const tmpDb = path.join(os.tmpdir(), `agent-rules-test-${process.pid}.db`);
process.env.DATABASE_URL = `file:${tmpDb}`;

// Each "remote host" test below builds a second, real buildApp() instance in
// `agent` role alongside the file's own primary one — both would otherwise
// default to the SAME SESSIONS_DIR (test/setup.ts sets it once per file),
// so their hooksPlugin listeners (registered for both roles) would collide
// on the same hooks.sock path. Gives each agent instance its own scratch
// directory instead.
function uniqueSessionsDir(): string {
  return path.join(
    os.tmpdir(),
    `agent-rules-agent-sessions-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
  );
}

const { buildApp } = await import("../../src/app.js");

// Every global-scope target resolves off os.homedir() — redirected here the
// same way test/services/agent-rules.test.ts does, so these route tests
// never touch the real developer/CI-runner's own ~/.claude etc.
describe("agent-rules routes", () => {
  let fakeHome: string;
  let projectCwd: string;
  const originalHome = process.env.HOME;

  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
  });

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-agent-rules-route-home-"));
    projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-agent-rules-route-project-"));
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

  async function createProject() {
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, name: "agent-rules-test", cwd: projectCwd },
    });
    return { app, projectId: created.json().id as number };
  }

  describe("GET /api/projects/:id/agent-rules", () => {
    it("404s for an unknown project", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/projects/999999/agent-rules" });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("400s for a non-integer project id", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/projects/not-a-number/agent-rules",
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("returns the full target list, all non-existent, for a fresh project", async () => {
      const { app, projectId } = await createProject();
      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/agent-rules`,
      });
      expect(res.statusCode).toBe(200);
      const targets = res.json();
      expect(Array.isArray(targets)).toBe(true);
      expect(targets.length).toBeGreaterThan(0);
      expect(targets.every((t: { exists: boolean }) => t.exists === false)).toBe(true);
      await app.close();
    });

    it("inlines content for a file that exists on disk", async () => {
      fs.writeFileSync(path.join(projectCwd, "CLAUDE.md"), "project guidance");
      const { app, projectId } = await createProject();
      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/agent-rules`,
      });
      const claude = res.json().find((t: { id: string }) => t.id === "claude-code:project");
      expect(claude.exists).toBe(true);
      expect(claude.content).toBe("project guidance");
      await app.close();
    });
  });

  describe("PUT /api/projects/:id/agent-rules/:target", () => {
    it("writes a new file and returns the updated target", async () => {
      const { app, projectId } = await createProject();
      const res = await app.inject({
        method: "PUT",
        url: `/api/projects/${projectId}/agent-rules/claude-code:project`,
        payload: { content: "hello from the editor" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().content).toBe("hello from the editor");
      expect(fs.readFileSync(path.join(projectCwd, "CLAUDE.md"), "utf8")).toBe(
        "hello from the editor",
      );
      await app.close();
    });

    it("400s for an unknown target id", async () => {
      const { app, projectId } = await createProject();
      const res = await app.inject({
        method: "PUT",
        url: `/api/projects/${projectId}/agent-rules/not-a-real-target`,
        payload: { content: "x" },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    // Issue #431, Hermes review on PR #458 — a global-scope target id used
    // to 400 here and force the frontend through a standalone,
    // primary-host-only route, which for a remote-hosted project silently
    // wrote to the *primary's* filesystem instead of that project's own
    // host. It's now routed the same way project-scope targets are.
    it("writes a global-scope target to the redirected HOME, routed through this same project route", async () => {
      const { app, projectId } = await createProject();
      const res = await app.inject({
        method: "PUT",
        url: `/api/projects/${projectId}/agent-rules/claude-code:global`,
        payload: { content: "global claude content" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().content).toBe("global claude content");
      expect(fs.readFileSync(path.join(fakeHome, ".claude", "CLAUDE.md"), "utf8")).toBe(
        "global claude content",
      );
      await app.close();
    });

    it("400s on oversized content, without writing the file", async () => {
      const { app, projectId } = await createProject();
      const res = await app.inject({
        method: "PUT",
        url: `/api/projects/${projectId}/agent-rules/claude-code:project`,
        payload: { content: "x".repeat(512 * 1024 + 1) },
      });
      expect(res.statusCode).toBe(400);
      expect(fs.existsSync(path.join(projectCwd, "CLAUDE.md"))).toBe(false);
      await app.close();
    });

    it("404s for an unknown project", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "PUT",
        url: "/api/projects/999999/agent-rules/claude-code:project",
        payload: { content: "x" },
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    // Independent review, PR #458 — the round-6 EACCES-to-503 mapping only
    // reached the GET routes; the write path had no such mapping at all
    // and would 500 on a permission error instead.
    it("503s (not 500s) when the target directory isn't writable", async () => {
      const { app, projectId } = await createProject();
      fs.chmodSync(projectCwd, 0o500);
      try {
        const res = await app.inject({
          method: "PUT",
          url: `/api/projects/${projectId}/agent-rules/claude-code:project`,
          payload: { content: "x" },
        });
        expect(res.statusCode).toBe(503);
      } finally {
        fs.chmodSync(projectCwd, 0o700);
        await app.close();
      }
    });
  });

  describe("DELETE /api/projects/:id/agent-rules/:target", () => {
    it("deletes an existing file and returns 204", async () => {
      fs.writeFileSync(path.join(projectCwd, "AGENTS.md"), "to be deleted");
      const { app, projectId } = await createProject();
      const res = await app.inject({
        method: "DELETE",
        url: `/api/projects/${projectId}/agent-rules/agy:project`,
      });
      expect(res.statusCode).toBe(204);
      expect(fs.existsSync(path.join(projectCwd, "AGENTS.md"))).toBe(false);
      await app.close();
    });

    it("deletes a global-scope target from the redirected HOME, routed through this same project route", async () => {
      fs.mkdirSync(path.join(fakeHome, ".gemini"), { recursive: true });
      fs.writeFileSync(path.join(fakeHome, ".gemini", "GEMINI.md"), "x");
      const { app, projectId } = await createProject();
      const res = await app.inject({
        method: "DELETE",
        url: `/api/projects/${projectId}/agent-rules/agy:global`,
      });
      expect(res.statusCode).toBe(204);
      expect(fs.existsSync(path.join(fakeHome, ".gemini", "GEMINI.md"))).toBe(false);
      await app.close();
    });

    // Independent review, PR #458 — the local DELETE branch had no
    // try/catch at all before; a permission error used to be an uncaught
    // 500.
    it("503s (not 500s) when the target's directory isn't writable", async () => {
      fs.writeFileSync(path.join(projectCwd, "CLAUDE.md"), "content");
      const { app, projectId } = await createProject();
      fs.chmodSync(projectCwd, 0o500);
      try {
        const res = await app.inject({
          method: "DELETE",
          url: `/api/projects/${projectId}/agent-rules/claude-code:project`,
        });
        expect(res.statusCode).toBe(503);
      } finally {
        fs.chmodSync(projectCwd, 0o700);
        await app.close();
      }
    });
  });

  // Issue #431, Hermes review on PR #458 — a remote host's 4xx (the agent
  // responded and refused) used to be flattened into the same 503 "Host
  // unreachable" as a genuine connectivity failure. A real second buildApp()
  // in `agent` role, listening on a real port, proves the primary forwards
  // the agent's actual status/message instead — same "two real app
  // instances, real HTTP between them" pattern as projects.test.ts's own
  // remote-host tests (no PTY involved here, so none of multi-host.test.ts's
  // node-pty/child_process mocking is needed).
  describe("remote host — forwarding a genuine 4xx instead of masking it as unreachable", () => {
    it("PUT forwards the agent's real 400 (oversized content) instead of 503", async () => {
      const prevEnv: Record<string, string | undefined> = {};
      const agentEnv = {
        MULLION_ROLE: "agent",
        MULLION_AGENT_TOKEN: "agent-rules-remote-token",
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

      const primary = await buildApp();
      const host = await primary.inject({
        method: "POST",
        url: "/api/hosts",
        payload: {
          name: "agent-rules-remote-host",
          baseUrl: `http://127.0.0.1:${address.port}`,
          token: "agent-rules-remote-token",
        },
      });
      const project = await primary.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "agent-rules-remote", cwd: projectCwd, hostId: host.json().id },
      });

      const res = await primary.inject({
        method: "PUT",
        url: `/api/projects/${project.json().id}/agent-rules/claude-code:project`,
        payload: { content: "x".repeat(512 * 1024 + 1) },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/exceeds the .* limit/);

      await primary.close();
      await agentApp.close();
    });

    // Independent review, PR #458 — forwardHostRequestError used to forward
    // ANY 4xx verbatim, including a 401 from the agent's own bearer-token
    // check (e.g. a rotated MULLION_AGENT_TOKEN). That reads to a browser
    // like "you need to log in," which it isn't — it's a host misconfigured
    // problem, folded into 503 instead. The genuinely request-specific 400
    // case above is still forwarded as-is.
    it("PUT folds the agent's real 401 (wrong token) into 503, not a raw 401", async () => {
      const prevEnv: Record<string, string | undefined> = {};
      const agentEnv = {
        MULLION_ROLE: "agent",
        MULLION_AGENT_TOKEN: "the-real-agent-token",
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

      const primary = await buildApp();
      // Deliberately registers with the WRONG token, so the agent's own
      // bearer check rejects every request from this primary with 401.
      const host = await primary.inject({
        method: "POST",
        url: "/api/hosts",
        payload: {
          name: "agent-rules-wrong-token-host",
          baseUrl: `http://127.0.0.1:${address.port}`,
          token: "a-completely-different-token",
        },
      });
      const project = await primary.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "agent-rules-wrong-token", cwd: projectCwd, hostId: host.json().id },
      });

      const res = await primary.inject({
        method: "PUT",
        url: `/api/projects/${project.json().id}/agent-rules/claude-code:project`,
        payload: { content: "x" },
      });
      expect(res.statusCode).toBe(503);
      // The agent's own raw rejection ("invalid or missing agent token")
      // must not leak through verbatim — only this route's own friendly
      // 503 wording.
      expect(res.json().message).not.toMatch(/invalid or missing/);
      expect(res.json().message).toBe("Host rejected the request — check its agent token");

      await primary.close();
      await agentApp.close();
    });
  });
});
