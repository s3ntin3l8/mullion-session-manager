// "Open this address in the other browser" (#3373, docs/design/one-browser-pane/
// note.md). The two engines see addresses differently, so ⇄ is not a copy of
// the address field: the preview is an iframe in the user's tab, the agent's
// browser a Chromium on the session's host. The server translates a project
// preview (src/services/browser-handoff.ts); what the client can decide on its
// own lives here.
import type { BrowserPanelParams } from "../BrowserPanel.js";

/**
 * What the preview loaded, as BrowserPanel reports it. Never the iframe's own
 * address: a project preview's iframe is the preview proxy's, and may carry
 * the `__mullion_preview` token, which must never reach the agent's browser.
 * - `address`: an address the user typed, saved or followed, sent as is.
 * - `project`: one of the project's previews, by slug (none: the checkout's
 *   dev server); the server says which address the agent's browser loads.
 */
export type PreviewSource = { kind: "address"; url: string } | { kind: "project"; slug?: string };

export function previewSourceKey(source: PreviewSource | null): string {
  if (!source) return "";
  return source.kind === "address" ? `a:${source.url}` : `p:${source.slug ?? ""}`;
}

export function isHttpAddress(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** `localhost`, `*.localhost`, 127.0.0.0/8 and `[::1]`: one machine's own. */
export function isLoopbackAddress(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  const h = hostname.replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h === "::1") return true;
  return /^127(?:\.\d{1,3}){3}$/.test(h);
}

export const HANDOFF_NOT_HTTP = "Only http and https addresses can open in the agent's browser";
export const HANDOFF_LOOPBACK =
  "localhost here is your own machine, and in the agent's browser it is the session's host";
export const HANDOFF_NO_PREVIEW_ADDRESS = "The preview has no address to open";
export const HANDOFF_NO_AGENT_PAGE = "The agent's browser has no page open";
export const HANDOFF_PENDING = "Working out the address…";
export const HANDOFF_FAILED = "Could not work out the address";

/** Why a preview address the client already knows cannot go to the agent's
 * browser as is, or null when it can. */
export function addressHandoffRefusal(url: string): string | null {
  if (!isHttpAddress(url)) return HANDOFF_NOT_HTTP;
  if (isLoopbackAddress(url)) return HANDOFF_LOOPBACK;
  return null;
}

/** Preview params with every target key named, so a retarget (and dockview's
 * merge of a write-back) clears what the previous target had set. */
export function retargetedPreviewParams(
  projectId: number | undefined,
  next: Pick<BrowserPanelParams, "kind" | "url" | "previewSlug" | "targetName" | "previewPath">,
): BrowserPanelParams {
  return {
    projectId,
    kind: next.kind,
    url: next.url,
    slug: undefined,
    previewSlug: next.previewSlug,
    targetName: next.targetName,
    targetRev: undefined,
    previewPath: next.previewPath,
    activeSavedUrlId: null,
    activeSavedUrlLabel: null,
  };
}

/** What "Browser · Preview: <target>" names after a retarget to an address. */
export function addressLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * An opener that focuses an existing preview pane asked for that pane's own
 * target. If ⇄ opened something else in it since (an external address, another
 * preview, a page below the root), this resets the pane to `home`; null when it
 * already shows it. `previewRev` tells the pane to drop what ⇄ opened.
 */
export function previewResetPatch(
  current: Partial<BrowserPanelParams> | undefined,
  home: { projectId: number; previewSlug?: string; targetName?: string },
): Record<string, unknown> | null {
  if (!current) return null;
  const retargeted =
    current.kind === "external" ||
    (current.previewSlug ?? undefined) !== home.previewSlug ||
    !!current.previewPath;
  if (!retargeted) return null;
  return {
    ...retargetedPreviewParams(home.projectId, {
      previewSlug: home.previewSlug,
      targetName: home.targetName,
    }),
    previewTarget: undefined,
    previewRev: Date.now(),
  };
}
