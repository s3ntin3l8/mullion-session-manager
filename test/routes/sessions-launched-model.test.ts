import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
// Must come before any import below that could load "node-pty" or
// "node:child_process" (see test/routes/sessions.test.ts, which this mirrors).
import { createNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import type * as ChildProcess from "node:child_process";
import { spawn as spawnChildProcess } from "node:child_process";

const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));
vi.mock("node:child_process", async (importOriginal) =>
  mockChildProcessSpawn(await importOriginal<typeof ChildProcess>(), { passthrough: ["git"] }),
);

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");

const tmpDb = path.join(os.tmpdir(), `sessions-launched-model-test-${process.pid}.db`);

// Issue #3235 — a model flag already on the command wins at launch
// (buildModelFlag skips the Mullion default), so sessions.model, which the
// quota badge and the model display read, must record that model and not the
// install default.
describe("POST /api/sessions records the model that launches", () => {
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
      payload: { allowDuplicate: true, createDir: true, name: "p", cwd: "/tmp" },
    });
    return res.json().id as number;
  }

  it("records the --model a claude command already names, without doubling the flag", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "claude --model opusplan" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().model).toBe("opusplan");
    const call = vi
      .mocked(spawnChildProcess)
      .mock.calls.findLast(([command]) => command === "systemd-run");
    const args = call?.[1] as string[];
    expect((args[args.length - 1].match(/--model/g) ?? []).length).toBe(1);

    await app.close();
  });

  it("records the -m model of a codex command", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "codex -m o3" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().model).toBe("o3");

    await app.close();
  });

  it("records the command's own flag over an explicit model in the body", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "claude --model opusplan", model: "sonnet" },
    });

    expect(res.statusCode).toBe(201);
    // The flag on the command is what launches, so it is what is recorded.
    expect(res.json().model).toBe("opusplan");

    await app.close();
  });

  it("records the --model of an agy command", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "agy --model gemini-4-argon-medium" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().model).toBe("gemini-4-argon-medium");

    await app.close();
  });

  it("records the -m model of an mcode command", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "mcode -m openai/gpt-5" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().model).toBe("openai/gpt-5");

    await app.close();
  });

  it("still records an explicit model for a command with no model flag", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "claude", model: "opusplan" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().model).toBe("opusplan");

    await app.close();
  });
});
