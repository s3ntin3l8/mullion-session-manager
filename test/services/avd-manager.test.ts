import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExecFileFn } from "../../src/services/avd-manager.js";
import {
  createAvd,
  listAvds,
  listDeviceProfiles,
  listInstalledSystemImages,
  parseSdkManagerList,
  listAvailableSystemImages,
  installSystemImage,
  uninstallSystemImage,
  licensesMayBePending,
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

// Every exec-based function in avd-manager.ts now goes through the same
// execFile(file, args, callback) shape (armKillEscalation, session-
// process.ts, needs the synchronously-returned ChildProcess) — these two
// fakes cover the two behaviors every test below needs: settle almost
// immediately (the ordinary case — fast enough that armKillEscalation's own
// timer never fires), or never settle at all (to exercise the timeout/
// escalation path deterministically under fake timers).
interface FakeChild {
  kill: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  signalCode: string | null;
  stdin: { end: ReturnType<typeof vi.fn> };
}

function makeFakeChild(): FakeChild {
  return { kill: vi.fn(), exitCode: null, signalCode: null, stdin: { end: vi.fn() } };
}

function fakeExecFileResolving(
  child: FakeChild,
  result: { error?: Error; stdout?: string; stderr?: string } = {},
): ExecFileFn {
  return vi.fn((_file: string, _args: string[], callback: unknown) => {
    queueMicrotask(() =>
      (callback as (error: Error | null, stdout: string, stderr: string) => void)(
        result.error ?? null,
        result.stdout ?? "",
        result.stderr ?? "",
      ),
    );
    return child;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the fake matches execFile's (file, args, callback) shape, not its full overload set
  }) as any;
}

function fakeExecFileHanging(child: FakeChild): ExecFileFn {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see fakeExecFileResolving's own comment
  return vi.fn(() => child) as any;
}

describe("listAvds", () => {
  it("parses real avdmanager list avd output into AVD names, ignoring the SDK XML warning line", async () => {
    const child = makeFakeChild();
    const execFileFn = fakeExecFileResolving(child, { stdout: REAL_LIST_AVD_OUTPUT });
    const result = await listAvds("/opt/sdk/avdmanager", { execFileFn });
    expect(execFileFn).toHaveBeenCalledWith(
      "/opt/sdk/avdmanager",
      ["list", "avd"],
      expect.any(Function),
    );
    expect(result).toEqual(["pixel_7", "pixel_6_tablet"]);
  });

  it("returns an empty array when no AVDs exist", async () => {
    const child = makeFakeChild();
    const execFileFn = fakeExecFileResolving(child, {
      stdout: "Available Android Virtual Devices:\n",
    });
    expect(await listAvds("/opt/sdk/avdmanager", { execFileFn })).toEqual([]);
  });

  // Hermes review — createAvd's timeout used to rely on execFile's own
  // `timeout` option, which only ever sends SIGTERM and leaves the promise
  // unsettled until the child actually exits; a stalled child can hold it
  // past the cap indefinitely. Every exec-based function here now arms
  // armKillEscalation (session-process.ts) instead, which this test
  // exercises via a child that never invokes its callback: the promise
  // must still reject with a clear "timed out" message, and the SIGTERM
  // escalation must actually have been sent — armKillEscalation's own
  // SIGTERM-then-SIGKILL timer mechanics are its own module's tested
  // responsibility (session-process.test.ts), not re-verified here.
  it("times out and sends SIGTERM via armKillEscalation when the process never responds", async () => {
    vi.useFakeTimers();
    try {
      const child = makeFakeChild();
      const execFileFn = fakeExecFileHanging(child);
      const promise = listAvds("/opt/sdk/avdmanager", { execFileFn });
      const assertion = expect(promise).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(20_000);
      await assertion;
      expect(child.kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("listDeviceProfiles", () => {
  it("parses the quoted id token (the -d-compatible identifier), not the display Name", async () => {
    const child = makeFakeChild();
    const execFileFn = fakeExecFileResolving(child, { stdout: REAL_LIST_DEVICE_OUTPUT });
    const result = await listDeviceProfiles("/opt/sdk/avdmanager", { execFileFn });
    expect(execFileFn).toHaveBeenCalledWith(
      "/opt/sdk/avdmanager",
      ["list", "device"],
      expect.any(Function),
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

  // Hermes review — readdirSync's own order is unspecified, so without an
  // explicit sort the picker's option order would be nondeterministic
  // across hosts/filesystems.
  it("returns images sorted by packagePath, regardless of directory scan order", () => {
    withFixtureSdkRoot((sdkRoot) => {
      makeImageDir(sdkRoot, "android-35", "google_apis", "x86_64");
      makeImageDir(sdkRoot, "android-35", "google_apis", "arm64-v8a");
      makeImageDir(sdkRoot, "android-34", "default", "x86_64");

      const packagePaths = listInstalledSystemImages(sdkRoot).map((img) => img.packagePath);
      expect(packagePaths).toEqual([
        "system-images;android-34;default;x86_64",
        "system-images;android-35;google_apis;arm64-v8a",
        "system-images;android-35;google_apis;x86_64",
      ]);
    });
  });
});

describe("createAvd", () => {
  it("builds argv as -n/-k/-d, closes stdin immediately, and never passes --force", async () => {
    const child = makeFakeChild();
    const execFileFn = fakeExecFileResolving(child);

    await createAvd({
      avdmanagerPath: "/opt/sdk/avdmanager",
      name: "pixel_7",
      systemImage: "system-images;android-35;google_apis;x86_64",
      deviceProfile: "pixel_6",
      execFileFn,
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
      expect.any(Function),
    );
    expect(execFileFn.mock.calls[0][1]).not.toContain("--force");
    expect(execFileFn.mock.calls[0][1]).not.toContain("-f");
    expect(child.stdin.end).toHaveBeenCalled();
  });

  it("rejects with the process's own stderr on failure (e.g. duplicate AVD name)", async () => {
    const child = makeFakeChild();
    const execFileFn = fakeExecFileResolving(child, {
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
        execFileFn,
      }),
    ).rejects.toThrow(/already exists/);
  });

  it("times out and sends SIGTERM via armKillEscalation when avdmanager never responds (Hermes review)", async () => {
    vi.useFakeTimers();
    try {
      const child = makeFakeChild();
      const execFileFn = fakeExecFileHanging(child);
      const promise = createAvd({
        avdmanagerPath: "/opt/sdk/avdmanager",
        name: "pixel_7",
        systemImage: "system-images;android-35;google_apis;x86_64",
        deviceProfile: "pixel_6",
        timeoutMs: 5_000,
        execFileFn,
      });
      const assertion = expect(promise).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
      expect(child.kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

const REAL_SDKMANAGER_LIST_OUTPUT = `Available Packages:
  Path                      | Version | Description
  -------                   | ------- | -----------
  system-images;android-35;google_apis;x86_64 | 7 | Google APIs x86_64 System Image
  system-images;android-35;google_apis;arm64-v8a | 7 | Google APIs ARM 64 v8a System Image
  system-images;android-34;default;x86_64 | 6 | Default x86_64 System Image
  build-tools;35.0.0        | 35     | Android SDK Build-Tools 35
`;

// Captured from a real `sdkmanager --list` on cmdline-tools 23.0 — the
// Android CLI under the sdkmanager deprecation shim prints a lowercase
// section header and slash-delimited sdk-style paths in a space-aligned
// table, not the classic pipe/semicolon package-path rows above. Issue:
// "SDK system images" showed "No system images available." with no error
// after #1374 made `--sdk_root=` succeed on this host.
const ANDROID_CLI_SDKMANAGER_LIST_OUTPUT = `Installed packages:
  system-images/android-35/google_apis/x86_64                                             9.0.0                                  Google APIs Intel x86_64 Atom System Image
  system-images/android-33/default/x86_64                                                 5.0.0                                  Default Intel x86_64 Atom System Image (obsolete, installed-only)

Available packages:
  build-tools/35.0.0                                                                      35.0.0                                 Android SDK Build-Tools 35
  system-images/android-35/google_apis/x86_64                                             9.0.0                                  Google APIs Intel x86_64 Atom System Image
  system-images/android-35/google_apis_playstore/x86_64                                   1.0.0                                  Google Play Intel x86_64 Atom System Image
  system-images/android-35-ext14/google_apis_playstore/x86_64                             1.0.0                                  Google Play Intel x86_64 Atom System Image
  system-images/android-35/google_apis/arm64-v8a                                          9.0.0                                  Google APIs ARM 64 v8a System Image
  system-images/android-34/default/x86_64                                                 6.0.0                                  Default Intel x86_64 Atom System Image
`;

describe("parseSdkManagerList", () => {
  it("parses sdkmanager --list output into AvailableSystemImage objects for host ABI", () => {
    const result = parseSdkManagerList(REAL_SDKMANAGER_LIST_OUTPUT, [], "x86_64");
    expect(result.length).toBe(2);
    expect(result.every((img) => img.abi === "x86_64")).toBe(true);
  });

  it("marks images as installed when they appear in the installed set", () => {
    const installed = [
      {
        packagePath: "system-images;android-35;google_apis;x86_64",
        apiLevel: "35",
        tagDisplay: "Google APIs",
        abi: "x86_64",
      },
    ];
    const result = parseSdkManagerList(REAL_SDKMANAGER_LIST_OUTPUT, installed, "x86_64");
    const x86Img = result.find((img) => img.abi === "x86_64");
    expect(x86Img?.installed).toBe(true);
  });

  it("parses Android CLI (cmdline-tools 23) slash-path output and normalizes to semicolon packagePath", () => {
    const result = parseSdkManagerList(ANDROID_CLI_SDKMANAGER_LIST_OUTPUT, [], "x86_64");
    // arm64 image filtered out (host ABI x86_64); 4 x86_64 images remain.
    // Sort: API 35 first (parseInt("35-ext14") === 35), then tag alpha —
    // the two google_apis_playstore entries tie on tag, so stable sort
    // keeps their source order (plain before -ext14).
    expect(result.map((img) => img.packagePath)).toEqual([
      "system-images;android-35;google_apis;x86_64",
      "system-images;android-35;google_apis_playstore;x86_64",
      "system-images;android-35-ext14;google_apis_playstore;x86_64",
      "system-images;android-34;default;x86_64",
    ]);
    expect(result[0]).toMatchObject({
      apiLevel: "35",
      tag: "google_apis",
      tagDisplay: "Google APIs Intel x86_64 Atom System Image",
      abi: "x86_64",
      installed: false,
    });
  });

  it("does not scrape the Android CLI Installed packages section", () => {
    const installed = [
      {
        packagePath: "system-images;android-35;google_apis;x86_64",
        apiLevel: "35",
        tagDisplay: "Google APIs",
        abi: "x86_64",
      },
    ];
    const result = parseSdkManagerList(ANDROID_CLI_SDKMANAGER_LIST_OUTPUT, installed, "x86_64");
    const paths = result.map((img) => img.packagePath);
    // android-33 lives only in the fixture's Installed block. The `seen`
    // dedupe alone cannot hide it (it never appears under Available), so this
    // assertion fails if the header-based section slice regresses to scanning
    // the whole stdout.
    expect(paths).not.toContain("system-images;android-33;default;x86_64");
    expect(new Set(paths).size).toBe(paths.length);
    expect(
      result.find((img) => img.packagePath === "system-images;android-35;google_apis;x86_64")
        ?.installed,
    ).toBe(true);
  });

  it("returns empty array when output has no matching lines", () => {
    const result = parseSdkManagerList("no system images here\n", [], "x86_64");
    expect(result).toEqual([]);
  });

  it("handles output without Available Packages: header", () => {
    const output = `  system-images;android-35;google_apis;x86_64 | 7 | Google APIs x86_64 System Image\n`;
    const result = parseSdkManagerList(output, [], "x86_64");
    expect(result.length).toBe(1);
  });

  it("sorts by API level descending, then tag alphabetically", () => {
    const output = [
      "Available Packages:",
      "  system-images;android-34;default;x86_64 | 6 | Default x86_64",
      "  system-images;android-35;google_apis;x86_64 | 7 | Google APIs x86_64",
    ].join("\n");
    const result = parseSdkManagerList(output, [], "x86_64");
    expect(result.length).toBe(2);
    expect(result[0].apiLevel).toBe("35");
    expect(result[1].apiLevel).toBe("34");
  });

  it("sorts tags alphabetically when API levels are equal", () => {
    const output = [
      "Available Packages:",
      "  system-images;android-35;google_apis_playstore;x86_64 | 7 | Play Store x86_64",
      "  system-images;android-35;google_apis;x86_64 | 7 | Google APIs x86_64",
    ].join("\n");
    const result = parseSdkManagerList(output, [], "x86_64");
    expect(result.length).toBe(2);
    expect(result[0].tag).toBe("google_apis");
    expect(result[1].tag).toBe("google_apis_playstore");
  });
});

describe("listAvailableSystemImages", () => {
  it("shells out to sdkmanager --list and returns parsed results", async () => {
    const child = makeFakeChild();
    const execFileFn = fakeExecFileResolving(child, { stdout: REAL_SDKMANAGER_LIST_OUTPUT });
    const result = await listAvailableSystemImages("/opt/sdk/sdkmanager", "/opt/sdk", {
      execFileFn,
    });
    expect(execFileFn).toHaveBeenCalledWith(
      "/opt/sdk/sdkmanager",
      ["--list", "--sdk_root=/opt/sdk"],
      expect.any(Function),
    );
    expect(Array.isArray(result)).toBe(true);
  });

  it("rejects when sdkmanager --list fails", async () => {
    const child = makeFakeChild();
    const execFileFn = fakeExecFileResolving(child, {
      error: new Error("spawn sdkmanager ENOENT"),
    });
    await expect(
      listAvailableSystemImages("/opt/sdk/sdkmanager", "/opt/sdk", { execFileFn }),
    ).rejects.toThrow(/ENOENT/);
  });
});

describe("installSystemImage", () => {
  it("shells out to sdkmanager --install with correct args", async () => {
    const child = makeFakeChild();
    const execFileFn = fakeExecFileResolving(child);
    await installSystemImage(
      "/opt/sdk/sdkmanager",
      "/opt/sdk",
      "system-images;android-35;google_apis;x86_64",
      {
        execFileFn,
      },
    );
    expect(execFileFn).toHaveBeenCalledWith(
      "/opt/sdk/sdkmanager",
      ["--install", "system-images;android-35;google_apis;x86_64", "--sdk_root=/opt/sdk"],
      expect.any(Function),
    );
  });

  it("streams progress lines via onLine callback", async () => {
    const child = makeFakeChild();
    const onLine = vi.fn();
    const execFileFn = fakeExecFileResolving(child);

    await installSystemImage(
      "/opt/sdk/sdkmanager",
      "/opt/sdk",
      "system-images;android-35;google_apis;x86_64",
      {
        execFileFn,
        onLine,
      },
    );
    expect(execFileFn).toHaveBeenCalled();
  });

  it("rejects with stderr message on failure", async () => {
    const child = makeFakeChild();
    const execFileFn = fakeExecFileResolving(child, {
      error: new Error("Install failed"),
      stderr: "Package not found",
    });
    await expect(
      installSystemImage(
        "/opt/sdk/sdkmanager",
        "/opt/sdk",
        "system-images;android-99;fake;x86_64",
        {
          execFileFn,
        },
      ),
    ).rejects.toThrow(/Package not found/);
  });

  it("times out and sends SIGTERM via armKillEscalation when the process never responds", async () => {
    vi.useFakeTimers();
    try {
      const child = makeFakeChild();
      const execFileFn = fakeExecFileHanging(child);
      const promise = installSystemImage(
        "/opt/sdk/sdkmanager",
        "/opt/sdk",
        "system-images;android-35;google_apis;x86_64",
        { execFileFn },
      );
      const assertion = expect(promise).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(600_000);
      await assertion;
      expect(child.kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("uninstallSystemImage", () => {
  it("shells out to sdkmanager --uninstall with correct args", async () => {
    const child = makeFakeChild();
    const execFileFn = fakeExecFileResolving(child);
    await uninstallSystemImage(
      "/opt/sdk/sdkmanager",
      "/opt/sdk",
      "system-images;android-35;google_apis;x86_64",
      {
        execFileFn,
      },
    );
    expect(execFileFn).toHaveBeenCalledWith(
      "/opt/sdk/sdkmanager",
      ["--uninstall", "system-images;android-35;google_apis;x86_64", "--sdk_root=/opt/sdk"],
      expect.any(Function),
    );
  });

  it("rejects with stderr message on failure", async () => {
    const child = makeFakeChild();
    const execFileFn = fakeExecFileResolving(child, {
      error: new Error("Uninstall failed"),
      stderr: "Package not installed",
    });
    await expect(
      uninstallSystemImage(
        "/opt/sdk/sdkmanager",
        "/opt/sdk",
        "system-images;android-99;fake;x86_64",
        {
          execFileFn,
        },
      ),
    ).rejects.toThrow(/Package not installed/);
  });

  it("times out and sends SIGTERM via armKillEscalation when the process never responds", async () => {
    vi.useFakeTimers();
    try {
      const child = makeFakeChild();
      const execFileFn = fakeExecFileHanging(child);
      const promise = uninstallSystemImage(
        "/opt/sdk/sdkmanager",
        "/opt/sdk",
        "system-images;android-35;google_apis;x86_64",
        { execFileFn },
      );
      const assertion = expect(promise).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(120_000);
      await assertion;
      expect(child.kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// Streaming variant: fake child with EventEmitter-based stdout/stderr so
// the `child.stdout.on("data")` / `child.stderr.on("data")` handlers in
// installSystemImage/uninstallSystemImage are exercised. The execFileFn
// captures the callback and invokes it after emitting stream data.
interface StreamingFakeChild extends FakeChild {
  stdout: EventEmitter;
  stderr: EventEmitter;
}

function makeStreamingFakeChild(): StreamingFakeChild {
  return {
    kill: vi.fn(),
    exitCode: null,
    signalCode: null,
    stdin: { end: vi.fn() },
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  };
}

function fakeExecFileStreaming(
  child: StreamingFakeChild,
  opts: { error?: Error; stdoutData?: string; stderrData?: string } = {},
): ExecFileFn {
  return vi.fn((_file: string, _args: string[], callback: unknown) => {
    queueMicrotask(() => {
      if (opts.stdoutData) child.stdout.emit("data", Buffer.from(opts.stdoutData));
      if (opts.stderrData) child.stderr.emit("data", Buffer.from(opts.stderrData));
      (callback as (error: Error | null, stdout: string, stderr: string) => void)(
        opts.error ?? null,
        "",
        "",
      );
    });
    return child;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches execFile's shape, not full overload set
  }) as any;
}

describe("installSystemImage — stdout/stderr streaming", () => {
  it("streams stdout lines via onLine callback", async () => {
    const child = makeStreamingFakeChild();
    const onLine = vi.fn();
    const execFileFn = fakeExecFileStreaming(child, { stdoutData: "Installing package\nDone.\n" });

    await installSystemImage(
      "/opt/sdk/sdkmanager",
      "/opt/sdk",
      "system-images;android-35;google_apis;x86_64",
      { execFileFn, onLine },
    );
    expect(onLine).toHaveBeenCalledWith("Installing package");
    expect(onLine).toHaveBeenCalledWith("Done.");
  });

  it("streams stderr lines via onLine callback", async () => {
    const child = makeStreamingFakeChild();
    const onLine = vi.fn();
    const execFileFn = fakeExecFileStreaming(child, { stderrData: "Warning: old version\n" });

    await installSystemImage(
      "/opt/sdk/sdkmanager",
      "/opt/sdk",
      "system-images;android-35;google_apis;x86_64",
      { execFileFn, onLine },
    );
    expect(onLine).toHaveBeenCalledWith("Warning: old version");
  });
});

describe("uninstallSystemImage — stdout/stderr streaming", () => {
  it("streams stdout lines via onLine callback", async () => {
    const child = makeStreamingFakeChild();
    const onLine = vi.fn();
    const execFileFn = fakeExecFileStreaming(child, { stdoutData: "Removing package\nDone.\n" });

    await uninstallSystemImage(
      "/opt/sdk/sdkmanager",
      "/opt/sdk",
      "system-images;android-35;google_apis;x86_64",
      { execFileFn, onLine },
    );
    expect(onLine).toHaveBeenCalledWith("Removing package");
    expect(onLine).toHaveBeenCalledWith("Done.");
  });

  it("streams stderr lines via onLine callback", async () => {
    const child = makeStreamingFakeChild();
    const onLine = vi.fn();
    const execFileFn = fakeExecFileStreaming(child, { stderrData: "Warning: not installed\n" });

    await uninstallSystemImage(
      "/opt/sdk/sdkmanager",
      "/opt/sdk",
      "system-images;android-35;google_apis;x86_64",
      { execFileFn, onLine },
    );
    expect(onLine).toHaveBeenCalledWith("Warning: not installed");
  });
});

describe("licensesMayBePending", () => {
  it("always returns true (conservative: can't know which hashes are needed without running sdkmanager)", () => {
    expect(licensesMayBePending()).toBe(true);
  });
});
