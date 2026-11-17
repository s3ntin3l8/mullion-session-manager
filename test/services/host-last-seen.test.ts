import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { hosts } from "../../src/db/schema.js";
import { HostHeartbeatTracker } from "../../src/services/host-heartbeat.js";

describe("heartbeat persisted last seen (#3183)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    app.db
      .insert(hosts)
      .values([
        { id: "hourly", name: "Hourly" },
        { id: "independent", name: "Independent" },
      ])
      .run();
  });

  afterEach(() => vi.useRealTimers());

  afterAll(async () => {
    await app.close();
    closeDb();
  });

  it("writes on success, throttles each host for an hour, and preserves the snapshot across restart", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2026-01-01T12:00:00Z");
    vi.setSystemTime(start);
    const tracker = new HostHeartbeatTracker(app.db);
    const seen = (id: string) =>
      app.db.select().from(hosts).where(eq(hosts.id, id)).get()!.lastSeenAt;
    const changes = () =>
      (app.db.$client.prepare("SELECT total_changes() AS n").get() as { n: number }).n;

    const before = changes();
    tracker.recordSuccess("hourly");
    expect(seen("hourly")).toEqual(start);
    expect(changes()).toBe(before + 1);

    vi.setSystemTime(start.getTime() + 3_599_000);
    tracker.recordSuccess("hourly");
    expect(seen("hourly")).toEqual(start);
    expect(changes()).toBe(before + 1);
    expect(tracker.getHealth("hourly").lastSeenAt).toBe(Date.now());

    tracker.recordSuccess("independent");
    expect(seen("independent")).toEqual(new Date(Date.now()));
    expect(changes()).toBe(before + 2);

    vi.setSystemTime(start.getTime() + 3_600_000);
    tracker.recordSuccess("hourly");
    expect(seen("hourly")).toEqual(new Date(Date.now()));
    expect(changes()).toBe(before + 3);

    tracker.recordFailure("hourly");
    tracker.markOffline("hourly");
    expect(changes()).toBe(before + 3);
    expect(new HostHeartbeatTracker(app.db).getHealth("hourly").lastSeenAt).toBeNull();
    expect(seen("hourly")).toEqual(new Date(Date.now()));
  });

  it("never writes a successful contact for the local host", () => {
    const tracker = new HostHeartbeatTracker(app.db);
    const before = app.db.$client.prepare("SELECT total_changes() AS n").get();
    tracker.recordSuccess("local");
    tracker.recordSuccess("local");
    expect(app.db.$client.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    expect(app.db.select().from(hosts).where(eq(hosts.id, "local")).get()!.lastSeenAt).toBeNull();
  });

  it("keeps the hourly throttle through health invalidation and forgets missing hosts even when invalidated", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2026-01-02T12:00:00Z");
    vi.setSystemTime(start);
    const tracker = new HostHeartbeatTracker(app.db);
    const changes = () =>
      (app.db.$client.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const before = changes();
    tracker.recordSuccess("hourly");
    expect(changes()).toBe(before + 1);

    vi.setSystemTime(start.getTime() + 60_000);
    tracker.invalidateHost("hourly");
    expect(tracker.getHealth("hourly").status).toBe("pending");
    tracker.pruneMissing(new Set(["hourly"]));
    tracker.recordSuccess("hourly");
    expect(changes()).toBe(before + 1);

    tracker.invalidateHost("hourly");
    tracker.pruneMissing(new Set());
    tracker.recordSuccess("hourly");
    expect(changes()).toBe(before + 2);
    expect(app.db.select().from(hosts).where(eq(hosts.id, "hourly")).get()!.lastSeenAt).toEqual(
      new Date(Date.now()),
    );
  });
});

describe("hosts last_seen_at migration backfill (#3183)", () => {
  it("starts existing nonlocal rows at migration time and keeps local and new unknown rows nullable", () => {
    const db = new Database(":memory:");
    try {
      const dir = path.resolve("drizzle");
      const files = fs
        .readdirSync(dir)
        .filter((file) => /^\d{4}_.*\.sql$/.test(file))
        .sort();
      const target = files.find((file) =>
        /ALTER TABLE [`"]?hosts[`"]? ADD [`"]?last_seen_at/.test(
          fs.readFileSync(path.join(dir, file), "utf8"),
        ),
      );
      expect(target).toBeDefined();
      const apply = (file: string) => {
        for (const statement of fs
          .readFileSync(path.join(dir, file), "utf8")
          .split("--> statement-breakpoint"))
          db.exec(statement);
      };
      for (const file of files.slice(0, files.indexOf(target!))) apply(file);
      db.exec(
        "INSERT INTO hosts (id, name, origin, created_at) VALUES ('old-manual', 'Manual', NULL, 1), ('old-enrolled', 'Enrolled', 'enrolled', 1)",
      );
      const before = Math.floor(Date.now() / 1000);
      apply(target!);
      const after = Math.floor(Date.now() / 1000);
      const rows = db
        .prepare("SELECT id, last_seen_at AS seen FROM hosts ORDER BY id")
        .all() as Array<{ id: string; seen: number | null }>;
      expect(rows.find((row) => row.id === "local")!.seen).toBeNull();
      for (const id of ["old-manual", "old-enrolled"]) {
        const seen = rows.find((row) => row.id === id)!.seen!;
        expect(seen).toBeGreaterThanOrEqual(before);
        expect(seen).toBeLessThanOrEqual(after);
        expect(Date.now() - seen * 1000).toBeLessThan(30 * 86_400_000);
      }
      db.exec("INSERT INTO hosts (id, name, created_at) VALUES ('new-unknown', 'Unknown', 1)");
      expect(
        db.prepare("SELECT last_seen_at AS seen FROM hosts WHERE id = 'new-unknown'").get(),
      ).toEqual({ seen: null });
    } finally {
      db.close();
    }
  });
});
