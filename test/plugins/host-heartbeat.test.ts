import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import net from "node:net";

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

  it("does not double-count a still-in-flight sweep as multiple misses (Hermes review, PR #524)", async () => {
    // A TCP server that accepts connections but never responds — the ping
    // hangs until RemoteHostClient's own 5s request timeout fires,
    // simulating a slow/hung agent so overlapping ticks
    // (HOST_HEARTBEAT_INTERVAL_SECONDS=1 here, well under that 5s) have a
    // real opportunity to race absent the sweep's reentrancy guard.
    const server = net.createServer(() => {
      // Deliberately never writes or ends — holds the connection open.
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected a real bound address");
    }

    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "slow-host", baseUrl: `http://127.0.0.1:${address.port}`, token: "t" },
    });
    const { id } = created.json();

    // Anchor on the first real result instead of a fixed absolute sleep —
    // less sensitive to scheduling jitter between test start and the first
    // tick firing. The first sweep's ping times out after ~5s (bounded by
    // RemoteHostClient's REQUEST_TIMEOUT_MS), so this is the first miss.
    await waitUntil(() => app.hostHeartbeatTracker?.getHealth(id).status !== "pending", 8000);
    expect(app.hostHeartbeatTracker?.getHealth(id).status).toBe("degraded");

    // Without the guard, ticks at t=1/2/3s each start their own
    // independent ping, so a 2nd and 3rd miss land within ~1-2s of the
    // first (each of those pings started only 1-2s later, so times out
    // only 1-2s later) — reaching "offline" almost immediately after this
    // point. With the guard, only one sweep runs at a time, so the next
    // miss can't land until a full ~5s ping cycle after this one, well
    // outside this window — the 3s wait discriminates the two outcomes
    // without needing to predict exactly when either miss lands.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(app.hostHeartbeatTracker?.getHealth(id).status).toBe("degraded");

    server.close();
    await app.close();
  }, 20000);
});
