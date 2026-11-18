import type { IdbHidButtonType, IdbHidEvent, IdbPoint } from "./idb-grpc.js";
import { DeviceActionError, type DeviceButton } from "./types.js";

// USB HID Keyboard/Keypad usage codes (Usage Page 0x07, US QWERTY layout).
export const HID_KEY_LEFT_SHIFT = 0xe1;
export const HID_KEY_LEFT_GUI = 0xe3;
export const HID_KEY_V = 0x19;

interface HidKeyStroke {
  usage: number;
  shift?: boolean;
}

const US_PUNCTUATION_MAP: Record<string, HidKeyStroke> = {
  "\n": { usage: 0x28 },
  "\t": { usage: 0x2b },
  " ": { usage: 0x2c },
  "-": { usage: 0x2d },
  _: { usage: 0x2d, shift: true },
  "=": { usage: 0x2e },
  "+": { usage: 0x2e, shift: true },
  "[": { usage: 0x2f },
  "{": { usage: 0x2f, shift: true },
  "]": { usage: 0x30 },
  "}": { usage: 0x30, shift: true },
  "\\": { usage: 0x31 },
  "|": { usage: 0x31, shift: true },
  ";": { usage: 0x33 },
  ":": { usage: 0x33, shift: true },
  "'": { usage: 0x34 },
  '"': { usage: 0x34, shift: true },
  "`": { usage: 0x35 },
  "~": { usage: 0x35, shift: true },
  ",": { usage: 0x36 },
  "<": { usage: 0x36, shift: true },
  ".": { usage: 0x37 },
  ">": { usage: 0x37, shift: true },
  "/": { usage: 0x38 },
  "?": { usage: 0x38, shift: true },
  "!": { usage: 0x1e, shift: true },
  "@": { usage: 0x1f, shift: true },
  "#": { usage: 0x20, shift: true },
  $: { usage: 0x21, shift: true },
  "%": { usage: 0x22, shift: true },
  "^": { usage: 0x23, shift: true },
  "&": { usage: 0x24, shift: true },
  "*": { usage: 0x25, shift: true },
  "(": { usage: 0x26, shift: true },
  ")": { usage: 0x27, shift: true },
};

const BUTTON_MAP: Record<DeviceButton, IdbHidButtonType> = {
  home: "HOME",
  lock: "LOCK",
  side: "SIDE_BUTTON",
  siri: "SIRI",
};

function lookupUsAsciiKey(ch: string): HidKeyStroke | null {
  const code = ch.codePointAt(0);
  if (code === undefined) return null;
  if (code >= 0x61 && code <= 0x7a) {
    // 'a'..'z'
    return { usage: 0x04 + (code - 0x61) };
  }
  if (code >= 0x41 && code <= 0x5a) {
    // 'A'..'Z'
    return { usage: 0x04 + (code - 0x41), shift: true };
  }
  if (code >= 0x31 && code <= 0x39) {
    // '1'..'9'
    return { usage: 0x1e + (code - 0x31) };
  }
  if (code === 0x30) {
    // '0'
    return { usage: 0x27 };
  }
  return US_PUNCTUATION_MAP[ch] ?? null;
}

/** Builds DOWN/UP HID key events for a single key, optionally wrapped in a
 * modifier key DOWN/UP pair. */
export function keyComboToHidEvents(usage: number, modifier?: number): IdbHidEvent[] {
  const events: IdbHidEvent[] = [];
  if (modifier !== undefined) {
    events.push({ press: { action: { key: { keycode: modifier } }, direction: "DOWN" } });
  }
  events.push(
    { press: { action: { key: { keycode: usage } }, direction: "DOWN" } },
    { press: { action: { key: { keycode: usage } }, direction: "UP" } },
  );
  if (modifier !== undefined) {
    events.push({ press: { action: { key: { keycode: modifier } }, direction: "UP" } });
  }
  return events;
}

/** Converts a printable US-ASCII string into HID key events. Rejects any
 * non-ASCII or unmapped character with a 400 naming it. */
export function textToHidEvents(text: string): IdbHidEvent[] {
  const events: IdbHidEvent[] = [];
  for (const ch of text) {
    const stroke = lookupUsAsciiKey(ch);
    if (!stroke) {
      throw new DeviceActionError(
        400,
        `iOS text input only supports printable US-ASCII characters; unsupported character: ${JSON.stringify(ch)}`,
      );
    }
    events.push(
      ...keyComboToHidEvents(stroke.usage, stroke.shift ? HID_KEY_LEFT_SHIFT : undefined),
    );
  }
  return events;
}

/** Builds DOWN/UP HID events for a hardware simulator button. */
export function buttonToHidEvents(button: DeviceButton): IdbHidEvent[] {
  const mapped = BUTTON_MAP[button];
  return [
    { press: { action: { button: { button: mapped } }, direction: "DOWN" } },
    { press: { action: { button: { button: mapped } }, direction: "UP" } },
  ];
}

/** Builds Cmd+V (Left GUI 0xE3 + V 0x19) HID events for pasting. */
export function cmdVToHidEvents(): IdbHidEvent[] {
  return keyComboToHidEvents(HID_KEY_V, HID_KEY_LEFT_GUI);
}

/** Scales `(x, y)` from `[0..fromW, 0..fromH]` into `[0..toW, 0..toH]` points.
 * Returns null if any dimension or coordinate is non-finite or non-positive. */
export function scaleToPoints(
  x: number,
  y: number,
  fromW: number,
  fromH: number,
  toW: number,
  toH: number,
): IdbPoint | null {
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(fromW) ||
    !Number.isFinite(fromH) ||
    !Number.isFinite(toW) ||
    !Number.isFinite(toH) ||
    fromW <= 0 ||
    fromH <= 0 ||
    toW <= 0 ||
    toH <= 0
  ) {
    return null;
  }
  return {
    x: (x * toW) / fromW,
    y: (y * toH) / fromH,
  };
}

/** Matches idb_companion's stale-HID error after a simulator reboot
 * ("The dtuhidd connection (...) has been invalidated"). */
export function isInvalidatedHidError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /invalidated/i.test(message);
}
