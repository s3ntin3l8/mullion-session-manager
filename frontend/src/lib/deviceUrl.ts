import { LOCAL_HOST_ID } from "../../../src/shared/constants.js";
import type { Device } from "../api/index.js";

// How the Dock's Preview menu hands a URL to a running device's browser: an
// iOS Simulator (`simctl openurl`) or an Android emulator/phone (`am start`
// with a VIEW intent), both through the same `openurl` device action
// (#3429, #3491, #3559).

/** The URL to hand a device's browser for a project's dev server, or null
 * when the device cannot reach it.
 *
 * `address` is the dev server's address as seen from `devServerHostId` (the
 * browser-destinations entry), and `localhost` in it points at that host's own
 * loopback. A device on that same host opens `http://127.0.0.1:<port><path>`:
 * an iOS Simulator shares its Mac's loopback, and for an Android device the
 * backend maps the port back to the host with `adb reverse` before opening
 * it. A device on any other host has no route to that loopback and gets null.
 * The scheme is forced to http: a certificate issued for `localhost` can never
 * match `127.0.0.1`, so https would only show the browser's certificate error. */
export function deviceOpenUrl(
  address: string,
  device: Pick<Device, "hostId">,
  devServerHostId: string,
): string | null {
  if (device.hostId !== devServerHostId) return null;
  let u: URL;
  try {
    u = new URL(address);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  // Switching the scheme re-normalises a default port away (443 -> 80), so carry
  // the original port across explicitly.
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  u.protocol = "http:";
  u.hostname = "127.0.0.1";
  u.port = port;
  return u.toString();
}

/** The slice of a device a route depends on; `live` is optional so a caller
 * that only knows the host gets the host-based answer. */
type DeviceRef = Pick<Device, "hostId"> & Partial<Pick<Device, "live">>;

/** How a device reaches a Preview-menu entry. */
export type DeviceRoute =
  /** Open this URL as is (the dev server on the device host's loopback). */
  | { kind: "direct"; url: string }
  /** Open the entry's Mullion preview URL (`preview-<slug>.<base host>`). */
  | { kind: "preview" }
  /** Cannot be opened; `reason` says why (shown on the disabled row). */
  | { kind: "unavailable"; reason: string };

/** What the menu knows about the preview proxy (from `GET /api/server-info`):
 * the settings, or that they are still loading or could not be read. */
export type PreviewAvailability =
  { previewsEnabled: boolean; previewBaseHost: string } | "loading" | "failed";

const PREVIEWS_OFF =
  "Previews are not enabled on this server (PREVIEW_BASE_HOST), so there is no preview URL to open";

/** Whether the Preview menu lists a device at all: an iOS Simulator or an
 * Android emulator/phone whose row is active and that has a live process
 * which has not exited. */
export function isOpenableDevice(d: Device): boolean {
  return (
    (d.platform === "ios" || d.platform === "android") &&
    d.status === "active" &&
    d.live != null &&
    d.live.status !== "exited" &&
    d.live.status !== "error"
  );
}

/** Whether the device is still starting or booting, so it cannot take a URL yet. */
export function isDeviceBooting(device: DeviceRef): boolean {
  const status = device.live?.status;
  return status === "starting" || status === "booting";
}

/** A reason the device cannot take a URL yet, or null when it can. */
function notReady(device: DeviceRef): string | null {
  return isDeviceBooting(device)
    ? "The device is still booting; try again once it is running"
    : null;
}

/** A base host that only ever resolves to the primary's own loopback, which a
 * device on another host (an agent Mac, a phone on an agent host) cannot reach. */
function isLoopbackHost(host: string): boolean {
  const raw = host.trim().toLowerCase();
  if (raw === "::1") return true;
  // Drop a port before comparing names.
  const name = raw.replace(/:\d+$/, "");
  return (
    name === "localhost" ||
    name.endsWith(".localhost") ||
    name === "[::1]" ||
    name === "0.0.0.0" ||
    /^127(\.\d{1,3}){3}$/.test(name)
  );
}

/** Whether a preview URL can work for a device on `deviceHostId`, or the
 * reason it cannot. */
function previewRoute(deviceHostId: string, previews: PreviewAvailability): DeviceRoute {
  if (previews === "loading") {
    return { kind: "unavailable", reason: "Checking whether previews are enabled…" };
  }
  if (previews === "failed") {
    return {
      kind: "unavailable",
      reason: "Could not read the server's preview settings; retrying shortly",
    };
  }
  if (!previews.previewsEnabled || !previews.previewBaseHost.trim()) {
    return { kind: "unavailable", reason: PREVIEWS_OFF };
  }
  if (deviceHostId !== LOCAL_HOST_ID && isLoopbackHost(previews.previewBaseHost)) {
    return {
      kind: "unavailable",
      reason: `The preview host (${previews.previewBaseHost}) is a loopback name, which a device on another host cannot reach`,
    };
  }
  return { kind: "preview" };
}

/** The project's dev server: a device on the dev server's own host opens its
 * loopback URL directly (no proxy, no auth); one on any other host goes
 * through the Mullion preview, which proxies to the dev server's host. */
export function deviceDevServerRoute(
  address: string,
  device: DeviceRef,
  devServerHostId: string,
  previews: PreviewAvailability,
): DeviceRoute {
  const booting = notReady(device);
  if (booting) return { kind: "unavailable", reason: booting };
  const url = deviceOpenUrl(address, device, devServerHostId);
  if (url) return { kind: "direct", url };
  // Same host but no loopback URL: the address itself is unusable, and the
  // preview would proxy to the same unusable address.
  if (device.hostId === devServerHostId) {
    return {
      kind: "unavailable",
      reason: `The dev server's address (${address}) is not an http(s) URL`,
    };
  }
  return previewRoute(device.hostId, previews);
}

/** A named preview target: always through its Mullion preview, whatever host
 * the device is on (the target's own address is resolved by the proxy, with
 * the target's connection origin). */
export function deviceTargetRoute(device: DeviceRef, previews: PreviewAvailability): DeviceRoute {
  const booting = notReady(device);
  if (booting) return { kind: "unavailable", reason: booting };
  return previewRoute(device.hostId, previews);
}
