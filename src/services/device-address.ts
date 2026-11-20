// A physical device's adb TCP address, as both the one-time pairing address
// (`adb pair <host:port>`) and the ongoing connect address (`adb connect
// <host:port>`) — Android shows a DIFFERENT port for each, but both are the
// same "host:port" shape. Validated as an allowlist, not shell-escaped:
// DeviceManager.pair()/getOrCreate() pass this straight into
// AdbServerClient.wireless.pair()/connect(), which builds an adb SERVICE
// STRING (`host:pair:<password>:<address>`), not a shell command — a stray
// `:` or newline here corrupts that framing, so shellQuoteArg (in
// services/device-drivers/android.ts, used only for the on-device `adb shell`
// actions) is the wrong tool for this input.
const DEVICE_ADDRESS_PATTERN = /^([A-Za-z0-9.-]+):(\d{1,5})$/;

export function isValidDeviceAddress(address: unknown): address is string {
  if (typeof address !== "string") return false;
  const match = DEVICE_ADDRESS_PATTERN.exec(address);
  if (!match) return false;
  const port = Number(match[2]);
  return port >= 1 && port <= 65535;
}

// The 6-digit code Android's Wireless debugging screen shows during
// pairing.
const PAIRING_CODE_PATTERN = /^\d{6}$/;

export function isValidPairingCode(code: unknown): code is string {
  return typeof code === "string" && PAIRING_CODE_PATTERN.test(code);
}
