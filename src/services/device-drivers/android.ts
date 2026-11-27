import { AndroidKeyEventAction } from "@yume-chan/scrcpy";
import { AndroidMotionEventAction, AndroidMotionEventButton } from "@yume-chan/scrcpy";
import type {
  AndroidKeyCode,
  AndroidKeyEventMeta,
  ScrcpyControlMessageWriter,
} from "@yume-chan/scrcpy";
import type { Adb } from "@yume-chan/adb";
import { CLIPBOARD_MAX_BYTES } from "../device-defaults.js";
import { pngDimensions } from "../screenshot-image.js";
import { isOpenableUrl } from "./actions.js";
import {
  DeviceActionError,
  type DeviceActionName,
  type DeviceButton,
  type DeviceDriver,
  type DeviceInfo,
  type DeviceInput,
  type DevicePlatform,
  type DeviceVideoPacket,
  type Unsubscribe,
} from "./types.js";

// Hermes review — @yume-chan/adb's `AdbNoneProtocolSubprocessService`
// builds its `exec:` service string as `command.join(" ")` (see that
// package's own source: adb's `exec:`/`shell:` transport is inherently a
// single string the device's OWN shell (`sh -c`) re-tokenizes — there is
// no argv-array adb service that skips shell interpretation). An
// argv element containing a space silently re-splits into extra shell
// words; one containing a shell metacharacter (`;`, `$()`, a backtick, …)
// EXECUTES on the device. Both `text` and `logcat`'s `filter` are
// arbitrary, agent-supplied strings reachable at session scope (device.*
// control-socket ops, control-socket.ts) — on-device command injection,
// not just a formatting bug. Standard POSIX single-quote escaping closes
// this for every spawnWaitText/spawnWait call in this file, numeric args
// included (quoting a digit string is a no-op, so applying it uniformly
// is simpler and safer than remembering which individual call sites carry
// untrusted content).
function shellQuoteArg(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function shellExecArgv(argv: string[]): string[] {
  return argv.map(shellQuoteArg);
}

/** A URL hostname that, on the device, would point at the device itself.
 * Kept in step with the Preview menu's `isLoopbackHost` (frontend
 * lib/deviceUrl.ts): a fully qualified `localhost.` and the unspecified
 * `0.0.0.0` (which Linux connects to locally) count too. */
function isLoopbackHostname(raw: string): boolean {
  const hostname = raw.replace(/\.$/, "");
  return (
    hostname === "0.0.0.0" ||
    hostname === "localhost" ||
    // Chrome resolves every *.localhost name to loopback itself.
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    /^127(\.\d{1,3}){3}$/.test(hostname)
  );
}

const PNG_IEND = Buffer.from("IEND");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** `screencap -p` on a multi-display device writes a "[Warning] Multiple
 * displays were found…" line to the same stream before the PNG, so the raw
 * output is not a valid image. Returns the bytes from the PNG signature on,
 * or null when the output holds no complete PNG (no signature, or no IEND). */
export function extractPng(bytes: Uint8Array): Uint8Array | null {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = buf.indexOf(PNG_SIGNATURE);
  if (at < 0) return null;
  // A truncated write has the signature but no closing IEND chunk (+ 4-byte CRC).
  if (buf.indexOf(PNG_IEND, at) < 0) return null;
  return bytes.subarray(at);
}

/** The slice of a live adb + scrcpy `Device` (device-manager.ts) the driver
 * reads. Structural, so this module does not import the manager that imports
 * it; a `Device` satisfies it as is. */
export interface AndroidDeviceHandle {
  readonly id: string;
  readonly isAlive: boolean;
  readonly controller: ScrcpyControlMessageWriter | undefined;
  readonly adbConnection: Adb | undefined;
  readonly lastClipboard: string | null;
  toInfo(): DeviceInfo;
  kill(): Promise<void>;
  setClipboard(text: string, paste: boolean): Promise<void>;
  reversePort(port: number): Promise<void>;
  onVideoPacket(listener: (packet: DeviceVideoPacket) => void): Unsubscribe;
  onExit(listener: () => void): Unsubscribe;
  onClipboard(listener: (text: string) => void): Unsubscribe;
}

/** The Android implementation of DeviceDriver: a thin adapter over a live
 * `Device` (adb + scrcpy, device-manager.ts). It holds no state of its own and
 * reads the Device's connections lazily, so it stays correct across the
 * Device's boot sequence (adb first, scrcpy control a little later). Cheap to
 * construct — DeviceManager.getDriver makes one per call.
 *
 * Two deliberately separate paths, as before the seam existed: live input
 * (`input`) drives the scrcpy control channel for low latency while a panel
 * is streaming, and the one-shot actions use plain `adb shell` commands so a
 * CLI/MCP action needs no active viewer. */
export class AndroidDriver implements DeviceDriver {
  readonly platform: DevicePlatform = "android";

  constructor(private readonly device: AndroidDeviceHandle) {}

  get id(): string {
    return this.device.id;
  }

  get isAlive(): boolean {
    return this.device.isAlive;
  }

  get hasLiveControl(): boolean {
    return Boolean(this.device.controller);
  }

  toInfo(): DeviceInfo {
    return this.device.toInfo();
  }

  stop(): Promise<void> {
    return this.device.kill();
  }

  onVideoPacket(listener: (packet: DeviceVideoPacket) => void): Unsubscribe {
    return this.device.onVideoPacket(listener);
  }

  onExit(listener: () => void): Unsubscribe {
    return this.device.onExit(listener);
  }

  onClipboard(listener: (text: string) => void): Unsubscribe {
    return this.device.onClipboard(listener);
  }

  async requestKeyframe(): Promise<void> {
    // scrcpy's resetVideo: the encoder emits an IDR now instead of after its
    // own (possibly many-second) keyframe interval.
    await this.device.controller?.resetVideo();
  }

  supports(action: DeviceActionName): boolean {
    return action !== "button";
  }

  // --- live input -------------------------------------------------------

  async input(message: DeviceInput): Promise<void> {
    const controller = this.device.controller;
    if (!controller) return;
    switch (message.type) {
      case "tap":
        await controller.injectTouch({
          action: AndroidMotionEventAction.Down,
          pointerId: 0n,
          pointerX: message.x,
          pointerY: message.y,
          videoWidth: message.videoWidth,
          videoHeight: message.videoHeight,
          pressure: 1,
          actionButton: AndroidMotionEventButton.Primary,
          buttons: AndroidMotionEventButton.Primary,
        });
        await controller.injectTouch({
          action: AndroidMotionEventAction.Up,
          pointerId: 0n,
          pointerX: message.x,
          pointerY: message.y,
          videoWidth: message.videoWidth,
          videoHeight: message.videoHeight,
          pressure: 0,
          actionButton: AndroidMotionEventButton.Primary,
          buttons: AndroidMotionEventButton.None,
        });
        break;
      case "touchDown":
      case "touchMove":
      case "touchUp": {
        const action =
          message.type === "touchDown"
            ? AndroidMotionEventAction.Down
            : message.type === "touchMove"
              ? AndroidMotionEventAction.Move
              : AndroidMotionEventAction.Up;
        const down = message.type !== "touchUp";
        await controller.injectTouch({
          action,
          pointerId: BigInt(message.pointerId),
          pointerX: message.x,
          pointerY: message.y,
          videoWidth: message.videoWidth,
          videoHeight: message.videoHeight,
          pressure: down ? 1 : 0,
          actionButton: down ? AndroidMotionEventButton.Primary : AndroidMotionEventButton.None,
          buttons: down ? AndroidMotionEventButton.Primary : AndroidMotionEventButton.None,
        });
        break;
      }
      case "scroll":
        await controller.injectScroll({
          pointerX: message.x,
          pointerY: message.y,
          videoWidth: message.videoWidth,
          videoHeight: message.videoHeight,
          scrollX: message.scrollX,
          scrollY: message.scrollY,
          buttons: AndroidMotionEventButton.None,
        });
        break;
      case "text":
        await controller.injectText(message.text);
        break;
      case "keyEvent":
        await controller.injectKeyCode({
          action: message.action === "down" ? AndroidKeyEventAction.Down : AndroidKeyEventAction.Up,
          // The frontend owns mapping a browser key to an AOSP KEYCODE_* value
          // — this just proxies whatever numeric value it's given, so there's
          // no closed set to validate against here.
          keyCode: message.androidKeyCode as AndroidKeyCode,
          repeat: 0,
          // Same proxy posture as keyCode above: parseDeviceInput already
          // validated this is a safe u32 and normalized a missing metaState to
          // 0, so it's just forwarded — the frontend owns which
          // AndroidKeyEventMeta bits to set. `?? 0` is belt-and-suspenders for
          // metaState's `?` in the KeyEventInput type (any caller that skips
          // parseDeviceInput would otherwise see `undefined` reach the wire as
          // NaN).
          metaState: (message.metaState ?? 0) as AndroidKeyEventMeta,
        });
        break;
      case "clipboard":
        // Routed through Device.setClipboard (device-manager.ts) rather than
        // calling controller.setClipboard directly, so a host-initiated paste
        // from this panel updates the SAME last-known-clipboard cache the
        // one-shot `clipboard get` action reads — scrcpy does NOT echo a
        // host-initiated SET_CLIPBOARD back through the autosync clipboard
        // stream (Device.pumpClipboard only ever sees DEVICE-initiated
        // copies), so without this an agent's `clipboard get` right after a
        // panel paste would return stale data. See Device.setClipboard's own
        // comment for the sequence-0n/fire-and-forget reasoning.
        await this.device.setClipboard(message.text, true);
        break;
      case "back":
        await controller.backOrScreenOn(AndroidKeyEventAction.Down);
        await controller.backOrScreenOn(AndroidKeyEventAction.Up);
        break;
      case "rotate":
        await controller.rotateDevice();
        break;
      case "button":
      case "hidKey":
        // iOS-only inputs; Android uses `back` and `keyEvent`.
        break;
    }
  }

  // --- one-shot actions -------------------------------------------------

  /** The live adb connection's shell, or a 400. Every one-shot action starts
   * here, so "no live adb connection" is answered before any other check. */
  private shell() {
    const adb = this.device.adbConnection;
    if (!adb) {
      throw new DeviceActionError(
        400,
        `device ${this.device.id} has no live adb connection (status: ${this.device.toInfo().status})`,
      );
    }
    return adb.subprocess.noneProtocol;
  }

  /** The scrcpy control channel, or a 400. Requires scrcpy specifically (not
   * just adb), which can lag adbConnection briefly during boot (Device.spawn
   * establishes adb, then pushes+starts scrcpy) — a clear 400 in that narrow
   * window rather than falling back to the shell. */
  private requireController() {
    this.shell();
    const controller = this.device.controller;
    if (!controller) {
      throw new DeviceActionError(
        400,
        `device ${this.device.id} has no live scrcpy control connection yet (status: ${this.device.toInfo().status})`,
      );
    }
    return controller;
  }

  async screenshot(): Promise<Uint8Array> {
    const png = await this.shell().spawnWait(shellExecArgv(["screencap", "-p"]));
    const image = extractPng(png);
    if (!image) {
      const head = Buffer.from(png.subarray(0, 200))
        .toString("utf8")
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "?");
      throw new DeviceActionError(502, `screencap did not return a PNG: ${head}`);
    }
    if (!pngDimensions(image)) {
      throw new DeviceActionError(502, "screencap returned a PNG with no readable header");
    }
    return image;
  }

  async tap(x: number, y: number): Promise<void> {
    await this.shell().spawnWaitText(shellExecArgv(["input", "tap", String(x), String(y)]));
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs?: number): Promise<void> {
    const args = ["input", "swipe", String(x1), String(y1), String(x2), String(y2)];
    if (durationMs !== undefined) args.push(String(durationMs));
    await this.shell().spawnWaitText(shellExecArgv(args));
  }

  async text(text: string): Promise<void> {
    // Routed through the scrcpy control channel (same as the live WS panel's
    // own "text" input), NOT `adb shell input text`: that path re-tokenizes
    // through the device's own shell (see shellQuoteArg's comment) for no
    // reason — injectText needs no shell at all.
    await this.requireController().injectText(text);
  }

  async key(androidKeyCode: number): Promise<void> {
    await this.shell().spawnWaitText(shellExecArgv(["input", "keyevent", String(androidKeyCode)]));
  }

  async button(_button: DeviceButton): Promise<void> {
    throw new DeviceActionError(400, 'action "button" is not supported on android devices');
  }

  async logs(options: { lines?: number; filter?: string }): Promise<string> {
    const args = ["logcat", "-d", "-t", String(options.lines ?? 200)];
    if (options.filter) args.push(options.filter);
    return this.shell().spawnWaitText(shellExecArgv(args));
  }

  /** Opens an http(s) URL in the device's default browser with a VIEW
   * intent. A loopback URL (`127.0.0.1`, `localhost`, `[::1]`) means "the
   * host running this adb server", not the device itself, so its port is
   * first mapped back with `adb reverse` (Device.reversePort) — the same
   * route on an emulator and a USB/wireless physical device, where an
   * emulator's own `10.0.2.2` alias would not exist. Any other host is
   * opened as is (a Mullion preview URL, say). The mapping stays until the
   * device is stopped (Device.teardownProcess removes it). */
  async openUrl(url: string): Promise<void> {
    if (!isOpenableUrl(url)) {
      throw new DeviceActionError(400, "openurl takes an http(s) URL");
    }
    const shell = this.shell();
    const u = new URL(url);
    if (isLoopbackHostname(u.hostname)) {
      const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
      try {
        await this.device.reversePort(port);
      } catch (err) {
        throw new DeviceActionError(
          502,
          `adb reverse tcp:${port} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const out = await shell.spawnWaitText(
      shellExecArgv(["am", "start", "-a", "android.intent.action.VIEW", "-d", u.href]),
    );
    // `am start` exits 0 even when no activity takes the intent; it says so
    // on a line starting with "Error".
    const error = out.split("\n").find((line) => line.startsWith("Error"));
    if (error) throw new DeviceActionError(502, `am start failed: ${error.trim()}`);
  }

  readonly clipboard = {
    // Scoped to "while a live scrcpy session for this device exists" for BOTH
    // sub-ops — including `get`, even though it only ever reads a local
    // cache — so `get` cannot answer from a stale cache after that session
    // has gone away. It reads the last-known-clipboard CACHE
    // (Device.lastClipboard), never a live GET_CLIPBOARD round-trip: scrcpy
    // only replies to GET_CLIPBOARD when clipboardAutosync is disabled, and
    // Mullion runs with it enabled (the AVD panel's clipboard-sync feature,
    // #1436, depends on it). `null` — not an error — is the correct answer for
    // "nothing copied or set yet this session".
    get: (): string | null => {
      this.requireController();
      return this.device.lastClipboard;
    },
    set: async (text: string, paste: boolean): Promise<void> => {
      this.requireController();
      if (Buffer.byteLength(text, "utf8") > CLIPBOARD_MAX_BYTES) {
        throw new DeviceActionError(
          400,
          `clipboard text exceeds scrcpy's ${CLIPBOARD_MAX_BYTES}-byte limit`,
        );
      }
      // Through Device.setClipboard so this verb and the live panel's paste
      // share one code path and keep the SAME cache up to date.
      await this.device.setClipboard(text, paste);
    },
  };
}
