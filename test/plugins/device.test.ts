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
import { buildTestApp } from "../helpers/app.js";
import { closeDb } from "../../src/db/client.js";
import { isDevicePanelSupported } from "../../src/services/device-manager.js";

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

  describe("isDevicePanelSupported", () => {
    it("is true on linux — the platform the panel's scope mechanism exists on", () => {
      expect(isDevicePanelSupported("linux")).toBe(true);
    });

    it("is false on darwin — there is no systemd scope to put an emulator in", () => {
      expect(isDevicePanelSupported("darwin")).toBe(false);
    });

    it("is false on windows, which has no supported primary at all", () => {
      expect(isDevicePanelSupported("win32")).toBe(false);
    });
  });

  describe("on a platform the panel does not support (darwin)", () => {
    it("keeps the panel off even with DEVICE_ENABLED=true, and says WHY", async () => {
      await withPlatform("darwin", async () => {
        process.env.DEVICE_ENABLED = "true";
        const app = await buildTestApp();
        try {
          await app.ready();
          expect(app.devicePanelEnabled).toBe(false);
          expect(app.devicePanelSupported).toBe(false);
          expect(app.devicePanelUnavailableMessage).toMatch(/not supported on darwin/);
          // The platform reason DOMINATES: telling the operator to set
          // DEVICE_ENABLED=true would send them off to change a .env and
          // restart for nothing.
          expect(app.devicePanelUnavailableMessage).not.toMatch(/set DEVICE_ENABLED=true/);
        } finally {
          await app.close();
        }
      });
    });

    it("answers the device routes with 400 and the platform message — not a 500", async () => {
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

    it("answers the AVD and system-image routes with the same reason", async () => {
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

    it("reports the panel as unavailable in server-info, so the UI hides it", async () => {
      await withPlatform("darwin", async () => {
        process.env.DEVICE_ENABLED = "true";
        const app = await buildTestApp();
        try {
          const res = await app.inject({ method: "GET", url: "/api/server-info" });
          expect(res.statusCode).toBe(200);
          expect(res.json().features.devices).toBe(false);
        } finally {
          await app.close();
        }
      });
    });

    it("does not bind the mDNS scanner — the panel's companion stays off too", async () => {
      await withPlatform("darwin", async () => {
        process.env.DEVICE_ENABLED = "true";
        const app = await buildTestApp();
        try {
          await app.ready();
          // The discovery service is constructed disabled, so it never builds
          // a Bonjour instance and never binds a multicast socket.
          expect(app.deviceDiscovery.getDiscovered()).toEqual([]);
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
