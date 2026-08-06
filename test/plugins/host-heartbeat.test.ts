import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Exercises the real background timer wiring end-to-end (plugin -> service
// -> a genuine unreachable-host ping) — test/routes/hosts.test.ts covers
// the GET /api/hosts merge logic directly against the tracker, which is
// faster and doesn't depend on timer scheduling.
const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { hosts } = await import("../../src/db/schema.js");

const tmpDb = path.join(os.tmpdir(), `host-heartbeat-plugin-test-${process.pid}.db`);

async function waitUntil(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition never became true");
}

describe("hostHeartbeatPlugin: real sweep wiring (issue #246)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.MULLION_ROLE = "primary";
    process.env.HOST_HEARTBEAT_INTERVAL_SECONDS = "1";
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_ROLE;
    delete process.env.HOST_HEARTBEAT_INTERVAL_SECONDS;
  });

  it("degrades an unreachable host's health via the real background timer, with no manual ping", async () => {
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "unreachable", baseUrl: "http://127.0.0.1:1", token: "t" },
    });
    const { id } = created.json();

    await waitUntil(() => app.hostHeartbeatTracker?.getHealth(id).status === "degraded");

    await app.close();
  });

  it("never pings a host with no baseUrl yet (#245's future pending-enrollment state)", async () => {
    const app = await buildApp();
    // onReady (which decorates app.hostHeartbeatTracker) only fires once
    // the app is actually readied — app.inject()/listen() trigger it
    // implicitly, a bare buildApp() does not.
    await app.ready();
    // Simulates a #245 enrollment-created row awaiting its first
    // registration call. Inserted directly — POST /api/hosts requires a
    // baseUrl today (routes/hosts.ts's schema), so this reaches straight
    // into the DB the way #245's future enrollHost() will.
    const [row] = app.db
      .insert(hosts)
      .values({ id: "pending-heartbeat-host", name: "pending-host", baseUrl: null })
      .returning()
      .all();

    // Long enough for several real sweep ticks (1s interval) to have run.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(app.hostHeartbeatTracker?.getHealth(row.id).status).toBe("pending");

    await app.close();
  });
});
