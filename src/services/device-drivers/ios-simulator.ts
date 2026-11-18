import { execFile } from "node:child_process";
import { CLIPBOARD_MAX_BYTES } from "../device-defaults.js";
import { pngDimensions } from "../screenshot-image.js";
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
// logs and clipboard. Video and input come later from idb_companion.
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

export interface IosSimulatorDriverOptions {
  id: string;
  udid: string;
  label: string | null;
  simctl?: SimctlRunner;
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

  constructor(options: IosSimulatorDriverOptions) {
    // Validated before the UDID can reach any argv.
    if (!UDID_PATTERN.test(options.udid)) {
      throw new Error(`invalid simulator UDID: ${JSON.stringify(options.udid)}`);
    }
    this.id = options.id;
    this.udid = options.udid;
    this.label = options.label;
    this.simctl = options.simctl ?? execSimctl;
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
    this.status = "streaming";
    this.startPolling();
  }

  /** Shuts the simulator down ONLY when this process booted it; never
   * deletes or erases. */
  async stop(): Promise<void> {
    this.stopPolling();
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
    // Registers, never emits: video arrives with the idb companion.
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

  async requestKeyframe(): Promise<void> {}

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
