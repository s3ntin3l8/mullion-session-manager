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
import { eq } from "drizzle-orm";
import { buildTestApp } from "../helpers/app.js";
import { closeDb } from "../../src/db/client.js";
import { devices } from "../../src/db/schema.js";

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

    it("POST /api/devices/pair rejects with 400", async () => {
      const app = await buildTestApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/devices/pair",
        payload: { pairingAddress: "192.168.1.23:41234", pairingCode: "123456" },
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

    it("POST /api/devices persists the allocated port on the row via onPortAssigned (issue #1325's reattach durability)", async () => {
      const app = await buildTestApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/devices",
        payload: { avdName: "dev35" },
      });
      const id = created.json().id;

      // onPortAssigned fires synchronously at the very start of spawn(),
      // before the fire-and-forget systemd-run bootstrap even starts (see
      // that field's own comment in device-manager.ts) — already reflected
      // in the row by the time getOrCreate() (awaited by this route) has
      // returned, not just eventually.
      const [row] = app.db.select().from(devices).where(eq(devices.id, id)).all();
      expect(typeof row.port).toBe("number");
    });

    it("a fresh spawn() on a NEW app instance (simulating a Mullion restart) skips a port persisted by a still-active, not-yet-reattached row (issue #1328)", async () => {
      // Plain buildApp(), not buildTestApp() — this test closes app1 itself,
      // mid-test, to force devicePlugin's own DeviceManager construction on
      // app2 to start from a genuinely empty `allocatedPorts` (see
      // buildTestApp's own header on why manual closes use buildApp
      // directly, e.g. test/routes/actions.test.ts). Imported dynamically,
      // not as a top-level static import — see mock-pty.ts's own header on
      // why a static import of anything that transitively loads "node-pty"
      // must never land above this file's own vi.mock("node:child_process",
      // ...) factory in evaluation order.
      const { buildApp } = await import("../../src/app.js");
      const app1 = await buildApp();
      const created = await app1.inject({
        method: "POST",
        url: "/api/devices",
        payload: { avdName: "dev35" },
      });
      const [row] = app1.db.select().from(devices).where(eq(devices.id, created.json().id)).all();
      const survivingPort = row.port;
      expect(typeof survivingPort).toBe("number");

      // Simulate a restart: close WITHOUT ever calling DELETE — the row
      // stays `status: "active"` with its port persisted, and (crucially)
      // nobody calls getOrCreate() for this id again, so reservePort()
      // never fires for it on the next app's manager either.
      await app1.close();

      const app2 = await buildApp();
      // devicePlugin's construction-time read (src/plugins/device.ts) must
      // have already reserved `survivingPort` on app2's DeviceManager
      // BEFORE this second, unrelated device's own allocatePort() call.
      const secondCreated = await app2.inject({
        method: "POST",
        url: "/api/devices",
        payload: { avdName: "dev35" },
      });
      const [secondRow] = app2.db
        .select()
        .from(devices)
        .where(eq(devices.id, secondCreated.json().id))
        .all();
      expect(secondRow.port).not.toBe(survivingPort);

      await app2.close();
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

    it("POST /api/devices rejects when avdName is missing", async () => {
      const app = await buildTestApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/devices",
        payload: { name: "no-avd" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain("avdName is required");
    });

    it("POST /api/devices rejects when getOrCreate throws", async () => {
      const app = await buildTestApp();
      vi.spyOn(app.device, "getOrCreate").mockRejectedValueOnce(new Error("boot failure"));
      const res = await app.inject({
        method: "POST",
        url: "/api/devices",
        payload: { avdName: "dev35" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain("boot failure");
    });

    it("GET /api/devices/:id rejects non-integer id with 400", async () => {
      const app = await buildTestApp();
      const res = await app.inject({ method: "GET", url: "/api/devices/abc" });
      expect(res.statusCode).toBe(400);
    });

    it("GET /api/devices/:id returns device info for valid row", async () => {
      const app = await buildTestApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/devices",
        payload: { avdName: "dev35", name: "Dev" },
      });
      const id = created.json().id;
      const res = await app.inject({ method: "GET", url: `/api/devices/${id}` });
      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe(id);
    });

    it("DELETE /api/devices/:id rejects non-integer id with 400", async () => {
      const app = await buildTestApp();
      const res = await app.inject({ method: "DELETE", url: "/api/devices/abc" });
      expect(res.statusCode).toBe(400);
    });

    it("POST /api/devices/:id/action rejects non-integer id with 400 and nonexistent with 404", async () => {
      const app = await buildTestApp();
      const res1 = await app.inject({
        method: "POST",
        url: "/api/devices/abc/action",
        payload: { action: "screenshot" },
      });
      expect(res1.statusCode).toBe(400);

      const res2 = await app.inject({
        method: "POST",
        url: "/api/devices/999/action",
        payload: { action: "screenshot" },
      });
      expect(res2.statusCode).toBe(404);
    });

    describe("action execution against live adbConnection", () => {
      it("executes screenshot, tap, swipe, text, key, and logcat actions", async () => {
        const app = await buildTestApp();
        const created = await app.inject({
          method: "POST",
          url: "/api/devices",
          payload: { avdName: "dev35" },
        });
        const id = created.json().id;
        const device = app.device.get(String(id))!;

        const spawnWait = vi.fn().mockResolvedValue(Buffer.from("fake-png"));
        const spawnWaitText = vi.fn().mockResolvedValue("log output");
        (device as unknown as { adb: unknown }).adb = {
          subprocess: {
            noneProtocol: {
              spawnWait,
              spawnWaitText,
            },
          },
        };
        // "text" goes through the scrcpy control channel, not the adb shell
        // (Hermes review — see routes/devices.ts's own shellQuoteArg
        // comment) — `controller` is a getter derived from `scrcpyClient`.
        const injectText = vi.fn().mockResolvedValue(undefined);
        (device as unknown as { scrcpyClient: unknown }).scrcpyClient = {
          controller: { injectText },
        };

        // Screenshot
        const rScreen = await app.inject({
          method: "POST",
          url: `/api/devices/${id}/action`,
          payload: { action: "screenshot" },
        });
        expect(rScreen.statusCode).toBe(200);
        expect(rScreen.json().screenshot).toBe(Buffer.from("fake-png").toString("base64"));
        expect(spawnWait).toHaveBeenCalledWith(["'screencap'", "'-p'"]);

        // Tap
        const rTap = await app.inject({
          method: "POST",
          url: `/api/devices/${id}/action`,
          payload: { action: "tap", x: 10, y: 20 },
        });
        expect(rTap.statusCode).toBe(200);
        expect(rTap.json()).toEqual({ ok: true });
        expect(spawnWaitText).toHaveBeenCalledWith(["'input'", "'tap'", "'10'", "'20'"]);

        // Swipe (with duration)
        const rSwipe1 = await app.inject({
          method: "POST",
          url: `/api/devices/${id}/action`,
          payload: { action: "swipe", x1: 1, y1: 2, x2: 3, y2: 4, durationMs: 100 },
        });
        expect(rSwipe1.statusCode).toBe(200);
        expect(spawnWaitText).toHaveBeenCalledWith([
          "'input'",
          "'swipe'",
          "'1'",
          "'2'",
          "'3'",
          "'4'",
          "'100'",
        ]);

        // Swipe (without duration)
        const rSwipe2 = await app.inject({
          method: "POST",
          url: `/api/devices/${id}/action`,
          payload: { action: "swipe", x1: 5, y1: 6, x2: 7, y2: 8 },
        });
        expect(rSwipe2.statusCode).toBe(200);
        expect(spawnWaitText).toHaveBeenCalledWith([
          "'input'",
          "'swipe'",
          "'5'",
          "'6'",
          "'7'",
          "'8'",
        ]);

        // Text
        const rText = await app.inject({
          method: "POST",
          url: `/api/devices/${id}/action`,
          payload: { action: "text", text: "hello" },
        });
        expect(rText.statusCode).toBe(200);
        expect(injectText).toHaveBeenCalledWith("hello");

        // Key
        const rKey = await app.inject({
          method: "POST",
          url: `/api/devices/${id}/action`,
          payload: { action: "key", androidKeyCode: 4 },
        });
        expect(rKey.statusCode).toBe(200);
        expect(spawnWaitText).toHaveBeenCalledWith(["'input'", "'keyevent'", "'4'"]);

        // Logcat (default lines, no filter)
        const rLog1 = await app.inject({
          method: "POST",
          url: `/api/devices/${id}/action`,
          payload: { action: "logcat" },
        });
        expect(rLog1.statusCode).toBe(200);
        expect(rLog1.json()).toEqual({ logcat: "log output" });
        expect(spawnWaitText).toHaveBeenCalledWith(["'logcat'", "'-d'", "'-t'", "'200'"]);

        // Logcat (lines and filter)
        const rLog2 = await app.inject({
          method: "POST",
          url: `/api/devices/${id}/action`,
          payload: { action: "logcat", lines: 50, filter: "MyTag:D" },
        });
        expect(rLog2.statusCode).toBe(200);
        expect(spawnWaitText).toHaveBeenCalledWith([
          "'logcat'",
          "'-d'",
          "'-t'",
          "'50'",
          "'MyTag:D'",
        ]);
      });

      // Hermes follow-up review suggestion on PR #1324 — "a test that
      // captures the args a mocked spawnWaitText receives (or asserts a
      // shell-injecting `text` string stays a single quoted token) would
      // lock the security fix in." The values below are exactly what the
      // adb `exec:` transport re-tokenizes through the device's own shell
      // (`sh -c`) if left unescaped: a space re-splits the token, `;`/`$()`
      // execute, and an embedded `'` would otherwise terminate the quoting
      // early. shellQuoteArg's `'...'.replace(/'/g, "'\\''")` handles all
      // three — asserted here against the actual argv spawnWaitText
      // receives, not just against shellQuoteArg in isolation, so a
      // regression in how routes/devices.ts calls it is caught too.
      it("neutralizes shell metacharacters in the logcat filter via POSIX single-quote escaping", async () => {
        const app = await buildTestApp();
        const created = await app.inject({
          method: "POST",
          url: "/api/devices",
          payload: { avdName: "dev35" },
        });
        const id = created.json().id;
        const device = app.device.get(String(id))!;

        const spawnWaitText = vi.fn().mockResolvedValue("log output");
        (device as unknown as { adb: unknown }).adb = {
          subprocess: { noneProtocol: { spawnWaitText } },
        };

        const res = await app.inject({
          method: "POST",
          url: `/api/devices/${id}/action`,
          payload: { action: "logcat", filter: "MyTag:D; rm -rf / #$(whoami)'" },
        });
        expect(res.statusCode).toBe(200);
        expect(spawnWaitText).toHaveBeenCalledWith([
          "'logcat'",
          "'-d'",
          "'-t'",
          "'200'",
          // The embedded `'` closes and re-opens the quoted token
          // (`'\''`) rather than breaking out of it — the whole filter
          // still arrives at `sh -c` as ONE argument, never re-tokenized
          // into `;`/`$()` as separate shell commands.
          "'MyTag:D; rm -rf / #$(whoami)'\\'''",
        ]);
      });

      it("400s on a logcat action whose optional fields have the wrong type", async () => {
        const app = await buildTestApp();
        const created = await app.inject({
          method: "POST",
          url: "/api/devices",
          payload: { avdName: "dev35" },
        });
        const id = created.json().id;
        (app.device.get(String(id)) as unknown as { adb: unknown }).adb = {
          subprocess: { noneProtocol: { spawnWaitText: vi.fn() } },
        };

        const badLines = await app.inject({
          method: "POST",
          url: `/api/devices/${id}/action`,
          payload: { action: "logcat", lines: "200" },
        });
        expect(badLines.statusCode).toBe(400);

        const badFilter = await app.inject({
          method: "POST",
          url: `/api/devices/${id}/action`,
          payload: { action: "logcat", filter: 123 },
        });
        expect(badFilter.statusCode).toBe(400);
      });
    });

    describe("physical devices", () => {
      it("POST /api/devices with kind: physical creates a row with kind/serial persisted, avdName/port null", async () => {
        const app = await buildTestApp();
        const res = await app.inject({
          method: "POST",
          url: "/api/devices",
          payload: { kind: "physical", address: "192.168.1.23:37251", name: "My Pixel" },
        });
        expect(res.statusCode).toBe(201);
        const body = res.json();
        expect(body).toMatchObject({
          kind: "physical",
          serial: "192.168.1.23:37251",
          avdName: null,
          name: "My Pixel",
          status: "active",
        });

        const [row] = app.db.select().from(devices).where(eq(devices.id, body.id)).all();
        expect(row.port).toBeNull();
      });

      it("POST /api/devices with kind: physical rejects a malformed address", async () => {
        const app = await buildTestApp();
        const res = await app.inject({
          method: "POST",
          url: "/api/devices",
          payload: { kind: "physical", address: "not-an-address" },
        });
        expect(res.statusCode).toBe(400);
      });

      it("POST /api/devices with kind: physical rejects an out-of-range port", async () => {
        const app = await buildTestApp();
        const res = await app.inject({
          method: "POST",
          url: "/api/devices",
          payload: { kind: "physical", address: "192.168.1.23:99999" },
        });
        expect(res.statusCode).toBe(400);
      });

      it("POST /api/devices with kind: physical rejects a body that also sets avdName", async () => {
        const app = await buildTestApp();
        const res = await app.inject({
          method: "POST",
          url: "/api/devices",
          payload: { kind: "physical", address: "192.168.1.23:37251", avdName: "dev35" },
        });
        expect(res.statusCode).toBe(400);
      });

      it("POST /api/devices without kind: physical rejects a body that sets address", async () => {
        const app = await buildTestApp();
        const res = await app.inject({
          method: "POST",
          url: "/api/devices",
          payload: { avdName: "dev35", address: "192.168.1.23:37251" },
        });
        expect(res.statusCode).toBe(400);
      });

      it("POST /api/devices/pair delegates to app.device.pair with the validated address/code", async () => {
        const app = await buildTestApp();
        const pair = vi.spyOn(app.device, "pair").mockResolvedValueOnce(undefined);
        const res = await app.inject({
          method: "POST",
          url: "/api/devices/pair",
          payload: { pairingAddress: "192.168.1.23:41234", pairingCode: "123456" },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ ok: true });
        expect(pair).toHaveBeenCalledWith("192.168.1.23:41234", "123456");
      });

      it("POST /api/devices/pair rejects a malformed pairing code", async () => {
        const app = await buildTestApp();
        const res = await app.inject({
          method: "POST",
          url: "/api/devices/pair",
          payload: { pairingAddress: "192.168.1.23:41234", pairingCode: "12" },
        });
        expect(res.statusCode).toBe(400);
      });

      it("POST /api/devices/pair surfaces a pair() failure as 400", async () => {
        const app = await buildTestApp();
        vi.spyOn(app.device, "pair").mockRejectedValueOnce(new Error("bad pairing code"));
        const res = await app.inject({
          method: "POST",
          url: "/api/devices/pair",
          payload: { pairingAddress: "192.168.1.23:41234", pairingCode: "123456" },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().message).toContain("bad pairing code");
      });

      it("DELETE /api/devices/:id passes the row's own kind through to terminate() — not a hardcoded emulator assumption", async () => {
        const app = await buildTestApp();
        const created = await app.inject({
          method: "POST",
          url: "/api/devices",
          payload: { kind: "physical", address: "192.168.1.23:37251" },
        });
        const id = created.json().id;
        const terminate = vi.spyOn(app.device, "terminate").mockResolvedValueOnce(undefined);

        const res = await app.inject({ method: "DELETE", url: `/api/devices/${id}` });
        expect(res.statusCode).toBe(204);
        expect(terminate).toHaveBeenCalledWith(String(id), "physical");
      });
    });
  });
});
