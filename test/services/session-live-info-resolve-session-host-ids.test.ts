import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { ne } from "drizzle-orm";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { hosts, projects, sessions } from "../../src/db/schema.js";
import { resolveSessionHostIds } from "../../src/services/session-live-info.js";

// Issue #1459's collision guard — the same "real DB, real joins" posture
// test/services/event-store-remote-ownership.test.ts uses for its sibling
// filterHostOwnership: `sessions` has no hostId column (ownership only
// resolves via sessions.projectId -> projects.hostId), so a mocked drizzle
// chain could pass while the real join semantics were wrong.
// relayRemoteEventsHost (routes/events.ts) uses this to filter a remote
// agent's own `cursors`/`seen` frame down to sessions that agent's hostId
// actually owns, mirroring filterHostOwnership's own role for persisted
// events.

const tmpDb = path.join(os.tmpdir(), `session-live-info-resolve-session-host-ids-test-${process.pid}.db`);

describe("resolveSessionHostIds", () => {
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
    // "local" is seeded by migrations and must survive every test's cleanup.
    app.db.delete(hosts).where(ne(hosts.id, "local")).run();
  });

  function seedHost(id: string): void {
    app.db
      .insert(hosts)
      .values({ id, name: id, baseUrl: `http://${id}.example` })
      .run();
  }

  function seedProject(hostId: string): number {
    const [row] = app.db
      .insert(projects)
      .values({ name: "p", cwd: "/tmp", hostId })
      .returning({ id: projects.id })
      .all();
    return row.id;
  }

  function seedSession(projectId: number): number {
    const [row] = app.db
      .insert(sessions)
      .values({ projectId, command: "bash" })
      .returning({ id: sessions.id })
      .all();
    return row.id;
  }

  it("returns an empty map without touching the DB when given no ids", () => {
    expect(resolveSessionHostIds(app, [])).toEqual(new Map());
  });

  it("resolves a session id to its project's hostId", () => {
    seedHost("remote-a");
    const projectId = seedProject("remote-a");
    const sessionId = seedSession(projectId);

    const owners = resolveSessionHostIds(app, [sessionId]);
    expect(owners.get(sessionId)).toBe("remote-a");
  });

  it("leaves a nonexistent session id absent from the returned map", () => {
    const owners = resolveSessionHostIds(app, [999999]);
    expect(owners.has(999999)).toBe(false);
  });

  it("resolves a mixed batch of local and remote sessions correctly", () => {
    seedHost("remote-a");
    seedHost("remote-b");
    const localProject = seedProject("local");
    const remoteAProject = seedProject("remote-a");
    const remoteBProject = seedProject("remote-b");
    const localSession = seedSession(localProject);
    const remoteASession = seedSession(remoteAProject);
    const remoteBSession = seedSession(remoteBProject);

    const owners = resolveSessionHostIds(app, [
      localSession,
      remoteASession,
      remoteBSession,
      424242,
    ]);

    expect(owners.get(localSession)).toBe("local");
    expect(owners.get(remoteASession)).toBe("remote-a");
    expect(owners.get(remoteBSession)).toBe("remote-b");
    expect(owners.has(424242)).toBe(false);
  });

  it("dedupes repeated ids and does not throw for a batch larger than SQLite's bind-parameter limit", () => {
    // Mirrors event-store-remote-ownership.test.ts's own flood regression
    // test — the inArray lookup is chunked specifically so a `cursors` frame
    // naming an unrealistically large number of distinct sessionIds can't
    // blow SQLite's ~32,766 bind-parameter limit.
    const ids: number[] = [];
    for (let sessionId = 1; sessionId <= 35_000; sessionId++) {
      ids.push(sessionId, sessionId); // repeated, to also exercise dedupe
    }

    let owners: Map<number, string> = new Map();
    expect(() => {
      owners = resolveSessionHostIds(app, ids);
    }).not.toThrow();
    // None of these session ids exist, so the map is legitimately empty.
    expect(owners.size).toBe(0);
  });
});
