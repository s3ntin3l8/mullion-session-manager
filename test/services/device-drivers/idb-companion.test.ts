import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  allocateLoopbackPort,
  IdbCompanion,
  parseStaleCompanionPids,
  StderrRingBuffer,
  type IdbCompanionSpawn,
} from "../../../src/services/device-drivers/idb-companion.js";
// grpc-js's own table of channel keys; it drops an unknown key silently.
import { recognizedOptions } from "@grpc/grpc-js/build/src/channel-options.js";
import {
  createIdbGrpcClient,
  IDB_CHANNEL_OPTIONS,
} from "../../../src/services/device-drivers/idb-grpc.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_COMPANION_SCRIPT = path.resolve(here, "./fake-idb-companion.mjs");
const FAKE_EXEC_PATH = "/usr/local/bin/idb_companion";

const UDID_A = "11111111-2222-3333-4444-555555555555";
const UDID_B = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    return true;
  }
}

async function waitForPidDead(pid: number, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !isPidAlive(pid);
}

describe("idb-grpc client", () => {
  it("caps reconnect backoff with channel keys grpc-js recognises (#3527)", () => {
    // A misspelt key is ignored and quietly restores the 120 s backoff.
    for (const key of Object.keys(IDB_CHANNEL_OPTIONS)) {
      expect(recognizedOptions).toHaveProperty([key]);
    }
    expect(IDB_CHANNEL_OPTIONS["grpc.max_reconnect_backoff_ms"]).toBeLessThanOrEqual(1_000);
  });

  it("rejects invalid ports so only valid loopback ports can be targeted", () => {
    expect(() => createIdbGrpcClient(0)).toThrow(RangeError);
    expect(() => createIdbGrpcClient(-1)).toThrow(RangeError);
    expect(() => createIdbGrpcClient(65536)).toThrow(RangeError);
    expect(() => createIdbGrpcClient(Number.NaN)).toThrow(RangeError);
  });
});

describe("StderrRingBuffer", () => {
  it("retains only the trailing maxBytes when appended data exceeds capacity", () => {
    const ring = new StderrRingBuffer(10);
    ring.append("12345");
    ring.append("67890");
    expect(ring.toString()).toBe("1234567890");

    ring.append("xyz");
    expect(ring.toString()).toBe("4567890xyz");

    ring.append("0123456789XYZ");
    expect(ring.toString()).toBe("3456789XYZ");
  });
});

describe("parseStaleCompanionPids", () => {
  it("matches only idb_companion processes with the exact --udid argument", () => {
    const psOutput = [
      `101 /opt/homebrew/bin/idb_companion --udid ${UDID_A} --grpc-port 10882`,
      `102 /opt/homebrew/bin/idb_companion --udid=${UDID_A.toLowerCase()} --grpc-port 10883`,
      `103 /opt/homebrew/bin/idb_companion --udid ${UDID_B} --grpc-port 10884`,
      `104 /opt/homebrew/bin/idb_companion --udid ${UDID_A}-extra --grpc-port 10885`,
      `105 /usr/bin/grep --udid ${UDID_A}`,
      `106 /usr/bin/node ${FAKE_COMPANION_SCRIPT} --udid ${UDID_A} --grpc-port 10886`,
      `${process.pid} /opt/homebrew/bin/idb_companion --udid ${UDID_A}`,
    ].join("\n");

    const matched = parseStaleCompanionPids(psOutput, UDID_A, FAKE_EXEC_PATH);
    expect(matched).toEqual([101, 102, 106]);
  });
});

