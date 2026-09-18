import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
  });

  afterEach(() => {
    delete process.env.DEVICE_ENABLED;
    delete process.env.DEVICE_AVDMANAGER_PATH;
    delete process.env.DEVICE_ANDROID_SDK_ROOT;
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
});
