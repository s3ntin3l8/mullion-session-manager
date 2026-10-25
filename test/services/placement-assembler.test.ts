import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { sql } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { hosts } from "../../src/db/schema.js";
import { previewPlacement, resolvePlacement } from "../../src/services/placement.js";
import * as listHostsModule from "../../src/services/host-registry.js";
import type { HostCapacity } from "../../src/services/host-capacity.js";

// Issue #1723 / roadmap 8.9 — the assembler's half: what goes INTO the
// candidate set. The policy's own decision table lives in
// test/services/placement.test.ts; this file checks that the live
// trackers are read correctly — a host that is offline per the heartbeat is
// not eligible, a host that never reported capacity is not eligible, and
// the local host's capacity is measured live rather than read from the
// cache.

const tmpDb = path.join(os.tmpdir(), `placement-assembler-test-${process.pid}.db`);

/** The project's own path, and the path it has on a remote host. */
const LOCAL_CWD = "/home/x/repo";
const REMOTE_CWD = "/srv/repo";

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
    // sql.raw, NOT a plain string: drizzle's where() only accepts SQL, and
    // a raw string is bound as a PARAMETER — `where ?` with the text
    // "id != 'local'" is false in SQLite, so the old string form silently
    // deleted NOTHING and the per-test cleanup never happened.
    app.db.delete(hosts).where(sql.raw("id != 'local'")).run();
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
      project: {
        hostId: "local",
        placement: "auto",
        cwd: LOCAL_CWD,
        // Issue #1724 — the project has to BE on the remote host for the
        // remote host to be a candidate at all.
        hostCwds: JSON.stringify({ [hostId]: REMOTE_CWD }),
      },
      unattended: true,
    });
    expect(decision.hostId).toBe(hostId);
    expect(decision.fellBack).toBe(false);
  });

  it("does not offer a host the project is not on", async () => {
    // Issue #1724 — a session runs in a directory, so a host without the
    // project cannot host a session for it. The host is healthy and idle,
    // and it is STILL not a candidate: no map entry, no checkout.
    const hostId = await registerHost("idle-agent");
    app.hostHeartbeatTracker?.recordSuccess(hostId);
    app.hostCapacityTracker?.record(hostId, capacity(0.2, 8));

    const decision = resolvePlacement(app, {
      project: { hostId: "local", placement: "auto", cwd: LOCAL_CWD },
      unattended: true,
    });
    expect(decision.hostId).toBe("local");
    expect(decision.considered.map((c) => c.hostId)).not.toContain(hostId);
  });

  it("does not offer a host that is offline per the heartbeat", async () => {
    const hostId = await registerHost("offline-agent");
    // Never recorded a success → the tracker reads it as "pending".
    app.hostCapacityTracker?.record(hostId, capacity(0.2, 8));

    const decision = resolvePlacement(app, {
      project: { hostId: "local", placement: "auto", cwd: LOCAL_CWD },
      unattended: true,
    });
    // The local host is this process — it is online and measured live, so it
    // is always eligible; the offline remote simply never becomes a
    // candidate.
    expect(decision.hostId).toBe("local");
    expect(decision.considered.map((c) => c.hostId)).not.toContain(hostId);
  });

  it("does not offer a PARKED host — the drain flag comes from the row", async () => {
    // Issue #1725 / roadmap 8.11 — the flag is the host's own column, so
    // parking a host is what makes it ineligible: the policy consults
    // `drained`, and the assembler reads the row.
    const hostId = await registerHost("parked-agent");
    app.hostHeartbeatTracker?.recordSuccess(hostId);
    app.hostCapacityTracker?.record(hostId, capacity(0.2, 8));
    const parked = await app.inject({
      method: "PATCH",
      url: `/api/hosts/${hostId}`,
      payload: { drained: true },
    });
    expect(parked.statusCode).toBe(200);
    expect(parked.json().drained).toBe(true);

    const decision = resolvePlacement(app, {
      project: {
        hostId: "local",
        placement: "auto",
        cwd: LOCAL_CWD,
        hostCwds: JSON.stringify({ [hostId]: REMOTE_CWD }),
      },
      unattended: true,
    });
    expect(decision.hostId).toBe("local");
    expect(decision.considered.map((c) => c.hostId)).not.toContain(hostId);
  });

  it("does not offer a host that never reported a capacity", async () => {
    const hostId = await registerHost("silent-agent");
    app.hostHeartbeatTracker?.recordSuccess(hostId);
    // No capacity recorded → not a candidate (not a failure).

    const decision = resolvePlacement(app, {
      project: { hostId: "local", placement: "auto", cwd: LOCAL_CWD },
      unattended: true,
    });
    expect(decision.hostId).toBe("local");
    expect(decision.considered.map((c) => c.hostId)).not.toContain(hostId);
  });

  it("uses the LOCAL host's live capacity, not a cached reading", async () => {
    // The local host is measured on demand (issue #1721) — it is this
    // process — so the assembler must not read its (absent) cached entry.
    const decision = resolvePlacement(app, {
      project: { hostId: "local", placement: "auto", cwd: LOCAL_CWD },
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

  it("falls back to the project's host when the candidate set cannot be built", async () => {
    // The seam must never fail a spawn either: the DB read or the
    // measurement throws BEFORE the policy is reached, and a placement
    // decision that cannot be made is not a reason to refuse the work.
    const spy = vi.spyOn(listHostsModule, "listHosts").mockImplementation(() => {
      throw new Error("the database is on fire");
    });
    try {
      const decision = resolvePlacement(app, {
        project: { hostId: "local", placement: "auto", cwd: LOCAL_CWD },
        unattended: true,
      });
      expect(decision.hostId).toBe("local");
      expect(decision.fellBack).toBe(true);
      expect(decision.reason).toMatch(/could not be evaluated/);
    } finally {
      spy.mockRestore();
    }
  });

  it("a PINNED project never scores — it takes the project's own host", async () => {
    const hostId = await registerHost("idle-agent");
    app.hostHeartbeatTracker?.recordSuccess(hostId);
    app.hostCapacityTracker?.record(hostId, capacity(0.2, 8));

    const decision = resolvePlacement(app, {
      project: { hostId: "local", placement: "pinned", cwd: LOCAL_CWD },
      unattended: true,
    });
    expect(decision.hostId).toBe("local");
    expect(decision.considered).toEqual([]);
    expect(decision.fellBack).toBe(false);
    expect(decision.reason).toMatch(/pinned/);
  });
});

// Issue #1726 / roadmap 8.12 — the PREVIEW. It answers "where would a new
// session land right now, and why?" with the SAME decision the spawn path
// makes, so it cannot drift from reality — but it announces nothing, because
// no placement happened.
describe("previewPlacement — the same decision, announced to nobody (issue #1726)", () => {
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
    // sql.raw, NOT a plain string: drizzle's where() only accepts SQL, and
    // a raw string is bound as a PARAMETER — `where ?` with the text
    // "id != 'local'" is false in SQLite, so the old string form silently
    // deleted NOTHING and the per-test cleanup never happened.
    app.db.delete(hosts).where(sql.raw("id != 'local'")).run();
    app.hostCapacityTracker?.pruneMissing(new Set());
  });

  async function registerHost(name: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name, baseUrl: "http://127.0.0.1:1", token: "t" },
    });
    return res.json().id as string;
  }

  it("decides EXACTLY what resolvePlacement would decide", async () => {
    const hostId = await registerHost("idle-agent");
    app.hostHeartbeatTracker?.recordSuccess(hostId);
    app.hostCapacityTracker?.record(hostId, capacity(0.2, 8));

    // Issue #1724 — the project is on the remote host, so the remote host
    // is a candidate at all. The preview and the spawn path must agree on
    // WHICH host, and they only can if both are asked the same question.
    const project = {
      hostId: "local",
      placement: "auto",
      cwd: LOCAL_CWD,
      hostCwds: JSON.stringify({ [hostId]: REMOTE_CWD }),
    } as const;
    const announced = resolvePlacement(app, { project, unattended: true });
    const previewed = previewPlacement(app, { project, unattended: true });

    expect(previewed).toEqual(announced);
    expect(previewed.hostId).toBe(hostId);
  });

  it("answers the SAME way when the project is on no other host", async () => {
    const hostId = await registerHost("idle-agent");
    app.hostHeartbeatTracker?.recordSuccess(hostId);
    app.hostCapacityTracker?.record(hostId, capacity(0.2, 8));

    // The other half of the rule: a host the project is NOT on is not a
    // candidate, so both paths fall back to the project's own host — and
    // they must fall back the same way.
    const project = { hostId: "local", placement: "auto", cwd: LOCAL_CWD } as const;
    const announced = resolvePlacement(app, { project, unattended: true });
    const previewed = previewPlacement(app, { project, unattended: true });

    expect(previewed).toEqual(announced);
    expect(previewed.hostId).toBe("local");
  });

  it("announces NOTHING — a preview is not a placement", async () => {
    const hostId = await registerHost("idle-agent");
    app.hostHeartbeatTracker?.recordSuccess(hostId);
    app.hostCapacityTracker?.record(hostId, capacity(0.2, 8));

    const spy = vi.spyOn(app.log, "info");
    try {
      previewPlacement(app, {
        project: { hostId: "local", placement: "auto" },
        unattended: true,
      });
      const messages = spy.mock.calls.map((call) => call[1]);
      expect(messages).not.toContain("placement: chose a host");
      expect(messages).not.toContain("placement: pinned to the project's host");
    } finally {
      spy.mockRestore();
    }
  });

  it("announces nothing for a PINNED project either", async () => {
    const spy = vi.spyOn(app.log, "info");
    try {
      const decision = previewPlacement(app, {
        project: { hostId: "local", placement: "pinned" },
      });
      expect(decision.hostId).toBe("local");
      expect(decision.reason).toMatch(/pinned/);
      const messages = spy.mock.calls.map((call) => call[1]);
      expect(messages).not.toContain("placement: pinned to the project's host");
    } finally {
      spy.mockRestore();
    }
  });

  it("falls back to the project's host when the candidate set cannot be built", async () => {
    const spy = vi.spyOn(listHostsModule, "listHosts").mockImplementation(() => {
      throw new Error("the database is on fire");
    });
    try {
      const decision = previewPlacement(app, {
        project: { hostId: "local", placement: "auto" },
      });
      expect(decision.hostId).toBe("local");
      expect(decision.fellBack).toBe(true);
      expect(decision.reason).toMatch(/could not be evaluated/);
    } finally {
      spy.mockRestore();
    }
  });

  it("answers for a project that does not exist yet (the create modal's preview)", async () => {
    // The preview takes the would-be host and mode, so the create-project
    // modal can ask BEFORE the row is saved.
    const decision = previewPlacement(app, {
      project: { hostId: "local", placement: "auto" },
    });
    expect(decision.hostId).toBe("local");
    expect(decision.considered.length).toBeGreaterThan(0);
  });
});
