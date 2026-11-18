import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nalType } from "../../../src/services/device-drivers/annexb.js";
import { IdbCompanion } from "../../../src/services/device-drivers/idb-companion.js";
import type { IdbGrpcClient } from "../../../src/services/device-drivers/idb-grpc.js";
import {
  IosSimulatorDriver,
  type IdbCompanionHandle,
  type SimctlRunner,
} from "../../../src/services/device-drivers/ios-simulator.js";
import type { DeviceVideoPacket } from "../../../src/services/device-drivers/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(here, "../../fixtures/devices/idb-h264-sample.h264");
const FAKE_COMPANION_SCRIPT = path.resolve(here, "./fake-idb-companion.mjs");
const fixture = new Uint8Array(readFileSync(FIXTURE));
const UDID = "0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9";

const bootedSimctl: SimctlRunner = async (args) =>
  args[0] === "list"
    ? Buffer.from(JSON.stringify({ devices: { rt: [{ udid: UDID, state: "Booted" }] } }))
    : Buffer.alloc(0);

const kinds = (ps: DeviceVideoPacket[]) =>
  ps.map((p) => (p.type === "configuration" ? "config" : p.keyframe ? "key" : "delta"));

/** A stand-in for the gRPC duplex stream. */
class FakeStream extends EventEmitter {
  written: unknown[] = [];
  cancelled = false;
  write(m: unknown) {
    this.written.push(m);
    return true;
  }
  end() {}
  cancel() {
    this.cancelled = true;
  }
  feed(bytes: Uint8Array, chunk = 64) {
    for (let i = 0; i < bytes.length; i += chunk) {
      this.emit("data", { payload: { data: Buffer.from(bytes.subarray(i, i + chunk)) } });
    }
  }
}

function fakeCompanion() {
  const streams: FakeStream[] = [];
  const startArgs: unknown[] = [];
  const exitListeners = new Set<() => void>();
  const client = {
    videoStream: (start: unknown) => {
      startArgs.push(start);
      const s = new FakeStream();
      streams.push(s);
      return s;
    },
  } as unknown as IdbGrpcClient;
  const handle = {
    client,
    isRunning: true as boolean,
    start: vi.fn(async () => {
      handle.isRunning = true;
    }),
    restart: vi.fn(async () => {}),
    onExit: (l: () => void) => {
      exitListeners.add(l);
      return () => void exitListeners.delete(l);
    },
  } satisfies IdbCompanionHandle;
  return { handle, streams, startArgs, crash: () => exitListeners.forEach((l) => l()) };
}

function make(c = fakeCompanion(), streamReopenDelayMs = 1000) {
  const driver = new IosSimulatorDriver({
    id: "9",
    udid: UDID,
    label: null,
    simctl: bootedSimctl,
    companion: c.handle,
    streamReopenDelayMs,
  });
  return { driver, ...c };
}

