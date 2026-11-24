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
