import { CLIPBOARD_MAX_BYTES } from "../device-defaults.js";
import { AnnexBPacketizer, GOP_BUFFER_MAX_BYTES, GopBuffer } from "./annexb.js";
import { isOpenableUrl } from "./actions.js";
import { simctlScreenshot } from "./ios-screenshot.js";
import { execSimctl, type SimctlRunner } from "./simctl.js";
import type {
  IdbGrpcClient,
  IdbHidEvent,
  IdbScreenDimensions,
  IdbVideoStreamResponse,
} from "./idb-grpc.js";
import {
  buttonToHidEvents,
  cmdVToHidEvents,
  isInvalidatedHidError,
  scaleToPoints,
  textToHidEvents,
} from "./ios-hid.js";
import {
  DeviceActionError,
  type DeviceActionName,
  type DeviceButton,
  type DeviceDriver,
  type DeviceInfo,
  type DeviceInput,
  type DeviceLiveStatus,
  type DevicePlatform,
  type DeviceVideoPacket,
  type Unsubscribe,
} from "./types.js";

export { execSimctl, type SimctlOptions, type SimctlRunner } from "./simctl.js";

// The simctl half of the iOS Simulator driver (#1943): lifecycle, screenshot,
// logs and clipboard, plus video from idb_companion (input comes later).
//
// CoreSimulator supervises simulators itself, so there is no scope backend: a
// simulator survives a Mullion restart on its own. A device row names an
// EXISTING simulator by UDID; this driver never creates, erases or deletes one,
// and only shuts down a simulator THIS process booted.

const UDID_PATTERN = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

const POLL_INTERVAL_MS = 5000;
const BOOT_TIMEOUT_MS = 180_000;
const LOGS_TIMEOUT_MS = 60_000;
const LOGS_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_LOG_LINES = 200;

/** The slice of `IdbCompanion` the driver needs, so a test can substitute it. */
export interface IdbCompanionHandle {
  readonly client: IdbGrpcClient | null;
  readonly isRunning: boolean;
  start(): Promise<void>;
  restart(): Promise<void>;
  onExit(listener: () => void): () => void;
}

/** No on-demand IDR exists in idb, so a keyframe request restarts the stream;
 * at most once per this window. */
const KEYFRAME_RESTART_MIN_INTERVAL_MS = 5000;
const STREAM_REOPEN_DELAY_MS = 1000;
const MAX_STREAM_REOPEN_FAILURES = 5;
const DESCRIBE_TIMEOUT_MS = 5000;
const HID_ONCE_TIMEOUT_MS = 5000;
const HID_STREAM_CLOSE_TIMEOUT_MS = 2000;
const RECENT_LIVE_BATCH_WINDOW_MS = 50;
const RECENT_LIVE_BATCH_MAX = 64;
const LAST_LIVE_BATCH_MAX_AGE_MS = 5000;
const SCROLL_POINTS_PER_UNIT = 40;
const SCROLL_SWIPE_DURATION_SEC = 0.15;

/** idb `video_stream` start request: H.264, an IDR about every 4 s
 * (idb's default; `1` would give ~1 s, docs/spikes/ios-simulator-idb.md). */
const VIDEO_STREAM_START = {
  fps: 30,
  format: "H264",
  compression_quality: 1,
  scale_factor: 1,
  avg_bitrate: 0,
  key_frame_rate: 0,
} as const;

type VideoStream = ReturnType<IdbGrpcClient["videoStream"]>;
type HidStream = ReturnType<IdbGrpcClient["hid"]>;

export interface IosSimulatorDriverOptions {
  id: string;
  udid: string;
  label: string | null;
  simctl?: SimctlRunner;
  /** The idb companion for this simulator. Without one the driver has no
   * video or HID input. */
  companion?: IdbCompanionHandle;
  /** Delay before reopening an ended video stream (default 1 s). */
  streamReopenDelayMs?: number;
  /** Optional logger for dropped live-input warnings (defaults to console). */
  log?: { warn: (message: string, ...args: unknown[]) => void };
}

export class IosSimulatorDriver implements DeviceDriver {
  readonly platform: DevicePlatform = "ios";
  readonly id: string;

