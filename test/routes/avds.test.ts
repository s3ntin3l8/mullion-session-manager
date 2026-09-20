import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";
// Must come before any import below that could itself trigger loading
// "node-pty"/"node:child_process" — see test/helpers/mock-pty.ts's header
// comment for the empirically confirmed hoisting/ordering failure mode.
// DEVICE_ENABLED=true also constructs a DeviceManager (src/plugins/
// device.ts), which spawns `adb start-server` at construction — faked here
// for the same reason test/routes/devices.test.ts fakes it (AGENTS.md's "a
// test must never let a real systemd-run/spawn fire" invariant).
import { createNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import type * as ChildProcess from "node:child_process";

const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return mockChildProcessSpawn(actual);
});

// Mock the whole service, not the `avdmanager` binary — same reasoning as
// test/routes/opencode-models.test.ts's own header comment: these routes
// call the service functions directly (avds.ts has no plugin/decorator
// seam), and mocking the binary would make this suite depend on a real
// Android SDK being installed in CI.
vi.mock("../../src/services/avd-manager.js", () => ({
  listAvds: vi.fn(),
  listDeviceProfiles: vi.fn(),
  listInstalledSystemImages: vi.fn(),
  createAvd: vi.fn(),
  listAvailableSystemImages: vi.fn(),
  installSystemImage: vi.fn(),
  uninstallSystemImage: vi.fn(),
  acceptLicenses: vi.fn(),
  licensesMayBePending: vi.fn(),
}));

// buildTestApp (not a static `import { buildApp } from "../../src/app.js"`)
// — it dynamically `import()`s app.js at call time, inside each test body,
// which is what actually avoids the node-pty mock-hoisting/ordering trap
// mock-pty.ts's header warns about: a static import of app.js here would
// resolve (and evaluate) the whole app.js -> pty-manager.ts -> "node-pty"
// chain during THIS file's own module-linking phase, before `const ptyMock
// = createNodePtyMock()` above has run — confirmed empirically, the same
// failure test/routes/devices.test.ts's own use of buildTestApp avoids.
import { buildTestApp } from "../helpers/app.js";
import {
  createAvd,
  listAvds,
  listDeviceProfiles,
  listInstalledSystemImages,
  listAvailableSystemImages,
  installSystemImage,
  uninstallSystemImage,
  acceptLicenses,
  licensesMayBePending,
} from "../../src/services/avd-manager.js";

