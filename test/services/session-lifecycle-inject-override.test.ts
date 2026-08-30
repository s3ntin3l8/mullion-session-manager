import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
// Must come before any import below that could itself trigger loading
// "node-pty"/"node:child_process" — see mock-pty.ts's header comment.
import { createNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as ChildProcess from "node:child_process";

// Issue #884 — the DB-backed producer for the per-project
// injectAgentGuide/injectProjectBriefing override, end to end through a
// real POST /api/sessions: does session-lifecycle.ts's createSessionRecord
// really resolve `projects.injectAgentGuide`/`injectProjectBriefing`
// (schema.ts) ahead of the global setting, and does a project with no
// override really still fall through to it — same "real spawn, real DB,
// assert on the resulting Session" posture as
// session-lifecycle-briefing.test.ts's own sibling file.
const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return mockChildProcessSpawn(actual);
});

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");

const tmpDb = path.join(os.tmpdir(), `session-lifecycle-inject-override-test-${process.pid}.db`);

async function waitUntil(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 50; i++) {
    if (await check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition never became true");
}

describe("session-lifecycle.ts — per-project injectAgentGuide/injectProjectBriefing override (issue #884)", () => {
  let projectDir: string;

  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  async function createProject(app: Awaited<ReturnType<typeof buildApp>>, name: string) {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name, cwd: projectDir },
    });
    return res.json().id as number;
  }

  it("falls through to the global setting when the project has no override", async () => {
    const app = await buildApp();
    const projectId = await createProject(app, "inject-override-fallthrough");

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" },
    });
    expect(res.statusCode).toBe(201);
    const sessionId = String(res.json().id);
    await waitUntil(() => app.pty.get(sessionId)?.isAlive === true);

    // DEFAULT_SETTINGS.sessions.injectAgentGuide/injectProjectBriefing are
    // both true — see settings.ts.
    expect(app.pty.get(sessionId)?.injectAgentGuide).toBe(true);
    expect(app.pty.get(sessionId)?.injectProjectBriefing).toBe(true);

    await app.close();
  });

  it("the project's own override wins over the (still-on) global setting", async () => {
    const app = await buildApp();
    const projectId = await createProject(app, "inject-override-wins");

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}`,
      payload: { injectAgentGuide: false, injectProjectBriefing: false },
    });
    expect(patchRes.statusCode).toBe(200);

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" },
    });
    expect(res.statusCode).toBe(201);
    const sessionId = String(res.json().id);
    await waitUntil(() => app.pty.get(sessionId)?.isAlive === true);

    expect(app.pty.get(sessionId)?.injectAgentGuide).toBe(false);
    expect(app.pty.get(sessionId)?.injectProjectBriefing).toBe(false);

    await app.close();
  });

  it("the two overrides are independent — only one need be set", async () => {
    const app = await buildApp();
    const projectId = await createProject(app, "inject-override-independent");

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}`,
      payload: { injectAgentGuide: false },
    });
    expect(patchRes.statusCode).toBe(200);

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" },
    });
    expect(res.statusCode).toBe(201);
    const sessionId = String(res.json().id);
    await waitUntil(() => app.pty.get(sessionId)?.isAlive === true);

    expect(app.pty.get(sessionId)?.injectAgentGuide).toBe(false);
    // Never overridden for this project — still the global default.
    expect(app.pty.get(sessionId)?.injectProjectBriefing).toBe(true);

    await app.close();
  });

  it("clearing the override (PATCH with null) restores the global setting for the next spawn", async () => {
    const app = await buildApp();
    const projectId = await createProject(app, "inject-override-cleared");

    await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}`,
      payload: { injectAgentGuide: false },
    });
    await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}`,
      payload: { injectAgentGuide: null },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" },
    });
    expect(res.statusCode).toBe(201);
    const sessionId = String(res.json().id);
    await waitUntil(() => app.pty.get(sessionId)?.isAlive === true);

    expect(app.pty.get(sessionId)?.injectAgentGuide).toBe(true);

    await app.close();
  });
});
