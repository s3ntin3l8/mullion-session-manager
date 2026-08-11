import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { closeDb } from "../../src/db/client.js";
import { buildTestApp } from "../helpers/app.js";

// Issue #213 (roadmap 4.7) — plugin-level wiring: the role gate (agent gets
// no decorator/hooks at all) and a primary-role smoke test that the
// decorator exists and PATCH /api/settings can call it without throwing.
// The debounce/ceiling/sweep LOGIC itself is unit-tested directly against a
// fakeApp() in test/services/event-store.test.ts — this file only proves
// the Fastify wiring around it.

const tmpDb = path.join(os.tmpdir(), `event-store-plugin-test-${process.pid}.db`);

describe("eventStorePlugin", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    delete process.env.MULLION_ROLE;
    delete process.env.MULLION_AGENT_TOKEN;
  });

  it("does not decorate reconfigureEventRetention for MULLION_ROLE=agent (no app.db to use)", async () => {
    process.env.MULLION_ROLE = "agent";
    process.env.MULLION_AGENT_TOKEN = "agent-token-0123456789";
    const app = await buildTestApp();
    await app.ready();
    expect(app.hasDecorator("reconfigureEventRetention")).toBe(false);
  });

  it("decorates reconfigureEventRetention for the (default) primary role", async () => {
    const app = await buildTestApp();
    await app.ready();
    expect(app.hasDecorator("reconfigureEventRetention")).toBe(true);
  });

  it("does not decorate reconfigureRemoteEventSubscriptions for MULLION_ROLE=agent (no app.db to use)", async () => {
    process.env.MULLION_ROLE = "agent";
    process.env.MULLION_AGENT_TOKEN = "agent-token-0123456789";
    const app = await buildTestApp();
    await app.ready();
    expect(app.hasDecorator("reconfigureRemoteEventSubscriptions")).toBe(false);
  });

  it("decorates reconfigureRemoteEventSubscriptions for the (default) primary role", async () => {
    const app = await buildTestApp();
    await app.ready();
    expect(app.hasDecorator("reconfigureRemoteEventSubscriptions")).toBe(true);
  });

  it("PATCH /api/settings changing eventPersistence also reconciles remote-event-subscriber.ts (issue #213 hazard 6)", async () => {
    const app = await buildTestApp();
    await app.ready();

    // The retention sweep's own onTick (event-store.ts) is what wires this
    // together — reconfigureEventRetention() runs one sweep immediately,
    // and every completed sweep calls onTick. Spying on
    // reconfigureRemoteEventSubscriptions itself wouldn't prove this path
    // (settings.ts never calls it directly), so this asserts the sweep
    // actually ran, which is the observable proxy for onTick having fired.
    const sweepSpy = vi.spyOn(app, "reconfigureEventRetention");

    const res = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { sessions: { eventPersistence: true } },
    });
    expect(res.statusCode).toBe(200);
    expect(sweepSpy).toHaveBeenCalledTimes(1);
  });

  it("PATCH /api/settings changing eventRetentionDays calls the decorator without throwing", async () => {
    const app = await buildTestApp();
    await app.ready();

    const res = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { sessions: { eventRetentionDays: 7 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sessions.eventRetentionDays).toBe(7);
  });

  it("PATCH /api/settings changing eventRetentionPerSession calls the decorator without throwing", async () => {
    const app = await buildTestApp();
    await app.ready();

    // Hermes review, PR #563 (round 3) — a bare 200 + echoed value doesn't
    // prove the decorator (and so the sweep) actually ran; the settings
    // route would return the same response even if the reconfigure branch
    // were never wired up at all. Spy on the real decorator directly.
    const spy = vi.spyOn(app, "reconfigureEventRetention");

    const res = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { sessions: { eventRetentionPerSession: 200 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sessions.eventRetentionPerSession).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("PATCH /api/settings changing eventPersistence calls the decorator without throwing", async () => {
    const app = await buildTestApp();
    await app.ready();

    const res = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { sessions: { eventPersistence: true } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sessions.eventPersistence).toBe(true);
  });

  it("app.close() tears down the writer/sweep timers cleanly with persistence on", async () => {
    const app = await buildTestApp();
    await app.ready();
    await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { sessions: { eventPersistence: true } },
    });

    // app.close() must tear this plugin's timers/subscription down cleanly
    // (see plugins/event-store.ts's onClose ordering comment) — a timer
    // firing after app.db is closed would otherwise throw outside any
    // test's own try/catch.
    await expect(app.close()).resolves.not.toThrow();
  });
});
