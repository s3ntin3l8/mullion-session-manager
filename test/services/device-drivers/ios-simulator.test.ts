import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type * as ChildProcess from "node:child_process";
import type * as FsPromises from "node:fs/promises";
import { existsSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (orig) => ({
  ...(await orig<typeof ChildProcess>()),
  execFile: execFileMock,
}));
/** `open` passes through to the real one unless a test makes it fail once. */
const openFail = vi.hoisted(() => ({ next: null as Error | null }));
vi.mock("node:fs/promises", async (orig) => {
  const actual = await orig<typeof FsPromises>();
  return {
    ...actual,
    open: (async (...a: Parameters<typeof actual.open>) => {
      const err = openFail.next;
      openFail.next = null;
      if (err) throw err;
      return actual.open(...a);
    }) as typeof actual.open,
  };
});

import {
  IosSimulatorDriver,
  execSimctl,
  type SimctlRunner,
} from "../../../src/services/device-drivers/ios-simulator.js";
import { performDeviceAction } from "../../../src/services/device-drivers/actions.js";
import { DeviceActionError } from "../../../src/services/device-drivers/types.js";

const UDID = "0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9";

function listing(state: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [
          { udid: "OTHER", state: "Booted" },
          { udid: UDID, state },
        ],
      },
    }),
  );
}

/** What `io <udid> screenshot <path>` does in the fake: like Xcode 27's simctl
 * (#3517) it writes the file named by its last argv element and prints nothing
 * on stdout. `size` makes a sparse file of that size instead; `null` writes
 * nothing. */
interface FakeShot {
  file?: Buffer | null;
  size?: number;
  stdout?: Buffer;
  stderr?: Buffer;
}

/** A scripted simctl: `state` is what `list` reports, other verbs are recorded. */
function fakeSimctl(initial = "Shutdown") {
  const calls: string[][] = [];
  const inputs: Array<string | undefined> = [];
  /** The screenshot directory's mode as simctl saw it. */
  const shotDirModes: number[] = [];
  const res: {
    state: string;
    out: Record<string, Buffer>;
    fail: Record<string, Error>;
    shot: FakeShot;
  } = {
    state: initial,
    out: {},
    fail: {},
    shot: {},
  };
  const simctl: SimctlRunner = async (args, options) => {
    calls.push(args);
    inputs.push(options?.input);
    const verb = args[0]!;
    if (verb === "io") shotDirModes.push(statSync(dirname(args.at(-1)!)).mode & 0o777);
    if (verb === "io" && res.fail.io && res.shot.file) writeFileSync(args.at(-1)!, res.shot.file);
    if (res.fail[verb]) throw res.fail[verb];
    if (verb === "list") return listing(res.state);
    if (verb === "boot") res.state = "Booted";
    if (verb === "shutdown") res.state = "Shutdown";
    if (verb === "io") {
      const path = args.at(-1)!;
      if (res.shot.size !== undefined) {
        writeFileSync(path, png());
        truncateSync(path, res.shot.size);
      } else if (res.shot.file !== null) {
        writeFileSync(path, res.shot.file ?? png());
      }
      if (res.shot.stderr) options?.onStderr?.(res.shot.stderr);
      return res.shot.stdout ?? Buffer.alloc(0);
    }
    return res.out[verb] ?? Buffer.alloc(0);
  };
  return { simctl, calls, inputs, res, shotDirModes };
}

const verbs = (calls: string[][]) => calls.map((c) => c[0]);

function make(f = fakeSimctl()) {
  const driver = new IosSimulatorDriver({ id: "9", udid: UDID, label: "iPhone", simctl: f.simctl });
  return { driver, ...f };
}

function png(width = 3, height = 2): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

