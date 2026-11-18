import { execFile } from "node:child_process";
import { CLIPBOARD_MAX_BYTES } from "../device-defaults.js";
import { pngDimensions } from "../screenshot-image.js";
import { AnnexBPacketizer, GopBuffer } from "./annexb.js";
import type { IdbGrpcClient, IdbVideoStreamResponse } from "./idb-grpc.js";
import {
  DeviceActionError,
  type DeviceActionName,
  type DeviceDriver,
  type DeviceInfo,
  type DeviceInput,
  type DeviceLiveStatus,
  type DevicePlatform,
  type DeviceVideoPacket,
  type Unsubscribe,
} from "./types.js";

// The simctl half of the iOS Simulator driver (#1943): lifecycle, screenshot,
// logs and clipboard, plus video from idb_companion (input comes later).
//
// CoreSimulator supervises simulators itself, so there is no scope backend: a
// simulator survives a Mullion restart on its own. A device row names an
// EXISTING simulator by UDID; this driver never creates, erases or deletes one,
// and only shuts down a simulator THIS process booted.

const UDID_PATTERN = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

const POLL_INTERVAL_MS = 5000;
const DEFAULT_TIMEOUT_MS = 30_000;
const BOOT_TIMEOUT_MS = 180_000;
const LOGS_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const SCREENSHOT_MAX_BYTES = 64 * 1024 * 1024;
const LOGS_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_LOG_LINES = 200;

export interface SimctlOptions {
  /** Bytes written to the child's stdin (then closed). */
  input?: string;
  timeoutMs?: number;
  /** Cap on stdout; the call fails when exceeded. */
  maxBytes?: number;
}

/** Runs `xcrun simctl <args>` and resolves with stdout; rejects on a non-zero
 * exit, a timeout or an exceeded output cap. */
export type SimctlRunner = (args: string[], options?: SimctlOptions) => Promise<Buffer>;

/** The production runner: `execFile` with an argv array (never a shell), a
 * per-call timeout and an output cap. */
export const execSimctl: SimctlRunner = (args, options = {}) =>
  new Promise<Buffer>((resolve, reject) => {
    const child = execFile(
      "xcrun",
      ["simctl", ...args],
      {
        encoding: "buffer",
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: options.maxBytes ?? DEFAULT_MAX_BYTES,
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = Buffer.from(stderr ?? "")
            .toString("utf8")
            .trim();
          reject(new Error(detail ? `${err.message}: ${detail}` : err.message));
          return;
        }
        resolve(Buffer.from(stdout));
      },
    );
    if (options.input !== undefined) {
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(options.input);
    }
  });

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

/** idb `video_stream` start request: H.264, an IDR about every second. */
const VIDEO_STREAM_START = {
  fps: 30,
  format: "H264",
  compression_quality: 1,
  scale_factor: 1,
  avg_bitrate: 0,
  key_frame_rate: 0,
} as const;

type VideoStream = ReturnType<IdbGrpcClient["videoStream"]>;

export interface IosSimulatorDriverOptions {
  id: string;
  udid: string;
  label: string | null;
  simctl?: SimctlRunner;
  /** The idb companion for this simulator. Without one the driver has no
   * video (the manager wires it in a later slice). */
  companion?: IdbCompanionHandle;
  /** Delay before reopening an ended video stream (default 1 s). */
  streamReopenDelayMs?: number;
}

export class IosSimulatorDriver implements DeviceDriver {
  readonly platform: DevicePlatform = "ios";
  readonly id: string;
  readonly hasLiveControl = false;

