import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Issue #2245 — the agent-side /internal/run-setup + /internal/setup-log pair.
// Real `sh`; no scope or pty is involved.
const TOKEN = "test-agent-token-run-setup";
const { buildApp } = await import("../../src/app.js");

describe("internal setup recipe routes (agent role)", () => {
  let root: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "internal-run-setup-"));
    process.env.MULLION_ROLE = "agent";
    process.env.MULLION_AGENT_TOKEN = TOKEN;
    process.env.PROJECTS_ROOTS = root;
  });
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.MULLION_ROLE;
    delete process.env.MULLION_AGENT_TOKEN;
    delete process.env.PROJECTS_ROOTS;
  });

  const auth = { authorization: `Bearer ${TOKEN}` };

  it("runs the recipe, answers a typed 200 envelope, and serves the log back", async () => {
    const app = await buildApp();
    const ok = await app.inject({
      method: "POST",
      url: "/internal/run-setup",
      headers: auth,
      payload: { cwd: root, recipe: "echo hello-setup", logKey: "77" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ outcome: "ok", exitCode: 0 });

    const failed = await app.inject({
      method: "POST",
      url: "/internal/run-setup",
      headers: auth,
      payload: { cwd: root, recipe: "echo nope; exit 4", logKey: "78" },
    });
    expect(failed.statusCode).toBe(200);
    expect(failed.json()).toMatchObject({ outcome: "failed", exitCode: 4 });

    const log = await app.inject({
      method: "GET",
      url: "/internal/setup-log?logKey=77",
      headers: auth,
    });
    expect(log.statusCode).toBe(200);
    expect(log.json().content).toContain("hello-setup");

    const missing = await app.inject({
      method: "GET",
      url: "/internal/setup-log?logKey=999",
      headers: auth,
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it("refuses a cwd outside PROJECTS_ROOTS and a log key that is a path", async () => {
    const app = await buildApp();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "internal-run-setup-out-"));
    const res = await app.inject({
      method: "POST",
      url: "/internal/run-setup",
      headers: auth,
      payload: { cwd: outside, recipe: "touch pwned", logKey: "1" },
    });
    expect(res.statusCode).toBe(400);
    expect(fs.existsSync(path.join(outside, "pwned"))).toBe(false);
    const traversal = await app.inject({
      method: "POST",
      url: "/internal/run-setup",
      headers: auth,
      payload: { cwd: root, recipe: "true", logKey: "../../etc/x" },
    });
    expect(traversal.statusCode).toBe(400);
    const badLog = await app.inject({
      method: "GET",
      url: `/internal/setup-log?logKey=${encodeURIComponent("../x")}`,
      headers: auth,
    });
    expect(badLog.statusCode).toBe(400);
    fs.rmSync(outside, { recursive: true, force: true });
    await app.close();
  });
});
