import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createAvd,
  listAvds,
  listDeviceProfiles,
  listInstalledSystemImages,
} from "../../src/services/avd-manager.js";

// Real `avdmanager list avd` output, captured against an actual SDK
// install — includes the "SDK XML versions" warning line the binary prints
// on a newer-SDK-than-cmdline-tools host, which the parser must tolerate
// rather than misparse as an AVD entry.
const REAL_LIST_AVD_OUTPUT = `Loading local repository...                                                     Warning: This version only understands SDK XML versions up to 3 but an SDK XML file of version 4 was encountered. This can happen if you use versions of Android Studio and the command-line tools that were released at different times.
Available Android Virtual Devices:
    Name: pixel_7
  Device: pixel_7 (Google)
    Path: /home/user/.android/avd/pixel_7.avd
  Target: Google APIs (Google Inc.)
          Based on: Android API 35 Tag/ABI: google_apis/x86_64
  Sdcard: 512 MB
---------
    Name: pixel_6_tablet
  Device: pixel_6_tablet (Google)
    Path: /home/user/.android/avd/pixel_6_tablet.avd
  Target: Google APIs (Google Inc.)
          Based on: Android API 35 Tag/ABI: google_apis/x86_64
  Sdcard: 512 MB
`;

const REAL_LIST_DEVICE_OUTPUT = `Available devices definitions:
id: 0 or "automotive_1024p_landscape"
    Name: Automotive (1024p landscape)
    OEM : Google
    Tag : android-automotive-playstore
---------
id: 1 or "Galaxy Nexus"
    Name: Galaxy Nexus
    OEM : Google
---------
id: 2 or "pixel_6"
    Name: Pixel 6
    OEM : Google
`;

