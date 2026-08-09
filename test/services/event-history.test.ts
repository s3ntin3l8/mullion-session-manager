import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { isNull } from "drizzle-orm";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { sessionEvents, sessions } from "../../src/db/schema.js";
import {
  insertSessionEvents,
  querySessionEvents,
  sweepOldSessionEvents,
  sweepSessionEventCap,
  DEFAULT_QUERY_LIMIT,
} from "../../src/services/event-history.js";
import type { NotificationEvent } from "../../src/services/pty-manager.js";

// Issue #213 (roadmap 4.7) — direct unit tests of the query/insert/sweep
// logic behind the `session_events` table against a real temp SQLite DB
// (migrations applied via buildApp()'s dbPlugin), not a mock — this is the
// only layer where the FK behavior (`onDelete: "set null"`, foreign_keys
// pragma ON — see db/client.ts) and real SQL filtering/ordering can
// actually be exercised.

const tmpDb = path.join(os.tmpdir(), `event-history-test-${process.pid}.db`);

function makeEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    seq: 1,
    sessionId: 1,
    kind: "status_change",
    ts: Date.now(),
    payload: { hello: "world" },
    ...overrides,
  };
}

describe("event-history service", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("insertSessionEvents no-ops on an empty batch", async () => {
    const app = await buildApp();
    expect(() => insertSessionEvents(app.db, [])).not.toThrow();
    await app.close();
  });

  it("insertSessionEvents persists a batch and round-trips the JSON payload on read", async () => {
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "history-a", cwd: "/tmp/history-a" },
    });
    const projectId = created.json().id as number;
    const [session] = app.db
      .insert(sessions)
      .values({ projectId, command: "bash" })
      .returning()
      .all();

    insertSessionEvents(app.db, [
      makeEvent({ sessionId: session.id, seq: 1, kind: "title_change", payload: { title: "x" } }),
    ]);

    const { events } = querySessionEvents(app.db, { sessionId: session.id });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sessionId: session.id,
      seq: 1,
      kind: "title_change",
      payload: { title: "x" },
    });

    await app.close();
  });

  it("insertSessionEvents throws straight through on a DB error (e.g. FK violation) rather than swallowing it", async () => {
    const app = await buildApp();
    // No session with this id exists — foreign_keys is ON (db/client.ts),
    // so this must violate the FK, not silently insert or null the column
    // out from under the caller.
    expect(() => insertSessionEvents(app.db, [makeEvent({ sessionId: 999_999 })])).toThrow();
    await app.close();
  });

  it("sessionId survives as null (not an FK violation) — the `set null` column accepts it directly", async () => {
    const app = await buildApp();
    expect(() =>
      insertSessionEvents(app.db, [
        {
          seq: 1,
          sessionId: null as unknown as number,
          kind: "session_end",
          ts: Date.now(),
          payload: {},
        },
      ]),
    ).not.toThrow();
    await app.close();
  });

  describe("querySessionEvents", () => {
    it("filters by sessionId and by kind independently", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "history-b", cwd: "/tmp/history-b" },
      });
      const projectId = created.json().id as number;
      const [s1, s2] = app.db
        .insert(sessions)
        .values([
          { projectId, command: "bash" },
          { projectId, command: "zsh" },
        ])
        .returning()
        .all();

      // A kind string unique to this test (not reused by any other `it` in
      // this file) — the `byKind` query below deliberately has no
      // `sessionId` filter, so it queries the WHOLE table, which (per this
      // file's shared-tmpDb, accumulate-across-tests posture, same as
      // test/routes/settings.test.ts) may also hold rows other tests in
      // this file inserted.
      const uniqueKind = "history_test_unique_kind_a";
      insertSessionEvents(app.db, [
        makeEvent({ sessionId: s1.id, seq: 1, kind: uniqueKind }),
        makeEvent({ sessionId: s1.id, seq: 2, kind: "status_change" }),
        makeEvent({ sessionId: s2.id, seq: 1, kind: uniqueKind }),
      ]);

      const bySession = querySessionEvents(app.db, { sessionId: s1.id });
      expect(bySession.events).toHaveLength(2);
      expect(bySession.events.every((e) => e.sessionId === s1.id)).toBe(true);

      const byKind = querySessionEvents(app.db, { kind: uniqueKind });
      expect(byKind.events).toHaveLength(2);
      expect(byKind.events.every((e) => e.kind === uniqueKind)).toBe(true);

      const both = querySessionEvents(app.db, { sessionId: s1.id, kind: uniqueKind });
      expect(both.events).toHaveLength(1);

      await app.close();
    });

    it("filters by since/until (inclusive) on ts", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "history-c", cwd: "/tmp/history-c" },
      });
      const projectId = created.json().id as number;
      const [session] = app.db
        .insert(sessions)
        .values({ projectId, command: "bash" })
        .returning()
        .all();

      const base = 1_000_000_000_000;
      insertSessionEvents(app.db, [
        makeEvent({ sessionId: session.id, seq: 1, ts: base }),
        makeEvent({ sessionId: session.id, seq: 2, ts: base + 1000 }),
        makeEvent({ sessionId: session.id, seq: 3, ts: base + 2000 }),
      ]);

      const windowed = querySessionEvents(app.db, {
        sessionId: session.id,
        since: base + 500,
        until: base + 1500,
      });
      expect(windowed.events.map((e) => e.seq)).toEqual([2]);

      const inclusive = querySessionEvents(app.db, {
        sessionId: session.id,
        since: base,
        until: base,
      });
      expect(inclusive.events.map((e) => e.seq)).toEqual([1]);

      await app.close();
    });

    it("orders by insertion (id) — NOT by ts — so an out-of-order ts doesn't corrupt pagination", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "history-d", cwd: "/tmp/history-d" },
      });
      const projectId = created.json().id as number;
      const [session] = app.db
        .insert(sessions)
        .values({ projectId, command: "bash" })
        .returning()
        .all();

      // Insert in this order; the second row is given an OLDER `ts` than the
      // first, deliberately — a ts-based sort would put it first, but
      // insertion (id) order must not be disturbed by that.
      insertSessionEvents(app.db, [makeEvent({ sessionId: session.id, seq: 1, ts: 5000 })]);
      insertSessionEvents(app.db, [makeEvent({ sessionId: session.id, seq: 2, ts: 1000 })]);
      insertSessionEvents(app.db, [makeEvent({ sessionId: session.id, seq: 3, ts: 9000 })]);

      const { events } = querySessionEvents(app.db, { sessionId: session.id });
      // Newest-inserted-first (id DESC): seq 3, then 2, then 1.
      expect(events.map((e) => e.seq)).toEqual([3, 2, 1]);

      await app.close();
    });

    it("paginates via the id cursor with no gaps or duplicates across pages", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "history-e", cwd: "/tmp/history-e" },
      });
      const projectId = created.json().id as number;
      const [session] = app.db
        .insert(sessions)
        .values({ projectId, command: "bash" })
        .returning()
        .all();

      insertSessionEvents(
        app.db,
        Array.from({ length: 5 }, (_, i) => makeEvent({ sessionId: session.id, seq: i + 1 })),
      );

      const seen: number[] = [];
      let cursor: number | undefined;
      for (let page = 0; page < 10; page++) {
        const result = querySessionEvents(app.db, { sessionId: session.id, limit: 2, cursor });
        seen.push(...result.events.map((e) => e.seq));
        if (result.nextCursor === null) break;
        cursor = result.nextCursor;
      }
      // Newest-first, 5 total: [5,4,3,2,1].
      expect(seen).toEqual([5, 4, 3, 2, 1]);

      await app.close();
    });

    it("falls back to DEFAULT_QUERY_LIMIT for a non-positive limit instead of erroring", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "history-f", cwd: "/tmp/history-f" },
      });
      const projectId = created.json().id as number;
      const [session] = app.db
        .insert(sessions)
        .values({ projectId, command: "bash" })
        .returning()
        .all();
      insertSessionEvents(app.db, [makeEvent({ sessionId: session.id, seq: 1 })]);

      const result = querySessionEvents(app.db, { sessionId: session.id, limit: -1 });
      expect(result.events).toHaveLength(1);
      expect(DEFAULT_QUERY_LIMIT).toBeGreaterThan(0);

      await app.close();
    });

    it("returns null (never the raw string) and logs a warning for an unparsable payload", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "history-g", cwd: "/tmp/history-g" },
      });
      const projectId = created.json().id as number;
      const [session] = app.db
        .insert(sessions)
        .values({ projectId, command: "bash" })
        .returning()
        .all();
      // Bypass insertSessionEvents (which always JSON.stringifies) to write
      // a genuinely malformed payload column directly.
      app.db
        .insert(sessionEvents)
        .values({
          sessionId: session.id,
          seq: 1,
          kind: "todo",
          ts: Date.now(),
          payload: "{not json",
        })
        .run();

      const warn = vi.fn();
      const { events } = querySessionEvents(app.db, { sessionId: session.id }, { warn });
      expect(events[0].payload).toBeNull();
      expect(warn).toHaveBeenCalled();

      await app.close();
    });
  });

  describe("sweepOldSessionEvents", () => {
    it("is a no-op for retentionDays <= 0", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "history-h", cwd: "/tmp/history-h" },
      });
      const projectId = created.json().id as number;
      const [session] = app.db
        .insert(sessions)
        .values({ projectId, command: "bash" })
        .returning()
        .all();
      insertSessionEvents(app.db, [
        makeEvent({ sessionId: session.id, seq: 1, ts: Date.now() - 365 * 24 * 60 * 60 * 1000 }),
      ]);

      expect(sweepOldSessionEvents(app.db, 0)).toBe(0);
      expect(sweepOldSessionEvents(app.db, -5)).toBe(0);
      expect(querySessionEvents(app.db, { sessionId: session.id }).events).toHaveLength(1);

      await app.close();
    });

    it("deletes rows older than the retention window and leaves recent ones", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "history-i", cwd: "/tmp/history-i" },
      });
      const projectId = created.json().id as number;
      const [session] = app.db
        .insert(sessions)
        .values({ projectId, command: "bash" })
        .returning()
        .all();

      const now = Date.now();
      const oldTs = now - 40 * 24 * 60 * 60 * 1000; // 40 days ago
      const recentTs = now - 60 * 60 * 1000; // 1 hour ago
      insertSessionEvents(app.db, [
        makeEvent({ sessionId: session.id, seq: 1, ts: oldTs }),
        makeEvent({ sessionId: session.id, seq: 2, ts: recentTs }),
      ]);

      const deleted = sweepOldSessionEvents(app.db, 30);
      expect(deleted).toBe(1);

      const remaining = querySessionEvents(app.db, { sessionId: session.id }).events;
      expect(remaining).toHaveLength(1);
      expect(remaining[0].seq).toBe(2);

      await app.close();
    });
  });

  // This test file's outer `beforeAll` creates ONE temp SQLite file shared
  // by every `it()` (no per-test reset) — so a session created by an
  // EARLIER test (e.g. the pagination fixtures under `describe
  // ("querySessionEvents")` above) can still be sitting in the table with
  // its own row count when a `sweepSessionEventCap` test runs. Since the
  // sweep operates across every session in the table, its aggregate
  // `deleted` return value is not safe to assert on exactly here — a
  // leftover session from an earlier test could independently exceed the
  // same cap and get swept too. Every test below asserts only on
  // session-scoped `querySessionEvents(..., { sessionId })` state instead,
  // which stays correct regardless of what else has accumulated in the
  // shared file. (`maxPerSession <= 0` is the one exception: it's a
  // pure argument check the function short-circuits on before ever
  // touching the DB, so its `0` return is exact and contamination-proof.)
  describe("sweepSessionEventCap", () => {
    it("is a no-op for maxPerSession <= 0", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "history-cap-a", cwd: "/tmp/history-cap-a" },
      });
      const projectId = created.json().id as number;
      const [session] = app.db
        .insert(sessions)
        .values({ projectId, command: "bash" })
        .returning()
        .all();
      insertSessionEvents(app.db, [
        makeEvent({ sessionId: session.id, seq: 1 }),
        makeEvent({ sessionId: session.id, seq: 2 }),
      ]);

      expect(sweepSessionEventCap(app.db, 0)).toBe(0);
      expect(sweepSessionEventCap(app.db, -5)).toBe(0);
      expect(querySessionEvents(app.db, { sessionId: session.id }).events).toHaveLength(2);

      await app.close();
    });

    it("keeps only the newest N rows for a session over the cap, deletes the rest", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "history-cap-b", cwd: "/tmp/history-cap-b" },
      });
      const projectId = created.json().id as number;
      const [session] = app.db
        .insert(sessions)
        .values({ projectId, command: "bash" })
        .returning()
        .all();
      // Insert one at a time so each gets a strictly increasing `id`
      // (autoincrement) — insertSessionEvents' own batch insert doesn't
      // guarantee per-row ordering within one statement the way this test
      // needs to assert exactly which three survive.
      for (let seq = 1; seq <= 5; seq++) {
        insertSessionEvents(app.db, [makeEvent({ sessionId: session.id, seq, ts: seq * 1000 })]);
      }

      sweepSessionEventCap(app.db, 3);

      const remaining = querySessionEvents(app.db, { sessionId: session.id, limit: 10 }).events;
      expect(remaining.map((e) => e.seq).sort()).toEqual([3, 4, 5]);

      await app.close();
    });

    it("does not delete anything when a session has fewer rows than the cap", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "history-cap-c", cwd: "/tmp/history-cap-c" },
      });
      const projectId = created.json().id as number;
      const [session] = app.db
        .insert(sessions)
        .values({ projectId, command: "bash" })
        .returning()
        .all();
      insertSessionEvents(app.db, [makeEvent({ sessionId: session.id, seq: 1 })]);

      sweepSessionEventCap(app.db, 100);

      expect(querySessionEvents(app.db, { sessionId: session.id }).events).toHaveLength(1);

      await app.close();
    });

    it("caps each session independently", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "history-cap-d", cwd: "/tmp/history-cap-d" },
      });
      const projectId = created.json().id as number;
      const [sessionA, sessionB] = app.db
        .insert(sessions)
        .values([
          { projectId, command: "bash" },
          { projectId, command: "bash" },
        ])
        .returning()
        .all();
      for (let seq = 1; seq <= 3; seq++) {
        insertSessionEvents(app.db, [makeEvent({ sessionId: sessionA.id, seq, ts: seq * 1000 })]);
      }
      insertSessionEvents(app.db, [makeEvent({ sessionId: sessionB.id, seq: 1 })]);

      sweepSessionEventCap(app.db, 1);

      expect(querySessionEvents(app.db, { sessionId: sessionA.id }).events).toHaveLength(1);
      expect(querySessionEvents(app.db, { sessionId: sessionB.id }).events).toHaveLength(1);

      await app.close();
    });

    it("leaves orphaned rows (sessionId: null) alone — they have no session to cap against", async () => {
      const app = await buildApp();
      const before = app.db
        .select()
        .from(sessionEvents)
        .where(isNull(sessionEvents.sessionId))
        .all().length;

      insertSessionEvents(app.db, [
        {
          seq: 1,
          sessionId: null as unknown as number,
          kind: "session_end",
          ts: 1000,
          payload: {},
        },
        {
          seq: 2,
          sessionId: null as unknown as number,
          kind: "session_end",
          ts: 2000,
          payload: {},
        },
      ]);

      sweepSessionEventCap(app.db, 1);

      const after = app.db
        .select()
        .from(sessionEvents)
        .where(isNull(sessionEvents.sessionId))
        .all().length;
      // The two rows just inserted must both still be there — a
      // count-based cap has nothing to count them against and must leave
      // every orphan alone, regardless of how many already existed.
      expect(after).toBe(before + 2);

      await app.close();
    });
  });
});
