import type { Session } from "./api.js";

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

function getFaviconLink(): HTMLLinkElement | null {
  return document.querySelector<HTMLLinkElement>('link[rel="icon"][type="image/svg+xml"]');
}

/** DOM-touching favicon swap — deliberately NOT unit tested, same posture
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
  const link = getFaviconLink();
  if (!link) return;
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
