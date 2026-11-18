import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { performDeviceAction } from "../../../src/services/device-drivers/actions.js";
import { IdbCompanion } from "../../../src/services/device-drivers/idb-companion.js";
import type { IdbGrpcClient, IdbHidEvent } from "../../../src/services/device-drivers/idb-grpc.js";
import { parseDeviceInput } from "../../../src/services/device-drivers/input.js";
import {
  HID_KEY_LEFT_GUI,
  HID_KEY_LEFT_SHIFT,
  HID_KEY_V,
} from "../../../src/services/device-drivers/ios-hid.js";
import {
  IosSimulatorDriver,
  type IdbCompanionHandle,
  type SimctlRunner,
} from "../../../src/services/device-drivers/ios-simulator.js";
import { DeviceActionError } from "../../../src/services/device-drivers/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_COMPANION_SCRIPT = path.resolve(here, "./fake-idb-companion.mjs");
const UDID = "0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9";

const bootedSimctl: SimctlRunner = async (args) =>
  args[0] === "list"
    ? Buffer.from(JSON.stringify({ devices: { rt: [{ udid: UDID, state: "Booted" }] } }))
    : Buffer.alloc(0);

class FakeVideoStream extends EventEmitter {
  write() {
    return true;
  }
  end() {}
  cancel() {}
}

class FakeHidStream extends EventEmitter {
  written: IdbHidEvent[] = [];
  ended = false;
  cancelled = false;
  constructor(
    private readonly onWrite?: (event: IdbHidEvent, stream: FakeHidStream) => Error | null,
  ) {
    super();
  }
  write(event: IdbHidEvent, cb?: (err?: Error | null) => void) {
    const err = this.onWrite?.(event, this) ?? null;
    if (err) {
      cb?.(err);
      return false;
    }
    this.written.push(event);
    cb?.(null);
    return true;
  }
  end() {
    this.ended = true;
    this.emit("close");
  }
  cancel() {
    this.cancelled = true;
    this.emit("close");
  }
}

function fakeCompanion(options?: {
  onHidWrite?: (event: IdbHidEvent, streamIndex: number) => Error | null;
}) {
  const hidStreams: FakeHidStream[] = [];
  const describe = vi.fn(async () => ({
    target_description: {
      udid: UDID,
      name: "iPhone 17 (Fake)",
      state: "Booted",
      target_type: "simulator",
      os_version: "iOS 26.5",
      architecture: "arm64",
      screen_dimensions: {
        width: 1206,
        height: 2622,
        density: 3,
        width_points: 402,
        height_points: 874,
      },
    },
  }));
  const client = {
    videoStream: () => new FakeVideoStream(),
    hid: () => {
      const idx = hidStreams.length;
      const stream = new FakeHidStream((ev) => options?.onHidWrite?.(ev, idx) ?? null);
      hidStreams.push(stream);
      return stream;
    },
    hidOnce: async (events: IdbHidEvent[]) => {
      const idx = hidStreams.length;
      const stream = new FakeHidStream((ev) => options?.onHidWrite?.(ev, idx) ?? null);
      hidStreams.push(stream);
      for (const ev of events) {
        await new Promise<void>((resolve, reject) => {
          stream.write(ev, (err) => (err ? reject(err) : resolve()));
        });
      }
      stream.end();
    },
    describe,
    close: vi.fn(),
  } as unknown as IdbGrpcClient;

  const exitListeners = new Set<() => void>();
  const handle = {
    client,
    isRunning: true,
    start: vi.fn(async () => {
      handle.isRunning = true;
    }),
    restart: vi.fn(async () => {}),
    onExit: (l: () => void) => {
      exitListeners.add(l);
      return () => void exitListeners.delete(l);
    },
  } satisfies IdbCompanionHandle;

  return { handle, hidStreams, describe };
}

