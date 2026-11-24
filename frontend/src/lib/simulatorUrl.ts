import { LOCAL_HOST_ID } from "../../../src/shared/constants.js";
import type { Device } from "../api/index.js";

/** The URL to hand a simulator's browser for a project's dev server, or null
 * when the simulator cannot reach it.
 *
 * `address` is the dev server's address as seen from `devServerHostId` (the
 * browser-destinations entry), and `localhost` in it points at that host's own
 * loopback. A simulator on that same host opens `http://127.0.0.1:<port><path>`;
 * a simulator on any other host has no route to that loopback and gets null.
 * The scheme is forced to http: a certificate issued for `localhost` can never
 * match `127.0.0.1`, so https would only show Safari's certificate error. */
export function simulatorOpenUrl(
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

/** How a simulator reaches a Preview-menu entry (#3491). */
export type SimulatorRoute =
  /** Open this URL as is (the dev server on the simulator's own loopback). */
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

/** A base host that only ever resolves to the primary's own loopback, which a
 * simulator on another host (an agent Mac) cannot reach. */
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

/** Whether a preview URL can work for a simulator on `deviceHostId`, or the
 * reason it cannot. */
function previewRoute(deviceHostId: string, previews: PreviewAvailability): SimulatorRoute {
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
      reason: `The preview host (${previews.previewBaseHost}) is a loopback name, which a simulator on another host cannot reach`,
    };
  }
  return { kind: "preview" };
}

/** The project's dev server: a simulator on the dev server's own host opens
 * its loopback URL directly (no proxy, no auth); one on any other host goes
 * through the Mullion preview, which proxies to the dev server's host. */
export function simulatorDevServerRoute(
  address: string,
  device: Pick<Device, "hostId">,
  devServerHostId: string,
  previews: PreviewAvailability,
): SimulatorRoute {
  const url = simulatorOpenUrl(address, device, devServerHostId);
  if (url) return { kind: "direct", url };
  return previewRoute(device.hostId, previews);
}

/** A named preview target: always through its Mullion preview, whatever host
 * the simulator is on (the target's own address is resolved by the proxy,
 * with the target's connection origin). */
export function simulatorTargetRoute(
  device: Pick<Device, "hostId">,
  previews: PreviewAvailability,
): SimulatorRoute {
  return previewRoute(device.hostId, previews);
}
