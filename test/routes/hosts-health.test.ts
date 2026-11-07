import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { hosts } from "../../src/db/schema.js";
import { DEGRADED_AFTER_BUSY } from "../../src/services/host-heartbeat.js";

const tmpDb = path.join(os.tmpdir(), `hosts-health-test-${process.pid}.db`);

// What the Settings hosts panel reads: the "test connection" ping and the
// health fields on the host list (#2702).
describe("hosts route: ping and health (issue #2702)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  async function addHost(app: Awaited<ReturnType<typeof buildApp>>, name: string) {
    const created = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name, baseUrl: "http://127.0.0.1:1", token: "t" },
    });
    return created.json().id as string;
  }

  it("reports offline, not 500, for a host whose stored URL the policy now refuses", async () => {
    const app = await buildApp();
    const id = await addHost(app, "box-6");
    // baseUrl is re-read on every call, so a row edited after registration
    // (or one the policy has since tightened against) reaches the probe.
    app.db.update(hosts).set({ baseUrl: "http://169.254.169.254" }).where(eq(hosts.id, id)).run();

    const res = await app.inject({ method: "POST", url: `/api/hosts/${id}/ping` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ online: false });

    await app.close();
  });

  it("lists the reason a saturated host is degraded", async () => {
    const app = await buildApp();
    const id = await addHost(app, "box-7");
    // Past DEGRADED_AFTER_BUSY sweeps in a row the host is degraded, for a reason.
    app.hostHeartbeatTracker!.recordSuccess(id);
    for (let i = 0; i < DEGRADED_AFTER_BUSY; i++) app.hostHeartbeatTracker!.recordBusy(id);

    const list = await app.inject({ method: "GET", url: "/api/hosts" });
    const row = (
      list.json() as Array<{ id: string; health: string; healthReason: string | null }>
    ).find((h) => h.id === id)!;
    expect(row.health).toBe("degraded");
    expect(row.healthReason).toBe("channel saturated");

    await app.close();
  });
});
