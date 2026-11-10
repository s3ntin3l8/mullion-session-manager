import { DEVICE_SCREENSHOT_DEFAULT_WIDTH, deviceScreenshot } from "./device-screenshot.mjs";

export const useDevice = {
  name: "use_device",
  description:
    "Execute a one-shot Android device action (screenshot, tap, swipe, text, key, logcat, " +
    "clipboard) against the device's live adb/scrcpy connection — works independently of " +
    "whether the device's video panel is currently open in the dashboard. Use list_devices " +
    "to find a deviceId first.",
  inputSchema: {
    type: "object",
    required: ["deviceId", "action"],
    properties: {
      deviceId: { type: "string", description: "The device's row id, from list_devices." },
      action: {
        type: "string",
        enum: ["screenshot", "tap", "swipe", "text", "key", "logcat", "clipboard"],
        description: "The device action to execute.",
      },
      x: {
        type: "number",
        description: "X coordinate, screen pixels — same space as screenshot (tap).",
      },
      y: {
        type: "number",
        description: "Y coordinate, screen pixels — same space as screenshot (tap).",
      },
      x1: {
        type: "number",
        description: "Start X, screen pixels — same space as screenshot (swipe).",
      },
      y1: {
        type: "number",
        description: "Start Y, screen pixels — same space as screenshot (swipe).",
      },
      x2: {
        type: "number",
        description: "End X, screen pixels — same space as screenshot (swipe).",
      },
      y2: {
        type: "number",
        description: "End Y, screen pixels — same space as screenshot (swipe).",
      },
      durationMs: { type: "number", description: "Swipe duration in milliseconds (swipe)." },
      maxWidth: {
        type: "number",
        description:
          `Screenshot width cap in pixels (screenshot). Defaults to ${DEVICE_SCREENSHOT_DEFAULT_WIDTH}: ` +
          "the image is downscaled and sent as JPEG. 0 returns the native PNG. tap/swipe " +
          "coordinates stay in NATIVE pixels — the text beside the image states the scale.",
      },
      text: {
        type: "string",
        description: "Text to type (text), or the text to place on the clipboard (clipboard set).",
      },
      androidKeyCode: {
        type: "number",
        description: "AOSP KEYCODE_* numeric value to send (key).",
      },
      lines: { type: "number", description: "Number of trailing log lines to return (logcat)." },
      filter: {
        type: "string",
        description: "logcat filter expression, e.g. 'MyApp:D *:S' (logcat).",
      },
      op: {
        type: "string",
        enum: ["get", "set"],
        description:
          "clipboard sub-operation (clipboard). 'get' returns the last-known device " +
          "clipboard text from a cache — never a live round-trip to the device, which scrcpy " +
          "only supports with clipboard autosync disabled (Mullion runs with it enabled). " +
          "'set' writes `text` to the device clipboard via the scrcpy control channel.",
      },
      paste: {
        type: "boolean",
        description:
          "Also simulate a paste action after setting the clipboard (clipboard set). " +
          "Defaults to false — set without pasting.",
      },
    },
  },
  async handler(args, client) {
    const { deviceId, ...actionPayload } = args ?? {};
    if (!deviceId) throw new Error("deviceId is required");
    if (actionPayload.action === "screenshot") {
      return deviceScreenshot(client, deviceId, actionPayload);
    }
    return JSON.stringify(await client.deviceAction(deviceId, actionPayload));
  },
};
