import { shapeScreenshot } from "../screenshot-image.js";
import {
  DeviceActionError,
  type DeviceAction,
  type DeviceActionResult,
  type DeviceDriver,
} from "./types.js";

// Platform-neutral half of the one-shot action endpoint
// (POST /api/devices/:id/action, i.e. `mullion device <verb>`): body
// validation, the unsupported-action gate, and mapping a driver's primitives
// to the REST response shapes. A driver supplies only the primitives.

export function isDeviceAction(value: unknown): value is DeviceAction {
  const v = value as Partial<DeviceAction> | null;
  if (typeof v !== "object" || v === null || typeof v.action !== "string") return false;
  switch (v.action) {
    case "screenshot":
      return (
        v.maxWidth === undefined ||
        (typeof v.maxWidth === "number" && Number.isFinite(v.maxWidth) && v.maxWidth >= 0)
      );
    case "tap":
      return typeof v.x === "number" && typeof v.y === "number";
    case "swipe":
      return (
        typeof v.x1 === "number" &&
        typeof v.y1 === "number" &&
        typeof v.x2 === "number" &&
        typeof v.y2 === "number"
      );
    case "text":
      return typeof v.text === "string";
    case "key":
      return typeof v.androidKeyCode === "number";
    case "logcat":
      // Unlike screenshot, logcat has two OPTIONAL fields — both must be
      // the right type when present, not just "any object passes" the way
      // this branch used to (Hermes review): a stray non-number `lines` or
      // non-string `filter` must 400 here, not surface as a confusing
      // downstream error once it reaches a driver's shell-escaping.
      return (
        (v.lines === undefined || typeof v.lines === "number") &&
        (v.filter === undefined || typeof v.filter === "string")
      );
    case "clipboard": {
      // `op` is itself a sub-discriminant — narrow on it before touching
      // `text`/`paste`, same reasoning logcat's own comment gives for
      // typing optional fields strictly rather than letting a malformed
      // body slip through to the driver.
      const c = v as Partial<{ op: "get" | "set"; text: string; paste: boolean }>;
      // `get` takes no fields of its own — same strict "reject anything
      // that doesn't belong" posture as logcat's own optional-field
      // checks above, even though a stray `text`/`paste` alongside
      // `op: "get"` would otherwise be harmlessly ignored.
      if (c.op === "get") return c.text === undefined && c.paste === undefined;
      if (c.op === "set") {
        return (
          typeof c.text === "string" && (c.paste === undefined || typeof c.paste === "boolean")
        );
      }
      return false;
    }
    default:
      return false;
  }
}

/** Shapes a native-resolution PNG into the screenshot response. No maxWidth
 * (CLI, dashboard) keeps the native PNG; the MCP tool supplies a default.
 * tap/swipe always take native pixels. */
export function toScreenshotResult(
  png: Uint8Array,
  maxWidth: number | undefined,
): DeviceActionResult {
  const shaped = shapeScreenshot(png, maxWidth);
  return {
    screenshot: Buffer.from(shaped.data).toString("base64"),
    mimeType: shaped.mimeType,
    width: shaped.width,
    height: shaped.height,
    nativeWidth: shaped.nativeWidth,
    nativeHeight: shaped.nativeHeight,
  };
}

/** Runs one validated action against a driver. Throws DeviceActionError for
 * an action the driver's platform does not implement, and whatever the
 * driver throws for its own failures. */
export async function performDeviceAction(
  driver: DeviceDriver,
  action: DeviceAction,
): Promise<DeviceActionResult> {
  if (!driver.supports(action.action)) {
    throw new DeviceActionError(
      400,
      `action "${action.action}" is not supported on ${driver.platform} devices`,
    );
  }
  switch (action.action) {
    case "screenshot":
      return toScreenshotResult(await driver.screenshot(), action.maxWidth);
    case "tap":
      await driver.tap(action.x, action.y);
      return { ok: true };
    case "swipe":
      await driver.swipe(action.x1, action.y1, action.x2, action.y2, action.durationMs);
      return { ok: true };
    case "text":
      await driver.text(action.text);
      return { ok: true };
    case "key":
      await driver.key(action.androidKeyCode);
      return { ok: true };
    case "logcat":
      return { logcat: await driver.logs({ lines: action.lines, filter: action.filter }) };
    case "clipboard":
      if (action.op === "get") return { text: await driver.clipboard.get() };
      await driver.clipboard.set(action.text, action.paste ?? false);
      return { ok: true };
  }
}
