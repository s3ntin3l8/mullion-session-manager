// Defaults for the device panel's scrcpy stream and emulator GPU mode. One
// definition shared by the env schema (src/plugins/env.ts, the deployed
// default) and DeviceManager's `??` fallbacks (a caller that doesn't pass
// the option, e.g. a test) so the two can't drift apart. See env.ts's
// DEVICE_VIDEO_* / DEVICE_EMULATOR_GPU comments for the reasoning.
export const DEFAULT_DEVICE_VIDEO_MAX_SIZE = 1280;
export const DEFAULT_DEVICE_VIDEO_MAX_FPS = 60;
export const DEFAULT_DEVICE_VIDEO_BIT_RATE = 8_000_000;
export const DEFAULT_DEVICE_EMULATOR_GPU = "swiftshader_indirect";

// scrcpy server's own CONTROL_MSG_CLIPBOARD_TEXT_MAX_LENGTH ((1 << 18) - 14):
// a longer SET_CLIPBOARD payload makes the server drop the message, and an
// oversized frame risks desyncing the whole control socket, which would kill
// every later input. Measured in UTF-8 bytes — that's what goes on the wire.
// Not a Mullion-tunable default like the constants above (there's nothing to
// override; it's a fixed scrcpy protocol limit) — shared here so both
// clipboard write paths (routes/device.ts's live WS panel and
// routes/devices.ts's one-shot `clipboard` action verb) validate against the
// exact same number instead of each carrying its own copy of this magic
// value.
export const CLIPBOARD_MAX_BYTES = (1 << 18) - 14;