  private readonly udid: string;
  private readonly label: string | null;
  private readonly simctl: SimctlRunner;
  private status: DeviceLiveStatus = "starting";
  private error: string | null = null;
  private alive = false;
  /** True only when THIS process booted the simulator. Not persisted: after a
   * Mullion restart the simulator is left running. */
  private bootedByUs = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private exited = false;
  private readonly exitListeners = new Set<() => void>();
  private readonly videoListeners = new Set<(packet: DeviceVideoPacket) => void>();
  private readonly clipboardListeners = new Set<(text: string) => void>();
  private readonly companion: IdbCompanionHandle | null;
  private readonly streamReopenDelayMs: number;
  private readonly gop = new GopBuffer();
  private stream: VideoStream | null = null;
  /** Identifies the live stream; events of a replaced stream are ignored. */
  private streamGeneration = 0;
  private lastStreamOpenAt = 0;
  private reopenTimer: NodeJS.Timeout | null = null;
  private reopenFailures = 0;
  private reopening = false;
  private offCompanionExit: (() => void) | null = null;
  private keyframeSent = false;

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
  }

  get isAlive(): boolean {
    return this.alive;
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
    this.status = "booting";
    this.error = null;
    try {
      // Only the boot branch, the poll and stop ever write bootedByUs: a retry
      // after a failed start must not forget a boot this process already did,
      // and the poll ends ownership when the simulator leaves Booted.
      if (!(await this.isBooted())) {
        try {
          await this.simctl(["boot", this.udid], { timeoutMs: BOOT_TIMEOUT_MS });
          this.bootedByUs = true;
        } catch (err) {
          // Lost a race with another booter: already Booted is success.
          if (!/current state: Booted/i.test(errorText(err))) throw err;
        }
      }
      await this.simctl(["bootstatus", this.udid, "-b"], { timeoutMs: BOOT_TIMEOUT_MS });
    } catch (err) {
      this.status = "error";
      this.error = errorText(err);
      // Ownership must be observed for as long as the flag is set: a boot of
      // ours that left Booted unseen is no longer ours to shut down.
      if (this.bootedByUs) this.startPolling();
      throw err;
    }
    this.alive = true;
    this.exited = false;
    // With a companion the status is `streaming` only once the first keyframe
    // has gone out; without one there is nothing further to wait for.
    this.status = this.companion ? "booting" : "streaming";
    this.startPolling();
    if (this.companion) await this.startVideo(this.companion);
  }

  /** Shuts the simulator down ONLY when this process booted it; never
   * deletes or erases. */
  async stop(): Promise<void> {
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
    for (const packet of this.gop.snapshot()) {
      try {
        listener(packet);
      } catch {
        // A throwing listener must not break the subscription.
      }
    }
    this.videoListeners.add(listener);
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

  async input(_message: DeviceInput): Promise<void> {}

  async screenshot(): Promise<Uint8Array> {
    const out = await this.simctl(["io", this.udid, "screenshot", "--type=png", "-"], {
      maxBytes: SCREENSHOT_MAX_BYTES,
    });
    const png = new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
    if (!PNG_SIGNATURE.equals(out.subarray(0, 8))) {
      const head = out
        .subarray(0, 200)
        .toString("utf8")
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "?");
      throw new DeviceActionError(502, `screencap did not return a PNG: ${head}`);
    }
    if (!pngDimensions(png)) {
      throw new DeviceActionError(502, "screencap returned a PNG with no readable header");
    }
    return png;
  }

  async tap(_x: number, _y: number): Promise<void> {}
  async swipe(): Promise<void> {}
  async text(_text: string): Promise<void> {}
  async key(_androidKeyCode: number): Promise<void> {}

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
    // `paste` is ignored until the input slice can send a paste key.
    set: async (text: string, _paste: boolean): Promise<void> => {
      if (Buffer.byteLength(text, "utf8") > CLIPBOARD_MAX_BYTES) {
        throw new DeviceActionError(
          400,
          `clipboard text exceeds the ${CLIPBOARD_MAX_BYTES}-byte limit`,
        );
      }
      await this.simctl(["pbcopy", this.udid], { input: text });
    },
  };

  supports(action: DeviceActionName): boolean {
    return action === "screenshot" || action === "logcat" || action === "clipboard";
  }

  private async startVideo(companion: IdbCompanionHandle): Promise<void> {
    this.offCompanionExit?.();
    this.offCompanionExit = null;
    try {
      // A companion is restarted after every boot: its HID connection is stale
      // once the simulator has rebooted. Subscribed after, so the restart's own
      // stop is not mistaken for a crash.
      await companion.restart();
      this.offCompanionExit = companion.onExit(() => this.scheduleReopen());
      const client = companion.client;
      if (!client) throw new Error("idb companion has no client");
      this.openStream(client);
    } catch (err) {
      this.status = "error";
      this.error = errorText(err);
      this.scheduleReopen();
    }
  }

  private openStream(client: IdbGrpcClient): void {
    this.closeStream();
    const generation = ++this.streamGeneration;
    const packetizer = new AnnexBPacketizer();
    const stream = client.videoStream({ ...VIDEO_STREAM_START });
    this.stream = stream;
    this.lastStreamOpenAt = Date.now();
    stream.on("data", (response: IdbVideoStreamResponse) => {
      if (generation !== this.streamGeneration) return;
      const data = response.payload?.data;
      if (!data || data.length === 0) return;
      for (const packet of packetizer.push(data)) this.emitVideo(packet);
    });
    const ended = (err?: Error) => {
      if (generation !== this.streamGeneration) return;
      this.stream = null;
      if (err && this.alive) this.error = errorText(err);
      this.scheduleReopen();
    };
    stream.on("error", ended);
    stream.on("end", () => ended());
  }

  private emitVideo(packet: DeviceVideoPacket): void {
    this.gop.push(packet);
    for (const listener of [...this.videoListeners]) {
      try {
        listener(packet);
      } catch {
        // One throwing listener must not starve the rest.
      }
    }
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
    this.gop.clear();
    this.keyframeSent = false;
  }

  /** Reopens the stream (restarting the companion if it died) while the
   * simulator is still ours and Booted; gives up after repeated failures. */
  private scheduleReopen(): void {
    const companion = this.companion;
    if (!companion || !this.alive || this.reopenTimer || this.reopening) return;
    if (this.reopenFailures >= MAX_STREAM_REOPEN_FAILURES) return;
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
      if (!companion.isRunning || !companion.client) await companion.start();
      const client = companion.client;
      if (!client) throw new Error("idb companion has no client");
      // A restarted stream opens with fresh SPS/PPS/IDR: forget the old GOP
      // and the first-keyframe latch so status tracks the new stream.
      this.gop.clear();
      this.keyframeSent = false;
      this.openStream(client);
    } catch (err) {
      this.reopenFailures++;
      this.status = "error";
      this.error = errorText(err);
      this.reopening = false;
      this.scheduleReopen();
      return;
    }
    this.reopening = false;
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

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
