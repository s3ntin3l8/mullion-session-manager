import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

// `xcrun` is faked at node:child_process, as agent-detect.test.ts fakes its
// probes: no real binary runs, whatever the host has installed.
const execFile = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => execFile(...args),
}));

const { detectCapabilities, getCachedCapabilities } =
  await import("../../src/services/host-capabilities.js");

const realPlatform = process.platform;
function stubPlatform(value: string) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

type Step = "find" | "first" | "list";
type Outcome = "ok" | "exit1" | "timeout" | "enoent";
const RUNTIMES = JSON.stringify({ runtimes: [{ identifier: "ios-27" }] });

function stepOf(cmd: string, args: string[]): Step {
  if (cmd === "xcodebuild") return "first";
  return args[0] === "--find" ? "find" : "list";
}

/** Fakes the three probe steps; unspecified steps pass. */
function xcodeSteps(outcomes: Partial<Record<Step, Outcome>>, listStdout = RUNTIMES) {
  execFile.mockImplementation(
    (
      cmd: string,
      args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout?: string) => void,
    ) => {
      const o = outcomes[stepOf(cmd, args)] ?? "ok";
      if (o === "ok") return cb(null, stepOf(cmd, args) === "list" ? listStdout : "");
      if (o === "exit1") return cb(Object.assign(new Error("exit 1"), { code: 1 }));
      if (o === "timeout")
        return cb(Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM" }));
      return cb(Object.assign(new Error("spawn xcrun ENOENT"), { code: "ENOENT" }));
    },
  );
}
function xcrunExits(ok: boolean) {
  xcodeSteps({ find: ok ? "ok" : "exit1" });
}
const stepsRun = () => execFile.mock.calls.map((c) => stepOf(c[0] as string, c[1] as string[]));

let dir: string;
let emulator: string;
function fakeApp(opts: { enabled: boolean; emulatorPath: string }) {
  return {
    deviceEmulatorEnabled: opts.enabled,
    config: { DEVICE_EMULATOR_PATH: opts.emulatorPath },
    log: { info: vi.fn(), warn: vi.fn() },
  } as unknown as FastifyInstance;
}

