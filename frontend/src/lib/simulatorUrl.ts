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
  u.protocol = "http:";
  u.hostname = "127.0.0.1";
  return u.toString();
}