describe("IosSimulatorDriver", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("refuses a non-UUID udid before any simctl call", () => {
    const f = fakeSimctl();
    for (const bad of ["", "booted", `${UDID}; rm -rf /`, "--help"]) {
      expect(
        () => new IosSimulatorDriver({ id: "1", udid: bad, label: null, simctl: f.simctl }),
      ).toThrow(/invalid simulator UDID/);
    }
    expect(f.calls).toEqual([]);
  });

  it("boots a shutdown simulator, waits for bootstatus and owns it", async () => {
    const { driver, calls, res } = make();
    expect(driver.toInfo().status).toBe("starting");
    await driver.start();
    expect(calls).toEqual([
      ["list", "devices", "-j"],
      ["boot", UDID],
      ["bootstatus", UDID, "-b"],
    ]);
    expect(driver.isAlive).toBe(true);
    expect(driver.toInfo()).toMatchObject({
      status: "streaming",
      serial: UDID,
    });
    await driver.stop();
    expect(calls.at(-1)).toEqual(["shutdown", UDID]);
    expect(res.state).toBe("Shutdown");
    expect(driver.toInfo().status).toBe("exited");
  });

  it("treats an already-Booted simulator as success and never shuts it down", async () => {
    const { driver, calls } = make(fakeSimctl("Booted"));
    await driver.start();
    expect(verbs(calls)).toEqual(["list", "bootstatus"]);
    await driver.stop();
    expect(verbs(calls)).not.toContain("shutdown");
    expect(verbs(calls)).not.toContain("boot");
  });

  it("tolerates a boot that loses a race to 'current state: Booted'", async () => {
    const f = fakeSimctl();
    f.res.fail.boot = new Error("Unable to boot device in current state: Booted");
    const { driver, calls } = make(f);
    await driver.start();
    await driver.stop();
    expect(verbs(calls)).not.toContain("shutdown");
  });

  it("reports an error when boot fails", async () => {
    const f = fakeSimctl();
    f.res.fail.boot = new Error("no such device");
    const { driver } = make(f);
    await expect(driver.start()).rejects.toThrow("no such device");
    expect(driver.toInfo()).toMatchObject({ status: "error", error: "no such device" });
    expect(driver.isAlive).toBe(false);
  });

  it("never runs delete or erase", async () => {
    const { driver, calls } = make();
    await driver.start();
    await driver.stop();
    expect(verbs(calls)).not.toContain("delete");
    expect(verbs(calls)).not.toContain("erase");
  });

  it("detects an exit from the list poll and fires onExit once", async () => {
    const { driver, res, calls } = make();
    const onExit = vi.fn();
    driver.onExit(onExit);
    await driver.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(onExit).not.toHaveBeenCalled();
    res.state = "Shutdown";
    await vi.advanceTimersByTimeAsync(5000);
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(driver.isAlive).toBe(false);
    expect(driver.toInfo().status).toBe("exited");
    const before = calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls.length).toBe(before);
    // The user rebooted it: that boot is not ours, so stop() must not shut it down.
    res.state = "Booted";
    await driver.stop();
    expect(verbs(calls)).not.toContain("shutdown");
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("a failed shutdown keeps ownership so a second stop() retries", async () => {
    const f = fakeSimctl();
    const { driver, calls, res } = make(f);
    await driver.start();
    res.fail.shutdown = new Error("CoreSimulatorService restarted");
    await expect(driver.stop()).rejects.toThrow("CoreSimulatorService restarted");
    expect(driver.toInfo().status).toBe("exited");
    delete res.fail.shutdown;
    await driver.stop();
    expect(verbs(calls).filter((v) => v === "shutdown")).toHaveLength(2);
    expect(res.state).toBe("Shutdown");
  });

  it("treats 'current state: Shutdown' from shutdown as success", async () => {
    const f = fakeSimctl();
    const { driver, res } = make(f);
    await driver.start();
    res.fail.shutdown = new Error("Unable to shutdown device in current state: Shutdown");
    await expect(driver.stop()).resolves.toBeUndefined();
  });

  it("a retried start() after a failed one still remembers it booted the simulator", async () => {
    const f = fakeSimctl();
    const { driver, calls, res } = make(f);
    res.fail.bootstatus = new Error("timeout");
    await expect(driver.start()).rejects.toThrow("timeout");
    delete res.fail.bootstatus;
    await driver.start();
    await driver.stop();
    expect(verbs(calls)).toContain("shutdown");
  });

  it("a boot left unobserved after a failed start is no longer ours to shut down", async () => {
    const { driver, calls, res } = make();
    const onExit = vi.fn();
    driver.onExit(onExit);
    res.fail.bootstatus = new Error("timeout");
    await expect(driver.start()).rejects.toThrow("timeout");
    res.state = "Shutdown";
    await vi.advanceTimersByTimeAsync(5000);
    res.state = "Booted"; // the user reboots in Simulator.app
    await vi.advanceTimersByTimeAsync(5000);
    // start() already rejected, so the poll must not report an exit for a never-alive driver
    expect(onExit).not.toHaveBeenCalled();
    await driver.stop();
    expect(verbs(calls)).not.toContain("shutdown");
    expect(onExit).toHaveBeenCalledTimes(1); // stop()'s own markExited
  });

  it("one throwing exit listener does not starve the rest", async () => {
    const { driver } = make();
    const second = vi.fn();
    driver.onExit(() => {
      throw new Error("boom");
    });
    driver.onExit(second);
    await driver.start();
    await driver.stop();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("keeps polling through a failed probe", async () => {
    const { driver, res } = make();
    const onExit = vi.fn();
    driver.onExit(onExit);
    await driver.start();
    res.fail.list = new Error("transient");
    await vi.advanceTimersByTimeAsync(5000);
    expect(driver.isAlive).toBe(true);
    delete res.fail.list;
    res.state = "Shutdown";
    await vi.advanceTimersByTimeAsync(5000);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("an unsubscribed exit listener is not called", async () => {
    const { driver, res } = make();
    const onExit = vi.fn();
    driver.onExit(onExit)();
    await driver.start();
    res.state = "Shutdown";
    await vi.advanceTimersByTimeAsync(5000);
    expect(onExit).not.toHaveBeenCalled();
  });

  describe("screenshot", () => {
    /** The private directory a screenshot call was given. */
    const shotDir = (calls: string[][]) => dirname(calls.find((c) => c[0] === "io")!.at(-1)!);

    it("writes to a private temp file, returns the PNG and removes the directory", async () => {
      const { driver, calls, res, shotDirModes } = make();
      res.shot.file = png(3, 2);
      const out = await driver.screenshot();
      expect(Buffer.from(out).equals(png(3, 2))).toBe(true);
      const args = calls[0]!;
      expect(args.slice(0, 4)).toEqual(["io", UDID, "screenshot", "--type=png"]);
      expect(args).not.toContain("-");
      expect(args.at(-1)!.startsWith(tmpdir())).toBe(true);
      expect(shotDirModes).toEqual([0o700]);
      expect(existsSync(shotDir(calls))).toBe(false);
    });

    it("uses a fresh directory per call", async () => {
      const { driver, calls } = make();
      await driver.screenshot();
      await driver.screenshot();
      expect(calls[0]!.at(-1)).not.toBe(calls[1]!.at(-1));
    });

    it("502s on a file that is not a PNG, with the file's first bytes, and cleans up", async () => {
      const { driver, calls, res } = make();
      res.shot.file = Buffer.from("An error\x01 occurred");
      const err = await driver.screenshot().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DeviceActionError);
      expect((err as DeviceActionError).statusCode).toBe(502);
      expect((err as Error).message).toBe("screencap did not return a PNG: An error? occurred");
      expect(existsSync(shotDir(calls))).toBe(false);
    });

    it("502s when simctl writes no file, quoting what it printed", async () => {
      const { driver, calls, res } = make();
      res.shot = { file: null, stderr: Buffer.from("Wrote screenshot to: /x/-\n") };
      await expect(driver.screenshot()).rejects.toMatchObject({
        statusCode: 502,
        message: "screencap did not return a PNG: Wrote screenshot to: /x/-",
      });
      expect(existsSync(shotDir(calls))).toBe(false);
    });

    it("502s on an oversize file without reading it, and cleans up", async () => {
      const { driver, calls, res } = make();
      res.shot.size = 64 * 1024 * 1024 + 1;
      await expect(driver.screenshot()).rejects.toMatchObject({
        statusCode: 502,
        message: `screencap returned ${64 * 1024 * 1024 + 1} bytes, over the ${64 * 1024 * 1024}-byte limit`,
      });
      expect(existsSync(shotDir(calls))).toBe(false);
    });

    it("propagates a simctl failure and still removes the directory", async () => {
      const { driver, calls, res } = make();
      res.fail.io = new Error("exit 1: no such device");
      await expect(driver.screenshot()).rejects.toThrow("exit 1: no such device");
      expect(existsSync(shotDir(calls))).toBe(false);
    });

    it("removes a partly written file when simctl fails after writing", async () => {
      const { driver, calls, res } = make();
      res.shot.file = png().subarray(0, 10);
      res.fail.io = new Error("timed out");
      await expect(driver.screenshot()).rejects.toThrow("timed out");
      expect(existsSync(shotDir(calls))).toBe(false);
    });

    it("rethrows an open failure other than ENOENT, and still cleans up", async () => {
      const { driver, calls } = make();
      openFail.next = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      await expect(driver.screenshot()).rejects.toThrow("EACCES: permission denied");
      expect(existsSync(shotDir(calls))).toBe(false);
    });

    it("quotes both what simctl printed and what it wrote", async () => {
      const { driver, res } = make();
      res.shot = { file: Buffer.from("garbage"), stderr: Buffer.from("Wrote screenshot to: /x\n") };
      await expect(driver.screenshot()).rejects.toMatchObject({
        statusCode: 502,
        message: "screencap did not return a PNG: Wrote screenshot to: /x | garbage",
      });
    });

    it("502s on a PNG with no readable header", async () => {
      const { driver, calls, res } = make();
      res.shot.file = png().subarray(0, 12);
      await expect(driver.screenshot()).rejects.toMatchObject({
        statusCode: 502,
        message: "screencap returned a PNG with no readable header",
      });
      expect(existsSync(shotDir(calls))).toBe(false);
    });
  });

  describe("logs", () => {
    const sample = Array.from({ length: 300 }, (_, i) => `line ${i} ${i % 50 === 0 ? "Boom" : ""}`);

    it("keeps the last 200 lines by default and honours lines", async () => {
      const { driver, calls, res } = make();
      res.out.spawn = Buffer.from(sample.join("\n") + "\n");
      const all = (await driver.logs({})).split("\n");
      expect(all).toHaveLength(200);
      expect(all.at(-1)).toBe("line 299 ");
      expect(calls[0]).toEqual([
        "spawn",
        UDID,
        "log",
        "show",
        "--last",
        "5m",
        "--style",
        "compact",
      ]);
      expect((await driver.logs({ lines: 3 })).split("\n")).toHaveLength(3);
    });

    it("filters by case-insensitive substring in Node", async () => {
      const { driver, calls, res } = make();
      res.out.spawn = Buffer.from(sample.join("\n"));
      const out = (await driver.logs({ filter: "bOOm" })).split("\n");
      expect(out).toEqual([
        "line 0 Boom",
        "line 50 Boom",
        "line 100 Boom",
        "line 150 Boom",
        "line 200 Boom",
        "line 250 Boom",
      ]);
      expect(calls[0]!.join(" ")).not.toContain("bOOm");
    });
  });

  it("round-trips the clipboard through pbcopy/pbpaste", async () => {
    const { driver, calls, inputs, res } = make();
    await driver.clipboard.set("héllo", true);
    expect(calls[0]).toEqual(["pbcopy", UDID]);
    expect(inputs[0]).toBe("héllo");
    res.out.pbpaste = Buffer.from("héllo");
    expect(await driver.clipboard.get()).toBe("héllo");
    expect(calls[1]).toEqual(["pbpaste", UDID]);
    await expect(driver.clipboard.set("x".repeat(10_000_000), false)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  describe("supports() through performDeviceAction", () => {
    it("answers screenshot, logcat and clipboard", async () => {
      const { driver, calls, res } = make();
      res.shot.file = png();
      res.out.spawn = Buffer.from("a\nb");
      res.out.pbpaste = Buffer.from("clip");
      expect(await performDeviceAction(driver, { action: "screenshot" })).toMatchObject({
        nativeWidth: 3,
        nativeHeight: 2,
      });
      expect(calls.flat()).not.toContain("-");
      expect(existsSync(dirname(calls[0]!.at(-1)!))).toBe(false);
      expect(await performDeviceAction(driver, { action: "logcat" })).toEqual({ logcat: "a\nb" });
      expect(await performDeviceAction(driver, { action: "clipboard", op: "get" })).toEqual({
        text: "clip",
      });
      expect(
        await performDeviceAction(driver, { action: "clipboard", op: "set", text: "t" }),
      ).toEqual({ ok: true });
    });

    it("opens an http(s) URL with simctl openurl, as one argv entry", async () => {
      const { driver, calls } = make();
      const url = " http://127.0.0.1:5173/a b?x=1&y=$(id)\n";
      expect(await performDeviceAction(driver, { action: "openurl", url })).toEqual({ ok: true });
      expect(calls).toEqual([["openurl", UDID, "http://127.0.0.1:5173/a%20b?x=1&y=$(id)"]]);
    });

    it("refuses a non-http(s) URL before any simctl call", async () => {
      const { driver, calls } = make();
      await expect(driver.openUrl("tel:123")).rejects.toMatchObject({ statusCode: 400 });
      expect(calls).toEqual([]);
    });

    it("refuses key as unsupported", async () => {
      const { driver, calls } = make();
      await expect(
        performDeviceAction(driver, { action: "key", androidKeyCode: 4 }),
      ).rejects.toMatchObject({
        statusCode: 400,
        message: 'action "key" is not supported on ios devices',
      });
      expect(calls).toEqual([]);
    });

    it.each([
      { action: "tap", x: 1, y: 2 },
      { action: "swipe", x1: 1, y1: 2, x2: 3, y2: 4 },
      { action: "text", text: "a" },
    ] as const)("supports $action and fails with 400 without a companion", async (action) => {
      const { driver } = make();
      await expect(performDeviceAction(driver, action)).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining("no live idb companion"),
      });
    });
  });

  it("video, input and keyframe are inert", async () => {
    const { driver } = make();
    const off = driver.onVideoPacket(vi.fn());
    off();
    driver.onClipboard(vi.fn())();
    await expect(driver.requestKeyframe()).resolves.toBeUndefined();
    await expect(driver.input({ type: "back" })).resolves.toBeUndefined();
    expect(driver.hasLiveControl).toBe(false);
    expect(driver.platform).toBe("ios");
  });
});

describe("IosSimulatorDriver stop during start", () => {
  it("a stop that lands mid-boot is not undone: no bootstatus, simulator shut down again", async () => {
    const f = fakeSimctl();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const inner = f.simctl;
    const gated: SimctlRunner = async (args, options) => {
      const out = await inner(args, options);
      if (args[0] === "boot") await gate;
      return out;
    };
    const driver = new IosSimulatorDriver({ id: "9", udid: UDID, label: "iPhone", simctl: gated });
    const starting = driver.start();
    await vi.waitFor(() => expect(verbs(f.calls)).toContain("boot"));
    await driver.stop();
    release();
    await starting;
    expect(verbs(f.calls)).not.toContain("bootstatus");
    expect(f.res.state).toBe("Shutdown");
    expect(driver.isAlive).toBe(false);
  });

  it("a stop that lands during bootstatus leaves the driver not alive", async () => {
    const f = fakeSimctl();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const inner = f.simctl;
    const gated: SimctlRunner = async (args, options) => {
      const out = await inner(args, options);
      if (args[0] === "bootstatus") await gate;
      return out;
    };
    const driver = new IosSimulatorDriver({ id: "9", udid: UDID, label: "iPhone", simctl: gated });
    const starting = driver.start();
    await vi.waitFor(() => expect(verbs(f.calls)).toContain("bootstatus"));
    await driver.stop();
    release();
    await starting;
    expect(driver.isAlive).toBe(false);
    expect(f.res.state).toBe("Shutdown");
  });
});

describe("execSimctl", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("runs xcrun simctl with argv, a timeout and an output cap", async () => {
    const stdin = { on: vi.fn(), end: vi.fn() };
    execFileMock.mockImplementation((...a) => {
      const cb = a[3];
      cb(null, Buffer.from("ok"), Buffer.alloc(0));
      return { stdin };
    });
    const out = await execSimctl(["pbcopy", UDID], { input: "hi", timeoutMs: 5, maxBytes: 7 });
    expect(out.toString()).toBe("ok");
    expect(execFileMock).toHaveBeenCalledWith(
      "xcrun",
      ["simctl", "pbcopy", UDID],
      expect.objectContaining({ timeout: 5, maxBuffer: 7, encoding: "buffer" }),
      expect.any(Function),
    );
    expect(stdin.end).toHaveBeenCalledWith("hi");
  });

  it("hands a successful call's stderr to onStderr", async () => {
    execFileMock.mockImplementation((...a) => {
      const cb = a[3];
      cb(null, Buffer.alloc(0), Buffer.from("Wrote screenshot to: /tmp/x"));
      return {};
    });
    const onStderr = vi.fn();
    await execSimctl(["io", UDID, "screenshot", "/tmp/x"], { onStderr });
    expect(onStderr.mock.calls[0]![0].toString()).toBe("Wrote screenshot to: /tmp/x");
  });

  it("rejects with stderr detail, and applies default limits", async () => {
    execFileMock.mockImplementation((...a) => {
      const cb = a[3];
      cb(new Error("exit 1"), Buffer.alloc(0), Buffer.from("bad device\n"));
      return {};
    });
    await expect(execSimctl(["boot", UDID])).rejects.toThrow("exit 1: bad device");
    expect(execFileMock.mock.calls[0]![2]).toMatchObject({
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
  });
});
