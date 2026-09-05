import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
// Must come before any import below that could itself trigger loading
// "node-pty"/"node:child_process" — see mock-pty.ts's header comment.
import { createNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as ChildProcess from "node:child_process";

// Issue #937 — session-lifecycle.ts's createSessionRecord resolves the
// GLOBAL settings.sessions.workflowConventionsText text against this
// project's own injectWorkflowConventions column, gating on BOTH the
// column being null/true AND the global text being non-empty. This file
// exercises that resolution end to end through a real POST /api/sessions,
// mirroring session-lifecycle-briefing.test.ts's own template for the
// sibling injectProjectBriefing/briefingOverride feature.
const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return mockChildProcessSpawn(actual);
});

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { sessionWorkflowConventionsPath } =
  await import("../../src/services/workflow-conventions.js");

const tmpDb = path.join(
  os.tmpdir(),
  `session-lifecycle-workflow-conventions-test-${process.pid}.db`,
);

async function waitUntil(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 50; i++) {
    if (await check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition never became true");
}

describe("session-lifecycle.ts — global workflow-conventions injection (issue #937)", () => {
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

  afterEach(() => {
    if (projectDir) fs.rmSync(projectDir, { recursive: true, force: true });
  });

  async function createProject(app: Awaited<ReturnType<typeof buildApp>>) {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-conventions-project-"));
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "workflow-conventions", cwd: projectDir },
    });
    return res.json().id as number;
  }

  async function spawnSession(app: Awaited<ReturnType<typeof buildApp>>, projectId: number) {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" },
    });
    expect(res.statusCode).toBe(201);
    const sessionId = res.json().id as number;
    await waitUntil(() => app.pty.get(String(sessionId))?.isAlive === true);
    return sessionId;
  }

  it("writes no per-session file when the global text is empty (the DEFAULT_SETTINGS default), regardless of the project's toggle", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const sessionId = await spawnSession(app, projectId);

    expect(
      fs.existsSync(sessionWorkflowConventionsPath(app.config.SESSIONS_DIR, String(sessionId))),
    ).toBe(false);

    await app.close();
  });

  it("injects the global text when it's non-empty and the project's injectWorkflowConventions column is null (inherit)", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const patchRes = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { sessions: { workflowConventionsText: "Always branch, never commit to main." } },
    });
    expect(patchRes.statusCode).toBe(200);

    const sessionId = await spawnSession(app, projectId);

    const written = fs.readFileSync(
      sessionWorkflowConventionsPath(app.config.SESSIONS_DIR, String(sessionId)),
      "utf8",
    );
    expect(written).toContain("Always branch, never commit to main.");

    await app.close();
  });

  it("injects the global text when the project's injectWorkflowConventions column is explicitly true", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { sessions: { workflowConventionsText: "Squash-merge PRs." } },
    });
    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}`,
      payload: { injectWorkflowConventions: true },
    });
    expect(patchRes.statusCode).toBe(200);

    const sessionId = await spawnSession(app, projectId);

    const written = fs.readFileSync(
      sessionWorkflowConventionsPath(app.config.SESSIONS_DIR, String(sessionId)),
      "utf8",
    );
    expect(written).toContain("Squash-merge PRs.");

    await app.close();
  });

  it("writes no per-session file when the project's injectWorkflowConventions column is explicitly false, even with non-empty global text", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { sessions: { workflowConventionsText: "Always branch, never commit to main." } },
    });
    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}`,
      payload: { injectWorkflowConventions: false },
    });
    expect(patchRes.statusCode).toBe(200);

    const sessionId = await spawnSession(app, projectId);

    expect(
      fs.existsSync(sessionWorkflowConventionsPath(app.config.SESSIONS_DIR, String(sessionId))),
    ).toBe(false);

    await app.close();
  });

  it("clearing the project's injectWorkflowConventions column back to null re-inherits the global text", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { sessions: { workflowConventionsText: "Rebase-merge PRs." } },
    });
    await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}`,
      payload: { injectWorkflowConventions: false },
    });
    const clearRes = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}`,
      payload: { injectWorkflowConventions: null },
    });
    expect(clearRes.statusCode).toBe(200);

    const sessionId = await spawnSession(app, projectId);

    const written = fs.readFileSync(
      sessionWorkflowConventionsPath(app.config.SESSIONS_DIR, String(sessionId)),
      "utf8",
    );
    expect(written).toContain("Rebase-merge PRs.");

    await app.close();
  });
});
