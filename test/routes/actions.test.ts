import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import { closeDb } from "../../src/db/client.js";

const tmpDb = path.join(os.tmpdir(), `actions-test-${process.pid}.db`);
process.env.DATABASE_URL = `file:${tmpDb}`;

// Only "claude" resolves — see the mocked `command -v` reply below.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn((_shell: string, args: string[]) => {
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter };
      child.stdout = new EventEmitter();
      const script = args[args.length - 1] ?? "";
      const isClaude = /command -v claude\b/.test(script);
      // probe() resolves off 'close', not 'exit' — see agent-detect.ts.
      setImmediate(() => {
        if (isClaude) child.stdout.emit("data", Buffer.from("/usr/bin/claude\n"));
        child.emit("exit", 0);
        child.emit("close", 0);
      });
      return child;
    }),
  };
});

const { buildApp } = await import("../../src/app.js");
const { clearAgentsCacheForTests } = await import("../../src/services/agent-detect.js");

describe("actions routes", () => {
  let configDir: string;

  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "actions-test-config-"));
    process.env.CRS_CONFIG_DIR = configDir;
  });

  beforeEach(() => {
    clearAgentsCacheForTests();
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
    delete process.env.DATABASE_URL;
    delete process.env.CRS_CONFIG_DIR;
  });

  describe("GET /api/actions", () => {
    it("returns only the available detected agent (claude), not unavailable ones", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/actions" });
      expect(res.statusCode).toBe(200);

      const ids = res.json().map((a: { id: string }) => a.id);
      expect(ids).toContain("agent:claude");
      expect(ids).not.toContain("agent:codex");
      expect(ids).not.toContain("shell:bash");

      await app.close();
    });

    it("merges in the global CRS_CONFIG_DIR/actions.json, overriding a detected preset by id", async () => {
      fs.writeFileSync(
        path.join(configDir, "actions.json"),
        JSON.stringify({
          actions: [
            { id: "agent:claude", title: "Claude (resume)", command: "claude --resume" },
            { id: "custom:hello", title: "Hello", command: "echo hi" },
          ],
        }),
      );

      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/actions" });
      const byId = Object.fromEntries(res.json().map((a: { id: string }) => [a.id, a]));
      expect(byId["agent:claude"].command).toBe("claude --resume");
      expect(byId["custom:hello"].command).toBe("echo hi");

      fs.rmSync(path.join(configDir, "actions.json"), { force: true });
      await app.close();
    });
  });

  describe("GET /api/projects/:id/actions", () => {
    it("404s for an unknown project", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/projects/999999/actions" });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("merges the project's own .crs/actions.json over the global presets", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "actions-test-project-"));
      fs.mkdirSync(path.join(projectCwd, ".crs"));
      fs.writeFileSync(
        path.join(projectCwd, ".crs", "actions.json"),
        JSON.stringify({ actions: [{ id: "custom:deploy", title: "Deploy", command: "make deploy" }] }),
      );

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "with-actions", cwd: projectCwd },
      });
      const projectId = created.json().id;

      const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/actions` });
      expect(res.statusCode).toBe(200);
      const ids = res.json().map((a: { id: string }) => a.id);
      expect(ids).toContain("custom:deploy");
      expect(ids).toContain("agent:claude"); // global preset still present underneath

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });
  });
});
