import { CLIPBOARD_MAX_BYTES } from "../device-defaults.js";
import type {
  ButtonInput,
  ClipboardInput,
  DeviceButton,
  DeviceInput,
  HidKeyInput,
  KeyEventInput,
  ScrollInput,
  TapInput,
  TextInput,
  TouchInput,
} from "./types.js";

// Validates one live-panel JSON control message (routes/device.ts's WS) into a
// DeviceInput. Platform-neutral: it checks shape only, a driver decides what a
// message means on its platform.

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

// scrcpy's InjectKeyCode control message packs metaState into a u32 on the
// wire — reject anything that couldn't round-trip through that (negative,
// fractional, or too large), rather than silently truncating or wrapping it.
const MAX_META_STATE = 0xffffffff;
function isValidMetaState(v: unknown): v is number {
  return isFiniteNumber(v) && Number.isInteger(v) && v >= 0 && v <= MAX_META_STATE;
}

const MAX_HID_USAGE = 0xffff;
const VALID_BUTTONS = new Set<DeviceButton>(["home", "lock", "side", "siri"]);

function isValidHidUsage(v: unknown): v is number {
  return isFiniteNumber(v) && Number.isInteger(v) && v >= 0 && v <= MAX_HID_USAGE;
}

export function parseDeviceInput(value: unknown): DeviceInput | null {
  const v = value as Partial<DeviceInput> | null;
  if (typeof v !== "object" || v === null || typeof v.type !== "string") return null;
  switch (v.type) {
    case "tap": {
      const m = v as Partial<TapInput>;
      if (
        isFiniteNumber(m.x) &&
        isFiniteNumber(m.y) &&
        isFiniteNumber(m.videoWidth) &&
        isFiniteNumber(m.videoHeight)
      ) {
        return {
          type: "tap",
          x: m.x,
          y: m.y,
          videoWidth: m.videoWidth,
          videoHeight: m.videoHeight,
        };
      }
      return null;
    }
    case "touchDown":
    case "touchMove":
    case "touchUp": {
      const m = v as Partial<TouchInput>;
      if (
        isFiniteNumber(m.x) &&
        isFiniteNumber(m.y) &&
        isFiniteNumber(m.videoWidth) &&
        isFiniteNumber(m.videoHeight) &&
        isFiniteNumber(m.pointerId)
      ) {
        return {
          type: v.type,
          x: m.x,
          y: m.y,
          videoWidth: m.videoWidth,
          videoHeight: m.videoHeight,
          pointerId: m.pointerId,
        };
      }
      return null;
    }
    case "scroll": {
      const m = v as Partial<ScrollInput>;
      if (
        isFiniteNumber(m.x) &&
        isFiniteNumber(m.y) &&
        isFiniteNumber(m.videoWidth) &&
        isFiniteNumber(m.videoHeight) &&
        isFiniteNumber(m.scrollX) &&
        isFiniteNumber(m.scrollY)
      ) {
        return {
          type: "scroll",
          x: m.x,
          y: m.y,
          videoWidth: m.videoWidth,
          videoHeight: m.videoHeight,
          scrollX: m.scrollX,
          scrollY: m.scrollY,
        };
      }
      return null;
    }
    case "text": {
      const m = v as Partial<TextInput>;
      return typeof m.text === "string" ? { type: "text", text: m.text } : null;
    }
    case "keyEvent": {
      const m = v as Partial<KeyEventInput>;
      if (!isFiniteNumber(m.androidKeyCode) || (m.action !== "down" && m.action !== "up")) {
        return null;
      }
      if (m.metaState !== undefined && !isValidMetaState(m.metaState)) return null;
      return {
        type: "keyEvent",
        androidKeyCode: m.androidKeyCode,
        action: m.action,
        metaState: m.metaState ?? 0,
      };
    }
    case "clipboard": {
      const m = v as Partial<ClipboardInput>;
      if (
        typeof m.text === "string" &&
        m.text.length > 0 &&
        Buffer.byteLength(m.text, "utf8") <= CLIPBOARD_MAX_BYTES
      ) {
        return { type: "clipboard", text: m.text };
      }
      return null;
    }
    case "back":
      return { type: "back" };
    case "rotate":
      return { type: "rotate" };
    case "button": {
      const m = v as Partial<ButtonInput>;
      return typeof m.button === "string" && VALID_BUTTONS.has(m.button as DeviceButton)
        ? { type: "button", button: m.button as DeviceButton }
        : null;
    }
    case "hidKey": {
      const m = v as Partial<HidKeyInput>;
      if (!isValidHidUsage(m.usage) || (m.action !== "down" && m.action !== "up")) {
        return null;
      }
      return { type: "hidKey", usage: m.usage, action: m.action };
    }
    default:
      return null;
  }
}
