import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { hosts as hostsTable } from "../../src/db/schema.js";
import { createPairedHost } from "../../src/services/host-registry.js";

const tmpDb = path.join(os.tmpdir(), `hosts-duplicates-test-${process.pid}.db`);

describe("hosts route: possible duplicates", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("GET /api/hosts marks a re-enrolled agent's older offline row as a possible duplicate (issue #2582)", async () => {
    const app = await buildApp();
    const baseUrl = "http://127.0.0.1:4582";
    const old = createPairedHost(app, { baseUrl, hostname: "ctr" });
    app.db
      .update(hostsTable)
      .set({ createdAt: new Date(Date.now() - 60_000) })
      .where(eq(hostsTable.id, old.hostId))
      .run();
    const fresh = createPairedHost(app, { baseUrl, hostname: "ctr" });
    const byId = async (id: string) => {
      app.hostHeartbeatTracker?.markOffline(old.hostId);
      app.hostHeartbeatTracker?.recordSuccess(fresh.hostId);
      const list = (await app.inject({ method: "GET", url: "/api/hosts" })).json();
      return list.find((h: { id: string }) => h.id === id);
    };
    await vi.waitFor(async () => {
      expect((await byId(fresh.hostId)).possibleDuplicateOf).toEqual([old.hostId]);
    });
    expect((await byId(old.hostId)).possibleDuplicateOf).toEqual([]);

    expect(
      (await app.inject({ method: "DELETE", url: `/api/hosts/${old.hostId}` })).statusCode,
    ).toBe(204);
    const after = (await app.inject({ method: "GET", url: "/api/hosts" })).json();
    expect(after.find((h: { id: string }) => h.id === fresh.hostId).possibleDuplicateOf).toEqual(
      [],
    );
    await app.close();
  });

  it("GET /api/hosts flags a lone legacy agent but not the legacy row its upgraded successor replaced (issue #2969)", async () => {
    const app = await buildApp();
    try {
      const loneId = crypto.randomUUID();
      app.db
        .insert(hostsTable)
        .values({
          id: loneId,
          name: "lone",
          baseUrl: "http://127.0.0.1:4601",
          authTokenEnc: null,
          origin: "enrolled",
          approvedAt: new Date(),
        })
        .run();
      const baseUrl = "http://127.0.0.1:4602";
      const oldId = crypto.randomUUID();
      app.db
        .insert(hostsTable)
        .values({
          id: oldId,
          name: "moved",
          baseUrl,
          authTokenEnc: null,
          origin: "enrolled",
          approvedAt: new Date(),
          createdAt: new Date(Date.now() - 60_000),
        })
        .run();
      const fresh = createPairedHost(app, { baseUrl, hostname: "moved" });
      const row = async (id: string) => {
        app.hostHeartbeatTracker?.markOffline(oldId);
        app.hostHeartbeatTracker?.recordSuccess(fresh.hostId);
        const list = (await app.inject({ method: "GET", url: "/api/hosts" })).json();
        return list.find((h: { id: string }) => h.id === id);
      };
      await vi.waitFor(async () => {
        expect((await row(fresh.hostId)).possibleDuplicateOf).toEqual([oldId]);
      });
      expect((await row(loneId)).legacyAgent).toBe(true);
      expect((await row(oldId)).legacyAgent).toBe(false);
      expect((await row(fresh.hostId)).legacyAgent).toBe(false);
    } finally {
      await app.close();
    }
  });
});