describe("parseDeviceInput (iOS button and hidKey)", () => {
  it("accepts valid button and hidKey messages", () => {
    for (const button of ["home", "lock", "side", "siri"] as const) {
      expect(parseDeviceInput({ type: "button", button })).toEqual({ type: "button", button });
    }
    expect(parseDeviceInput({ type: "hidKey", usage: 0x04, action: "down" })).toEqual({
      type: "hidKey",
      usage: 0x04,
      action: "down",
    });
    expect(parseDeviceInput({ type: "hidKey", usage: 0xffff, action: "up" })).toEqual({
      type: "hidKey",
      usage: 0xffff,
      action: "up",
    });
    expect(parseDeviceInput({ type: "hidKey", usage: 0, action: "down" })).toEqual({
      type: "hidKey",
      usage: 0,
      action: "down",
    });
  });

  it("rejects malformed button and hidKey messages", () => {
    expect(parseDeviceInput({ type: "button", button: "power" })).toBeNull();
    expect(parseDeviceInput({ type: "button" })).toBeNull();
    expect(parseDeviceInput({ type: "hidKey", usage: -1, action: "down" })).toBeNull();
    expect(parseDeviceInput({ type: "hidKey", usage: 0x10000, action: "down" })).toBeNull();
    expect(parseDeviceInput({ type: "hidKey", usage: 4.5, action: "down" })).toBeNull();
    expect(parseDeviceInput({ type: "hidKey", usage: "4", action: "down" })).toBeNull();
    expect(parseDeviceInput({ type: "hidKey", usage: 4, action: "press" })).toBeNull();
  });
});

