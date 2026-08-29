import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
// Must come before any import below that could itself trigger loading
// "node-pty"/"node:child_process" — see mock-pty.ts's header comment.
import { createNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as ChildProcess from "node:child_process";

// Issue: per-project Mullion briefing authored from the UI — the DB-backed
// producer for the spawn-time briefingOverride channel (PR #892). This file
// exercises session-lifecycle.ts's createSessionRecord as the actual
// producer, end to end through a real POST /api/sessions: does the DB row
// (project-tooling.ts) really win over a project's own committed AGENTS.md
// briefing region, and does a project with no DB row really still fall back
// to that file exactly as it did before this feature existed?
const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return mockChildProcessSpawn(actual);
});

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { sessionBriefingPath } = await import("../../src/services/project-briefing.js");

const tmpDb = path.join(os.tmpdir(), `session-lifecycle-briefing-test-${process.pid}.db`);

async function waitUntil(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 50; i++) {
    if (await check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition never became true");
}

describe("session-lifecycle.ts — per-project briefing precedence (DB row vs. committed file)", () => {
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

  async function createProjectWithCommittedBriefing(app: Awaited<ReturnType<typeof buildApp>>) {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "briefing-precedence-project-"));
    fs.writeFileSync(
      path.join(projectDir, "AGENTS.md"),
      [
        "# AGENTS.md",
        "<!-- mullion:briefing:start -->",
        "committed repo instructions",
        "<!-- mullion:briefing:end -->",
      ].join("\n"),
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "briefing-precedence", cwd: projectDir },
    });
    return res.json().id as number;
  }

  it("falls back to the project's committed AGENTS.md region when no DB row exists", async () => {
    const app = await buildApp();
    const projectId = await createProjectWithCommittedBriefing(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" },
    });
    expect(res.statusCode).toBe(201);
    const sessionId = res.json().id as number;
    await waitUntil(() => app.pty.get(String(sessionId))?.isAlive === true);

    const written = fs.readFileSync(
      sessionBriefingPath(app.config.SESSIONS_DIR, String(sessionId)),
      "utf8",
    );
    expect(written).toContain("committed repo instructions");

    await app.close();
  });

  it("the DB row wins over the committed AGENTS.md region once one is authored via the UI", async () => {
    const app = await buildApp();
    const projectId = await createProjectWithCommittedBriefing(app);

    const putRes = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/tooling`,
      payload: { briefing: "DB-authored briefing, should win" },
    });
    expect(putRes.statusCode).toBe(200);

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" },
    });
    expect(res.statusCode).toBe(201);
    const sessionId = res.json().id as number;
    await waitUntil(() => app.pty.get(String(sessionId))?.isAlive === true);

    const written = fs.readFileSync(
      sessionBriefingPath(app.config.SESSIONS_DIR, String(sessionId)),
      "utf8",
    );
    expect(written).toContain("DB-authored briefing, should win");
    expect(written).not.toContain("committed repo instructions");

    await app.close();
  });

  it("deleting the DB row restores the committed AGENTS.md region for the next spawn", async () => {
    const app = await buildApp();
    const projectId = await createProjectWithCommittedBriefing(app);

    await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/tooling`,
      payload: { briefing: "temporary DB briefing" },
    });
    await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}/tooling`,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" },
    });
    expect(res.statusCode).toBe(201);
    const sessionId = res.json().id as number;
    await waitUntil(() => app.pty.get(String(sessionId))?.isAlive === true);

    const written = fs.readFileSync(
      sessionBriefingPath(app.config.SESSIONS_DIR, String(sessionId)),
      "utf8",
    );
    expect(written).toContain("committed repo instructions");
    expect(written).not.toContain("temporary DB briefing");

    await app.close();
  });

  // Hermes review, PR #893 — an empty-string DB row is a real, reachable
  // state (select-all-delete in the UI, then Save) and is NOT the same as
  // deleting the row: `??` only falls through on null/undefined, so an
  // empty string still wins over the committed region — the exact
  // distinction deleteProjectBriefing's own doc comment (project-tooling.ts)
  // documents as the reason DELETE exists as a separate action from a blank
  // PUT. This pins that documented behavior down end to end rather than
  // just asserting it in a comment.
  it("an empty-string DB row still overrides the committed region — it is not the same as no row at all", async () => {
    const app = await buildApp();
    const projectId = await createProjectWithCommittedBriefing(app);

    const putRes = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/tooling`,
      payload: { briefing: "" },
    });
    expect(putRes.statusCode).toBe(200);
    expect(putRes.json()).toEqual({ briefing: "" });

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" },
    });
    expect(res.statusCode).toBe(201);
    const sessionId = res.json().id as number;
    await waitUntil(() => app.pty.get(String(sessionId))?.isAlive === true);

    const written = fs.readFileSync(
      sessionBriefingPath(app.config.SESSIONS_DIR, String(sessionId)),
      "utf8",
    );
    expect(written).not.toContain("committed repo instructions");

    await app.close();
  });
});