describe("avds routes", () => {
  beforeEach(() => {
    vi.mocked(listAvds).mockReset().mockResolvedValue(["pixel_7"]);
    vi.mocked(listDeviceProfiles).mockReset().mockResolvedValue(["pixel_6"]);
    vi.mocked(listInstalledSystemImages)
      .mockReset()
      .mockReturnValue([
        {
          packagePath: "system-images;android-35;google_apis;x86_64",
          apiLevel: "35",
          tagDisplay: "Google APIs",
          abi: "x86_64",
        },
      ]);
    vi.mocked(createAvd).mockReset().mockResolvedValue(undefined);
    vi.mocked(listAvailableSystemImages)
      .mockReset()
      .mockResolvedValue([
        {
          packagePath: "system-images;android-35;google_apis;x86_64",
          apiLevel: "35",
          tag: "google_apis",
          tagDisplay: "Google APIs",
          abi: "x86_64",
          installed: true,
        },
      ]);
    vi.mocked(installSystemImage).mockReset().mockResolvedValue(undefined);
    vi.mocked(uninstallSystemImage).mockReset().mockResolvedValue(undefined);
    vi.mocked(acceptLicenses).mockReset().mockResolvedValue(undefined);
    vi.mocked(licensesMayBePending).mockReset().mockReturnValue(true);
  });

  afterEach(() => {
    delete process.env.DEVICE_ENABLED;
    delete process.env.DEVICE_AVDMANAGER_PATH;
    delete process.env.DEVICE_ANDROID_SDK_ROOT;
    delete process.env.DEVICE_SDKMANAGER_PATH;
  });

  describe("with DEVICE_ENABLED unset (default off)", () => {
    it("GET /api/avds rejects with 400", async () => {
      const app = await buildTestApp();
      const res = await app.inject({ method: "GET", url: "/api/avds" });
      expect(res.statusCode).toBe(400);
    });

    it("GET /api/system-images rejects with 400", async () => {
      const app = await buildTestApp();
      const res = await app.inject({ method: "GET", url: "/api/system-images" });
      expect(res.statusCode).toBe(400);
    });

    it("GET /api/device-profiles rejects with 400", async () => {
      const app = await buildTestApp();
      const res = await app.inject({ method: "GET", url: "/api/device-profiles" });
      expect(res.statusCode).toBe(400);
    });

    it("POST /api/avds rejects with 400", async () => {
      const app = await buildTestApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/avds",
        payload: {
          name: "pixel_7",
          systemImage: "system-images;android-35;google_apis;x86_64",
          deviceProfile: "pixel_6",
        },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("with DEVICE_ENABLED=true", () => {
    beforeEach(() => {
      process.env.DEVICE_ENABLED = "true";
    });

    it("GET /api/avds rejects with 400 when DEVICE_AVDMANAGER_PATH is unset", async () => {
      const app = await buildTestApp();
      const res = await app.inject({ method: "GET", url: "/api/avds" });
      expect(res.statusCode).toBe(400);
    });

    it("GET /api/system-images rejects with 400 when DEVICE_ANDROID_SDK_ROOT is unset", async () => {
      const app = await buildTestApp();
      const res = await app.inject({ method: "GET", url: "/api/system-images" });
      expect(res.statusCode).toBe(400);
    });

    describe("with DEVICE_AVDMANAGER_PATH and DEVICE_ANDROID_SDK_ROOT configured", () => {
      beforeEach(() => {
        process.env.DEVICE_AVDMANAGER_PATH = "/opt/sdk/avdmanager";
        process.env.DEVICE_ANDROID_SDK_ROOT = "/opt/sdk";
      });

      it("GET /api/avds lists AVDs from the service", async () => {
        const app = await buildTestApp();
        const res = await app.inject({ method: "GET", url: "/api/avds" });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ avds: ["pixel_7"] });
        expect(vi.mocked(listAvds)).toHaveBeenCalledWith("/opt/sdk/avdmanager");
      });

      // Self-review (mullion-reviewer) — an exec failure (a misconfigured
      // DEVICE_AVDMANAGER_PATH, ENOENT, a timeout) used to fall through
      // uncaught to a generic 500, unlike every other error case this file
      // handles as a 400.
      it("GET /api/avds surfaces a listAvds failure as 400, not an uncaught 500", async () => {
        vi.mocked(listAvds).mockRejectedValueOnce(new Error("spawn avdmanager ENOENT"));
        const app = await buildTestApp();
        const res = await app.inject({ method: "GET", url: "/api/avds" });
        expect(res.statusCode).toBe(400);
        expect(res.json().message).toContain("ENOENT");
      });

      it("GET /api/system-images lists installed images from the service", async () => {
        const app = await buildTestApp();
        const res = await app.inject({ method: "GET", url: "/api/system-images" });
        expect(res.statusCode).toBe(200);
        expect(res.json().systemImages).toHaveLength(1);
        expect(vi.mocked(listInstalledSystemImages)).toHaveBeenCalledWith("/opt/sdk");
      });

      it("GET /api/device-profiles lists device profiles from the service", async () => {
        const app = await buildTestApp();
        const res = await app.inject({ method: "GET", url: "/api/device-profiles" });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ deviceProfiles: ["pixel_6"] });
      });

      it("GET /api/device-profiles surfaces a listDeviceProfiles failure as 400, not an uncaught 500", async () => {
        vi.mocked(listDeviceProfiles).mockRejectedValueOnce(new Error("spawn avdmanager ENOENT"));
        const app = await buildTestApp();
        const res = await app.inject({ method: "GET", url: "/api/device-profiles" });
        expect(res.statusCode).toBe(400);
        expect(res.json().message).toContain("ENOENT");
      });

      it("POST /api/avds surfaces a listDeviceProfiles/listInstalledSystemImages failure as 400", async () => {
        vi.mocked(listDeviceProfiles).mockRejectedValueOnce(new Error("spawn avdmanager ENOENT"));
        const app = await buildTestApp();
        const res = await app.inject({
          method: "POST",
          url: "/api/avds",
          payload: {
            name: "pixel_7",
            systemImage: "system-images;android-35;google_apis;x86_64",
            deviceProfile: "pixel_6",
          },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().message).toContain("ENOENT");
        expect(vi.mocked(createAvd)).not.toHaveBeenCalled();
      });

      it("POST /api/avds creates an AVD and returns 201", async () => {
        const app = await buildTestApp();
        const res = await app.inject({
          method: "POST",
          url: "/api/avds",
          payload: {
            name: "pixel_7",
            systemImage: "system-images;android-35;google_apis;x86_64",
            deviceProfile: "pixel_6",
          },
        });
        expect(res.statusCode).toBe(201);
        expect(res.json()).toEqual({ name: "pixel_7" });
        expect(vi.mocked(createAvd)).toHaveBeenCalledWith(
          expect.objectContaining({
            avdmanagerPath: "/opt/sdk/avdmanager",
            name: "pixel_7",
            systemImage: "system-images;android-35;google_apis;x86_64",
            deviceProfile: "pixel_6",
          }),
        );
      });

      it("POST /api/avds rejects a name with invalid characters", async () => {
        const app = await buildTestApp();
        const res = await app.inject({
          method: "POST",
          url: "/api/avds",
          payload: {
            name: "pixel 7; rm -rf /",
            systemImage: "system-images;android-35;google_apis;x86_64",
            deviceProfile: "pixel_6",
          },
        });
        expect(res.statusCode).toBe(400);
        expect(vi.mocked(createAvd)).not.toHaveBeenCalled();
      });

      // Hermes review — a bare "." or ".." is meaningless as an AVD name
      // (harmless either way, since argv is never shelled, but the
      // allowlist's own purpose is matching avdmanager's accepted charset).
      it("POST /api/avds rejects a bare-dot name", async () => {
        const app = await buildTestApp();
        const res = await app.inject({
          method: "POST",
          url: "/api/avds",
          payload: {
            name: "..",
            systemImage: "system-images;android-35;google_apis;x86_64",
            deviceProfile: "pixel_6",
          },
        });
        expect(res.statusCode).toBe(400);
        expect(vi.mocked(createAvd)).not.toHaveBeenCalled();
      });

      // CodeQL (js/polynomial-redos) — an earlier version of the bare-dot
      // fix above combined the charset check and the alphanumeric
      // requirement into one regex with two overlapping `*` groups, which
      // is catastrophically slow on exactly this shape of input (many
      // repeats of a character the pattern accepts, followed by one it
      // doesn't). This pins the fix: validation must stay linear-time.
      it("rejects a pathological name in linear time, not catastrophic-backtracking time", async () => {
        const app = await buildTestApp();
        const pathologicalName = "0".repeat(50_000) + "!";
        const start = Date.now();
        const res = await app.inject({
          method: "POST",
          url: "/api/avds",
          payload: {
            name: pathologicalName,
            systemImage: "system-images;android-35;google_apis;x86_64",
            deviceProfile: "pixel_6",
          },
        });
        const elapsedMs = Date.now() - start;
        expect(res.statusCode).toBe(400);
        expect(vi.mocked(createAvd)).not.toHaveBeenCalled();
        expect(elapsedMs).toBeLessThan(1_000);
      });

      it("POST /api/avds rejects a systemImage not in the installed allowlist", async () => {
        const app = await buildTestApp();
        const res = await app.inject({
          method: "POST",
          url: "/api/avds",
          payload: {
            name: "pixel_7",
            systemImage: "system-images;android-99;made_up;x86_64",
            deviceProfile: "pixel_6",
          },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().message).toContain("installed system images");
        expect(vi.mocked(createAvd)).not.toHaveBeenCalled();
      });

      it("POST /api/avds rejects a deviceProfile not in the known allowlist", async () => {
        const app = await buildTestApp();
        const res = await app.inject({
          method: "POST",
          url: "/api/avds",
          payload: {
            name: "pixel_7",
            systemImage: "system-images;android-35;google_apis;x86_64",
            deviceProfile: "made_up_profile",
          },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().message).toContain("device profiles");
        expect(vi.mocked(createAvd)).not.toHaveBeenCalled();
      });

      it("POST /api/avds rejects when name is missing", async () => {
        const app = await buildTestApp();
        const res = await app.inject({
          method: "POST",
          url: "/api/avds",
          payload: {
            systemImage: "system-images;android-35;google_apis;x86_64",
            deviceProfile: "pixel_6",
          },
        });
        expect(res.statusCode).toBe(400);
      });

      it("POST /api/avds surfaces a createAvd failure (e.g. duplicate name) as 400", async () => {
        vi.mocked(createAvd).mockRejectedValueOnce(
          new Error("Android Virtual Device 'pixel_7' already exists."),
        );
        const app = await buildTestApp();
        const res = await app.inject({
          method: "POST",
          url: "/api/avds",
          payload: {
            name: "pixel_7",
            systemImage: "system-images;android-35;google_apis;x86_64",
            deviceProfile: "pixel_6",
          },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().message).toContain("already exists");
      });
    });
  });

  describe("GET /api/system-images/available", () => {
    it("rejects with 400 when DEVICE_ENABLED is unset", async () => {
      const app = await buildTestApp();
      const res = await app.inject({ method: "GET", url: "/api/system-images/available" });
      expect(res.statusCode).toBe(400);
    });

    it("rejects with 400 when DEVICE_SDKMANAGER_PATH is unset", async () => {
      process.env.DEVICE_ENABLED = "true";
      process.env.DEVICE_ANDROID_SDK_ROOT = "/opt/sdk";
      const app = await buildTestApp();
      const res = await app.inject({ method: "GET", url: "/api/system-images/available" });
      expect(res.statusCode).toBe(400);
    });

    it("rejects with 400 when DEVICE_ANDROID_SDK_ROOT is unset", async () => {
      process.env.DEVICE_ENABLED = "true";
      process.env.DEVICE_SDKMANAGER_PATH = "/opt/sdk/sdkmanager";
      const app = await buildTestApp();
      const res = await app.inject({ method: "GET", url: "/api/system-images/available" });
      expect(res.statusCode).toBe(400);
    });

    it("returns available system images when all config is set", async () => {
      process.env.DEVICE_ENABLED = "true";
      process.env.DEVICE_SDKMANAGER_PATH = "/opt/sdk/sdkmanager";
      process.env.DEVICE_ANDROID_SDK_ROOT = "/opt/sdk";
      const app = await buildTestApp();
      const res = await app.inject({ method: "GET", url: "/api/system-images/available" });
      expect(res.statusCode).toBe(200);
      expect(res.json().systemImages).toHaveLength(1);
      expect(vi.mocked(listAvailableSystemImages)).toHaveBeenCalledWith(
        "/opt/sdk/sdkmanager",
        "/opt/sdk",
      );
    });

    it("surfaces a listAvailableSystemImages failure as 400", async () => {
      process.env.DEVICE_ENABLED = "true";
      process.env.DEVICE_SDKMANAGER_PATH = "/opt/sdk/sdkmanager";
      process.env.DEVICE_ANDROID_SDK_ROOT = "/opt/sdk";
      vi.mocked(listAvailableSystemImages).mockRejectedValueOnce(
        new Error("spawn sdkmanager ENOENT"),
      );
      const app = await buildTestApp();
      const res = await app.inject({ method: "GET", url: "/api/system-images/available" });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain("ENOENT");
    });

    it("cache is invalidated after a successful install via WS", async () => {
      process.env.DEVICE_ENABLED = "true";
      process.env.DEVICE_SDKMANAGER_PATH = "/opt/sdk/sdkmanager";
      process.env.DEVICE_ANDROID_SDK_ROOT = "/opt/sdk";
      const app = await buildTestApp();
      await app.listen({ port: 0, host: "127.0.0.1" });
      const address = app.server.address();
      if (address === null || typeof address === "string") {
        throw new Error("expected a real bound address");
      }
      const port = address.port;
      try {
        // 1) Populate the cache with a GET request.
        const first = await app.inject({ method: "GET", url: "/api/system-images/available" });
        expect(first.statusCode).toBe(200);
        expect(vi.mocked(listAvailableSystemImages)).toHaveBeenCalledTimes(1);

        // 2) Complete an install via WS — this clears the cache.
        vi.mocked(installSystemImage).mockResolvedValue(undefined);
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/system-image-install`);
        const msgs = collectJsonMessages(ws);
        await waitForOpen(ws);
        ws.send(
          JSON.stringify({
            type: "install",
            packagePath: "system-images;android-35;google_apis;x86_64",
          }),
        );
        await waitUntil(() => msgs.some((m) => (m as { type?: string }).type === "done"));
        ws.close();

        // 3) The next GET should call the service again (cache was cleared).
        const second = await app.inject({ method: "GET", url: "/api/system-images/available" });
        expect(second.statusCode).toBe(200);
        // Count is 3: first GET (1), WS validation (2), second GET re-fetches (3).
        expect(vi.mocked(listAvailableSystemImages)).toHaveBeenCalledTimes(3);
      } finally {
        await app.close();
      }
    });
  });

  describe("GET /api/sdk-licenses/status", () => {
    it("rejects with 400 when DEVICE_ENABLED is unset", async () => {
      const app = await buildTestApp();
      const res = await app.inject({ method: "GET", url: "/api/sdk-licenses/status" });
      expect(res.statusCode).toBe(400);
    });

    it("returns pending status when config is set", async () => {
      process.env.DEVICE_ENABLED = "true";
      const app = await buildTestApp();
      const res = await app.inject({ method: "GET", url: "/api/sdk-licenses/status" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ pending: true });
      expect(vi.mocked(licensesMayBePending)).toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// WebSocket integration tests — real listening server, real WS client.
// app.inject() can't drive a full WebSocket upgrade; these tests build +
// listen on a random port and connect with a `ws` client, same harness
// shape as test/routes/ws-tasks.test.ts.
// ---------------------------------------------------------------------------

function collectJsonMessages(ws: WebSocket): unknown[] {
  const messages: unknown[] = [];
  ws.on("message", (data) => {
    messages.push(JSON.parse(String(data)));
  });
  return messages;
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => ws.on("open", () => resolve(), { once: true }));
}

async function waitUntil(check: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition never became true within timeout");
}

describe("WS /ws/system-image-install", () => {
  async function buildAndListen() {
    const app = await buildTestApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected a real bound address");
    }
    return { app, port: address.port };
  }

  beforeEach(() => {
    vi.mocked(listInstalledSystemImages).mockReturnValue([
      { packagePath: "system-images;android-35;google_apis;x86_64" },
    ]);
    vi.mocked(listAvailableSystemImages).mockResolvedValue([
      {
        packagePath: "system-images;android-35;google_apis;x86_64",
        installed: false,
        apiLevel: "35",
        tag: "google_apis",
        tagDisplay: "Google APIs",
        abi: "x86_64",
      },
    ]);
  });

  afterEach(() => {
    delete process.env.DEVICE_ENABLED;
    delete process.env.DEVICE_SDKMANAGER_PATH;
    delete process.env.DEVICE_ANDROID_SDK_ROOT;
  });

  it("rejects invalid JSON", async () => {
    process.env.DEVICE_ENABLED = "true";
    process.env.DEVICE_SDKMANAGER_PATH = "/opt/sdk/sdkmanager";
    process.env.DEVICE_ANDROID_SDK_ROOT = "/opt/sdk";
    const { app, port } = await buildAndListen();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/system-image-install`);
      const msgs = collectJsonMessages(ws);
      await waitForOpen(ws);
      ws.send("not json");
      await waitUntil(() => msgs.length > 0);
      expect(msgs[0]).toEqual({ type: "error", message: "Invalid JSON" });
      ws.close();
    } finally {
      await app.close();
    }
  });

  it("rejects unknown message type", async () => {
    process.env.DEVICE_ENABLED = "true";
    process.env.DEVICE_SDKMANAGER_PATH = "/opt/sdk/sdkmanager";
    process.env.DEVICE_ANDROID_SDK_ROOT = "/opt/sdk";
    const { app, port } = await buildAndListen();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/system-image-install`);
      const msgs = collectJsonMessages(ws);
      await waitForOpen(ws);
      ws.send(
        JSON.stringify({
          type: "delete",
          packagePath: "system-images;android-35;google_apis;x86_64",
        }),
      );
      await waitUntil(() => msgs.length > 0);
      expect(msgs[0]).toEqual({ type: "error", message: 'type must be "install" or "uninstall"' });
      ws.close();
    } finally {
      await app.close();
    }
  });

  it("rejects missing/invalid packagePath", async () => {
    process.env.DEVICE_ENABLED = "true";
    process.env.DEVICE_SDKMANAGER_PATH = "/opt/sdk/sdkmanager";
    process.env.DEVICE_ANDROID_SDK_ROOT = "/opt/sdk";
    const { app, port } = await buildAndListen();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/system-image-install`);
      const msgs = collectJsonMessages(ws);
      await waitForOpen(ws);
      ws.send(JSON.stringify({ type: "install", packagePath: "not-a-system-image" }));
      await waitUntil(() => msgs.length > 0);
      expect(msgs[0]).toEqual({ type: "error", message: "Invalid packagePath" });
      ws.close();
    } finally {
      await app.close();
    }
  });

  it("rejects when DEVICE_ENABLED is not set", async () => {
    process.env.DEVICE_SDKMANAGER_PATH = "/opt/sdk/sdkmanager";
    process.env.DEVICE_ANDROID_SDK_ROOT = "/opt/sdk";
    const { app, port } = await buildAndListen();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/system-image-install`);
      const msgs = collectJsonMessages(ws);
      await waitForOpen(ws);
      ws.send(
        JSON.stringify({
          type: "install",
          packagePath: "system-images;android-35;google_apis;x86_64",
        }),
      );
      await waitUntil(() => msgs.length > 0);
      expect(msgs[0]).toEqual({
        type: "error",
        message: "Device panel is disabled or DEVICE_SDKMANAGER_PATH is not configured",
      });
      ws.close();
    } finally {
      await app.close();
    }
  });

  it("rejects when DEVICE_ANDROID_SDK_ROOT is not set", async () => {
    process.env.DEVICE_ENABLED = "true";
    process.env.DEVICE_SDKMANAGER_PATH = "/opt/sdk/sdkmanager";
    const { app, port } = await buildAndListen();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/system-image-install`);
      const msgs = collectJsonMessages(ws);
      await waitForOpen(ws);
      ws.send(
        JSON.stringify({
          type: "install",
          packagePath: "system-images;android-35;google_apis;x86_64",
        }),
      );
      await waitUntil(() => msgs.length > 0);
      expect(msgs[0]).toEqual({
        type: "error",
        message: "DEVICE_ANDROID_SDK_ROOT is not configured",
      });
      ws.close();
    } finally {
      await app.close();
    }
  });

  it("rejects packagePath not in installed or available list", async () => {
    process.env.DEVICE_ENABLED = "true";
    process.env.DEVICE_SDKMANAGER_PATH = "/opt/sdk/sdkmanager";
    process.env.DEVICE_ANDROID_SDK_ROOT = "/opt/sdk";
    vi.mocked(listAvailableSystemImages).mockResolvedValue([]);
    const { app, port } = await buildAndListen();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/system-image-install`);
      const msgs = collectJsonMessages(ws);
      await waitForOpen(ws);
      ws.send(
        JSON.stringify({ type: "install", packagePath: "system-images;android-99;fake;x86_64" }),
      );
      await waitUntil(() => msgs.length > 0);
      expect(msgs[0]).toEqual({
        type: "error",
        message: "packagePath is not in the installed or available images list",
      });
      ws.close();
    } finally {
      await app.close();
    }
  });

  it("successful install streams progress and done", async () => {
    process.env.DEVICE_ENABLED = "true";
    process.env.DEVICE_SDKMANAGER_PATH = "/opt/sdk/sdkmanager";
    process.env.DEVICE_ANDROID_SDK_ROOT = "/opt/sdk";
    vi.mocked(installSystemImage).mockImplementation(async (_sdkmanager, _sdkRoot, _pkg, opts) => {
      opts?.onLine?.("Installing...");
      opts?.onLine?.("Done.");
    });
    const { app, port } = await buildAndListen();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/system-image-install`);
      const msgs = collectJsonMessages(ws);
      await waitForOpen(ws);
      ws.send(
        JSON.stringify({
          type: "install",
          packagePath: "system-images;android-35;google_apis;x86_64",
        }),
      );
      await waitUntil(() => msgs.some((m) => (m as { type: string }).type === "done"));
      expect(msgs).toEqual([
        { type: "progress", message: "Installing..." },
        { type: "progress", message: "Done." },
        { type: "done" },
      ]);
      ws.close();
    } finally {
      await app.close();
    }
  });

  it("successful uninstall streams progress and done", async () => {
    process.env.DEVICE_ENABLED = "true";
    process.env.DEVICE_SDKMANAGER_PATH = "/opt/sdk/sdkmanager";
    process.env.DEVICE_ANDROID_SDK_ROOT = "/opt/sdk";
    vi.mocked(uninstallSystemImage).mockImplementation(
      async (_sdkmanager, _sdkRoot, _pkg, opts) => {
        opts?.onLine?.("Removing...");
        opts?.onLine?.("Removed.");
      },
    );
    const { app, port } = await buildAndListen();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/system-image-install`);
      const msgs = collectJsonMessages(ws);
      await waitForOpen(ws);
      ws.send(
        JSON.stringify({
          type: "uninstall",
          packagePath: "system-images;android-35;google_apis;x86_64",
        }),
      );
      await waitUntil(() => msgs.some((m) => (m as { type: string }).type === "done"));
      expect(msgs).toEqual([
        { type: "progress", message: "Removing..." },
        { type: "progress", message: "Removed." },
        { type: "done" },
      ]);
      ws.close();
    } finally {
      await app.close();
    }
  });

  it("install error sends error message", async () => {
    process.env.DEVICE_ENABLED = "true";
    process.env.DEVICE_SDKMANAGER_PATH = "/opt/sdk/sdkmanager";
    process.env.DEVICE_ANDROID_SDK_ROOT = "/opt/sdk";
    vi.mocked(installSystemImage).mockRejectedValue(new Error("Package not found"));
    const { app, port } = await buildAndListen();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/system-image-install`);
      const msgs = collectJsonMessages(ws);
      await waitForOpen(ws);
      ws.send(
        JSON.stringify({
          type: "install",
          packagePath: "system-images;android-35;google_apis;x86_64",
        }),
      );
      await waitUntil(() => msgs.some((m) => (m as { type: string }).type === "error"));
      expect(msgs[0]).toEqual({ type: "error", message: "Package not found" });
      ws.close();
    } finally {
      await app.close();
    }
  });

  it("rejects concurrent operations from different sockets", async () => {
    process.env.DEVICE_ENABLED = "true";
    process.env.DEVICE_SDKMANAGER_PATH = "/opt/sdk/sdkmanager";
    process.env.DEVICE_ANDROID_SDK_ROOT = "/opt/sdk";
    vi.mocked(installSystemImage).mockImplementation(async (_sdkmanager, _sdkRoot, _pkg, opts) => {
      opts?.onLine?.("starting");
      return new Promise(() => {});
    });
    const { app, port } = await buildAndListen();
    try {
      const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ws/system-image-install`);
      const msgs1 = collectJsonMessages(ws1);
      await waitForOpen(ws1);
      ws1.send(
        JSON.stringify({
          type: "install",
          packagePath: "system-images;android-35;google_apis;x86_64",
        }),
      );
      await waitUntil(() => msgs1.length >= 1);
      const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws/system-image-install`);
      const msgs2 = collectJsonMessages(ws2);
      await waitForOpen(ws2);
      ws2.send(
        JSON.stringify({
          type: "install",
          packagePath: "system-images;android-35;google_apis;x86_64",
        }),
      );
      await waitUntil(() => msgs2.length >= 1);
      expect(msgs1[0]).toEqual({ type: "progress", message: "starting" });
      expect(msgs2[0]).toEqual({
        type: "error",
        message: "An SDK operation is already in progress",
      });
      ws1.close();
      ws2.close();
    } finally {
      await app.close();
    }
  });

  it("second message while active=true on same socket is rejected", async () => {
    process.env.DEVICE_ENABLED = "true";
    process.env.DEVICE_SDKMANAGER_PATH = "/opt/sdk/sdkmanager";
    process.env.DEVICE_ANDROID_SDK_ROOT = "/opt/sdk";
    vi.mocked(installSystemImage).mockImplementation(async (_sdkmanager, _sdkRoot, _pkg, opts) => {
      opts?.onLine?.("starting");
      return new Promise(() => {});
    });
    const { app, port } = await buildAndListen();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/system-image-install`);
      const msgs = collectJsonMessages(ws);
      await waitForOpen(ws);
      ws.send(
        JSON.stringify({
          type: "install",
          packagePath: "system-images;android-35;google_apis;x86_64",
        }),
      );
      await waitUntil(() => msgs.length >= 1);
      ws.send(
        JSON.stringify({
          type: "install",
          packagePath: "system-images;android-35;google_apis;x86_64",
        }),
      );
      await waitUntil(() => msgs.length >= 2);
      expect(msgs[1]).toEqual({ type: "error", message: "Operation already in progress" });
      ws.close();
    } finally {
      await app.close();
    }
  });
});

describe("WS /ws/sdk-licenses", () => {
  async function buildAndListen() {
    const app = await buildTestApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected a real bound address");
    }
    return { app, port: address.port };
  }

  afterEach(() => {
    delete process.env.DEVICE_ENABLED;
    delete process.env.DEVICE_SDKMANAGER_PATH;
    delete process.env.DEVICE_ANDROID_SDK_ROOT;
  });

  it("rejects invalid JSON", async () => {
    process.env.DEVICE_ENABLED = "true";
    process.env.DEVICE_SDKMANAGER_PATH = "/opt/sdk/sdkmanager";
    process.env.DEVICE_ANDROID_SDK_ROOT = "/opt/sdk";
    const { app, port } = await buildAndListen();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/sdk-licenses`);
      const msgs = collectJsonMessages(ws);
      await waitForOpen(ws);
      ws.send("not json");
      await waitUntil(() => msgs.length > 0);
      expect(msgs[0]).toEqual({ type: "error", message: "Invalid JSON" });
      ws.close();
    } finally {
      await app.close();
    }
  });

  it("rejects unknown message type", async () => {
    process.env.DEVICE_ENABLED = "true";
    process.env.DEVICE_SDKMANAGER_PATH = "/opt/sdk/sdkmanager";
    process.env.DEVICE_ANDROID_SDK_ROOT = "/opt/sdk";
    const { app, port } = await buildAndListen();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/sdk-licenses`);
      const msgs = collectJsonMessages(ws);
      await waitForOpen(ws);
      ws.send(JSON.stringify({ type: "reject-licenses" }));
      await waitUntil(() => msgs.length > 0);
      expect(msgs[0]).toEqual({ type: "error", message: 'type must be "accept-licenses"' });
      ws.close();
    } finally {
      await app.close();
    }
  });

  it("rejects when DEVICE_ENABLED is not set", async () => {
    process.env.DEVICE_SDKMANAGER_PATH = "/opt/sdk/sdkmanager";
    process.env.DEVICE_ANDROID_SDK_ROOT = "/opt/sdk";
    const { app, port } = await buildAndListen();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/sdk-licenses`);
      const msgs = collectJsonMessages(ws);
      await waitForOpen(ws);
      ws.send(JSON.stringify({ type: "accept-licenses" }));
      await waitUntil(() => msgs.length > 0);
      expect(msgs[0]).toEqual({
        type: "error",
        message: "Device panel is disabled or DEVICE_SDKMANAGER_PATH is not configured",
      });
      ws.close();
    } finally {
      await app.close();
    }
  });

  it("rejects when DEVICE_ANDROID_SDK_ROOT is not set", async () => {
    process.env.DEVICE_ENABLED = "true";
    process.env.DEVICE_SDKMANAGER_PATH = "/opt/sdk/sdkmanager";
    const { app, port } = await buildAndListen();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/sdk-licenses`);
      const msgs = collectJsonMessages(ws);
      await waitForOpen(ws);
      ws.send(JSON.stringify({ type: "accept-licenses" }));
      await waitUntil(() => msgs.length > 0);
      expect(msgs[0]).toEqual({
        type: "error",
        message: "DEVICE_ANDROID_SDK_ROOT is not configured",
      });
      ws.close();
    } finally {
      await app.close();
    }
  });

  it("successful acceptance streams progress and done", async () => {
    process.env.DEVICE_ENABLED = "true";
    process.env.DEVICE_SDKMANAGER_PATH = "/opt/sdk/sdkmanager";
    process.env.DEVICE_ANDROID_SDK_ROOT = "/opt/sdk";
    vi.mocked(acceptLicenses).mockImplementation(async (_sdkmanager, _sdkRoot, opts) => {
      opts?.onLine?.("Accepting licenses...");
      opts?.onLine?.("All SDK package licenses accepted");
    });
    const { app, port } = await buildAndListen();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/sdk-licenses`);
      const msgs = collectJsonMessages(ws);
      await waitForOpen(ws);
      ws.send(JSON.stringify({ type: "accept-licenses" }));
      await waitUntil(() => msgs.some((m) => (m as { type: string }).type === "done"));
      expect(msgs).toEqual([
        { type: "progress", message: "Accepting licenses..." },
        { type: "progress", message: "All SDK package licenses accepted" },
        { type: "done" },
      ]);
      ws.close();
    } finally {
      await app.close();
    }
  });

  it("acceptance error sends error message", async () => {
    process.env.DEVICE_ENABLED = "true";
    process.env.DEVICE_SDKMANAGER_PATH = "/opt/sdk/sdkmanager";
    process.env.DEVICE_ANDROID_SDK_ROOT = "/opt/sdk";
    vi.mocked(acceptLicenses).mockRejectedValue(new Error("sdkmanager not found"));
    const { app, port } = await buildAndListen();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/sdk-licenses`);
      const msgs = collectJsonMessages(ws);
      await waitForOpen(ws);
      ws.send(JSON.stringify({ type: "accept-licenses" }));
      await waitUntil(() => msgs.some((m) => (m as { type: string }).type === "error"));
      expect(msgs[0]).toEqual({ type: "error", message: "sdkmanager not found" });
      ws.close();
    } finally {
      await app.close();
    }
  });

  it("rejects concurrent operations from different sockets", async () => {
    process.env.DEVICE_ENABLED = "true";
    process.env.DEVICE_SDKMANAGER_PATH = "/opt/sdk/sdkmanager";
    process.env.DEVICE_ANDROID_SDK_ROOT = "/opt/sdk";
    vi.mocked(acceptLicenses).mockImplementation(async (_sdkmanager, _sdkRoot, opts) => {
      opts?.onLine?.("starting");
      return new Promise(() => {});
    });
    const { app, port } = await buildAndListen();
    try {
      const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ws/sdk-licenses`);
      const msgs1 = collectJsonMessages(ws1);
      await waitForOpen(ws1);
      ws1.send(JSON.stringify({ type: "accept-licenses" }));
      await waitUntil(() => msgs1.length >= 1);
      const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws/sdk-licenses`);
      const msgs2 = collectJsonMessages(ws2);
      await waitForOpen(ws2);
      ws2.send(JSON.stringify({ type: "accept-licenses" }));
      await waitUntil(() => msgs2.length >= 1);
      expect(msgs1[0]).toEqual({ type: "progress", message: "starting" });
      expect(msgs2[0]).toEqual({
        type: "error",
        message: "An SDK operation is already in progress",
      });
      ws1.close();
      ws2.close();
    } finally {
      await app.close();
    }
  });

  it("second message while active=true on same socket is rejected", async () => {
    process.env.DEVICE_ENABLED = "true";
    process.env.DEVICE_SDKMANAGER_PATH = "/opt/sdk/sdkmanager";
    process.env.DEVICE_ANDROID_SDK_ROOT = "/opt/sdk";
    vi.mocked(acceptLicenses).mockImplementation(async (_sdkmanager, _sdkRoot, opts) => {
      opts?.onLine?.("starting");
      return new Promise(() => {});
    });
    const { app, port } = await buildAndListen();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/sdk-licenses`);
      const msgs = collectJsonMessages(ws);
      await waitForOpen(ws);
      ws.send(JSON.stringify({ type: "accept-licenses" }));
      await waitUntil(() => msgs.length >= 1);
      ws.send(JSON.stringify({ type: "accept-licenses" }));
      await waitUntil(() => msgs.length >= 2);
      expect(msgs[1]).toEqual({ type: "error", message: "License acceptance already in progress" });
      ws.close();
    } finally {
      await app.close();
    }
  });
});