describe("host capability detection (issue #2306)", () => {
  beforeEach(() => {
    execFile.mockReset();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "caps-"));
    emulator = path.join(dir, "emulator");
    fs.writeFileSync(emulator, "#!/bin/sh\n", { mode: 0o755 });
  });
  afterEach(() => {
    stubPlatform(realPlatform);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reports xcode on darwin when every step passes", async () => {
    stubPlatform("darwin");
    xcrunExits(true);
    const app = fakeApp({ enabled: false, emulatorPath: "" });
    expect(await detectCapabilities(app)).toEqual(["xcode"]);
    expect(execFile).toHaveBeenCalledWith(
      "xcrun",
      ["--find", "simctl"],
      expect.objectContaining({ timeout: 10_000 }),
      expect.any(Function),
    );
  });

  it("omits xcode on darwin with only the Command Line Tools", async () => {
    stubPlatform("darwin");
    xcrunExits(false);
    expect(await detectCapabilities(fakeApp({ enabled: false, emulatorPath: "" }))).toEqual([]);
  });

  it("omits xcode when xcrun cannot even be launched", async () => {
    stubPlatform("darwin");
    execFile.mockImplementation(() => {
      throw new Error("spawn xcrun ENOENT");
    });
    expect(await detectCapabilities(fakeApp({ enabled: false, emulatorPath: "" }))).toEqual([]);
  });

  it.each([
    ["simctl is missing", { find: "exit1" }, ["find"]],
    ["first launch is incomplete", { first: "exit1" }, ["find", "first"]],
    ["the runtime list command fails", { list: "exit1" }, ["find", "first", "list"]],
  ] as const)("omits xcode when %s, without running later steps", async (_n, outcomes, ran) => {
    stubPlatform("darwin");
    xcodeSteps(outcomes);
    expect(await detectCapabilities(fakeApp({ enabled: false, emulatorPath: "" }))).toEqual([]);
    expect(stepsRun()).toEqual(ran);
  });

  it("omits xcode when no simulator runtime is listed", async () => {
    stubPlatform("darwin");
    xcodeSteps({}, JSON.stringify({ runtimes: [] }));
    expect(await detectCapabilities(fakeApp({ enabled: false, emulatorPath: "" }))).toEqual([]);
  });

  it("never runs simctl list when first launch is outstanding", async () => {
    stubPlatform("darwin");
    xcodeSteps({ first: "exit1" });
    await detectCapabilities(fakeApp({ enabled: false, emulatorPath: "" }));
    expect(execFile).not.toHaveBeenCalledWith(
      "xcrun",
      expect.arrayContaining(["list"]),
      expect.anything(),
      expect.anything(),
    );
  });

  it.each(["timeout", "enoent"] as const)(
    "keeps a previously reported xcode when a step hits %s, and warns",
    async (kind) => {
      stubPlatform("darwin");
      const app = fakeApp({ enabled: false, emulatorPath: "" });
      xcodeSteps({});
      expect(await detectCapabilities(app)).toEqual(["xcode"]);
      xcodeSteps({ first: kind });
      expect(await detectCapabilities(app)).toEqual(["xcode"]);
      expect(app.log.warn).toHaveBeenCalled();
      // A clean non-zero exit afterwards is a real "lacks".
      xcodeSteps({ first: "exit1" });
      expect(await detectCapabilities(app)).toEqual([]);
    },
  );

  it("logs the failing step once per state change", async () => {
    stubPlatform("darwin");
    const app = fakeApp({ enabled: false, emulatorPath: "" });
    xcodeSteps({ first: "exit1" });
    await detectCapabilities(app);
    await detectCapabilities(app);
    expect(app.log.info).toHaveBeenCalledTimes(1);
    expect(app.log.info).toHaveBeenCalledWith(expect.stringContaining("first launch incomplete"));
    xcodeSteps({ find: "exit1" });
    await detectCapabilities(app);
    expect(app.log.info).toHaveBeenCalledTimes(2);
  });

  it("answers GET /internal/capabilities through the route", async () => {
    stubPlatform("darwin");
    xcodeSteps({});
    const Fastify = (await import("fastify")).default;
    const { registerProbeRoutes } = await import("../../src/routes/internal-probes.js");
    const app = Fastify();
    Object.assign(app, { deviceEmulatorEnabled: false, config: { DEVICE_EMULATOR_PATH: "" } });
    registerProbeRoutes(app, {});
    const res = await app.inject({ method: "GET", url: "/internal/capabilities" });
    expect(res.json()).toEqual({ capabilities: ["xcode"] });
    await app.close();
  });

  it.each(["linux", "win32"])("never spawns xcrun on %s", async (platform) => {
    stubPlatform(platform);
    xcrunExits(true);
    expect(await detectCapabilities(fakeApp({ enabled: false, emulatorPath: "" }))).toEqual([]);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("reports android-emulator when enabled and DEVICE_EMULATOR_PATH is executable", async () => {
    stubPlatform("linux");
    expect(await detectCapabilities(fakeApp({ enabled: true, emulatorPath: emulator }))).toEqual([
      "android-emulator",
    ]);
  });

  it("omits android-emulator when the device panel's emulator support is off", async () => {
    expect(await detectCapabilities(fakeApp({ enabled: false, emulatorPath: emulator }))).toEqual(
      [],
    );
  });

  it("omits android-emulator for an empty path (DeviceManager has no PATH fallback)", async () => {
    expect(await detectCapabilities(fakeApp({ enabled: true, emulatorPath: "" }))).toEqual([]);
  });

  it("omits android-emulator when the binary is missing or not executable", async () => {
    expect(
      await detectCapabilities(fakeApp({ enabled: true, emulatorPath: path.join(dir, "nope") })),
    ).toEqual([]);
    const plain = path.join(dir, "plain");
    fs.writeFileSync(plain, "x", { mode: 0o644 });
    expect(await detectCapabilities(fakeApp({ enabled: true, emulatorPath: plain }))).toEqual([]);
  });

  it("can report both", async () => {
    stubPlatform("darwin");
    xcrunExits(true);
    expect(await detectCapabilities(fakeApp({ enabled: true, emulatorPath: emulator }))).toEqual([
      "xcode",
      "android-emulator",
    ]);
  });

  it("caches, and re-probes in the background once the TTL lapses", async () => {
    stubPlatform("darwin");
    xcrunExits(true);
    const app = fakeApp({ enabled: false, emulatorPath: "" });
    vi.useFakeTimers();
    try {
      expect(await getCachedCapabilities(app)).toEqual(["xcode"]);
      expect(await getCachedCapabilities(app)).toEqual(["xcode"]);
      expect(execFile).toHaveBeenCalledTimes(3); // one probe = three steps

      xcrunExits(false);
      vi.advanceTimersByTime(61_000);
      // Stale-while-revalidate: the stale answer is returned, the refresh runs.
      expect(await getCachedCapabilities(app)).toEqual(["xcode"]);
      await vi.waitFor(() => expect(execFile).toHaveBeenCalledTimes(4)); // find fails, short-circuits
      await vi.waitFor(async () => expect(await getCachedCapabilities(app)).toEqual([]));
    } finally {
      vi.useRealTimers();
    }
  });
});
