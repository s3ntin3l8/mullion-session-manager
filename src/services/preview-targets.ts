import { isAllowedHttpUrl } from "./url-guard.js";

export const CONFIGURED_PREVIEW_POLICY = { allowLoopback: true, allowPrivate: true };

/** Configured destinations use the same trust level as a project's dev server. */
export function normalizePreviewDestination(value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  let candidate = text;
  if (/^\d+$/.test(text)) {
    const port = Number(text);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    candidate = `http://127.0.0.1:${port}`;
  } else if (!/^https?:\/\//i.test(text)) {
    // Only host:port shorthand: never reinterpret an arbitrary URI scheme.
    if (!/^(?:[a-z\d.-]+|\[[a-f\d:]+\]):\d+(?:[/?].*)?$/i.test(text)) return null;
    candidate = `http://${text}`;
  }
  if (!isAllowedHttpUrl(candidate, CONFIGURED_PREVIEW_POLICY)) return null;
  const url = new URL(candidate);
  if (url.username || url.password || url.hash || url.port === "0") return null;
  return url.href;
}
