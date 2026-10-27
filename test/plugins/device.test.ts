import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
// Must come before any import below that could itself trigger loading
// "node-pty"/"node:child_process" — see test/helpers/mock-pty.ts's header
// comment for the empirically confirmed hoisting/ordering failure mode.
// The device manager's constructor spawns `adb start-server` when the panel
// is enabled, and its scope paths shell out to systemd-run — a test must
// never let a real one fire (AGENTS.md, issue #1137's mocking invariant).
import { createNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import type * as ChildProcess from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildTestApp, warmSqliteBinding } from "../helpers/app.js";
import { closeDb } from "../../src/db/client.js";
import { devices } from "../../src/db/schema.js";
import {
  deviceCapabilities,
  isDeviceKindSupported,
  isDevicePanelSupported,
} from "../../src/services/device-manager.js";

const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return mockChildProcessSpawn(actual);
});

const tmpDb = path.join(os.tmpdir(), `device-panel-gate-test-${process.pid}.db`);

/**
 * Runs the test body with `process.platform` stubbed.
 *
 * The same technique test/services/scope.test.ts uses for its darwin case
 * (issue #1715's platform seam): the platform is a property of the HOST,
 * and a test that could only ever run on one platform could not show that
 * the gate works on the other. The stub covers the whole body because
 * Fastify defers a plugin's function to `app.ready()` — and `app.inject()`
 * is what triggers that — so the platform must still be stubbed when the
 * request is made, not only when the app was built.
 */
async function withPlatform<T>(platform: NodeJS.Platform, body: () => Promise<T>): Promise<T> {
  // The native SQLite binding must be loaded BEFORE the platform is stubbed:
  // better-sqlite3 resolves its prebuild lazily, in the Database constructor,
  // and that loader reads process.platform — so a stubbed platform would make
  // it try the WRONG platform's .node file (a Linux binary on macOS, a
  // Darwin binary on CI). The binding is memoized, so loading it once here
  // makes the stub safe. See warmSqliteBinding()'s own doc comment.
  await warmSqliteBinding();
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return await body();
  } finally {
    Object.defineProperty(process, "platform", { value: original, configurable: true });
  }
}

