import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { DEFAULT_SETTINGS } from "../../src/services/settings.js";

const tmpDb = path.join(os.tmpdir(), `settings-test-${process.pid}.db`);

describe("settings route", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("returns DEFAULT_SETTINGS before any row exists", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/settings" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.json()).toEqual(DEFAULT_SETTINGS);
    await app.close();
  });

  it("deep-merges a partial nested PATCH onto defaults, leaving siblings untouched", async () => {
    const app = await buildApp();

    const patched = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { terminal: { fontSize: 18 } },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.headers["content-type"]).toMatch(/^application\/json/);
    const body = patched.json();
    expect(body.terminal.fontSize).toBe(18);
    // Siblings of fontSize inside terminal must survive untouched.
    expect(body.terminal.cursorStyle).toBe(DEFAULT_SETTINGS.terminal.cursorStyle);
    expect(body.terminal.fontFamily).toBe(DEFAULT_SETTINGS.terminal.fontFamily);
    // Top-level siblings of `terminal` must survive untouched too.
    expect(body.theme).toBe(DEFAULT_SETTINGS.theme);

    const fetched = await app.inject({ method: "GET", url: "/api/settings" });
    expect(fetched.json().terminal.fontSize).toBe(18);

    await app.close();
  });

  it("replaces arrays outright rather than merging element-wise", async () => {
    const app = await buildApp();

    await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { projectRoots: ["~/work", "~/fun"] },
    });
    const cleared = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { projectRoots: [] },
    });
    expect(cleared.json().projectRoots).toEqual([]);

    await app.close();
  });

  it("accumulates across independent PATCHes to different nested fields", async () => {
    const app = await buildApp();

    await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { theme: "light" },
    });
    const second = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { sessions: { hideEndedSessions: true } },
    });

    expect(second.json()).toMatchObject({
      theme: "light",
      sessions: expect.objectContaining({ hideEndedSessions: true }),
    });

    await app.close();
  });

  it("rejects a non-object PATCH body", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: JSON.stringify(["not", "an", "object"]),
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("falls back to the default reconcile interval instead of persisting a busy-loop value", async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { sessions: { reconcileIntervalSeconds: 0 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sessions.reconcileIntervalSeconds).toBe(
      DEFAULT_SETTINGS.sessions.reconcileIntervalSeconds,
    );

    const fetched = await app.inject({ method: "GET", url: "/api/settings" });
    expect(fetched.json().sessions.reconcileIntervalSeconds).toBe(
      DEFAULT_SETTINGS.sessions.reconcileIntervalSeconds,
    );

    await app.close();
  });

  it("falls back to the default idle threshold when patched with a non-number", async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { notifications: { idleThresholdSeconds: "soon" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().notifications.idleThresholdSeconds).toBe(
      DEFAULT_SETTINGS.notifications.idleThresholdSeconds,
    );

    await app.close();
  });
});
