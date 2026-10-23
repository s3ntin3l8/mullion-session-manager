import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Marks a request the control socket proxies into the HTTP app via
 * `app.inject()`. The header value is a per-process random token, so a client
 * cannot forge it: routes that audit their caller trust `isControlSocketRequest`,
 * never the raw header.
 */
export const CONTROL_SOCKET_VIA_HEADER = "x-mullion-via";
export const CONTROL_SOCKET_VIA_TOKEN = randomBytes(16).toString("hex");

export function isControlSocketRequest(
  headers: Record<string, string | string[] | undefined>,
): boolean {
  const got = headers[CONTROL_SOCKET_VIA_HEADER];
  if (typeof got !== "string") return false;
  const a = Buffer.from(got);
  const b = Buffer.from(CONTROL_SOCKET_VIA_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}
