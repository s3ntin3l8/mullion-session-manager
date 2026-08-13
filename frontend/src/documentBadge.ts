import type { Session } from "./api/index.js";

// Rich statuses (issue: extend surfaced session statuses) — a backgrounded
// Mullion tab previously gave no signal at all that something happened: the
// favicon is a static SVG (index.html) and `document.title` is never
// assigned anywhere in the app. This gives a backgrounded tab a live count
// of sessions needing attention, the same way an email client badges its
// tab/favicon with an unread count.
//
// Split the same way desktopNotify.ts is: pure, unit-testable decision
// logic here (what should the title/badge say), DOM-touching canvas/favicon-
// swapping glue in App.tsx's own effect (there's no meaningful way to unit
// test "did the <link rel=icon> href change to this exact data: URL" without
// a real browser canvas, so that part stays untested, mirroring
// desktopNotify.ts's own split rationale).

// The app's own base title (index.html's static <title>) — the one place
// both this module's formatDocumentTitle and Settings.tsx's nav-footer
// "app initial" badge should read from, so the two can never drift out of
// sync the way a badge prefix silently breaking `document.title[0]` would.
export const BASE_TITLE = "Mullion";

/** Count of sessions whose derived rich status needs a human's attention
 * right now (src/services/session-status.ts's own `attentionRequired`) —
 * the same "put this in front of the user" set sessionStatus.ts's
 * STATUS_PRESENTATION's severities imply, not the old single `attention`
 * boolean alone. */
export function countAttentionRequired(
  sessions: readonly Pick<Session, "sessionStatusAttentionRequired">[],
): number {
  return sessions.reduce((n, s) => (s.sessionStatusAttentionRequired ? n + 1 : n), 0);
}

/** `document.title` for a given attention count — a bare base title at
 * zero, `"(N) Mullion"` otherwise. Caps the visible number at 9 with a "9+"
 * label so the title doesn't grow unboundedly long. */
export function formatDocumentTitle(count: number, baseTitle: string = BASE_TITLE): string {
  if (count <= 0) return baseTitle;
  const label = count > 9 ? "9+" : String(count);
  return `(${label}) ${baseTitle}`;
}

let originalFaviconHref: string | null = null;

// P4 perf fix — App.tsx's favicon effect re-runs every LIVE_REFRESH_INTERVAL_MS
// tick (its deps are `[sessions]`, and `sessions` gets a fresh array identity
// on every poll regardless of whether any session's attention state actually
// changed — see store.ts's refreshSessions). Without this cache,
// updateFaviconBadge unconditionally rebuilds a canvas and reassigns
// `link.href` via `toDataURL` on every one of those ticks whenever count > 0,
// forcing the browser to re-decode the favicon indefinitely on an otherwise
// idle dashboard. Keyed on (count, dotColor) together, not count alone —
// `dotColor` is a caller-supplied param (currently always the default in
// practice, but the cache must not paper over a real color change if a
// future caller varies it). Module-level (not a ref) since this function has
// no component instance of its own to hold one; matches the existing
// module-level `originalFaviconHref` cache just above.
let lastRenderedCount: number | null = null;
let lastRenderedDotColor: string | null = null;

/** Test-only reset — mirrors store.ts's clearTaskMasterEnvCacheForTests /
 * agent-detect.ts's clearAgentsCacheForTests precedent for module-scoped
 * caches that must not leak state across test cases. */
export function clearFaviconBadgeCacheForTests(): void {
  lastRenderedCount = null;
  lastRenderedDotColor = null;
  originalFaviconHref = null;
}

function getFaviconLink(): HTMLLinkElement | null {
  return document.querySelector<HTMLLinkElement>('link[rel="icon"][type="image/svg+xml"]');
}

/** DOM-touching favicon swap — deliberately NOT unit tested beyond the
 * bail-out's call-count behavior (see documentBadge.test.ts), same posture
 * desktopNotify.ts's header comment documents for its own DOM glue
 * (`new Notification()`, `window.focus()`): there's no meaningful way to
 * assert "the <link rel=icon> href is now this exact canvas-drawn data:
 * URL" without a real browser canvas. Draws a small solid dot (favicon
 * real estate is tiny — 16-32px — so a count digit there would be
 * illegible; `document.title`, not the favicon, carries the actual number)
 * and swaps `<link rel="icon">`'s href to it, restoring the ORIGINAL
 * favicon once the count returns to zero. Caches that original href on
 * first call (not baked in as a constant) so it survives regardless of
 * whichever build's actual favicon.svg is currently served. */
export function updateFaviconBadge(count: number, dotColor = "#e5575a"): void {
  if (typeof document === "undefined") return;
  // Bail before touching the DOM at all when nothing the caller cares about
  // changed — this is the whole fix: skip the canvas rebuild + toDataURL
  // re-decode that would otherwise fire on every 4s poll tick regardless of
  // whether the attention count actually moved.
  if (count === lastRenderedCount && dotColor === lastRenderedDotColor) return;

  const link = getFaviconLink();
  // Deliberately NOT cached above this point: if the <link> isn't in the DOM
  // yet on this call, a later call with the same (count, dotColor) must still
  // be allowed to retry rather than silently bailing forever.
  if (!link) return;
  lastRenderedCount = count;
  lastRenderedDotColor = dotColor;
  if (originalFaviconHref === null) originalFaviconHref = link.href;

  if (count <= 0) {
    link.href = originalFaviconHref;
    return;
  }

  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.beginPath();
  ctx.arc(16, 16, 14, 0, Math.PI * 2);
  ctx.fillStyle = dotColor;
  ctx.fill();
  link.href = canvas.toDataURL("image/png");
}
