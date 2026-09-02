import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
// Must come before any import below that could itself trigger loading
// "node-pty"/"node:child_process" — see mock-pty.ts's header comment.
import { createNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as ChildProcess from "node:child_process";

// Issue: per-project Mullion pinned note authored from the UI — the
// DB-backed producer for the spawn-time briefingOverride channel (PR #892),
// redesigned by issue #942 into a short, always-additive note with no file
// fallback of its own. This file exercises session-lifecycle.ts's
// createSessionRecord as the actual producer, end to end through a real
// POST /api/sessions: is the DB row (project-tooling.ts) the ONLY source
// now, with no committed-file mechanism to compete with or fall back to.
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

describe("session-lifecycle.ts — per-project pinned note (issue #942, no file fallback)", () => {
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
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "briefing-precedence-project-"));
    // A committed AGENTS.md region is present here to prove it's NEVER
    // read or re-injected by Mullion anymore — every CLI reads it
    // natively instead. If any test below found this text in the
    // per-session copy, that would mean the old file-scanning mechanism
    // regressed back in.
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

  it("writes no per-session note when no DB row exists — AGENTS.md's committed region is never read", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" },
    });
    expect(res.statusCode).toBe(201);
    const sessionId = res.json().id as number;
    await waitUntil(() => app.pty.get(String(sessionId))?.isAlive === true);

    expect(fs.existsSync(sessionBriefingPath(app.config.SESSIONS_DIR, String(sessionId)))).toBe(
      false,
    );

    await app.close();
  });

  it("writes the DB row's note once one is authored via the UI — never mixed with AGENTS.md's committed region", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const putRes = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/tooling`,
      payload: { briefing: "DB-authored pinned note" },
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
    expect(written).toContain("DB-authored pinned note");
    expect(written).not.toContain("committed repo instructions");

    await app.close();
  });

  it("deleting the DB row removes the per-session note for the next spawn — nothing to restore", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/tooling`,
      payload: { briefing: "temporary DB note" },
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

    expect(fs.existsSync(sessionBriefingPath(app.config.SESSIONS_DIR, String(sessionId)))).toBe(
      false,
    );

    await app.close();
  });

  // Hermes review, PR #893 — an empty-string DB row is a real, reachable
  // state (select-all-delete in the UI, then Save) and is NOT the same as
  // deleting the row: `!== undefined` only excludes null/absent, so an
  // empty string still produces a (header-only) per-session file — the
  // exact distinction deleteProjectBriefing's own doc comment
  // (project-tooling.ts) documents as the reason DELETE exists as a
  // separate action from a blank PUT.
  it("an empty-string DB row still writes a (header-only) note — it is not the same as no row at all", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

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

    expect(fs.existsSync(sessionBriefingPath(app.config.SESSIONS_DIR, String(sessionId)))).toBe(
      true,
    );
    const written = fs.readFileSync(
      sessionBriefingPath(app.config.SESSIONS_DIR, String(sessionId)),
      "utf8",
    );
    expect(written).not.toContain("committed repo instructions");

    await app.close();
  });
});
