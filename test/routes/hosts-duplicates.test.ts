import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { hosts as hostsTable } from "../../src/db/schema.js";
import { enrollHost } from "../../src/services/host-registry.js";

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
    const old = enrollHost(app, { baseUrl, hostname: "ctr", wantsMachineCredential: true });
    app.db
      .update(hostsTable)
      .set({ createdAt: new Date(Date.now() - 60_000) })
      .where(eq(hostsTable.id, old.hostId))
      .run();
    const fresh = enrollHost(app, { baseUrl, hostname: "ctr", wantsMachineCredential: true });
    // The boot-time sweep prunes tracker entries for hosts it did not see, so
    // re-assert the verdicts until one lands after it.
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

    // Nothing is merged or deleted automatically; deleting the stale row clears the flag.
    expect(
      (await app.inject({ method: "DELETE", url: `/api/hosts/${old.hostId}` })).statusCode,
    ).toBe(204);
    const after = (await app.inject({ method: "GET", url: "/api/hosts" })).json();
    expect(after.find((h: { id: string }) => h.id === fresh.hostId).possibleDuplicateOf).toEqual(
      [],
    );
    await app.close();
  });
});
