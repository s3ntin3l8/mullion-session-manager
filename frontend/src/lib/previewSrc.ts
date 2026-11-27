import { api } from "../api/index.js";
import type { ServerInfo } from "../api/index.js";

// Shared by the Browser pane's preview iframe (BrowserPanel.tsx) and the Dock
// Preview menu's "Open … on <device>" rows (#3491, #3559), which hand the same URL to
// a device's browser.

// Mirrors src/services/preview-auth.ts's PREVIEW_TOKEN_QUERY_PARAM 1:1
// (issue #383) — duplicated across the workspace boundary like every other
// backend-shape mirror in api/ (frontend/ is its own npm workspace, see
// api.ts's own top-of-file comment on this convention).
export const PREVIEW_TOKEN_QUERY_PARAM = "__mullion_preview";

// The one place that builds a "preview-<slug>.<baseHost>" iframe src —
// consolidated from three separate inline template strings that used to live
// in BrowserPanel.tsx (resolvePreviewUrl, twice, plus the project-bound preview
// effect) so the bootstrap-token query param (issue #383) only needs
// appending in one place. `token` is omitted entirely (not just empty) when
// previewAuthRequired is false, so a gate-off deployment's iframe src is
// unchanged from before this feature existed.
export function buildPreviewSrc(
  scheme: string,
  slug: string,
  baseHost: string,
  token?: string,
  path?: string,
): string {
  const base = `${scheme}//preview-${slug}.${baseHost}/`;
  if (!path || path === "/") {
    return token ? `${base}?${PREVIEW_TOKEN_QUERY_PARAM}=${encodeURIComponent(token)}` : base;
  }
  // #3373 — a page the agent's browser was on. Its parts are assigned one by
  // one, never resolved against the base: a path starting with "//" must not
  // become a network-path reference that changes the authority.
  const url = new URL(base);
  const [, pathname = "/", search = "", hash = ""] = /^([^?#]*)(\?[^#]*)?(#.*)?$/.exec(path) ?? [];
  url.pathname = pathname || "/";
  url.search = search;
  if (token) url.searchParams.set(PREVIEW_TOKEN_QUERY_PARAM, token);
  url.hash = hash;
  return url.href;
}

// Mints a preview's bootstrap token only when the server requires one (see
// ServerInfo.previewAuthRequired) — a no-op Promise<undefined> otherwise, so
// every call site can `await` this unconditionally.
export async function mintPreviewTokenIfRequired(
  info: ServerInfo,
  slug: string,
): Promise<string | undefined> {
  if (!info.previewAuthRequired) return undefined;
  const { token } = await api.mintPreviewToken(slug);
  return token;
}
