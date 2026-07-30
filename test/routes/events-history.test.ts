import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { sessions } from "../../src/db/schema.js";
import { insertSessionEvents } from "../../src/services/event-history.js";

// Issue #213 (roadmap 4.7) — GET /api/events filtering/pagination, adjacent
// to test/routes/events.test.ts (which covers the live /ws/events stream).
// Plain app.inject() against a temp DB, no real PTY/node-pty faking needed:
// this route only ever reads the `session_events` table directly.

const tmpDb = path.join(os.tmpdir(), `events-history-test-${process.pid}.db`);

async function createProject(app: Awaited<ReturnType<typeof buildApp>>, cwd: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { name: cwd, cwd },
  });
  return res.json().id as number;
}

describe("GET /api/events", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("returns persistenceEnabled:false with an empty result set by default, even if rows exist", async () => {
    const app = await buildApp();
    const projectId = await createProject(app, "/tmp/events-history-a");
    const [session] = app.db
      .insert(sessions)
      .values({ projectId, command: "bash" })
      .returning()
      .all();
    insertSessionEvents(app.db, [
      { seq: 1, sessionId: session.id, kind: "status_change", ts: Date.now(), payload: {} },
    ]);

    const res = await app.inject({ method: "GET", url: "/api/events" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.json()).toEqual({ persistenceEnabled: false, events: [], nextCursor: null });

    await app.close();
  });

  it("filters by sessionId/kind/since/until and paginates once persistence is enabled", async () => {
    const app = await buildApp();
    await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { sessions: { eventPersistence: true } },
    });

    const projectId = await createProject(app, "/tmp/events-history-b");
    const [s1, s2] = app.db
      .insert(sessions)
      .values([
        { projectId, command: "bash" },
        { projectId, command: "zsh" },
      ])
      .returning()
      .all();

    const base = 2_000_000_000_000;
    insertSessionEvents(app.db, [
      { seq: 1, sessionId: s1.id, kind: "title_change", ts: base, payload: { a: 1 } },
      { seq: 2, sessionId: s1.id, kind: "status_change", ts: base + 1000, payload: { a: 2 } },
      { seq: 3, sessionId: s1.id, kind: "status_change", ts: base + 2000, payload: { a: 3 } },
      { seq: 1, sessionId: s2.id, kind: "title_change", ts: base + 500, payload: { a: 4 } },
    ]);

    // No filter at all: every row for this test's two sessions (plus
    // whatever the previous `it` inserted, since this file's tmpDb
    // accumulates across its — same style as test/routes/settings.test.ts —
    // so scope every assertion below by this test's own session ids/kind).
    const bySession = await app.inject({ method: "GET", url: `/api/events?sessionId=${s1.id}` });
    expect(bySession.statusCode).toBe(200);
    const bySessionBody = bySession.json();
    expect(bySessionBody.persistenceEnabled).toBe(true);
    expect(bySessionBody.events).toHaveLength(3);
    expect(bySessionBody.events.every((e: { sessionId: number }) => e.sessionId === s1.id)).toBe(
      true,
    );

    const byKind = await app.inject({
      method: "GET",
      url: `/api/events?sessionId=${s1.id}&kind=status_change`,
    });
    expect(byKind.json().events).toHaveLength(2);

    const byWindow = await app.inject({
      method: "GET",
      url: `/api/events?sessionId=${s1.id}&since=${base + 500}&until=${base + 1500}`,
    });
    expect(byWindow.json().events.map((e: { seq: number }) => e.seq)).toEqual([2]);

    // Payload round-trips as a real object, not a string.
    expect(byWindow.json().events[0].payload).toEqual({ a: 2 });

    // Pagination: page through with limit=1, newest-inserted-first.
    const seen: number[] = [];
    let cursor: number | undefined;
    for (let page = 0; page < 10; page++) {
      const url =
        `/api/events?sessionId=${s1.id}&limit=1` +
        (cursor !== undefined ? `&cursor=${cursor}` : "");
      const pageRes = await app.inject({ method: "GET", url });
      const body = pageRes.json();
      seen.push(...body.events.map((e: { seq: number }) => e.seq));
      if (body.nextCursor === null) break;
      cursor = body.nextCursor;
    }
    expect(seen).toEqual([3, 2, 1]);

    await app.close();
  });

  it("rejects a non-integer sessionId querystring value with a 400", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/events?sessionId=not-a-number" });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