describe("IosSimulatorDriver input (in-process companion)", () => {
  it("opens the hid stream lazily, converts 1206x2622 -> 402x874, and sends tap DOWN then UP", async () => {
    const c = fakeCompanion();
    const driver = new IosSimulatorDriver({
      id: "1",
      udid: UDID,
      label: null,
      simctl: bootedSimctl,
      companion: c.handle,
    });
    await driver.start();
    expect(driver.hasLiveControl).toBe(true);
    expect(c.hidStreams).toHaveLength(0);

    await driver.input({
      type: "tap",
      x: 603,
      y: 1311,
      videoWidth: 1206,
      videoHeight: 2622,
    });

    expect(c.describe).toHaveBeenCalledTimes(1);
    expect(c.hidStreams).toHaveLength(1);
    expect(c.hidStreams[0]!.written).toEqual([
      { press: { action: { touch: { point: { x: 201, y: 437 } } }, direction: "DOWN" } },
      { press: { action: { touch: { point: { x: 201, y: 437 } } }, direction: "UP" } },
    ]);
    await driver.stop();
  });

  it("keeps one hid stream open for a drag (DOWN at moving points then UP) and reuses describe", async () => {
    const c = fakeCompanion();
    const driver = new IosSimulatorDriver({
      id: "1",
      udid: UDID,
      label: null,
      simctl: bootedSimctl,
      companion: c.handle,
    });
    await driver.start();

    await driver.input({
      type: "touchDown",
      x: 300,
      y: 600,
      videoWidth: 1206,
      videoHeight: 2622,
      pointerId: 1,
    });
    await driver.input({
      type: "touchMove",
      x: 300,
      y: 900,
      videoWidth: 1206,
      videoHeight: 2622,
      pointerId: 1,
    });
    await driver.input({
      type: "touchUp",
      x: 300,
      y: 1200,
      videoWidth: 1206,
      videoHeight: 2622,
      pointerId: 1,
    });

    expect(c.describe).toHaveBeenCalledTimes(1);
    expect(c.hidStreams).toHaveLength(1);
    expect(c.hidStreams[0]!.written).toEqual([
      { press: { action: { touch: { point: { x: 100, y: 200 } } }, direction: "DOWN" } },
      { press: { action: { touch: { point: { x: 100, y: 300 } } }, direction: "DOWN" } },
      { press: { action: { touch: { point: { x: 100, y: 400 } } }, direction: "UP" } },
    ]);
    await driver.stop();
  });

  it("drops coordinate messages with videoWidth or videoHeight of 0", async () => {
    const c = fakeCompanion();
    const driver = new IosSimulatorDriver({
      id: "1",
      udid: UDID,
      label: null,
      simctl: bootedSimctl,
      companion: c.handle,
    });
    await driver.start();

    await driver.input({ type: "tap", x: 10, y: 10, videoWidth: 0, videoHeight: 2622 });
    await driver.input({
      type: "touchDown",
      x: 10,
      y: 10,
      videoWidth: 1206,
      videoHeight: 0,
      pointerId: 0,
    });
    await driver.input({
      type: "scroll",
      x: 10,
      y: 10,
      videoWidth: 0,
      videoHeight: 0,
      scrollX: 0,
      scrollY: 1,
    });

    expect(c.hidStreams).toHaveLength(0);
    await driver.stop();
  });

  it("sends scroll as a short HID swipe from scaled (x, y)", async () => {
    const c = fakeCompanion();
    const driver = new IosSimulatorDriver({
      id: "1",
      udid: UDID,
      label: null,
      simctl: bootedSimctl,
      companion: c.handle,
    });
    await driver.start();

    await driver.input({
      type: "scroll",
      x: 603,
      y: 1311,
      videoWidth: 1206,
      videoHeight: 2622,
      scrollX: 0,
      scrollY: -2,
    });

    expect(c.hidStreams[0]!.written).toEqual([
      {
        swipe: {
          start: { x: 201, y: 437 },
          end: { x: 201, y: 357 },
          duration: 0.15,
        },
      },
    ]);
    await driver.stop();
  });

  it("types upper case and punctuation with exact Shift key sequences and refuses non-ASCII with 400", async () => {
    const c = fakeCompanion();
    const driver = new IosSimulatorDriver({
      id: "1",
      udid: UDID,
      label: null,
      simctl: bootedSimctl,
      companion: c.handle,
    });
    await driver.start();

    await driver.text("A!");
    expect(c.hidStreams[0]!.written).toEqual([
      // 'A': Left Shift DOWN, 'a' (0x04) DOWN, 'a' UP, Left Shift UP
      { press: { action: { key: { keycode: HID_KEY_LEFT_SHIFT } }, direction: "DOWN" } },
      { press: { action: { key: { keycode: 0x04 } }, direction: "DOWN" } },
      { press: { action: { key: { keycode: 0x04 } }, direction: "UP" } },
      { press: { action: { key: { keycode: HID_KEY_LEFT_SHIFT } }, direction: "UP" } },
      // '!': Left Shift DOWN, '1' (0x1e) DOWN, '1' UP, Left Shift UP
      { press: { action: { key: { keycode: HID_KEY_LEFT_SHIFT } }, direction: "DOWN" } },
      { press: { action: { key: { keycode: 0x1e } }, direction: "DOWN" } },
      { press: { action: { key: { keycode: 0x1e } }, direction: "UP" } },
      { press: { action: { key: { keycode: HID_KEY_LEFT_SHIFT } }, direction: "UP" } },
    ]);

    const err = await driver.text("café").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceActionError);
    expect((err as DeviceActionError).statusCode).toBe(400);
    expect((err as Error).message).toContain("é");

    await driver.stop();
  });

  it("maps button, hidKey, and clipboard (pbcopy + Cmd+V)", async () => {
    const c = fakeCompanion();
    const simctlCalls: Array<{ args: string[]; input?: string }> = [];
    const driver = new IosSimulatorDriver({
      id: "1",
      udid: UDID,
      label: null,
      simctl: async (args, opts) => {
        simctlCalls.push({ args, input: opts?.input });
        return bootedSimctl(args, opts);
      },
      companion: c.handle,
    });
    await driver.start();

    await driver.input({ type: "button", button: "home" });
    await driver.input({ type: "button", button: "side" });
    await driver.input({ type: "hidKey", usage: 0x28, action: "down" });
    await driver.input({ type: "clipboard", text: "hello" });

    expect(simctlCalls.find((call) => call.args[0] === "pbcopy")).toEqual({
      args: ["pbcopy", UDID],
      input: "hello",
    });
    expect(c.hidStreams[0]!.written).toEqual([
      { press: { action: { button: { button: "HOME" } }, direction: "DOWN" } },
      { press: { action: { button: { button: "HOME" } }, direction: "UP" } },
      { press: { action: { button: { button: "SIDE_BUTTON" } }, direction: "DOWN" } },
      { press: { action: { button: { button: "SIDE_BUTTON" } }, direction: "UP" } },
      { press: { action: { key: { keycode: 0x28 } }, direction: "DOWN" } },
      { press: { action: { key: { keycode: HID_KEY_LEFT_GUI } }, direction: "DOWN" } },
      { press: { action: { key: { keycode: HID_KEY_V } }, direction: "DOWN" } },
      { press: { action: { key: { keycode: HID_KEY_V } }, direction: "UP" } },
      { press: { action: { key: { keycode: HID_KEY_LEFT_GUI } }, direction: "UP" } },
    ]);
    await driver.stop();
  });

  it("supports one-shot tap, swipe (with durationMs), text, and button; keeps key false", async () => {
    const c = fakeCompanion();
    const driver = new IosSimulatorDriver({
      id: "1",
      udid: UDID,
      label: null,
      simctl: bootedSimctl,
      companion: c.handle,
    });
    expect(driver.supports("tap")).toBe(true);
    expect(driver.supports("swipe")).toBe(true);
    expect(driver.supports("text")).toBe(true);
    expect(driver.supports("button")).toBe(true);
    expect(driver.supports("logs")).toBe(true);
    expect(driver.supports("key")).toBe(false);

    await driver.start();
    await performDeviceAction(driver, { action: "tap", x: 300, y: 600 });
    await performDeviceAction(driver, {
      action: "swipe",
      x1: 300,
      y1: 1800,
      x2: 300,
      y2: 600,
      durationMs: 250,
    });
    await performDeviceAction(driver, { action: "button", button: "home" });

    expect(c.hidStreams.flatMap((s) => s.written)).toEqual([
      { press: { action: { touch: { point: { x: 100, y: 200 } } }, direction: "DOWN" } },
      { press: { action: { touch: { point: { x: 100, y: 200 } } }, direction: "UP" } },
      { swipe: { start: { x: 100, y: 600 }, end: { x: 100, y: 200 }, duration: 0.25 } },
      { press: { action: { button: { button: "HOME" } }, direction: "DOWN" } },
      { press: { action: { button: { button: "HOME" } }, direction: "UP" } },
    ]);
    await driver.stop();
  });

  it("retries once after companion restart on stale HID, and surfaces second failure appropriately", async () => {
    // Case 1: first HID stream fails with invalidated error, second succeeds.
    const c1 = fakeCompanion({
      onHidWrite: (_ev, streamIdx) =>
        streamIdx === 0
          ? new Error(
              "13 INTERNAL: The dtuhidd connection (com.apple.coredevice.feature.remote.hid.digitizer) has been invalidated",
            )
          : null,
    });
    const d1 = new IosSimulatorDriver({
      id: "1",
      udid: UDID,
      label: null,
      simctl: bootedSimctl,
      companion: c1.handle,
    });
    await d1.start();
    expect(c1.handle.restart).toHaveBeenCalledTimes(1);

    await d1.tap(300, 600);
    expect(c1.handle.restart).toHaveBeenCalledTimes(2);
    expect(c1.hidStreams).toHaveLength(2);
    expect(c1.hidStreams[1]!.written).toEqual([
      { press: { action: { touch: { point: { x: 100, y: 200 } } }, direction: "DOWN" } },
      { press: { action: { touch: { point: { x: 100, y: 200 } } }, direction: "UP" } },
    ]);
    await d1.stop();

    // Case 2: both attempts fail -> 502 for one-shot action, logged drop for live input.
    const warn = vi.fn();
    const c2 = fakeCompanion({
      onHidWrite: () => new Error("The dtuhidd connection has been invalidated"),
    });
    const d2 = new IosSimulatorDriver({
      id: "2",
      udid: UDID,
      label: null,
      simctl: bootedSimctl,
      companion: c2.handle,
      log: { warn },
    });
    await d2.start();

    await expect(d2.tap(300, 600)).rejects.toMatchObject({ statusCode: 502 });
    await expect(d2.input({ type: "button", button: "home" })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    await d2.stop();
  });

  it("retries when stream becomes stale mid-batch or throws destroyed-stream error after hidStale", async () => {
    let stream0Writes = 0;
    const c = fakeCompanion();
    const origHid = c.handle.client!.hid.bind(c.handle.client);
    c.handle.client!.hid = () => {
      const stream = origHid();
      if (c.hidStreams.length === 1) {
        const origWrite = stream.write.bind(stream);
        stream.write = ((event: IdbHidEvent, cb?: (err?: Error | null) => void) => {
          stream0Writes += 1;
          if (stream0Writes === 1) {
            // Simulate grpc-js flushing the write callback, then delivering the
            // invalidated status on the stream before the batch finishes.
            const ok = origWrite(event, cb);
            stream.emit(
              "error",
              new Error("13 INTERNAL: The dtuhidd connection has been invalidated"),
            );
            return ok;
          }
          cb?.(new Error("Cannot call write after a stream was destroyed"));
          return false;
        }) as typeof stream.write;
      }
      return stream;
    };

    const driver = new IosSimulatorDriver({
      id: "1",
      udid: UDID,
      label: null,
      simctl: bootedSimctl,
      companion: c.handle,
    });
    await driver.start();
    expect(c.handle.restart).toHaveBeenCalledTimes(1);

    await driver.input({ type: "button", button: "home" });
    expect(c.handle.restart).toHaveBeenCalledTimes(2);
    expect(c.hidStreams).toHaveLength(2);
    expect(c.hidStreams[1]!.written).toEqual([
      { press: { action: { button: { button: "HOME" } }, direction: "DOWN" } },
      { press: { action: { button: { button: "HOME" } }, direction: "UP" } },
    ]);
    await driver.stop();
  });

  it("closes the live stream before a one-shot action mid-drag and reopens it for touchUp", async () => {
    const c = fakeCompanion();
    const driver = new IosSimulatorDriver({
      id: "1",
      udid: UDID,
      label: null,
      simctl: bootedSimctl,
      companion: c.handle,
    });
    await driver.start();

    await driver.input({
      type: "touchDown",
      x: 300,
      y: 600,
      videoWidth: 1206,
      videoHeight: 2622,
      pointerId: 0,
    });
    await driver.tap(600, 1200);
    await driver.input({
      type: "touchUp",
      x: 300,
      y: 900,
      videoWidth: 1206,
      videoHeight: 2622,
      pointerId: 0,
    });

    expect(c.hidStreams).toHaveLength(3);
    expect(c.hidStreams[0]!.ended).toBe(true);
    expect(c.hidStreams[0]!.written).toEqual([
      { press: { action: { touch: { point: { x: 100, y: 200 } } }, direction: "DOWN" } },
    ]);
    expect(c.hidStreams[1]!.written).toEqual([
      { press: { action: { touch: { point: { x: 200, y: 400 } } }, direction: "DOWN" } },
      { press: { action: { touch: { point: { x: 200, y: 400 } } }, direction: "UP" } },
    ]);
    expect(c.hidStreams[2]!.written).toEqual([
      { press: { action: { touch: { point: { x: 100, y: 300 } } }, direction: "UP" } },
    ]);
    await driver.stop();
  });

  it("does not delay final touchUp or tap after a 60-event touchMove burst", async () => {
    const c = fakeCompanion();
    const driver = new IosSimulatorDriver({
      id: "1",
      udid: UDID,
      label: null,
      simctl: bootedSimctl,
      companion: c.handle,
    });
    await driver.start();

    await driver.input({
      type: "touchDown",
      x: 300,
      y: 600,
      videoWidth: 1206,
      videoHeight: 2622,
      pointerId: 0,
    });

    const burstStart = Date.now();
    for (let i = 1; i <= 60; i++) {
      await driver.input({
        type: "touchMove",
        x: 300 + i * 3,
        y: 600 + i * 3,
        videoWidth: 1206,
        videoHeight: 2622,
        pointerId: 0,
      });
    }
    const touchUpStart = Date.now();
    await driver.input({
      type: "touchUp",
      x: 480,
      y: 780,
      videoWidth: 1206,
      videoHeight: 2622,
      pointerId: 0,
    });
    const touchUpElapsed = Date.now() - touchUpStart;
    const totalElapsed = Date.now() - burstStart;

    expect(touchUpElapsed).toBeLessThan(32);
    expect(totalElapsed).toBeLessThan(32);
    expect(c.hidStreams[0]!.written.at(-1)).toEqual({
      press: { action: { touch: { point: { x: 160, y: 260 } } }, direction: "UP" },
    });

    const tapStart = Date.now();
    await driver.tap(300, 600);
    expect(Date.now() - tapStart).toBeLessThan(32);

    await driver.stop();
  });

  it("coalesces queued touchMove events under backpressure so touchUp lands promptly", async () => {
    const c = fakeCompanion();
    const origHid = c.handle.client!.hid.bind(c.handle.client);
    c.handle.client!.hid = () => {
      const stream = origHid();
      const origWrite = stream.write.bind(stream);
      stream.write = ((event: IdbHidEvent, cb?: (err?: Error | null) => void) => {
        // Simulate 5 ms gRPC write flush backpressure.
        setTimeout(() => {
          origWrite(event, cb);
        }, 5);
        return true;
      }) as typeof stream.write;
      return stream;
    };

    const driver = new IosSimulatorDriver({
      id: "1",
      udid: UDID,
      label: null,
      simctl: bootedSimctl,
      companion: c.handle,
    });
    await driver.start();

    await driver.input({
      type: "touchDown",
      x: 300,
      y: 600,
      videoWidth: 1206,
      videoHeight: 2622,
      pointerId: 0,
    });

    const start = Date.now();
    const moves = Array.from({ length: 60 }, (_, idx) =>
      driver.input({
        type: "touchMove",
        x: 300 + (idx + 1) * 3,
        y: 600 + (idx + 1) * 3,
        videoWidth: 1206,
        videoHeight: 2622,
        pointerId: 0,
      }),
    );
    const touchUpPromise = driver.input({
      type: "touchUp",
      x: 480,
      y: 780,
      videoWidth: 1206,
      videoHeight: 2622,
      pointerId: 0,
    });
    await Promise.all([...moves, touchUpPromise]);
    const elapsed = Date.now() - start;

    // 60 uncoalesced 5 ms writes would take >= 300 ms; coalescing keeps it to a couple of writes.
    expect(elapsed).toBeLessThan(50);
    expect(c.hidStreams[0]!.written.length).toBeLessThan(10);
    expect(c.hidStreams[0]!.written.at(-1)).toEqual({
      press: { action: { touch: { point: { x: 160, y: 260 } } }, direction: "UP" },
    });
    await driver.stop();
  });

  it("restarts and resends the last live batch when invalidated error arrives late", async () => {
    const c = fakeCompanion();
    const driver = new IosSimulatorDriver({
      id: "1",
      udid: UDID,
      label: null,
      simctl: bootedSimctl,
      companion: c.handle,
    });
    await driver.start();
    expect(c.handle.restart).toHaveBeenCalledTimes(1);

    await driver.input({ type: "button", button: "home" });
    expect(c.hidStreams).toHaveLength(1);

    // Emit the invalidated error well past the 50 ms burst window.
    await new Promise((r) => setTimeout(r, 80));
    c.hidStreams[0]!.emit(
      "error",
      new Error("13 INTERNAL: The dtuhidd connection has been invalidated"),
    );

    await vi.waitFor(() => {
      expect(c.handle.restart).toHaveBeenCalledTimes(2);
      expect(c.hidStreams).toHaveLength(2);
      expect(c.hidStreams[1]!.written).toEqual([
        { press: { action: { button: { button: "HOME" } }, direction: "DOWN" } },
        { press: { action: { button: { button: "HOME" } }, direction: "UP" } },
      ]);
    });
    await driver.stop();
  });

  function invalidateHidOnEnd(c: ReturnType<typeof fakeCompanion>) {
    const origHid = c.handle.client!.hid.bind(c.handle.client);
    c.handle.client!.hid = () => {
      const stream = origHid() as unknown as FakeHidStream;
      stream.end = () => {
        stream.ended = true;
        stream.emit("status", {
          code: 13,
          details: "The dtuhidd connection has been invalidated",
        });
      };
      return stream as unknown as ReturnType<typeof origHid>;
    };
  }

  it("maps a failing live-batch replay to DeviceActionError and still sends the action", async () => {
    const c = fakeCompanion();
    invalidateHidOnEnd(c);
    const hidOnceCalls: IdbHidEvent[][] = [];
    c.handle.client!.hidOnce = async (events: IdbHidEvent[]) => {
      hidOnceCalls.push(events);
      throw new Error("14 UNAVAILABLE: connect failed: Connection refused");
    };

    const driver = new IosSimulatorDriver({
      id: "1",
      udid: UDID,
      label: null,
      simctl: bootedSimctl,
      companion: c.handle,
    });
    await driver.start();

    await driver.input({
      type: "touchDown",
      x: 300,
      y: 600,
      videoWidth: 1206,
      videoHeight: 2622,
      pointerId: 0,
    });

    await expect(driver.tap(300, 600)).rejects.toMatchObject({
      name: "DeviceActionError",
      statusCode: 502,
    });
    expect(c.handle.restart).toHaveBeenCalledTimes(2);
    expect(hidOnceCalls).toHaveLength(2);
    expect(hidOnceCalls[0]).toEqual([
      { press: { action: { touch: { point: { x: 100, y: 200 } } }, direction: "DOWN" } },
    ]);
    expect(hidOnceCalls[1]).toEqual([
      { press: { action: { touch: { point: { x: 100, y: 200 } } }, direction: "DOWN" } },
      { press: { action: { touch: { point: { x: 100, y: 200 } } }, direction: "UP" } },
    ]);

    await driver.stop();
  });

  it("continues with the one-shot action when only the live-batch replay fails", async () => {
    const c = fakeCompanion();
    invalidateHidOnEnd(c);
    const hidOnceCalls: IdbHidEvent[][] = [];
    const origHidOnce = c.handle.client!.hidOnce.bind(c.handle.client);
    c.handle.client!.hidOnce = async (events: IdbHidEvent[]) => {
      hidOnceCalls.push(events);
      if (hidOnceCalls.length === 1) {
        throw new Error("14 UNAVAILABLE: transient replay failure");
      }
      return origHidOnce(events);
    };

    const driver = new IosSimulatorDriver({
      id: "1",
      udid: UDID,
      label: null,
      simctl: bootedSimctl,
      companion: c.handle,
    });
    await driver.start();

    await driver.input({
      type: "touchDown",
      x: 300,
      y: 600,
      videoWidth: 1206,
      videoHeight: 2622,
      pointerId: 0,
    });

    await expect(driver.tap(300, 600)).resolves.toBeUndefined();
    expect(hidOnceCalls).toHaveLength(2);
    expect(hidOnceCalls[1]).toEqual([
      { press: { action: { touch: { point: { x: 100, y: 200 } } }, direction: "DOWN" } },
      { press: { action: { touch: { point: { x: 100, y: 200 } } }, direction: "UP" } },
    ]);

    await driver.stop();
  });

  it("maps a failing stale-HID companion restart during an action to DeviceActionError 502", async () => {
    let firstWrite = true;
    const c = fakeCompanion({
      onHidWrite: () => {
        if (firstWrite) {
          firstWrite = false;
          return new Error("13 INTERNAL: The dtuhidd connection has been invalidated");
        }
        return null;
      },
    });
    const driver = new IosSimulatorDriver({
      id: "1",
      udid: UDID,
      label: null,
      simctl: bootedSimctl,
      companion: c.handle,
    });
    await driver.start();

    // First input fails and retries on stream 1 (recorded as retried=true).
    await driver.input({
      type: "touchDown",
      x: 300,
      y: 600,
      videoWidth: 1206,
      videoHeight: 2622,
      pointerId: 0,
    });

    // Invalidate stream 1 asynchronously: since its batch is already retried,
    // hidStale=true is set with no pending recovery batches.
    c.hidStreams[1]!.emit(
      "error",
      new Error("13 INTERNAL: The dtuhidd connection has been invalidated"),
    );
    c.handle.restart = vi.fn(async () => {
      throw new Error("spawn idb_companion ENOENT");
    });

    await expect(driver.tap(300, 600)).rejects.toMatchObject({
      name: "DeviceActionError",
      statusCode: 502,
    });
    expect(c.handle.restart).toHaveBeenCalledTimes(1);

    // Live input on the same failing restart drops cleanly without throwing.
    firstWrite = true;
    c.handle.restart = vi.fn(async () => {});
    await driver.input({
      type: "touchDown",
      x: 300,
      y: 600,
      videoWidth: 1206,
      videoHeight: 2622,
      pointerId: 0,
    });
    c.hidStreams[3]!.emit(
      "error",
      new Error("13 INTERNAL: The dtuhidd connection has been invalidated"),
    );
    c.handle.restart = vi.fn(async () => {
      throw new Error("spawn idb_companion ENOENT");
    });
    await expect(
      driver.input({
        type: "tap",
        x: 300,
        y: 600,
        videoWidth: 1206,
        videoHeight: 2622,
      }),
    ).resolves.toBeUndefined();
    expect(c.handle.restart).toHaveBeenCalledTimes(1);

    await driver.stop();
  });
});

