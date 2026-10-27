import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { sql } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { hosts, projects, sessions } from "../../src/db/schema.js";
import { findEligibleDevServerSessions } from "../../src/plugins/pty.js";

// Issue #1722 / roadmap 8.8 — the dev-server detection sweep probes THIS
// process's PtyManager, so only a session that actually lives here can be
// probed. With the host derived from the PROJECT, a session placed on a
// remote host (whose project may well live here) would be offered to the
// local sweep, which does not have it.
//
// Real DB, real joins — the rule lives in a SQL predicate, so a mocked
// query builder could pass while the predicate was wrong.

const tmpDb = path.join(os.tmpdir(), `pty-dev-server-eligibility-test-${process.pid}.db`);

describe("findEligibleDevServerSessions — the session's own host decides eligibility (issue #1722)", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  beforeEach(() => {
    app.db.delete(sessions).run();
    app.db.delete(projects).run();
    app.db
      .delete(hosts)
      .where(sql`id != 'local'`)
      .run();
  });

  function seedProject(hostId: string): number {
    const [row] = app.db
      .insert(projects)
      .values({ name: "p", cwd: "/tmp", hostId })
      .returning({ id: projects.id })
      .all();
    return row.id;
  }

  function seedSession(
    projectId: number,
    hostId?: string,
    kind: "terminal" | "dock" = "terminal",
    status: "active" | "exited" = "active",
  ): number {
    const [row] = app.db
      .insert(sessions)
      .values({
        projectId,
        command: "bash",
        kind,
        status,
        ...(hostId === undefined ? {} : { hostId }),
      })
      .returning({ id: sessions.id })
      .all();
    return row.id;
  }

  it("offers an active session that lives HERE", () => {
    const projectId = seedProject("local");
    const sessionId = seedSession(projectId);
    expect(findEligibleDevServerSessions(app).get(String(sessionId))).toBe(projectId);
  });

  it("does NOT offer a session PLACED on a remote host (issue #1722)", () => {
    app.db
      .insert(hosts)
      .values({ id: "remote-b", name: "remote-b", baseUrl: "http://remote-b.example" })
      .run();
    const projectId = seedProject("local");
    const sessionId = seedSession(projectId, "remote-b");
    expect(findEligibleDevServerSessions(app).has(String(sessionId))).toBe(false);
  });

  it("still offers a session that inherits its project's LOCAL host (issue #1722)", () => {
    // Every pre-existing row is NULL here and must keep behaving exactly as
    // before the column existed.
    const projectId = seedProject("local");
    const sessionId = seedSession(projectId);
    expect(findEligibleDevServerSessions(app).get(String(sessionId))).toBe(projectId);
  });

  it("offers an active DOCK control's session too", () => {
    const projectId = seedProject("local");
    const sessionId = seedSession(projectId, undefined, "dock");
    expect(findEligibleDevServerSessions(app).get(String(sessionId))).toBe(projectId);
  });

  it("does NOT offer a dock session once it is no longer active", () => {
    const projectId = seedProject("local");
    const sessionId = seedSession(projectId, undefined, "dock", "exited");
    expect(findEligibleDevServerSessions(app).has(String(sessionId))).toBe(false);
  });

  it("does NOT offer a dock session placed on a remote host", () => {
    app.db
      .insert(hosts)
      .values({ id: "remote-b", name: "remote-b", baseUrl: "http://remote-b.example" })
      .run();
    const projectId = seedProject("local");
    const sessionId = seedSession(projectId, "remote-b", "dock");
    expect(findEligibleDevServerSessions(app).has(String(sessionId))).toBe(false);
  });

  it("does NOT offer a dock session when the project already has a devServerUrl", () => {
    const projectId = seedProject("local");
    app.db
      .update(projects)
      .set({ devServerUrl: "3000" })
      .where(sql`id = ${projectId}`)
      .run();
    const sessionId = seedSession(projectId, undefined, "dock");
    expect(findEligibleDevServerSessions(app).has(String(sessionId))).toBe(false);
  });
});