  private readonly udid: string;
  private readonly label: string | null;
  private readonly simctl: SimctlRunner;
  private readonly log: { warn: (message: string, ...args: unknown[]) => void };
  private status: DeviceLiveStatus = "starting";
  private error: string | null = null;
  private alive = false;
  /** True only when THIS process booted the simulator. Not persisted: after a
   * Mullion restart the simulator is left running. */
  private bootedByUs = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private exited = false;
  /** Bumped by stop(). A start() snapshots it and abandons itself when it
   * moved, so a Stop that lands mid-boot is never undone by the late boot. */
  private teardownEpoch = 0;
  private readonly exitListeners = new Set<() => void>();
  /** Per listener: has it received a keyframe since its last configuration? A
   * delta is never delivered before one. */
  private readonly videoListeners = new Map<
    (packet: DeviceVideoPacket) => void,
    { key: boolean }
  >();
  private readonly clipboardListeners = new Set<(text: string) => void>();
  private readonly companion: IdbCompanionHandle | null;
  private readonly streamReopenDelayMs: number;
  private readonly gop = new GopBuffer(GOP_BUFFER_MAX_BYTES);
  private stream: VideoStream | null = null;
  /** Identifies the live stream; events of a replaced stream are ignored. */
  private streamGeneration = 0;
  private lastStreamOpenAt = 0;
  private reopenTimer: NodeJS.Timeout | null = null;
  private reopenFailures = 0;
  private reopening = false;
  private offCompanionExit: (() => void) | null = null;
  private keyframeSent = false;
  private hidStream: HidStream | null = null;
  private writingHidStream: HidStream | null = null;
  private hidStreamError: Error | null = null;
  private hidStale = false;
  private recentLiveBatches: Array<{
    stream: HidStream;
    events: IdbHidEvent[];
    at: number;
    retried: boolean;
  }> = [];
  private pendingRecoveryBatches: IdbHidEvent[][] = [];
  private hidPending: Array<{
    kind: "touchMove" | "other";
    events: IdbHidEvent[];
    forAction: boolean;
    timeoutMs?: number;
    resolve: () => void;
    reject: (err: unknown) => void;
  }> = [];
  private hidDraining = false;
  private hidRestartPromise: Promise<void> | null = null;
  private hidRestartEpoch = 0;
  private screenDimensions: IdbScreenDimensions | null = null;
  private describePromise: Promise<IdbScreenDimensions> | null = null;
  private describeEpoch = 0;

  constructor(options: IosSimulatorDriverOptions) {
    // Validated before the UDID can reach any argv.
    if (!UDID_PATTERN.test(options.udid)) {
      throw new Error(`invalid simulator UDID: ${JSON.stringify(options.udid)}`);
    }
    this.id = options.id;
    this.udid = options.udid;
    this.label = options.label;
    this.simctl = options.simctl ?? execSimctl;
    this.companion = options.companion ?? null;
    this.streamReopenDelayMs = options.streamReopenDelayMs ?? STREAM_REOPEN_DELAY_MS;
    this.log = options.log ?? console;
  }

  get isAlive(): boolean {
    return this.alive;
  }

  get hasLiveControl(): boolean {
    return this.alive && Boolean(this.companion?.client);
  }

  toInfo(): DeviceInfo {
    return {
      id: this.id,
      kind: "emulator",
      avdName: null,
      label: this.label,
      status: this.status,
      serial: this.udid,
      error: this.error,
    };
  }

  /** Boots the simulator (an already Booted one counts as success), waits for
   * it to finish booting and starts the liveness poll. */
  async start(): Promise<void> {
    const epoch = this.teardownEpoch;
    this.status = "booting";
    this.error = null;
    try {
      // Only the boot branch, the poll and stop ever write bootedByUs: a retry
      // after a failed start must not forget a boot this process already did,
      // and the poll ends ownership when the simulator leaves Booted.
      if (!(await this.isBooted())) {
        if (epoch !== this.teardownEpoch) return;
        try {
          await this.simctl(["boot", this.udid], { timeoutMs: BOOT_TIMEOUT_MS });
          this.bootedByUs = true;
        } catch (err) {
          // Lost a race with another booter: already Booted is success.
          if (!/current state: Booted/i.test(errorText(err))) throw err;
        }
      }
      if (epoch !== this.teardownEpoch) return await this.abandonStart();
      await this.simctl(["bootstatus", this.udid, "-b"], { timeoutMs: BOOT_TIMEOUT_MS });
    } catch (err) {
      if (epoch !== this.teardownEpoch) return await this.abandonStart();
      this.status = "error";
      this.error = errorText(err);
      // Ownership must be observed for as long as the flag is set: a boot of
      // ours that left Booted unseen is no longer ours to shut down.
      if (this.bootedByUs) this.startPolling();
      throw err;
    }
    // A stop() during bootstatus: do not resurrect the device.
    if (epoch !== this.teardownEpoch) return await this.abandonStart();
    this.alive = true;
    this.exited = false;
    // With a companion the status is `streaming` only once the first keyframe
    // has gone out; without one there is nothing further to wait for.
    this.status = this.companion ? "booting" : "streaming";
    this.startPolling();
    if (this.companion) await this.startVideo(this.companion);
  }

  /** A stop() landed while start() was in flight. stop() could not shut down a
   * boot that had not returned yet, so finish that here, then stay exited. */
  private async abandonStart(): Promise<void> {
    if (this.bootedByUs) {
      try {
        await this.simctl(["shutdown", this.udid]);
      } catch (err) {
        if (!/current state: Shutdown/i.test(errorText(err))) {
          this.log.warn(
            "iOS simulator %s: shutdown after a cancelled start failed: %s",
            this.udid,
            errorText(err),
          );
          return;
        }
      }
      this.bootedByUs = false;
    }
  }

  /** Shuts the simulator down ONLY when this process booted it; never
   * deletes or erases. */
  async stop(): Promise<void> {
    this.teardownEpoch++;
    this.stopPolling();
    this.stopVideo();
    try {
      if (this.bootedByUs) {
        try {
          await this.simctl(["shutdown", this.udid]);
        } catch (err) {
          // Already Shutdown is the outcome we wanted.
          if (!/current state: Shutdown/i.test(errorText(err))) throw err;
        }
        // Cleared only once the shutdown landed, so a failed one can be retried.
        this.bootedByUs = false;
      }
    } finally {
      this.markExited();
    }
  }

