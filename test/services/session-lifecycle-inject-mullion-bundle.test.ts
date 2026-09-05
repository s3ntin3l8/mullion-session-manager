import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
// Must come before any import below that could itself trigger loading
// "node-pty"/"node:child_process" — see mock-pty.ts's header comment.
import { createNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as ChildProcess from "node:child_process";

// Issue #1089 — the DB-backed producer for sessions.injectMullionBundle
// (settings.ts), end to end through a real POST /api/sessions: does
// session-lifecycle.ts's createSessionRecord really resolve the global
// setting and thread it through to the spawned Session (pty-manager.ts),
// rather than letting the spawn path silently fall back to its own
// always-true default? Same "real spawn, real DB, assert on the resulting
// Session" posture as session-lifecycle-inject-override.test.ts's own
// sibling file for injectAgentGuide/injectProjectBriefing — but unlike
// those two, there is no per-project override to test here (schema.ts's own
// comment on `projects.injectAgentGuide` explains why injectMullionBundle
// deliberately doesn't get one): this is purely the global setting.
const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return mockChildProcessSpawn(actual);
});

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");

const tmpDb = path.join(os.tmpdir(), `session-lifecycle-inject-bundle-test-${process.pid}.db`);

async function waitUntil(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 50; i++) {
    if (await check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition never became true");
}

describe("session-lifecycle.ts — sessions.injectMullionBundle threading (issue #1089)", () => {
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

  it("defaults to true (DEFAULT_SETTINGS.sessions.injectMullionBundle) when the setting was never changed", async () => {
    const app = await buildApp();
    const projectId = await createProject(app, "inject-bundle-default");

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" },
    });
    expect(res.statusCode).toBe(201);
    const sessionId = String(res.json().id);
    await waitUntil(() => app.pty.get(sessionId)?.isAlive === true);

    expect(app.pty.get(sessionId)?.injectMullionBundle).toBe(true);

    await app.close();
  });

  it("threads the global setting turned off all the way to the spawned Session", async () => {
    const app = await buildApp();
    const projectId = await createProject(app, "inject-bundle-off");

    const patchRes = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { sessions: { injectMullionBundle: false } },
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

    // This is the exact case issue #1089 reports: before the fix, a
    // multi-host agent host ignored this and always fell back to `true`.
    // This assertion is against the LOCAL spawn path (this process is both
    // primary and the host that runs the session), which already proves
    // session-lifecycle.ts's own resolution + forwarding is correct — the
    // separate agent-side half of the fix (an explicit opts value actually
    // winning over the agent's own default) is proven directly against
    // PtyManager.getOrCreate() in pty-manager.test.ts, and against the
    // agent-role /internal/sessions route in routes/internal.test.ts.
    expect(app.pty.get(sessionId)?.injectMullionBundle).toBe(false);

    await app.close();
  });

  it("turning the setting back on is reflected in the next spawn", async () => {
    const app = await buildApp();
    const projectId = await createProject(app, "inject-bundle-restored");

    await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { sessions: { injectMullionBundle: false } },
    });
    await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { sessions: { injectMullionBundle: true } },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" },
    });
    expect(res.statusCode).toBe(201);
    const sessionId = String(res.json().id);
    await waitUntil(() => app.pty.get(sessionId)?.isAlive === true);

    expect(app.pty.get(sessionId)?.injectMullionBundle).toBe(true);

    await app.close();
  });
});
