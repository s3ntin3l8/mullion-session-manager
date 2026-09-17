import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
// Must come before any import below that could itself trigger loading
// "node-pty"/"node:child_process" — see mock-pty.ts's header comment for the
// empirically confirmed hoisting/ordering failure mode.
import { createNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import type * as ChildProcess from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildTestApp } from "../helpers/app.js";
import { closeDb } from "../../src/db/client.js";

// A device's spawn() bootstraps a real systemd-run scope the same way a
// session's master does — faked here for the same reason
// test/routes/sessions.test.ts fakes it (AGENTS.md's "a test must never let
// a real systemd-run fire" invariant, issue #1137). This file never awaits
// spawn() to actually finish (it's fire-and-forget from getOrCreate, per
// device-manager.ts's own doc comment) — every test here asserts the
// route/DB layer's own immediate behavior, not a real adb/scrcpy boot,
// which needs live hardware this suite has no access to.
const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return mockChildProcessSpawn(actual);
});

const tmpDb = path.join(os.tmpdir(), `devices-test-${process.pid}.db`);

describe("devices routes", () => {
  beforeEach(() => {
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.DEVICE_ENABLED;
  });

  describe("with DEVICE_ENABLED unset (default off)", () => {
    it("POST /api/devices rejects with 400", async () => {
      const app = await buildTestApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/devices",
        payload: { avdName: "dev35" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("GET /api/devices still returns 200 (an empty live map is a valid answer)", async () => {
      const app = await buildTestApp();
      const res = await app.inject({ method: "GET", url: "/api/devices" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });

    it("GET /api/devices/:id 404s for a nonexistent row", async () => {
      const app = await buildTestApp();
      const res = await app.inject({ method: "GET", url: "/api/devices/999" });
      expect(res.statusCode).toBe(404);
    });

    it("POST /api/devices/:id/action rejects with 400 regardless of row existence", async () => {
      const app = await buildTestApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/devices/1/action",
        payload: { action: "screenshot" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("with DEVICE_ENABLED=true", () => {
    beforeEach(() => {
      process.env.DEVICE_ENABLED = "true";
    });

    it("POST /api/devices creates a row and returns 201 with the expected shape", async () => {
      const app = await buildTestApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/devices",
        payload: { avdName: "dev35", name: "My Emulator" },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({
        avdName: "dev35",
        name: "My Emulator",
        status: "active",
        hostId: "local",
        projectId: null,
      });
      expect(typeof body.id).toBe("number");
    });

    it("GET /api/devices lists a created row", async () => {
      const app = await buildTestApp();
      await app.inject({ method: "POST", url: "/api/devices", payload: { avdName: "dev35" } });
      const res = await app.inject({ method: "GET", url: "/api/devices" });
      expect(res.statusCode).toBe(200);
      const rows = res.json();
      expect(rows).toHaveLength(1);
      expect(rows[0].avdName).toBe("dev35");
    });

    it("DELETE /api/devices/:id flips status to killed and returns 204", async () => {
      const app = await buildTestApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/devices",
        payload: { avdName: "dev35" },
      });
      const id = created.json().id;

      const del = await app.inject({ method: "DELETE", url: `/api/devices/${id}` });
      expect(del.statusCode).toBe(204);

      const got = await app.inject({ method: "GET", url: `/api/devices/${id}` });
      expect(got.json().status).toBe("killed");
    });

    it("DELETE /api/devices/:id 404s for a nonexistent row", async () => {
      const app = await buildTestApp();
      const res = await app.inject({ method: "DELETE", url: "/api/devices/999" });
      expect(res.statusCode).toBe(404);
    });

    it("POST /api/devices/:id/action 400s when the device has no live adb connection yet", async () => {
      const app = await buildTestApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/devices",
        payload: { avdName: "dev35" },
      });
      const id = created.json().id;

      const res = await app.inject({
        method: "POST",
        url: `/api/devices/${id}/action`,
        payload: { action: "screenshot" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/no live adb connection/);
    });

    it("POST /api/devices/:id/action rejects an invalid action body", async () => {
      const app = await buildTestApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/devices",
        payload: { avdName: "dev35" },
      });
      const id = created.json().id;

      const res = await app.inject({
        method: "POST",
        url: `/api/devices/${id}/action`,
        payload: { action: "not-a-real-action" },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
