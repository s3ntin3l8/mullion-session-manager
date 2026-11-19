import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
// Must come before any import below that could load "node-pty" or
// "node:child_process" (see test/routes/sessions.test.ts, which this mirrors).
import { createNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import { waitUntil } from "../helpers/sessions-routes.js";
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

// The database belongs to the WHOLE FILE, not to one describe: both suites
// below share it, and a describe-scoped afterAll would close the database
// and delete DATABASE_URL before the second suite's tests ran.
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

// Issue #3235 — a model flag already on the command wins at launch
// (buildModelFlag skips the Mullion default), so sessions.model, which the
// quota badge and the model display read, must record that model and not the
// install default.
describe("POST /api/sessions records the model that launches", () => {
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

// Issue #1733 — the row is not the end of the story: the child's CLI has
// to actually RECEIVE the skip-permissions flag. This asserts the join
// end to end — the POST body through the spawn to the argv the agent is
// launched with — rather than the row alone. It lives here, next to the
// other "what argv does the launch use" assertions, rather than under a
// suite about READING a session's row.
describe("POST /api/sessions — skipPermissions reaches the launched argv", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    app = await buildApp();
    // Every test starts with an EMPTY spawn log: the assertions below read
    // "the last spawn", so a spawn recorded by an earlier test must not be
    // in the log (the sessions-route harness's per-test reset does this in
    // the file this suite came from).
    vi.mocked(spawnChildProcess).mockClear();
  });

  // The app MUST be closed even when an assertion throws — this file's
  // other tests share the node-pty mock and the session/socket paths, so
  // an app left open by a failed assertion cascades into every test after
  // it.
  afterEach(async () => {
    await app.close();
  });

  it("launches with the agent's skip-permissions flag when the row says so", async () => {
    const projectId = await createProject(app);
    const before = vi.mocked(spawnChildProcess).mock.calls.length;

    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "claude", skipPermissions: true },
    });
    expect(created.statusCode).toBe(201);

    await waitUntil(() => vi.mocked(spawnChildProcess).mock.calls.length > before);
    const spawnCall =
      vi.mocked(spawnChildProcess).mock.calls[vi.mocked(spawnChildProcess).mock.calls.length - 1];
    const argv = [spawnCall[0], ...(spawnCall[1] ?? [])].join(" ");
    expect(argv).toContain("--dangerously-skip-permissions");
  });

  it("launches WITHOUT the flag when the row says so", async () => {
    const projectId = await createProject(app);
    const before = vi.mocked(spawnChildProcess).mock.calls.length;

    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "claude", skipPermissions: false },
    });
    expect(created.statusCode).toBe(201);

    await waitUntil(() => vi.mocked(spawnChildProcess).mock.calls.length > before);
    const spawnCall =
      vi.mocked(spawnChildProcess).mock.calls[vi.mocked(spawnChildProcess).mock.calls.length - 1];
    const argv = [spawnCall[0], ...(spawnCall[1] ?? [])].join(" ");
    expect(argv).not.toContain("--dangerously-skip-permissions");
  });
});