describe("listAvds", () => {
  it("parses real avdmanager list avd output into AVD names, ignoring the SDK XML warning line", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: REAL_LIST_AVD_OUTPUT, stderr: "" });
    const result = await listAvds("/opt/sdk/avdmanager", { exec });
    expect(exec).toHaveBeenCalledWith(
      "/opt/sdk/avdmanager",
      ["list", "avd"],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toEqual(["pixel_7", "pixel_6_tablet"]);
  });

  it("returns an empty array when no AVDs exist", async () => {
    const exec = vi
      .fn()
      .mockResolvedValue({ stdout: "Available Android Virtual Devices:\n", stderr: "" });
    expect(await listAvds("/opt/sdk/avdmanager", { exec })).toEqual([]);
  });

  // Self-review (mullion-reviewer) caught a real bug an earlier version of
  // runList() had: a second, separately-scheduled timer raced against
  // `exec()` was never cleared on the success path, leaking a pending timer
  // for the full LIST_TIMEOUT_MS after every call — confirmed empirically
  // to add up to 15s of wall-clock hang. This test exercises the actual
  // timeout PATH (not just the happy path the other tests cover) and
  // asserts no timer is left pending afterward — the exact regression that
  // bug would reintroduce. The fake `exec` mimics what a real `execFile`
  // does when handed a signal that fires (reject), which is what runList()'s
  // timeout mechanism now depends on entirely, having dropped the
  // redundant second mechanism.
  it("times out and leaves no dangling timer when exec never resolves on its own", async () => {
    vi.useFakeTimers();
    try {
      const exec = vi.fn(
        (_file: string, _args: string[], options: { signal?: AbortSignal }) =>
          new Promise<{ stdout: string; stderr: string }>((_resolve, reject) => {
            options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      );
      const promise = listAvds("/opt/sdk/avdmanager", { exec });
      const assertion = expect(promise).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(20_000);
      await assertion;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("listDeviceProfiles", () => {
  it("parses the quoted id token (the -d-compatible identifier), not the display Name", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: REAL_LIST_DEVICE_OUTPUT, stderr: "" });
    const result = await listDeviceProfiles("/opt/sdk/avdmanager", { exec });
    expect(exec).toHaveBeenCalledWith(
      "/opt/sdk/avdmanager",
      ["list", "device"],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toEqual(["automotive_1024p_landscape", "Galaxy Nexus", "pixel_6"]);
  });
});

describe("listInstalledSystemImages", () => {
  function withFixtureSdkRoot(build: (sdkRoot: string) => void): void {
    const sdkRoot = mkdtempSync(path.join(os.tmpdir(), "avd-manager-test-"));
    try {
      build(sdkRoot);
    } finally {
      rmSync(sdkRoot, { recursive: true, force: true });
    }
  }

  function makeImageDir(sdkRoot: string, api: string, tag: string, abi: string): string {
    const dir = path.join(sdkRoot, "system-images", api, tag, abi);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("scans <sdkRoot>/system-images/<api>/<tag>/<abi>/ and enriches from source.properties", () => {
    withFixtureSdkRoot((sdkRoot) => {
      const dir = makeImageDir(sdkRoot, "android-35", "google_apis", "x86_64");
      writeFileSync(
        path.join(dir, "source.properties"),
        [
          "Pkg.Desc=System Image x86_64 with Google APIs.",
          "AndroidVersion.ApiLevel=35",
          "SystemImage.Abi=x86_64",
          "SystemImage.TagId=google_apis",
          "SystemImage.TagDisplay=Google APIs",
        ].join("\n"),
      );

      const images = listInstalledSystemImages(sdkRoot);
      expect(images).toEqual([
        {
          packagePath: "system-images;android-35;google_apis;x86_64",
          apiLevel: "35",
          tagDisplay: "Google APIs",
          abi: "x86_64",
        },
      ]);
    });
  });

  it("still returns a usable entry (packagePath only) when source.properties is missing", () => {
    withFixtureSdkRoot((sdkRoot) => {
      makeImageDir(sdkRoot, "android-34", "default", "arm64-v8a");

      const images = listInstalledSystemImages(sdkRoot);
      expect(images).toEqual([
        {
          packagePath: "system-images;android-34;default;arm64-v8a",
          apiLevel: null,
          tagDisplay: null,
          abi: null,
        },
      ]);
    });
  });

  it("still returns a usable entry when source.properties is corrupt/unparseable", () => {
    withFixtureSdkRoot((sdkRoot) => {
      const dir = makeImageDir(sdkRoot, "android-33", "google_apis_playstore", "x86_64");
      writeFileSync(path.join(dir, "source.properties"), "\x00\xff not a properties file");

      const images = listInstalledSystemImages(sdkRoot);
      expect(images).toEqual([
        {
          packagePath: "system-images;android-33;google_apis_playstore;x86_64",
          apiLevel: null,
          tagDisplay: null,
          abi: null,
        },
      ]);
    });
  });

  it("returns an empty array (not a throw) when the SDK root doesn't exist", () => {
    expect(listInstalledSystemImages("/nonexistent/sdk/root")).toEqual([]);
  });

  it("lists multiple installed images", () => {
    withFixtureSdkRoot((sdkRoot) => {
      makeImageDir(sdkRoot, "android-35", "google_apis", "x86_64");
      makeImageDir(sdkRoot, "android-35", "google_apis", "arm64-v8a");
      makeImageDir(sdkRoot, "android-34", "default", "x86_64");

      const packagePaths = listInstalledSystemImages(sdkRoot)
        .map((img) => img.packagePath)
        .sort();
      expect(packagePaths).toEqual([
        "system-images;android-34;default;x86_64",
        "system-images;android-35;google_apis;arm64-v8a",
        "system-images;android-35;google_apis;x86_64",
      ]);
    });
  });
});

describe("createAvd", () => {
  // A minimal fake matching execFile's (file, args, options, callback)
  // shape closely enough for this test: it must (a) synchronously return
  // something with a `.stdin.end()` on it, so createAvd's own stdin-close
  // call doesn't throw, and (b) invoke the callback asynchronously, the
  // same way the real one does.
  function fakeExecFile(result: { error: Error | null; stdout?: string; stderr?: string }) {
    const stdinEnd = vi.fn();
    const execFileFn = vi.fn((_file, _args, _options, callback) => {
      queueMicrotask(() => callback(result.error, result.stdout ?? "", result.stderr ?? ""));
      return { stdin: { end: stdinEnd } };
    });
    return { execFileFn, stdinEnd };
  }

  it("builds argv as -n/-k/-d, closes stdin immediately, and never passes --force", async () => {
    const { execFileFn, stdinEnd } = fakeExecFile({ error: null });

    await createAvd({
      avdmanagerPath: "/opt/sdk/avdmanager",
      name: "pixel_7",
      systemImage: "system-images;android-35;google_apis;x86_64",
      deviceProfile: "pixel_6",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake matches execFile's (file, args, options, cb) shape, not its full overload set
      execFileFn: execFileFn as any,
    });

    expect(execFileFn).toHaveBeenCalledWith(
      "/opt/sdk/avdmanager",
      [
        "create",
        "avd",
        "-n",
        "pixel_7",
        "-k",
        "system-images;android-35;google_apis;x86_64",
        "-d",
        "pixel_6",
      ],
      expect.objectContaining({ timeout: expect.any(Number) }),
      expect.any(Function),
    );
    expect(execFileFn.mock.calls[0][1]).not.toContain("--force");
    expect(execFileFn.mock.calls[0][1]).not.toContain("-f");
    expect(stdinEnd).toHaveBeenCalled();
  });

  it("rejects with the process's own stderr on failure (e.g. duplicate AVD name)", async () => {
    const { execFileFn } = fakeExecFile({
      error: new Error("Command failed"),
      stderr:
        "Error: Android Virtual Device 'pixel_7' already exists.\nUse --force if you want to replace it.\n",
    });

    await expect(
      createAvd({
        avdmanagerPath: "/opt/sdk/avdmanager",
        name: "pixel_7",
        systemImage: "system-images;android-35;google_apis;x86_64",
        deviceProfile: "pixel_6",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see comment above
        execFileFn: execFileFn as any,
      }),
    ).rejects.toThrow(/already exists/);
  });

  it("never invokes a shell (execFile, not exec) — no real avdmanager process runs in this test", async () => {
    const { execFileFn } = fakeExecFile({ error: null });
    await createAvd({
      avdmanagerPath: "/opt/sdk/avdmanager",
      name: "pixel_7",
      systemImage: "system-images;android-35;google_apis;x86_64",
      deviceProfile: "pixel_6",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see comment above
      execFileFn: execFileFn as any,
    });
    // No call ever carries `shell: true`.
    for (const call of execFileFn.mock.calls) {
      expect((call[2] as Record<string, unknown>).shell).not.toBe(true);
    }
  });
});