describe("device panel platform gate (issue #1720, roadmap 8.6)", () => {
  beforeEach(() => {
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.DEVICE_ENABLED;
  });

  describe("device capabilities per platform", () => {
    it("linux can run both physical and emulator devices", () => {
      expect(isDevicePanelSupported("linux")).toBe(true);
      expect(isDeviceKindSupported("physical", "linux")).toBe(true);
      expect(isDeviceKindSupported("emulator", "linux")).toBe(true);
    });

    it("darwin is physical-only — an emulator needs a device scope it does not have yet", () => {
      expect(isDevicePanelSupported("darwin")).toBe(true);
      expect(isDeviceKindSupported("physical", "darwin")).toBe(true);
      expect(isDeviceKindSupported("emulator", "darwin")).toBe(false);
      expect([...deviceCapabilities("darwin")]).toEqual(["physical"]);
    });

    it("windows has no capability at all — the whole panel is off", () => {
      expect(isDevicePanelSupported("win32")).toBe(false);
      expect(deviceCapabilities("win32").size).toBe(0);
    });
  });

  describe("on a platform with physical devices only (darwin)", () => {
    it("turns the panel on with DEVICE_ENABLED=true but keeps emulators off, and says WHY", async () => {
      await withPlatform("darwin", async () => {
        process.env.DEVICE_ENABLED = "true";
        const app = await buildTestApp();
        try {
          await app.ready();
          expect(app.devicePanelEnabled).toBe(true);
          expect(app.deviceEmulatorSupported).toBe(false);
          expect(app.deviceEmulatorEnabled).toBe(false);
          expect(app.deviceKinds).toEqual(["physical"]);
          expect(app.deviceEmulatorUnavailableMessage).toMatch(/not supported on darwin/);
          // The platform reason DOMINATES: telling the operator to set
          // DEVICE_ENABLED=true would send them off to change a .env and
          // restart for nothing.
          expect(app.deviceEmulatorUnavailableMessage).not.toMatch(/set DEVICE_ENABLED=true/);
        } finally {
          await app.close();
        }
      });
    });

    it("rejects an unknown kind instead of letting it fall through to the emulator path", async () => {
      await withPlatform("darwin", async () => {
        process.env.DEVICE_ENABLED = "true";
        const app = await buildTestApp();
        try {
          const res = await app.inject({
            method: "POST",
            url: "/api/devices",
            payload: { kind: "bogus", avdName: "dev35" },
          });
          expect(res.statusCode).toBe(400);
          expect(res.json().message).toMatch(/kind must be/);
        } finally {
          await app.close();
        }
      });
    });

    it("refuses to start an emulator row and to open its stream", async () => {
      await withPlatform("darwin", async () => {
        process.env.DEVICE_ENABLED = "true";
        const app = await buildTestApp();
        try {
          // Rows as a DB carried over from a Linux host would hold them.
          const [emu] = app.db
            .insert(devices)
            .values({ kind: "emulator", avdName: "dev35", status: "active" })
            .returning()
            .all();
          const start = await app.inject({ method: "POST", url: `/api/devices/${emu.id}/start` });
          expect(start.statusCode).toBe(400);
          expect(start.json().message).toMatch(/Emulator devices are not supported on darwin/);
          const ws = await app.inject({ method: "GET", url: `/ws/device/${emu.id}` });
          expect(ws.statusCode).toBe(400);
          expect(ws.json().message).toMatch(/Emulator devices are not supported on darwin/);
          // The WS routes of the AVD provisioning surface carry the same gate.
          expect(app.deviceEmulatorSupported).toBe(false);
        } finally {
          await app.close();
        }
      });
    });

    it("leaves pairing open — it is physical-only and needs no scope", async () => {
      await withPlatform("darwin", async () => {
        process.env.DEVICE_ENABLED = "true";
        const app = await buildTestApp();
        try {
          const res = await app.inject({
            method: "POST",
            url: "/api/devices/pair",
            payload: { pairingAddress: "nope", pairingCode: "123456" },
          });
          expect(res.statusCode).toBe(400);
          expect(res.json().message).toMatch(/pairingAddress must be host:port/);
        } finally {
          await app.close();
        }
      });
    });

    it("refuses an emulator create with 400 and the platform message — not a 500", async () => {
      await withPlatform("darwin", async () => {
        process.env.DEVICE_ENABLED = "true";
        const app = await buildTestApp();
        try {
          const res = await app.inject({
            method: "POST",
            url: "/api/devices",
            payload: { avdName: "dev35" },
          });
          expect(res.statusCode).toBe(400);
          expect(res.json().message).toMatch(/not supported on darwin/);
        } finally {
          await app.close();
        }
      });
    });

    it("lets a physical create past the gate — it fails on the body, not the platform", async () => {
      await withPlatform("darwin", async () => {
        process.env.DEVICE_ENABLED = "true";
        const app = await buildTestApp();
        try {
          const res = await app.inject({
            method: "POST",
            url: "/api/devices",
            payload: { kind: "physical", address: "not-an-address" },
          });
          expect(res.statusCode).toBe(400);
          expect(res.json().message).toMatch(/address must be host:port/);
          expect(res.json().message).not.toMatch(/not supported/);
        } finally {
          await app.close();
        }
      });
    });

    it("answers the AVD and system-image routes with the emulator reason", async () => {
      await withPlatform("darwin", async () => {
        process.env.DEVICE_ENABLED = "true";
        const app = await buildTestApp();
        try {
          for (const url of ["/api/avds", "/api/system-images", "/api/system-images/available"]) {
            const res = await app.inject({ method: "GET", url });
            expect(res.statusCode, url).toBe(400);
            expect(res.json().message, url).toMatch(/not supported on darwin/);
          }
        } finally {
          await app.close();
        }
      });
    });

    it("reports devices on and the physical-only kind list in server-info, so the UI hides emulators", async () => {
      await withPlatform("darwin", async () => {
        process.env.DEVICE_ENABLED = "true";
        const app = await buildTestApp();
        try {
          const res = await app.inject({ method: "GET", url: "/api/server-info" });
          expect(res.statusCode).toBe(200);
          expect(res.json().features.devices).toBe(true);
          expect(res.json().features.deviceKinds).toEqual(["physical"]);
        } finally {
          await app.close();
        }
      });
    });
  });

  describe("mDNS discovery follows the panel, not the emulator capability", () => {
    it("is wired on darwin, where the physical half works", async () => {
      await withPlatform("darwin", async () => {
        process.env.DEVICE_ENABLED = "true";
        const app = await buildTestApp();
        try {
          await app.ready();
          const info = await app.inject({ method: "GET", url: "/api/server-info" });
          expect(info.json().features.devices).toBe(true);
          expect(app.deviceDiscovery).toBeDefined();
        } finally {
          await app.close();
        }
      });
    });
  });

  describe("on a platform with no device support (win32)", () => {
    it("keeps the whole panel off even with DEVICE_ENABLED=true, and says WHY", async () => {
      await withPlatform("win32", async () => {
        process.env.DEVICE_ENABLED = "true";
        const app = await buildTestApp();
        try {
          await app.ready();
          expect(app.devicePanelEnabled).toBe(false);
          expect(app.devicePanelSupported).toBe(false);
          expect(app.deviceKinds).toEqual([]);
          expect(app.devicePanelUnavailableMessage).toMatch(/not supported on win32/);
          expect(app.devicePanelUnavailableMessage).not.toMatch(/set DEVICE_ENABLED=true/);
          const res = await app.inject({
            method: "POST",
            url: "/api/devices",
            payload: { kind: "physical", address: "10.0.0.2:5555" },
          });
          expect(res.statusCode).toBe(400);
          expect(res.json().message).toMatch(/not supported on win32/);
          const info = await app.inject({ method: "GET", url: "/api/server-info" });
          expect(info.json().features.devices).toBe(false);
          expect(info.json().features.deviceKinds).toEqual([]);
        } finally {
          await app.close();
        }
      });
    });
  });

  describe("on a platform the panel does support (linux)", () => {
    it("follows DEVICE_ENABLED exactly, as before the gate", async () => {
      await withPlatform("linux", async () => {
        const app = await buildTestApp();
        try {
          await app.ready();
          // The flag is off by default: the panel is off, and the message is
          // the CONFIG one — the platform supports it, so setting the flag
          // is the right advice.
          expect(app.devicePanelEnabled).toBe(false);
          expect(app.devicePanelSupported).toBe(true);
          expect(app.devicePanelUnavailableMessage).toMatch(/set DEVICE_ENABLED=true/);
          expect(app.devicePanelUnavailableMessage).not.toMatch(/not supported/);
        } finally {
          await app.close();
        }
      });
    });

    it("enables the panel when DEVICE_ENABLED=true", async () => {
      await withPlatform("linux", async () => {
        process.env.DEVICE_ENABLED = "true";
        const app = await buildTestApp();
        try {
          await app.ready();
          expect(app.devicePanelEnabled).toBe(true);
        } finally {
          await app.close();
        }
      });
    });

    it("keeps answering the device routes with the CONFIG message when the flag is off", async () => {
      await withPlatform("linux", async () => {
        const app = await buildTestApp();
        try {
          const res = await app.inject({
            method: "POST",
            url: "/api/devices",
            payload: { avdName: "dev35" },
          });
          expect(res.statusCode).toBe(400);
          expect(res.json().message).toMatch(/Device panel is disabled/);
        } finally {
          await app.close();
        }
      });
    });
  });
});
