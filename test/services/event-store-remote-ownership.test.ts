import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { ne } from "drizzle-orm";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { hosts, projects, sessions } from "../../src/db/schema.js";
import { filterHostOwnership, type BufferedEvent } from "../../src/services/event-store.js";
import type { NotificationEvent } from "../../src/services/pty-manager.js";

// Issue #213 cross-host capture, hazard 2 — filterHostOwnership is the gate
// that stops a buggy or compromised agent from getting an arbitrary
// sessionId persisted against a session it doesn't actually own. `sessions`
// has no hostId column (ownership only resolves via
// sessions.projectId -> projects.hostId), so this needs a real DB with real
// joins to verify correctly — a mocked drizzle chain could pass while the
// real join semantics were wrong. Same "real temp SQLite DB, not a mock"
// posture as test/services/event-history.test.ts.

const tmpDb = path.join(os.tmpdir(), `event-store-remote-ownership-test-${process.pid}.db`);

function makeEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    seq: 1,
    sessionId: 1,
    kind: "status_change",
    ts: Date.now(),
    payload: {},
    ...overrides,
  };
}

describe("filterHostOwnership", () => {
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

  it("passes a local event (sourceHostId: null) through untouched, without touching the DB", () => {
    // No hosts/projects/sessions seeded at all — a query here would throw
    // on a dangling FK-less join result, or at minimum find nothing. This
    // asserts the short-circuit: filterHostOwnership must never query for
    // an all-local batch.
    const event = makeEvent({ sessionId: 999 });
    const batch: BufferedEvent[] = [{ event, sourceHostId: null }];
    expect(filterHostOwnership(app, batch)).toEqual([event]);
  });

  it("keeps a remote event whose session resolves to the reporting host", () => {
    seedHost("remote-a");
    const projectId = seedProject("remote-a");
    const sessionId = seedSession(projectId);
    const event = makeEvent({ sessionId });
    const result = filterHostOwnership(app, [{ event, sourceHostId: "remote-a" }]);
    expect(result).toEqual([event]);
  });

  it("drops a remote event whose session resolves to a DIFFERENT host", () => {
    seedHost("remote-a");
    seedHost("remote-b");
    const projectId = seedProject("remote-a"); // owned by remote-a
    const sessionId = seedSession(projectId);
    const event = makeEvent({ sessionId });
    // remote-b claims an event for a session that actually belongs to remote-a.
    const result = filterHostOwnership(app, [{ event, sourceHostId: "remote-b" }]);
    expect(result).toEqual([]);
  });

  it("drops a remote event whose sessionId doesn't resolve to any host at all", () => {
    const event = makeEvent({ sessionId: 123456 }); // no such session
    const result = filterHostOwnership(app, [{ event, sourceHostId: "remote-a" }]);
    expect(result).toEqual([]);
  });

  it("filters a mixed batch correctly: local always kept, remote checked per-event", () => {
    seedHost("remote-a");
    seedHost("remote-b");
    const projectA = seedProject("remote-a");
    const validSessionId = seedSession(projectA);

    const localEvent = makeEvent({ sessionId: 777, seq: 1 }); // no session row needed — local, trusted
    const validRemoteEvent = makeEvent({ sessionId: validSessionId, seq: 2 });
    const spoofedRemoteEvent = makeEvent({ sessionId: validSessionId, seq: 3 }); // same session, wrong reporting host

    const result = filterHostOwnership(app, [
      { event: localEvent, sourceHostId: null },
      { event: validRemoteEvent, sourceHostId: "remote-a" },
      { event: spoofedRemoteEvent, sourceHostId: "remote-b" },
    ]);

    expect(result).toEqual([localEvent, validRemoteEvent]);
  });

  it("issues exactly one ownership query per flush batch, not one per event", () => {
    seedHost("remote-a");
    const projectId = seedProject("remote-a");
    const s1 = seedSession(projectId);
    const s2 = seedSession(projectId);
    const s3 = seedSession(projectId);

    const spy = vi.spyOn(app.db, "select");
    const result = filterHostOwnership(app, [
      { event: makeEvent({ sessionId: s1, seq: 1 }), sourceHostId: "remote-a" },
      { event: makeEvent({ sessionId: s2, seq: 2 }), sourceHostId: "remote-a" },
      { event: makeEvent({ sessionId: s3, seq: 3 }), sourceHostId: "remote-a" },
    ]);

    expect(result).toHaveLength(3);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
