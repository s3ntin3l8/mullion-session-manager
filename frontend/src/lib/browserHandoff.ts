// "Open this address in the other browser" (#3373, docs/design/one-browser-pane/
// note.md). The two engines see addresses differently, so ⇄ is not a copy of
// the address field: the preview is an iframe in the user's tab, the agent's
// browser a Chromium on the session's host. The server translates a project
// preview (src/services/browser-handoff.ts); what the client can decide on its
// own lives here.

/** The preview params a retarget names: BrowserPanelParams' target keys,
 * spelled out here so this module does not import the lazy BrowserPanel. */
export interface PreviewTargetParams {
  projectId?: number;
  kind?: "external";
  url?: string;
  slug?: string;
  previewSlug?: string;
  targetName?: string;
  targetRev?: number;
  previewPath?: string;
  activeSavedUrlId?: number | null;
  activeSavedUrlLabel?: string | null;
}

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

/** `localhost`, `*.localhost`, 127.0.0.0/8, `[::1]` and the unspecified
 * addresses (`0.0.0.0`, `[::]`), which a browser dials as its own loopback.
 * Mirrors src/services/browser-handoff.ts's isLoopbackHostname. */
export function isLoopbackAddress(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  const h = hostname.replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1" || h === "::" || h === "0.0.0.0") return true;
  if (/^::ffff:(?:127\.|7f[0-9a-f]{2}:)/.test(h)) return true;
  return /^127(?:\.\d{1,3}){3}$/.test(h);
}

export const HANDOFF_NOT_HTTP = "Only http and https addresses can open in the agent's browser";
export const HANDOFF_LOOPBACK =
  "localhost here is your own machine, and in the agent's browser it is the session's host";
export const HANDOFF_PROXY_ADDRESS =
  "This is a preview proxy address; open the preview itself and use ⇄ from there";
export const HANDOFF_NO_PREVIEW_ADDRESS = "The preview has no address to open";
export const HANDOFF_NO_AGENT_PAGE = "The agent's browser has no page open";
export const HANDOFF_PENDING = "Working out the address…";
export const HANDOFF_FAILED = "Could not work out the address";

/** Why a preview address the client already knows cannot go to the agent's
 * browser as is, or null when it can. */
export function addressHandoffRefusal(url: string): string | null {
  if (!isHttpAddress(url)) return HANDOFF_NOT_HTTP;
  if (isLoopbackAddress(url)) return HANDOFF_LOOPBACK;
  if (isPreviewProxyAddress(url)) return HANDOFF_PROXY_ADDRESS;
  return null;
}

/** A preview proxy address pasted or saved as is (the project toolbar shows
 * the iframe's own one): `preview-<slug>.<host>`, or anything carrying the
 * `__mullion_preview` token. Never handed to the agent's browser, where the
 * token would sit in a page address the agent can read. */
export function isPreviewProxyAddress(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      /^preview-[^.]+\./i.test(parsed.hostname) ||
      parsed.searchParams.has("__mullion_preview") ||
      /__mullion_preview/i.test(parsed.hash)
    );
  } catch {
    return false;
  }
}

/** Preview params with every target key named, so a retarget (and dockview's
 * merge of a write-back) clears what the previous target had set. */
export function retargetedPreviewParams(
  projectId: number | undefined,
  next: Pick<PreviewTargetParams, "kind" | "url" | "previewSlug" | "targetName" | "previewPath">,
): PreviewTargetParams {
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
  current: Partial<PreviewTargetParams> | undefined,
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

/** The keys that name what a preview pane shows (not where the user went in
 * it), as one comparable value. */
export function previewTargetKey(params: PreviewTargetParams): string {
  return JSON.stringify([
    params.projectId ?? null,
    params.kind ?? null,
    params.previewSlug ?? null,
    params.targetName ?? null,
    params.targetRev ?? null,
  ]);
}