  onVideoPacket(listener: (packet: DeviceVideoPacket) => void): Unsubscribe {
    // Replay the GOP before registering, so a late joiner starts with the
    // configuration and an IDR and never sees a delta before a keyframe.
    const state = { key: false };
    for (const packet of this.gop.snapshot()) deliver(listener, state, packet);
    this.videoListeners.set(listener, state);
    return () => void this.videoListeners.delete(listener);
  }

  onExit(listener: () => void): Unsubscribe {
    this.exitListeners.add(listener);
    return () => void this.exitListeners.delete(listener);
  }

  onClipboard(listener: (text: string) => void): Unsubscribe {
    this.clipboardListeners.add(listener);
    return () => void this.clipboardListeners.delete(listener);
  }

  /** idb has no force-keyframe control: restart the stream (it opens with
   * SPS/PPS/IDR), at most once per 5 s. Inside the window it resolves without
   * restarting. */
  async requestKeyframe(): Promise<void> {
    const client = this.companion?.client;
    if (!this.alive || !client || !this.stream) return;
    if (Date.now() - this.lastStreamOpenAt < KEYFRAME_RESTART_MIN_INTERVAL_MS) return;
    this.openStream(client);
  }

  async input(message: DeviceInput): Promise<void> {
    if (!this.alive || !this.companion?.client) return;
    switch (message.type) {
      case "tap": {
        if (message.videoWidth <= 0 || message.videoHeight <= 0) return;
        const dims = await this.getScreenDimensionsSafe();
        if (!dims) return;
        const point = scaleToPoints(
          message.x,
          message.y,
          message.videoWidth,
          message.videoHeight,
          dims.width_points,
          dims.height_points,
        );
        if (!point) return;
        await this.sendHid(
          [
            { press: { action: { touch: { point } }, direction: "DOWN" } },
            { press: { action: { touch: { point } }, direction: "UP" } },
          ],
          false,
        );
        break;
      }
      case "touchDown":
      case "touchMove":
      case "touchUp": {
        if (message.videoWidth <= 0 || message.videoHeight <= 0) return;
        const dims = await this.getScreenDimensionsSafe();
        if (!dims) return;
        const point = scaleToPoints(
          message.x,
          message.y,
          message.videoWidth,
          message.videoHeight,
          dims.width_points,
          dims.height_points,
        );
        if (!point) return;
        const direction = message.type === "touchUp" ? "UP" : "DOWN";
        await this.sendHid([{ press: { action: { touch: { point } }, direction } }], false, {
          kind: message.type === "touchMove" ? "touchMove" : "other",
        });
        break;
      }
      case "scroll": {
        if (message.videoWidth <= 0 || message.videoHeight <= 0) return;
        if (!Number.isFinite(message.scrollX) || !Number.isFinite(message.scrollY)) return;
        if (message.scrollX === 0 && message.scrollY === 0) return;
        const dims = await this.getScreenDimensionsSafe();
        if (!dims) return;
        const start = scaleToPoints(
          message.x,
          message.y,
          message.videoWidth,
          message.videoHeight,
          dims.width_points,
          dims.height_points,
        );
        if (!start) return;
        const end = {
          x: start.x + message.scrollX * SCROLL_POINTS_PER_UNIT,
          y: start.y + message.scrollY * SCROLL_POINTS_PER_UNIT,
        };
        await this.sendHid([{ swipe: { start, end, duration: SCROLL_SWIPE_DURATION_SEC } }], false);
        break;
      }
      case "button":
        await this.sendHid(buttonToHidEvents(message.button), false);
        break;
      case "hidKey":
        await this.sendHid(
          [
            {
              press: {
                action: { key: { keycode: message.usage } },
                direction: message.action === "down" ? "DOWN" : "UP",
              },
            },
          ],
          false,
        );
        break;
      case "text": {
        const events = textToHidEvents(message.text);
        await this.sendHid(events, false);
        break;
      }
      case "clipboard": {
        if (Buffer.byteLength(message.text, "utf8") > CLIPBOARD_MAX_BYTES) {
          this.log.warn("iOS clipboard live input exceeds byte limit; dropping");
          return;
        }
        await this.simctl(["pbcopy", this.udid], { input: message.text });
        await this.sendHid(cmdVToHidEvents(), false);
        break;
      }
      case "keyEvent":
      case "back":
      case "rotate":
        // Android-only inputs; iOS uses hidKey and button.
        break;
    }
  }

  async screenshot(): Promise<Uint8Array> {
    return simctlScreenshot(this.simctl, this.udid);
  }

