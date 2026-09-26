// Defaults for the device panel's scrcpy stream and emulator GPU mode. One
// definition shared by the env schema (src/plugins/env.ts, the deployed
// default) and DeviceManager's `??` fallbacks (a caller that doesn't pass
// the option, e.g. a test) so the two can't drift apart. See env.ts's
// DEVICE_VIDEO_* / DEVICE_EMULATOR_GPU comments for the reasoning.
export const DEFAULT_DEVICE_VIDEO_MAX_SIZE = 1280;
export const DEFAULT_DEVICE_VIDEO_MAX_FPS = 60;
export const DEFAULT_DEVICE_VIDEO_BIT_RATE = 8_000_000;
export const DEFAULT_DEVICE_EMULATOR_GPU = "swiftshader_indirect";