describe("IosSimulatorDriver input (fake idb_companion)", () => {
  const dirs: string[] = [];
  const companions: IdbCompanion[] = [];

  afterEach(async () => {
    await Promise.all(companions.map((c) => c.stop()));
    companions.length = 0;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("records tap, drag, text, button, and stale-HID retry over real gRPC", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mullion-hid-test-"));
    dirs.push(dir);
    const hidLog = path.join(dir, "hid.jsonl");
    const staleMarker = path.join(dir, "stale");
    writeFileSync(staleMarker, "1");

    const companion = new IdbCompanion({
      udid: UDID,
      executablePath: FAKE_COMPANION_SCRIPT,
      killStaleCompanions: async () => {},
      spawn: (cmd, args, opts) =>
        spawn(process.execPath, [cmd, ...args], {
          ...opts,
          env: {
            ...process.env,
            FAKE_IDB_HID_LOG: hidLog,
            FAKE_IDB_STALE_HID_MARKER: staleMarker,
          },
        }) as unknown as ChildProcess,
    });
    companions.push(companion);

    const driver = new IosSimulatorDriver({
      id: "1",
      udid: UDID,
      label: null,
      simctl: bootedSimctl,
      companion,
    });

    await driver.start();

    // First input hits stale HID marker; live input waits briefly for the
    // loopback gRPC error, restarts the companion, and retries the same event.
    await driver.input({ type: "tap", x: 603, y: 1311, videoWidth: 1206, videoHeight: 2622 });
    await driver.input({
      type: "touchDown",
      x: 300,
      y: 600,
      videoWidth: 1206,
      videoHeight: 2622,
      pointerId: 0,
    });
    await driver.input({
      type: "touchUp",
      x: 300,
      y: 900,
      videoWidth: 1206,
      videoHeight: 2622,
      pointerId: 0,
    });
    await driver.input({ type: "button", button: "home" });
    await driver.text("A");

    // Allow the gRPC server to flush the final data frames before reading the log.
    await new Promise((r) => setTimeout(r, 100));
    await driver.stop();

    const recorded = readFileSync(hidLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as IdbHidEvent);

    expect(recorded).toMatchObject([
      { press: { action: { touch: { point: { x: 201, y: 437 } } }, direction: "DOWN" } },
      { press: { action: { touch: { point: { x: 201, y: 437 } } }, direction: "UP" } },
      { press: { action: { touch: { point: { x: 100, y: 200 } } }, direction: "DOWN" } },
      { press: { action: { touch: { point: { x: 100, y: 300 } } }, direction: "UP" } },
      { press: { action: { button: { button: "HOME" } }, direction: "DOWN" } },
      { press: { action: { button: { button: "HOME" } }, direction: "UP" } },
      { press: { action: { key: { keycode: HID_KEY_LEFT_SHIFT } }, direction: "DOWN" } },
      { press: { action: { key: { keycode: 0x04 } }, direction: "DOWN" } },
      { press: { action: { key: { keycode: 0x04 } }, direction: "UP" } },
      { press: { action: { key: { keycode: HID_KEY_LEFT_SHIFT } }, direction: "UP" } },
    ]);
  }, 15_000);

  it("restarts and retries live input when stale HID occurs between two live events", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mullion-hid-live-stale-"));
    dirs.push(dir);
    const hidLog = path.join(dir, "hid.jsonl");
    const staleMarker = path.join(dir, "stale");

    const companion = new IdbCompanion({
      udid: UDID,
      executablePath: FAKE_COMPANION_SCRIPT,
      killStaleCompanions: async () => {},
      spawn: (cmd, args, opts) =>
        spawn(process.execPath, [cmd, ...args], {
          ...opts,
          env: {
            ...process.env,
            FAKE_IDB_HID_LOG: hidLog,
            FAKE_IDB_STALE_HID_MARKER: staleMarker,
          },
        }) as unknown as ChildProcess,
    });
    companions.push(companion);

    const driver = new IosSimulatorDriver({
      id: "1",
      udid: UDID,
      label: null,
      simctl: bootedSimctl,
      companion,
    });

    await driver.start();
    await driver.input({ type: "button", button: "home" });
    await vi.waitFor(() => expect(existsSync(hidLog)).toBe(true), { timeout: 2000 });
    await new Promise((r) => setTimeout(r, 60));
    writeFileSync(staleMarker, "1");
    await driver.input({ type: "button", button: "lock" });

    // Recovery runs off the critical path: wait for the companion restart and
    // resend to record LOCK DOWN/UP.
    await vi.waitFor(
      () => {
        const lines = readFileSync(hidLog, "utf8").trim().split("\n").filter(Boolean);
        expect(lines).toHaveLength(4);
      },
      { timeout: 5000 },
    );
    await driver.stop();

    const recorded = readFileSync(hidLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as IdbHidEvent);
    expect(recorded).toMatchObject([
      { press: { action: { button: { button: "HOME" } }, direction: "DOWN" } },
      { press: { action: { button: { button: "HOME" } }, direction: "UP" } },
      { press: { action: { button: { button: "LOCK" } }, direction: "DOWN" } },
      { press: { action: { button: { button: "LOCK" } }, direction: "UP" } },
    ]);
  }, 15_000);

  it("restarts and retries one-shot tap immediately on stale HID over real gRPC", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mullion-hid-action-stale-"));
    dirs.push(dir);
    const hidLog = path.join(dir, "hid.jsonl");
    const staleMarker = path.join(dir, "stale");
    writeFileSync(staleMarker, "1");

    const companion = new IdbCompanion({
      udid: UDID,
      executablePath: FAKE_COMPANION_SCRIPT,
      killStaleCompanions: async () => {},
      spawn: (cmd, args, opts) =>
        spawn(process.execPath, [cmd, ...args], {
          ...opts,
          env: {
            ...process.env,
            FAKE_IDB_HID_LOG: hidLog,
            FAKE_IDB_STALE_HID_MARKER: staleMarker,
          },
        }) as unknown as ChildProcess,
    });
    companions.push(companion);

    const driver = new IosSimulatorDriver({
      id: "1",
      udid: UDID,
      label: null,
      simctl: bootedSimctl,
      companion,
    });

    await driver.start();
    // No delay: a one-shot action awaits the gRPC completion status, so stale HID
    // restarts the companion and retries within the same tap() call.
    await driver.tap(300, 600);
    await driver.stop();

    const recorded = readFileSync(hidLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as IdbHidEvent);
    expect(recorded).toMatchObject([
      { press: { action: { touch: { point: { x: 100, y: 200 } } }, direction: "DOWN" } },
      { press: { action: { touch: { point: { x: 100, y: 200 } } }, direction: "UP" } },
    ]);
  }, 15_000);
});
