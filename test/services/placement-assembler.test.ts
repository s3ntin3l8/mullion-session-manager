import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { hosts } from "../../src/db/schema.js";
import { resolvePlacement } from "../../src/services/placement.js";
import type { HostCapacity } from "../../src/services/host-capacity.js";

// Issue #1723 / roadmap 8.9 — the assembler's half: what goes INTO the
// candidate set. The policy's own decision table lives in
// test/services/placement.test.ts; this file checks that the live
// trackers are read correctly — a host that is offline per the heartbeat is
// not eligible, a host that never reported capacity is not eligible, and
// the local host's capacity is measured live rather than read from the
// cache.

const tmpDb = path.join(os.tmpdir(), `placement-assembler-test-${process.pid}.db`);

function capacity(loadAverage1m: number, logicalCores: number): HostCapacity {
  return {
    platform: "linux",
    logicalCores,
    loadAverage1m,
    memory: { totalBytes: 1000, freeBytes: 500 },
    sessions: { tracked: 0, alive: 0 },
  };
}

describe("resolvePlacement — the candidate set comes from the live trackers (issue #1723)", () => {
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
    app.db.delete(hosts).where("id != 'local'").run();
    app.hostCapacityTracker?.pruneMissing(new Set());
  });

  /** Registers a remote host and returns its id. */
  async function registerHost(name: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name, baseUrl: "http://127.0.0.1:1", token: "t" },
    });
    return res.json().id as string;
  }

  it("places an unattended session on an online host that reported capacity", async () => {
    const hostId = await registerHost("idle-agent");
    app.hostHeartbeatTracker?.recordSuccess(hostId);
    app.hostCapacityTracker?.record(hostId, capacity(0.2, 8));

    const decision = resolvePlacement(app, {
      project: { hostId: "local", placement: "auto" },
      unattended: true,
    });
    expect(decision.hostId).toBe(hostId);
    expect(decision.fellBack).toBe(false);
  });

  it("does not offer a host that is offline per the heartbeat", async () => {
    const hostId = await registerHost("offline-agent");
    // Never recorded a success → the tracker reads it as "pending".
    app.hostCapacityTracker?.record(hostId, capacity(0.2, 8));

    const decision = resolvePlacement(app, {
      project: { hostId: "local", placement: "auto" },
      unattended: true,
    });
    // The local host is this process — it is online and measured live, so it
    // is always eligible; the offline remote simply never becomes a
    // candidate.
    expect(decision.hostId).toBe("local");
    expect(decision.considered.map((c) => c.hostId)).not.toContain(hostId);
  });

  it("does not offer a host that never reported a capacity", async () => {
    const hostId = await registerHost("silent-agent");
    app.hostHeartbeatTracker?.recordSuccess(hostId);
    // No capacity recorded → not a candidate (not a failure).

    const decision = resolvePlacement(app, {
      project: { hostId: "local", placement: "auto" },
      unattended: true,
    });
    expect(decision.hostId).toBe("local");
    expect(decision.considered.map((c) => c.hostId)).not.toContain(hostId);
  });

  it("uses the LOCAL host's live capacity, not a cached reading", async () => {
    // The local host is measured on demand (issue #1721) — it is this
    // process — so the assembler must not read its (absent) cached entry.
    const decision = resolvePlacement(app, {
      project: { hostId: "local", placement: "auto" },
      unattended: true,
    });
    // The local host is the only candidate, and it is eligible (measured
    // live), so the decision is local — with a capacity reading in the
    // considered table.
    expect(decision.hostId).toBe("local");
    expect(decision.fellBack).toBe(false);
    expect(decision.considered[0].hostId).toBe("local");
    expect(decision.considered[0].logicalCores).toBeGreaterThan(0);
  });

  it("a PINNED project never scores — it takes the project's own host", async () => {
    const hostId = await registerHost("idle-agent");
    app.hostHeartbeatTracker?.recordSuccess(hostId);
    app.hostCapacityTracker?.record(hostId, capacity(0.2, 8));

    const decision = resolvePlacement(app, {
      project: { hostId: "local", placement: "pinned" },
      unattended: true,
    });
    expect(decision.hostId).toBe("local");
    expect(decision.considered).toEqual([]);
    expect(decision.fellBack).toBe(false);
    expect(decision.reason).toMatch(/pinned/);
  });
});