describe("IosSimulatorDriver video (in-process companion)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("restarts the companion after boot and opens the stream with the decided request", async () => {
    const { driver, handle, startArgs } = make();
    await driver.start();
    expect(handle.restart).toHaveBeenCalledTimes(1);
    expect(startArgs).toEqual([
      {
        fps: 30,
        format: "H264",
        compression_quality: 1,
        scale_factor: 1,
        avg_bitrate: 0,
        key_frame_rate: 0,
      },
    ]);
    await driver.stop();
  });

  it("reports streaming only once the first keyframe has gone out", async () => {
    const { driver, streams } = make();
    await driver.start();
    expect(driver.toInfo().status).toBe("booting");
    const seen: DeviceVideoPacket[] = [];
    driver.onVideoPacket((p) => seen.push(p));
    // Cut so config completes but the IDR is still held back by the splitter.
    streams[0]!.feed(fixture.subarray(0, 40), 7);
    expect(driver.toInfo().status).toBe("booting");
    streams[0]!.feed(fixture.subarray(40));
    expect(kinds(seen).slice(0, 3)).toEqual(["config", "key", "delta"]);
    expect(driver.toInfo().status).toBe("streaming");
    await driver.stop();
  });

  it("replays config, the IDR and deltas to a late subscriber, and keeps feeding it", async () => {
    const { driver, streams } = make();
    await driver.start();
    streams[0]!.feed(fixture);
    const late: DeviceVideoPacket[] = [];
    driver.onVideoPacket((p) => late.push(p));
    const replayed = late.length;
    expect(replayed).toBeGreaterThanOrEqual(3);
    expect(kinds(late)[0]).toBe("config");
    expect(kinds(late)[1]).toBe("key");
    expect(
      kinds(late)
        .slice(2)
        .every((k) => k === "delta"),
    ).toBe(true);
    // Live packets after the replay: a fresh IDR restarts nothing for it.
    streams[0]!.feed(fixture);
    expect(late.length).toBeGreaterThan(replayed);
    await driver.stop();
  });

  it("a subscriber added before any keyframe gets nothing to replay", async () => {
    const { driver, streams } = make();
    await driver.start();
    const early: DeviceVideoPacket[] = [];
    driver.onVideoPacket((p) => early.push(p));
    expect(early).toEqual([]);
    streams[0]!.feed(fixture);
    expect(kinds(early)[0]).toBe("config");
    await driver.stop();
  });

  it("one throwing subscriber does not starve the others or the replay", async () => {
    const { driver, streams } = make();
    await driver.start();
    streams[0]!.feed(fixture);
    driver.onVideoPacket(() => {
      throw new Error("boom");
    });
    const ok = vi.fn();
    driver.onVideoPacket(ok);
    streams[0]!.feed(fixture);
    expect(ok).toHaveBeenCalled();
    await driver.stop();
  });

  it("requestKeyframe restarts the stream at most once per 5 s", async () => {
    const { driver, streams } = make();
    await driver.start();
    await driver.requestKeyframe();
    expect(streams).toHaveLength(1);
    vi.advanceTimersByTime(4999);
    await driver.requestKeyframe();
    expect(streams).toHaveLength(1);
    vi.advanceTimersByTime(1);
    await driver.requestKeyframe();
    expect(streams).toHaveLength(2);
    expect(streams[0]!.cancelled).toBe(true);
    await driver.requestKeyframe();
    expect(streams).toHaveLength(2);
    // The new stream's output (not the old one's) reaches subscribers.
    const seen: DeviceVideoPacket[] = [];
    driver.onVideoPacket((p) => seen.push(p));
    streams[0]!.feed(fixture);
    expect(seen).toEqual([]);
    streams[1]!.feed(fixture);
    expect(seen.length).toBeGreaterThan(0);
    await driver.stop();
  });

  it("requestKeyframe is a no-op without a companion or a live stream", async () => {
    const bare = new IosSimulatorDriver({ id: "1", udid: UDID, label: null, simctl: bootedSimctl });
    await bare.start();
    await expect(bare.requestKeyframe()).resolves.toBeUndefined();
    await bare.stop();
    const { driver } = make();
    await expect(driver.requestKeyframe()).resolves.toBeUndefined();
  });

  it("reopens the stream when it ends while the simulator is Booted", async () => {
    const { driver, streams, handle } = make();
    await driver.start();
    streams[0]!.feed(fixture);
    expect(driver.toInfo().status).toBe("streaming");
    streams[0]!.emit("end");
    await vi.advanceTimersByTimeAsync(1000);
    expect(streams).toHaveLength(2);
    expect(handle.start).not.toHaveBeenCalled();
    // The old GOP is gone: a late joiner sees nothing until the new stream's IDR.
    const late: DeviceVideoPacket[] = [];
    driver.onVideoPacket((p) => late.push(p));
    expect(late).toEqual([]);
    streams[1]!.feed(fixture);
    expect(kinds(late)[0]).toBe("config");
    await driver.stop();
  });

  it("restarts a crashed companion and reopens the stream", async () => {
    const { driver, streams, handle, crash } = make();
    await driver.start();
    handle.isRunning = false;
    crash();
    streams[0]!.emit("error", new Error("UNAVAILABLE"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(handle.start).toHaveBeenCalledTimes(1);
    expect(streams).toHaveLength(2);
    await driver.stop();
  });

  it("stops retrying after repeated failures and does nothing once stopped", async () => {
    const { driver, handle, streams } = make();
    await driver.start();
    handle.isRunning = false;
    handle.start.mockRejectedValue(new Error("no companion"));
    streams[0]!.emit("end");
    await vi.advanceTimersByTimeAsync(10_000);
    // The first stream's keyframe-less end counts as a failure too.
    expect(handle.start).toHaveBeenCalledTimes(4);
    expect(driver.toInfo()).toMatchObject({ status: "error", error: "no companion" });
    await driver.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(handle.start).toHaveBeenCalledTimes(4);
  });

  it("gives up when streams keep ending without a keyframe", async () => {
    const { driver, streams, handle } = make();
    await driver.start();
    for (let i = 0; i < 12; i++) {
      streams.at(-1)!.emit("error", new Error("UNAVAILABLE: target not ready"));
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(streams.length).toBeLessThanOrEqual(6);
    expect(handle.start).not.toHaveBeenCalled();
    expect(driver.toInfo()).toMatchObject({ status: "error" });
    await driver.stop();
  });

  it("a stream that ends without any error still counts as a failure", async () => {
    const { driver, streams } = make();
    await driver.start();
    for (let i = 0; i < 12; i++) {
      streams.at(-1)!.emit("end");
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(streams.length).toBeLessThanOrEqual(6);
    expect(driver.toInfo().status).toBe("error");
    await driver.stop();
  });

  it("opens no stream when stopped while a reopen awaits the companion", async () => {
    const { driver, streams, handle } = make();
    await driver.start();
    streams[0]!.feed(fixture);
    handle.isRunning = false;
    let release!: () => void;
    handle.start.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          release = () => {
            handle.isRunning = true;
            r();
          };
        }),
    );
    streams[0]!.emit("end");
    await vi.advanceTimersByTimeAsync(1000);
    await driver.stop();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(streams).toHaveLength(1);
    // A restarted driver must still reopen video after its next stream end.
    await driver.start();
    expect(streams).toHaveLength(2);
    streams[1]!.emit("end");
    await vi.advanceTimersByTimeAsync(1000);
    expect(streams).toHaveLength(3);
    await driver.stop();
  });

  it("counts a real gRPC stream end (end then error) as one failure", async () => {
    const { driver, streams } = make();
    await driver.start();
    for (let i = 0; i < 12; i++) {
      const s = streams.at(-1)!;
      s.emit("end");
      s.emit("error", new Error("UNAVAILABLE"));
      await vi.advanceTimersByTimeAsync(1000);
    }
    // Budget of 5 failures: the initial stream plus 4 reopens.
    expect(streams).toHaveLength(5);
    expect(driver.toInfo().status).toBe("error");
    await driver.stop();
  });

  it("never gives a late subscriber a delta before a keyframe after an overflowed GOP", async () => {
    const { driver, streams } = make();
    await driver.start();
    const sps = Uint8Array.of(0, 0, 0, 1, 0x67, 1, 2);
    const pps = Uint8Array.of(0, 0, 0, 1, 0x68, 3);
    const idr = Uint8Array.of(0, 0, 0, 1, 0x65, 4);
    streams[0]!.feed(Uint8Array.of(...sps, ...pps, ...idr), 1024);
    const slice = new Uint8Array(1024 * 1024).fill(0xaa);
    slice.set([0, 0, 0, 1, 0x41], 0);
    for (let i = 0; i < 9; i++) streams[0]!.emit("data", { payload: { data: Buffer.from(slice) } });
    streams[0]!.emit("data", { payload: { data: Buffer.from(Uint8Array.of(0, 0, 0, 1, 0x41)) } });
    const late: DeviceVideoPacket[] = [];
    driver.onVideoPacket((p) => late.push(p));
    streams[0]!.emit("data", { payload: { data: Buffer.from(Uint8Array.of(0, 0, 0, 1, 0x41)) } });
    expect(kinds(late)).not.toContain("delta");
    await driver.stop();
  });

  it("reports an error and keeps trying when the companion will not start", async () => {
    const c = fakeCompanion();
    c.handle.restart.mockRejectedValueOnce(new Error("spawn failed"));
    const { driver } = make(c);
    await driver.start();
    expect(driver.toInfo()).toMatchObject({ status: "error", error: "spawn failed" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(c.streams).toHaveLength(1);
    await driver.stop();
  });

  it("stop cancels the stream and drops the replay", async () => {
    const { driver, streams } = make();
    await driver.start();
    streams[0]!.feed(fixture);
    await driver.stop();
    expect(streams[0]!.cancelled).toBe(true);
    expect(streams[0]!.written).toContainEqual({ stop: {} });
    const late = vi.fn();
    driver.onVideoPacket(late);
    expect(late).not.toHaveBeenCalled();
  });
});

describe("IosSimulatorDriver video (fake idb_companion)", () => {
  const children: ChildProcess[] = [];
  const companions: IdbCompanion[] = [];
  afterEach(async () => {
    for (const c of companions.splice(0)) await c.stop();
    for (const ch of children.splice(0)) if (ch.exitCode === null) ch.kill("SIGKILL");
  });

  it("streams the fixture: config, then a keyframe, then deltas", async () => {
    const companion = new IdbCompanion({
      udid: UDID,
      executablePath: "/usr/local/bin/idb_companion",
      killStaleCompanions: async () => undefined,
      spawn: (_cmd, args, options) => {
        const child = spawn(process.execPath, [FAKE_COMPANION_SCRIPT, ...args], {
          ...options,
          env: {
            ...process.env,
            FAKE_IDB_VIDEO_FILE: FIXTURE,
            FAKE_IDB_CHUNK_BYTES: "37",
          },
        });
        children.push(child);
        return child;
      },
    });
    companions.push(companion);
    const driver = new IosSimulatorDriver({
      id: "9",
      udid: UDID,
      label: null,
      simctl: bootedSimctl,
      companion,
    });
    const seen: DeviceVideoPacket[] = [];
    driver.onVideoPacket((p) => seen.push(p));
    await driver.start();
    await vi.waitFor(() => expect(driver.toInfo().status).toBe("streaming"), { timeout: 10_000 });
    // The last slice is held by the splitter until the next start code arrives.
    await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(21), { timeout: 10_000 });
    expect(kinds(seen)[0]).toBe("config");
    expect(kinds(seen)[1]).toBe("key");
    expect(
      kinds(seen)
        .slice(2)
        .every((k) => k === "delta"),
    ).toBe(true);
    expect(nalType(seen[1]!.data.subarray(4))).toBe(5);
    await driver.stop();
  });
});