describe("IdbCompanion", () => {
  const trackedChildren: ChildProcess[] = [];
  const trackedCompanions: IdbCompanion[] = [];

  function makeFakeSpawn(
    envOverrides: Record<string, string> = {},
    recordedCalls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = [],
  ): IdbCompanionSpawn {
    return (command, args, options) => {
      recordedCalls.push({ command, args, options });
      const child = spawn(process.execPath, [FAKE_COMPANION_SCRIPT, ...args], {
        ...options,
        env: { ...process.env, ...envOverrides },
      });
      trackedChildren.push(child);
      return child;
    };
  }

  afterEach(async () => {
    for (const companion of trackedCompanions.splice(0)) {
      await companion.stop();
    }
    for (const child of trackedChildren.splice(0)) {
      if (child.pid && isPidAlive(child.pid)) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Ignore already exited.
        }
      }
    }
  });

  it("starts on a free loopback port, serves describe, captures stderr, and stops cleanly", async () => {
    const calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = [];
    const unexpectedExits: Array<{ code: number | null; signal: NodeJS.Signals | null }> = [];

    const companion = new IdbCompanion({
      udid: UDID_A,
      executablePath: FAKE_EXEC_PATH,
      spawn: makeFakeSpawn({}, calls),
      killStaleCompanions: async () => undefined,
      onExit: (code, signal) => unexpectedExits.push({ code, signal }),
    });
    trackedCompanions.push(companion);

    await companion.start();

    expect(companion.isRunning).toBe(true);
    expect(companion.port).toBeTypeOf("number");
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe(FAKE_EXEC_PATH);
    expect(calls[0].args).toEqual(["--udid", UDID_A, "--grpc-port", String(companion.port)]);
    expect(calls[0].options.shell).toBe(false);

    const desc = await companion.client!.describe();
    expect(desc.target_description?.udid).toBe(UDID_A);
    expect(desc.target_description?.screen_dimensions).toEqual({
      width: 1206,
      height: 2622,
      density: 3,
      width_points: 402,
      height_points: 874,
    });
    expect(companion.getStderr()).toContain("fake idb_companion listening on 127.0.0.1:");

    // Exercise videoStream and hid RPCs against the fake companion as well.
    const video = companion.client!.videoStream({ fps: 30, format: "H264" });
    const firstChunk = await new Promise<Buffer>((resolve, reject) => {
      video.once("data", (res) => resolve(Buffer.from(res.payload?.data ?? [])));
      video.once("error", reject);
    });
    expect(firstChunk).toEqual(Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67]));
    video.write({ stop: {} });
    video.end();

    const hid = companion.client!.hid();
    await new Promise<void>((resolve, reject) => {
      hid.once("error", reject);
      hid.once("finish", resolve);
      hid.write({
        press: {
          action: { touch: { point: { x: 100, y: 200 } } },
          direction: "DOWN",
        },
      });
      hid.end();
    });

    const pid = trackedChildren[0].pid!;
    expect(isPidAlive(pid)).toBe(true);

    await companion.stop();

    expect(companion.isRunning).toBe(false);
    expect(companion.port).toBeNull();
    expect(await waitForPidDead(pid)).toBe(true);
    expect(unexpectedExits).toEqual([]);
  });

  it("kills the child on readiness timeout and rejects", async () => {
    const companion = new IdbCompanion({
      udid: UDID_A,
      executablePath: FAKE_EXEC_PATH,
      spawn: makeFakeSpawn({ FAKE_IDB_MODE: "hang-describe" }),
      killStaleCompanions: async () => undefined,
      startTimeoutMs: 400,
      readyPollIntervalMs: 50,
      stopGraceMs: 200,
    });
    trackedCompanions.push(companion);

    await expect(companion.start()).rejects.toThrow(/failed to become ready within 400ms/);

    const pid = trackedChildren[0].pid!;
    expect(await waitForPidDead(pid)).toBe(true);
    expect(companion.isRunning).toBe(false);
  });

  it("rejects on unexpected describe UDID while accepting a matching UDID under the same timeout", async () => {
    const sharedOptions = {
      udid: UDID_A,
      executablePath: FAKE_EXEC_PATH,
      killStaleCompanions: async () => undefined,
      startTimeoutMs: 3000,
      readyPollIntervalMs: 50,
      stopGraceMs: 200,
    };

    const mismatched = new IdbCompanion({
      ...sharedOptions,
      spawn: makeFakeSpawn({ FAKE_IDB_DESCRIBE_UDID: UDID_B }),
    });
    trackedCompanions.push(mismatched);

    const t0 = Date.now();
    try {
      await mismatched.start();
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toMatch(/describe returned unexpected udid/);
      expect((err as Error).message).not.toMatch(/failed to become ready/);
    }
    expect(Date.now() - t0).toBeLessThan(2000);

    const mismatchedPid = trackedChildren[0].pid!;
    expect(await waitForPidDead(mismatchedPid)).toBe(true);
    expect(mismatched.isRunning).toBe(false);

    const matching = new IdbCompanion({
      ...sharedOptions,
      spawn: makeFakeSpawn({ FAKE_IDB_DESCRIBE_UDID: UDID_A }),
    });
    trackedCompanions.push(matching);

    await expect(matching.start()).resolves.toBeUndefined();
    expect(matching.isRunning).toBe(true);
    await matching.stop();
  });

  it("restarts by killing the old process and starting a fresh one", async () => {
    const companion = new IdbCompanion({
      udid: UDID_A,
      executablePath: FAKE_EXEC_PATH,
      spawn: makeFakeSpawn(),
      killStaleCompanions: async () => undefined,
    });
    trackedCompanions.push(companion);

    await companion.start();
    const firstPid = trackedChildren[0].pid!;
    expect(isPidAlive(firstPid)).toBe(true);

    await companion.restart();
    expect(await waitForPidDead(firstPid)).toBe(true);

    const secondPid = trackedChildren[1].pid!;
    expect(secondPid).not.toBe(firstPid);
    expect(isPidAlive(secondPid)).toBe(true);

    const desc = await companion.client!.describe();
    expect(desc.target_description?.udid).toBe(UDID_A);
  });

  it("escalates to SIGKILL in stop() when the child ignores SIGTERM", async () => {
    const companion = new IdbCompanion({
      udid: UDID_A,
      executablePath: FAKE_EXEC_PATH,
      spawn: makeFakeSpawn({ FAKE_IDB_MODE: "ignore-sigterm" }),
      killStaleCompanions: async () => undefined,
      stopGraceMs: 150,
      stderrMaxBytes: 24,
    });
    trackedCompanions.push(companion);

    await companion.start();
    const pid = trackedChildren[0].pid!;

    await companion.stop();

    expect(await waitForPidDead(pid)).toBe(true);
    expect(companion.getStderr()).toContain("ignoring SIGTERM");
    expect(Buffer.byteLength(companion.getStderr(), "utf8")).toBeLessThanOrEqual(24);
  });

  it("emits onExit with the exit code on an unexpected crash", async () => {
    const companion = new IdbCompanion({
      udid: UDID_A,
      executablePath: FAKE_EXEC_PATH,
      spawn: makeFakeSpawn({ FAKE_IDB_MODE: "exit-after-ready", FAKE_IDB_EXIT_MS: "120" }),
      killStaleCompanions: async () => undefined,
    });
    trackedCompanions.push(companion);

    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        companion.onExit((code, signal) => resolve({ code, signal }));
      },
    );

    await companion.start();
    const exit = await exitPromise;

    expect(exit.code).toBe(42);
    expect(companion.isRunning).toBe(false);
    expect(companion.getStderr()).toContain("simulated crash");
  });

  it("kills stale companions matching the exact --udid without touching other devices", async () => {
    const stalePortA = await allocateLoopbackPort();
    const otherPortB = await allocateLoopbackPort();

    const staleChildA = spawn(
      process.execPath,
      [FAKE_COMPANION_SCRIPT, "--udid", UDID_A, "--grpc-port", String(stalePortA)],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const otherChildB = spawn(
      process.execPath,
      [FAKE_COMPANION_SCRIPT, "--udid", UDID_B, "--grpc-port", String(otherPortB)],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    trackedChildren.push(staleChildA, otherChildB);

    // Wait briefly so both processes appear in ps before start() runs cleanup.
    await new Promise((r) => setTimeout(r, 150));
    expect(isPidAlive(staleChildA.pid!)).toBe(true);
    expect(isPidAlive(otherChildB.pid!)).toBe(true);

    const companionA = new IdbCompanion({
      udid: UDID_A,
      executablePath: FAKE_EXEC_PATH,
      spawn: makeFakeSpawn(),
    });
    trackedCompanions.push(companionA);

    await companionA.start();

    expect(await waitForPidDead(staleChildA.pid!)).toBe(true);
    expect(isPidAlive(otherChildB.pid!)).toBe(true);
  });
});
