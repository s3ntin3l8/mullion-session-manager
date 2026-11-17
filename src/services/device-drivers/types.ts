// The platform-neutral seam between the device routes and a platform's engine.
// routes/device.ts (live WS panel) and routes/devices.ts (one-shot action
// endpoint) talk only to `DeviceDriver`; the Android implementation
// (adb + scrcpy) lives in ./android.ts. An iOS Simulator driver (#1943) is a
// second implementation of the same interface.
//
// The driver wraps a live engine; it does NOT own its lifecycle yet.
// DeviceManager still spawns/attaches/terminates (scope backend, port pool),
// so there is no `start()` here — it arrives with the first driver whose
// lifecycle is not the manager's.

export type DevicePlatform = "android" | "ios";

export type DeviceKind = "emulator" | "physical";

export type DeviceLiveStatus = "starting" | "booting" | "streaming" | "exited" | "error";

export interface DeviceInfo {
  id: string;
  kind: DeviceKind;
  avdName: string | null;
  label: string | null;
  status: DeviceLiveStatus;
  serial: string | null;
  error: string | null;
}

/** One encoded video packet. The shape `encodeVideoFrame` (routes/device.ts)
 * frames onto the WS wire: `configuration` carries SPS/PPS, `data` a coded
 * frame. Structurally a subset of scrcpy's `ScrcpyMediaStreamPacket`, and an
 * iOS driver produces the same from idb's Annex-B stream. */
export type DeviceVideoPacket =
  | { type: "configuration"; data: Uint8Array }
  | { type: "data"; keyframe?: boolean; data: Uint8Array };

export type Unsubscribe = () => void;

// --- live input (the WS panel's JSON messages, validated) -----------------

export interface TapInput {
  type: "tap";
  x: number;
  y: number;
  videoWidth: number;
  videoHeight: number;
}

export interface TouchInput {
  type: "touchDown" | "touchMove" | "touchUp";
  x: number;
  y: number;
  videoWidth: number;
  videoHeight: number;
  pointerId: number;
}

export interface ScrollInput {
  type: "scroll";
  x: number;
  y: number;
  videoWidth: number;
  videoHeight: number;
  scrollX: number;
  scrollY: number;
}

export interface TextInput {
  type: "text";
  text: string;
}

/** `androidKeyCode` is an AOSP `KEYCODE_*` numeric value — the frontend owns
 * mapping a browser KeyboardEvent to this. `metaState` is the scrcpy
 * `AndroidKeyEventMeta` bitmask (optional, defaulting to 0). */
export interface KeyEventInput {
  type: "keyEvent";
  androidKeyCode: number;
  action: "down" | "up";
  metaState?: number;
}

/** Host clipboard text to place on the device and paste. */
export interface ClipboardInput {
  type: "clipboard";
  text: string;
}

export interface BackInput {
  type: "back";
}

export interface RotateInput {
  type: "rotate";
}

export type DeviceInput =
  | TapInput
  | TouchInput
  | ScrollInput
  | TextInput
  | KeyEventInput
  | ClipboardInput
  | BackInput
  | RotateInput;

// --- one-shot actions (`mullion device <verb>`, POST /api/devices/:id/action)

export type DeviceAction =
  | { action: "screenshot"; maxWidth?: number }
  | { action: "tap"; x: number; y: number }
  | { action: "swipe"; x1: number; y1: number; x2: number; y2: number; durationMs?: number }
  | { action: "text"; text: string }
  | { action: "key"; androidKeyCode: number }
  | { action: "logcat"; lines?: number; filter?: string }
  | { action: "clipboard"; op: "get" }
  | { action: "clipboard"; op: "set"; text: string; paste?: boolean };

export type DeviceActionName = DeviceAction["action"];

export type DeviceActionResult =
  | {
      screenshot: string;
      mimeType: string;
      width: number;
      height: number;
      nativeWidth: number;
      nativeHeight: number;
    }
  | { ok: true }
  | { logcat: string }
  | { text: string | null };

/** A failure a driver wants answered as a specific 4xx/5xx with a clear
 * message, as opposed to an unexpected error (which stays a 500). */
export class DeviceActionError extends Error {
  constructor(
    readonly statusCode: 400 | 502,
    message: string,
  ) {
    super(message);
    this.name = "DeviceActionError";
  }
}

export interface DeviceDriver {
  readonly platform: DevicePlatform;
  readonly id: string;
  readonly isAlive: boolean;
  /** True once the live input/control channel exists (it can lag the
   * connection briefly during boot). */
  readonly hasLiveControl: boolean;

  toInfo(): DeviceInfo;
  /** Tears the engine down (does not remove the DB row). */
  stop(): Promise<void>;

  /** Subscribes to encoded video. Replays the codec configuration to a new
   * subscriber so a late joiner can configure its decoder. */
  onVideoPacket(listener: (packet: DeviceVideoPacket) => void): Unsubscribe;
  onExit(listener: () => void): Unsubscribe;
  /** Live-only device-side clipboard copies; no replay on subscribe. */
  onClipboard(listener: (text: string) => void): Unsubscribe;
  /** Asks the engine for a fresh keyframe. Resolves immediately when there
   * is nothing to ask; rejects when the request fails. */
  requestKeyframe(): Promise<void>;

  /** Live input. Silently dropped while there is no control channel. */
  input(message: DeviceInput): Promise<void>;

  // One-shot action primitives. Each throws DeviceActionError for a
  // condition with a clear status (no live connection, bad screenshot, …).
  screenshot(): Promise<Uint8Array>;
  tap(x: number, y: number): Promise<void>;
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs?: number): Promise<void>;
  text(text: string): Promise<void>;
  key(androidKeyCode: number): Promise<void>;
  logs(options: { lines?: number; filter?: string }): Promise<string>;
  clipboard: {
    /** Last-known device clipboard (a cache, never a live round-trip). */
    get(): string | null;
    set(text: string, paste: boolean): Promise<void>;
  };

  /** Whether this platform implements an action; an unsupported one is
   * answered with a 4xx naming the action and platform. */
  supports(action: DeviceActionName): boolean;
}
