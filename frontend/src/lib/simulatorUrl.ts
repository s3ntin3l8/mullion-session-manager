import type { Device } from "../api/index.js";

const PORT_ONLY = /^\d{1,5}$/;

/** The URL to hand a simulator's browser for a project's dev server, or null
 * when the simulator cannot reach it.
 *
 * `devServerUrl` is a bare port or an http(s) URL, but only its port, scheme
 * and path matter: the dev server is always on the loopback of the project's
 * own host (the preview proxy ignores the URL's host the same way). So a
 * simulator on that same host opens `http://127.0.0.1:<port>`; a simulator on
 * any other host has no route to that loopback and gets null. */
export function simulatorOpenUrl(
  devServerUrl: string,
  device: Pick<Device, "hostId">,
  projectHostId: string,
): string | null {
  if (device.hostId !== projectHostId) return null;
  if (PORT_ONLY.test(devServerUrl)) {
    const port = Number(devServerUrl);
    return port >= 1 && port <= 65535 ? `http://127.0.0.1:${port}/` : null;
  }
  let u: URL;
  try {
    u = new URL(devServerUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hostname = "127.0.0.1";
  return u.toString();
}