  async tap(x: number, y: number): Promise<void> {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new DeviceActionError(400, "tap coordinates must be finite numbers");
    }
    const dims = await this.requireScreenDimensions();
    const point = scaleToPoints(
      x,
      y,
      dims.width,
      dims.height,
      dims.width_points,
      dims.height_points,
    );
    if (!point) {
      throw new DeviceActionError(502, "idb describe returned invalid screen dimensions");
    }
    await this.sendHid(
      [
        { press: { action: { touch: { point } }, direction: "DOWN" } },
        { press: { action: { touch: { point } }, direction: "UP" } },
      ],
      true,
    );
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs?: number): Promise<void> {
    if (
      !Number.isFinite(x1) ||
      !Number.isFinite(y1) ||
      !Number.isFinite(x2) ||
      !Number.isFinite(y2)
    ) {
      throw new DeviceActionError(400, "swipe coordinates must be finite numbers");
    }
    if (durationMs !== undefined && (!Number.isFinite(durationMs) || durationMs < 0)) {
      throw new DeviceActionError(400, "swipe durationMs must be a non-negative finite number");
    }
    const dims = await this.requireScreenDimensions();
    const start = scaleToPoints(
      x1,
      y1,
      dims.width,
      dims.height,
      dims.width_points,
      dims.height_points,
    );
    const end = scaleToPoints(
      x2,
      y2,
      dims.width,
      dims.height,
      dims.width_points,
      dims.height_points,
    );
    if (!start || !end) {
      throw new DeviceActionError(502, "idb describe returned invalid screen dimensions");
    }
    const swipe =
      durationMs !== undefined ? { start, end, duration: durationMs / 1000 } : { start, end };
    await this.sendHid([{ swipe }], true, { timeoutMs: HID_ONCE_TIMEOUT_MS + (durationMs ?? 0) });
  }

  async text(text: string): Promise<void> {
    const events = textToHidEvents(text);
    this.requireCompanionClient();
    await this.sendHid(events, true);
  }

  async key(_androidKeyCode: number): Promise<void> {}

  async button(button: DeviceButton): Promise<void> {
    const events = buttonToHidEvents(button);
    this.requireCompanionClient();
    await this.sendHid(events, true);
  }

  async logs(options: { lines?: number; filter?: string }): Promise<string> {
    const out = await this.simctl(
      ["spawn", this.udid, "log", "show", "--last", "5m", "--style", "compact"],
      { timeoutMs: LOGS_TIMEOUT_MS, maxBytes: LOGS_MAX_BYTES },
    );
    let lines = out.toString("utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    // A plain substring match in Node, never a log predicate.
    const needle = options.filter?.toLowerCase();
    if (needle) lines = lines.filter((l) => l.toLowerCase().includes(needle));
    const count =
      options.lines !== undefined && Number.isFinite(options.lines) && options.lines > 0
        ? Math.floor(options.lines)
        : DEFAULT_LOG_LINES;
    return lines.slice(-count).join("\n");
  }

  readonly clipboard = {
    get: async (): Promise<string | null> => {
      const out = await this.simctl(["pbpaste", this.udid]);
      return out.toString("utf8");
    },
    set: async (text: string, paste: boolean): Promise<void> => {
      if (Buffer.byteLength(text, "utf8") > CLIPBOARD_MAX_BYTES) {
        throw new DeviceActionError(
          400,
          `clipboard text exceeds the ${CLIPBOARD_MAX_BYTES}-byte limit`,
        );
      }
      await this.simctl(["pbcopy", this.udid], { input: text });
      if (paste && this.alive && this.companion?.client) {
        await this.sendHid(cmdVToHidEvents(), true);
      }
    },
  };

  /** `simctl openurl` hands the URL to the simulator's own handler (Safari for
   * http(s)); the argument is passed as one argv entry, never through a shell. */
  async openUrl(url: string): Promise<void> {
    if (!isOpenableUrl(url)) {
      throw new DeviceActionError(400, "openurl takes an http(s) URL");
    }
    // The normalised href, so whitespace the URL parser strips never reaches simctl.
    await this.simctl(["openurl", this.udid, new URL(url).href]);
  }

  supports(action: DeviceActionName): boolean {
    return (
      action === "screenshot" ||
      action === "logcat" ||
      action === "clipboard" ||
      action === "openurl" ||
      action === "tap" ||
      action === "swipe" ||
      action === "text" ||
      action === "button"
    );
  }

  private async startVideo(companion: IdbCompanionHandle): Promise<void> {
    this.offCompanionExit?.();
    this.offCompanionExit = null;
    this.resetCompanionSession();
    try {
      // A companion is restarted after every boot: its HID connection is stale
      // once the simulator has rebooted. Subscribed after, so the restart's own
      // stop is not mistaken for a crash.
      await companion.restart();
      // Stopped (or exited) while the companion was starting: open nothing.
      if (!this.alive) return;
      this.offCompanionExit = companion.onExit(() => this.scheduleReopen());
      const client = companion.client;
      if (!client) throw new Error("idb companion has no client");
      this.openStream(client);
    } catch (err) {
      if (!this.alive) return;
      this.status = "error";
      this.error = errorText(err);
      this.scheduleReopen();
    }
  }

  private openStream(client: IdbGrpcClient): void {
    this.closeStream();
    const generation = ++this.streamGeneration;
    const packetizer = new AnnexBPacketizer();
    let sawKeyframe = false;
    const stream = client.videoStream({ ...VIDEO_STREAM_START });
    this.stream = stream;
    this.lastStreamOpenAt = Date.now();
    stream.on("data", (response: IdbVideoStreamResponse) => {
      if (generation !== this.streamGeneration) return;
      const data = response.payload?.data;
      if (!data || data.length === 0) return;
      for (const packet of packetizer.push(data)) {
        if (packet.type === "data" && packet.keyframe && !sawKeyframe) {
          sawKeyframe = true;
          this.reopenFailures = 0;
        }
        this.emitVideo(packet);
      }
    });
    const ended = (err?: Error) => {
      if (generation !== this.streamGeneration) return;
      // grpc-js emits `error` (and status) before `end` for a non-OK status:
      // the first event counts, the later one is ignored.
      this.streamGeneration++;
      this.stream = null;
      if (err && this.alive) this.error = errorText(err);
      // A stream that ended without ever producing a keyframe is a failure.
      if (!sawKeyframe) this.reopenFailures++;
      this.scheduleReopen();
    };
    stream.on("error", ended);
    stream.on("end", () => ended());
  }

  private emitVideo(packet: DeviceVideoPacket): void {
    this.gop.push(packet);
    for (const [listener, state] of [...this.videoListeners]) deliver(listener, state, packet);
    if (packet.type === "data" && packet.keyframe && !this.keyframeSent) {
      this.keyframeSent = true;
      this.reopenFailures = 0;
      if (this.status !== "exited") {
        this.status = "streaming";
        this.error = null;
      }
    }
  }

  /** Detaches and cancels the current stream; its events no longer count. */
  private closeStream(): void {
    const stream = this.stream;
    this.stream = null;
    this.streamGeneration++;
    if (!stream) return;
    // A cancelled call still emits `error`; keep a listener so it is not thrown.
    stream.on("error", () => undefined);
    try {
      stream.write({ stop: {} });
      stream.end();
    } catch {
      // The stream may already be closed.
    }
    try {
      stream.cancel();
    } catch {
      // Same.
    }
  }

  private stopVideo(): void {
    if (this.reopenTimer) clearTimeout(this.reopenTimer);
    this.reopenTimer = null;
    this.offCompanionExit?.();
    this.offCompanionExit = null;
    this.closeStream();
    this.closeHidStream();
    this.screenDimensions = null;
    this.describePromise = null;
    this.hidStale = false;
    this.hidStreamError = null;
    this.recentLiveBatches = [];
    this.pendingRecoveryBatches = [];
    this.gop.clear();
    this.keyframeSent = false;
  }

  /** Reopens the stream (restarting the companion if it died) while the
   * simulator is still ours and Booted; gives up after repeated failures. */
  private scheduleReopen(): void {
    const companion = this.companion;
    if (!companion || !this.alive || this.reopenTimer || this.reopening) return;
    if (this.reopenFailures >= MAX_STREAM_REOPEN_FAILURES) {
      this.status = "error";
      this.error ??= "idb video stream failed repeatedly";
      return;
    }
    this.reopenTimer = setTimeout(() => {
      this.reopenTimer = null;
      void this.reopen(companion);
    }, this.streamReopenDelayMs);
    this.reopenTimer.unref();
  }

  private async reopen(companion: IdbCompanionHandle): Promise<void> {
    if (!this.alive) return;
    this.reopening = true;
    try {
      if (!companion.isRunning || !companion.client) {
        this.resetCompanionSession();
        await companion.start();
      }
      if (!this.alive) {
        this.reopening = false;
        return;
      }
      const client = companion.client;
      if (!client) throw new Error("idb companion has no client");
      // A restarted stream opens with fresh SPS/PPS/IDR: forget the old GOP
      // and the first-keyframe latch so status tracks the new stream.
      this.gop.clear();
      this.keyframeSent = false;
      this.openStream(client);
    } catch (err) {
      if (!this.alive) {
        this.reopening = false;
        return;
      }
      this.reopenFailures++;
      this.status = "error";
      this.error = errorText(err);
      this.reopening = false;
      this.scheduleReopen();
      return;
    }
    this.reopening = false;
  }

  private resetCompanionSession(): void {
    this.closeHidStream();
    this.screenDimensions = null;
    this.describeEpoch += 1;
    this.describePromise = null;
    this.hidStale = false;
    this.hidStreamError = null;
    this.recentLiveBatches = [];
    this.pendingRecoveryBatches = [];
  }

  private requireCompanionClient(): IdbGrpcClient {
    const client = this.companion?.client;
    if (!this.alive || !client) {
      throw new DeviceActionError(
        400,
        `device ${this.id} has no live idb companion (status: ${this.status})`,
      );
    }
    return client;
  }

  private async getScreenDimensionsSafe(): Promise<IdbScreenDimensions | null> {
    try {
      return await this.requireScreenDimensions();
    } catch (err) {
      this.log.warn("iOS describe failed; dropping coordinate input", err);
      return null;
    }
  }

  private async requireScreenDimensions(): Promise<IdbScreenDimensions> {
    if (this.screenDimensions) return this.screenDimensions;
    if (this.describePromise) return this.describePromise;
    const client = this.requireCompanionClient();
    const epoch = ++this.describeEpoch;
    const promise = (async () => {
      const res = await client.describe({ timeoutMs: DESCRIBE_TIMEOUT_MS });
      const dims = res.target_description?.screen_dimensions;
      if (
        !dims ||
        !Number.isFinite(dims.width) ||
        !Number.isFinite(dims.height) ||
        !Number.isFinite(dims.width_points) ||
        !Number.isFinite(dims.height_points) ||
        dims.width <= 0 ||
        dims.height <= 0 ||
        dims.width_points <= 0 ||
        dims.height_points <= 0
      ) {
        throw new DeviceActionError(502, "idb describe did not return valid screen dimensions");
      }
      if (this.describeEpoch === epoch) this.screenDimensions = dims;
      return dims;
    })();
    this.describePromise = promise;
    try {
      return await promise;
    } finally {
      if (this.describeEpoch === epoch) this.describePromise = null;
    }
  }

  private ensureHidStream(client: IdbGrpcClient): HidStream {
    if (this.hidStream) return this.hidStream;
    this.hidStreamError = null;
    const stream = client.hid();
    stream.on("error", (err: Error) => {
      if (this.hidStream !== stream) return;
      this.hidStream = null;
      this.hidStreamError = err;
      if (!isInvalidatedHidError(err)) {
        this.recentLiveBatches = this.recentLiveBatches.filter((b) => b.stream !== stream);
        return;
      }
      this.hidStale = true;
      // When writeBatchToStream is currently awaiting flush on this stream,
      // sendHidSerialized handles the restart and retry inline. Otherwise the
      // invalidated status arrived asynchronously after flush: recover any
      // un-retried recent batches off the critical path.
      if (this.writingHidStream === stream) return;
      const { batches, hadDropped } = this.drainRecentLiveBatches(stream);
      if (batches.length > 0) {
        this.pendingRecoveryBatches.push(...batches);
        if (!this.hidDraining) void this.drainHidQueue();
      } else if (hadDropped) {
        this.log.warn("iOS HID stream invalidated after retry or expiry; dropping batch", err);
      }
    });
    const clear = () => {
      if (this.hidStream === stream) {
        this.hidStream = null;
        this.recentLiveBatches = this.recentLiveBatches.filter((b) => b.stream !== stream);
      }
    };
    stream.on("close", clear);
    stream.on("finish", clear);
    this.hidStream = stream;
    return stream;
  }

  private recordLiveBatch(stream: HidStream, events: IdbHidEvent[], retried: boolean): void {
    const now = Date.now();
    this.recentLiveBatches.push({ stream, events, at: now, retried });
    while (this.recentLiveBatches.length > 1) {
      const oldest = this.recentLiveBatches[0]!;
      if (
        this.recentLiveBatches.length > RECENT_LIVE_BATCH_MAX ||
        now - oldest.at > RECENT_LIVE_BATCH_WINDOW_MS
      ) {
        this.recentLiveBatches.shift();
      } else {
        break;
      }
    }
  }

  private drainRecentLiveBatches(stream: HidStream): {
    batches: IdbHidEvent[][];
    hadDropped: boolean;
  } {
    const now = Date.now();
    const matching = this.recentLiveBatches.filter((b) => b.stream === stream);
    this.recentLiveBatches = this.recentLiveBatches.filter((b) => b.stream !== stream);
    const batches = matching
      .filter((b) => !b.retried && now - b.at <= LAST_LIVE_BATCH_MAX_AGE_MS)
      .map((b) => b.events);
    return { batches, hadDropped: matching.length > batches.length };
  }

  private closeHidStream(): void {
    const stream = this.hidStream;
    this.hidStream = null;
    if (!stream) return;
    this.recentLiveBatches = this.recentLiveBatches.filter((b) => b.stream !== stream);
    stream.on("error", () => undefined);
    try {
      stream.end();
    } catch {
      // The stream may already be closed.
    }
    try {
      stream.cancel?.();
    } catch {
      // Same.
    }
  }

  private async writeBatchToStream(stream: HidStream, events: IdbHidEvent[]): Promise<void> {
    this.writingHidStream = stream;
    try {
      for (const event of events) {
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const finish = (err?: Error | null) => {
            if (settled) return;
            settled = true;
            stream.off("error", onError);
            if (err) reject(err);
            else resolve();
          };
          const onError = (err: Error) => finish(err);
          stream.once("error", onError);
          try {
            if (stream.write.length >= 2) {
              stream.write(event, (err?: Error | null) => finish(err));
            } else {
              stream.write(event);
              finish();
            }
          } catch (err) {
            finish(err instanceof Error ? err : new Error(String(err)));
          }
        });
      }
    } finally {
      if (this.writingHidStream === stream) this.writingHidStream = null;
    }
  }

  private async restartForStaleHid(): Promise<void> {
    if (this.hidRestartPromise) return this.hidRestartPromise;
    const companion = this.companion;
    if (!companion) return;
    const epoch = ++this.hidRestartEpoch;
    const promise = (async () => {
      this.resetCompanionSession();
      this.offCompanionExit?.();
      this.offCompanionExit = null;
      await companion.restart();
      if (this.alive) {
        this.offCompanionExit = companion.onExit(() => this.scheduleReopen());
      }
    })();
    this.hidRestartPromise = promise;
    try {
      await promise;
    } finally {
      if (this.hidRestartEpoch === epoch) this.hidRestartPromise = null;
    }
  }

  private async closeLiveStreamForAction(prev: HidStream): Promise<Error | null> {
    let closeError: Error | null = null;
    const isGrpcStream = typeof (prev as { getPeer?: unknown }).getPeer === "function";
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        prev.off("status", onStatus);
        prev.off("error", onError);
        prev.off("close", finish);
        resolve();
      };
      const onError = (err: Error) => {
        closeError ??= err;
        finish();
      };
      const onStatus = (status: { code?: number; details?: string }) => {
        if (status && typeof status.code === "number" && status.code !== 0) {
          closeError ??= new Error(`${status.code}: ${status.details ?? "gRPC error"}`);
        }
        finish();
      };
      const timer = setTimeout(() => {
        try {
          prev.cancel?.();
        } catch {
          // The stream may already be closed.
        }
        finish();
      }, HID_STREAM_CLOSE_TIMEOUT_MS);
      prev.once("status", onStatus);
      prev.once("error", onError);
      // grpc-js ClientWritableStream emits `close` when the writable side ends
      // before the server status arrives; only treat `close` as completion for
      // non-gRPC test doubles.
      if (!isGrpcStream) prev.once("close", finish);
      try {
        prev.end();
      } catch {
        finish();
      }
    });
    return closeError;
  }

  private async sendHidBatch(
    client: IdbGrpcClient,
    events: IdbHidEvent[],
    forAction: boolean,
    timeoutMs?: number,
    retried = false,
  ): Promise<{ ok: true } | { ok: false; invalidated: boolean; err: unknown }> {
    if (forAction) {
      let activeClient = client;
      if (this.hidStream) {
        // idb_companion allows one active HID session at a time, so close the
        // held live stream before opening a one-shot hidOnce call.
        const prev = this.hidStream;
        const { batches } = this.drainRecentLiveBatches(prev);
        this.hidStream = null;
        const closeErr = await this.closeLiveStreamForAction(prev);
        if (closeErr && isInvalidatedHidError(closeErr)) {
          try {
            await this.restartForStaleHid();
          } catch (err) {
            return { ok: false, invalidated: false, err };
          }
          const retryClient = this.companion?.client;
          if (!retryClient) {
            return {
              ok: false,
              invalidated: false,
              err: new Error("idb companion unavailable after restart"),
            };
          }
          activeClient = retryClient;
          if (batches.length > 0) {
            try {
              await activeClient.hidOnce(batches.flat(), { timeoutMs: HID_ONCE_TIMEOUT_MS });
            } catch (err) {
              this.log.warn("iOS HID live-batch replay failed before action; continuing", err);
            }
          }
        }
      }
      try {
        await activeClient.hidOnce(events, { timeoutMs: timeoutMs ?? HID_ONCE_TIMEOUT_MS });
        return { ok: true };
      } catch (err) {
        return { ok: false, invalidated: isInvalidatedHidError(err), err };
      }
    }
    const stream = this.ensureHidStream(client);
    try {
      await this.writeBatchToStream(stream, events);
      if (!this.hidStale && this.hidStream === stream) {
        this.recordLiveBatch(stream, events, retried);
        return { ok: true };
      }
      const streamErr = this.hidStreamError;
      const wasStale = this.hidStale || (streamErr !== null && isInvalidatedHidError(streamErr));
      this.closeHidStream();
      this.hidStale = false;
      this.hidStreamError = null;
      return {
        ok: false,
        invalidated: wasStale,
        err:
          streamErr ??
          new Error(
            wasStale
              ? "idb HID stream became stale during write"
              : "idb HID stream closed during write",
          ),
      };
    } catch (err) {
      const streamErr = this.hidStreamError;
      const wasStale =
        this.hidStale ||
        isInvalidatedHidError(err) ||
        (streamErr !== null && isInvalidatedHidError(streamErr));
      this.closeHidStream();
      this.hidStale = false;
      this.hidStreamError = null;
      return { ok: false, invalidated: wasStale, err };
    }
  }

  private sendHid(
    events: IdbHidEvent[],
    forAction: boolean,
    options?: { timeoutMs?: number; kind?: "touchMove" | "other" },
  ): Promise<void> {
    if (events.length === 0) return Promise.resolve();
    const kind = options?.kind ?? "other";
    return new Promise<void>((resolve, reject) => {
      if (kind === "touchMove") {
        const tail = this.hidPending.at(-1);
        if (tail && tail.kind === "touchMove") {
          // Coalesce queued touchMove events to the newest point so a fast
          // pointermove burst never backs up touchUp or one-shot actions.
          tail.events = events;
          tail.resolve();
          tail.resolve = resolve;
          tail.reject = reject;
          return;
        }
      }
      this.hidPending.push({
        kind,
        events,
        forAction,
        timeoutMs: options?.timeoutMs,
        resolve,
        reject,
      });
      if (!this.hidDraining) {
        void this.drainHidQueue();
      }
    });
  }

  private async drainHidQueue(): Promise<void> {
    this.hidDraining = true;
    try {
      while (this.hidPending.length > 0 || this.pendingRecoveryBatches.length > 0) {
        if (this.pendingRecoveryBatches.length > 0) {
          await this.recoverStaleLiveBatches();
          continue;
        }
        const item = this.hidPending.shift()!;
        try {
          await this.sendHidSerialized(item.events, item.forAction, item.timeoutMs);
          item.resolve();
        } catch (err) {
          item.reject(err);
        }
      }
    } finally {
      this.hidDraining = false;
      if (this.hidPending.length > 0 || this.pendingRecoveryBatches.length > 0) {
        void this.drainHidQueue();
      }
    }
  }

  private async recoverStaleLiveBatches(): Promise<void> {
    const batches = this.pendingRecoveryBatches.splice(0);
    if (batches.length === 0 || !this.alive || !this.companion) return;
    this.hidStale = false;
    try {
      await this.restartForStaleHid();
      const retryClient = this.companion.client;
      if (!retryClient) {
        throw new Error("idb companion unavailable after restart");
      }
      const stream = this.ensureHidStream(retryClient);
      for (const events of batches) {
        await this.writeBatchToStream(stream, events);
        this.recordLiveBatch(stream, events, true);
      }
    } catch (retryErr) {
      this.closeHidStream();
      this.log.warn("iOS HID input failed after companion restart; dropping event", retryErr);
    }
  }

  private async sendHidSerialized(
    events: IdbHidEvent[],
    forAction: boolean,
    timeoutMs?: number,
  ): Promise<void> {
    if (!this.alive || !this.companion) {
      if (forAction) {
        throw new DeviceActionError(
          400,
          `device ${this.id} has no live idb companion (status: ${this.status})`,
        );
      }
      return;
    }
    if (this.hidStale) {
      this.hidStale = false;
      try {
        await this.restartForStaleHid();
      } catch (err) {
        this.closeHidStream();
        if (forAction) {
          throw new DeviceActionError(
            502,
            `idb HID write failed after companion restart: ${errorText(err)}`,
          );
        }
        this.log.warn("iOS HID input failed after companion restart; dropping event", err);
        return;
      }
    }
    const client = this.companion.client;
    if (!client) {
      if (forAction) {
        throw new DeviceActionError(
          400,
          `device ${this.id} has no live idb companion (status: ${this.status})`,
        );
      }
      return;
    }

    const first = await this.sendHidBatch(client, events, forAction, timeoutMs);
    if (first.ok) return;
    if (!first.invalidated) {
      if (forAction) {
        throw new DeviceActionError(502, `idb HID write failed: ${errorText(first.err)}`);
      }
      this.log.warn("iOS HID input failed; dropping event", first.err);
      return;
    }

    // Stale HID connection: restart the companion once, reopen the stream and retry.
    try {
      await this.restartForStaleHid();
      const retryClient = this.companion.client;
      if (!retryClient) {
        throw new Error("idb companion unavailable after restart");
      }
      const retry = await this.sendHidBatch(retryClient, events, forAction, timeoutMs, true);
      if (!retry.ok) {
        throw retry.err;
      }
    } catch (retryErr) {
      this.closeHidStream();
      if (forAction) {
        throw new DeviceActionError(
          502,
          `idb HID write failed after companion restart: ${errorText(retryErr)}`,
        );
      }
      this.log.warn("iOS HID input failed after companion restart; dropping event", retryErr);
    }
  }

  private async isBooted(): Promise<boolean> {
    const out = await this.simctl(["list", "devices", "-j"]);
    const parsed = JSON.parse(out.toString("utf8")) as {
      devices?: Record<string, Array<{ udid?: string; state?: string }>>;
    };
    const wanted = this.udid.toUpperCase();
    for (const group of Object.values(parsed.devices ?? {})) {
      for (const d of group) {
        if (d.udid?.toUpperCase() === wanted) return d.state === "Booted";
      }
    }
    return false;
  }

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    this.pollTimer.unref();
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      if (!(await this.isBooted())) {
        this.stopPolling();
        // Ownership ends with the boot: any later boot is not ours.
        this.bootedByUs = false;
        // A failed start never had a live driver to exit.
        if (this.alive) this.markExited();
      }
    } catch {
      // A failed probe is not evidence the simulator left Booted; retry next tick.
    } finally {
      this.polling = false;
    }
  }

  private markExited(): void {
    this.stopVideo();
    this.alive = false;
    if (this.status !== "error") this.status = "exited";
    if (this.exited) return;
    this.exited = true;
    for (const listener of [...this.exitListeners]) {
      try {
        listener();
      } catch {
        // One throwing listener must not starve the rest.
      }
    }
  }
}

/** Hands a packet to one listener, never a delta before its first keyframe. */
function deliver(
  listener: (packet: DeviceVideoPacket) => void,
  state: { key: boolean },
  packet: DeviceVideoPacket,
): void {
  if (packet.type === "configuration") state.key = false;
  else if (packet.keyframe) state.key = true;
  else if (!state.key) return;
  try {
    listener(packet);
  } catch {
    // One throwing listener must not starve the rest.
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
