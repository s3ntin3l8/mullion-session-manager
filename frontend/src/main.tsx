import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AuthGate } from "./AuthGate.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
// B1 — self-hosted via @fontsource instead of a fonts.googleapis.com/
// fonts.gstatic.com <link> in index.html: this is a self-hosted, typically
// LAN/VPN-only dashboard, so a third-party font CDN is a render-blocking
// dependency on every load, a hard failure mode on an air-gapped host, and
// a per-load ping to Google. Each import below pulls in exactly the weights
// the removed Google Fonts URL requested
// (`family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&
// family=JetBrains+Mono:wght@400;500&family=IBM+Plex+Mono:wght@400;500`) —
// importing the package's bare `400.css` (rather than `latin-400.css`)
// would pull in @font-face rules for every subset the package ships
// (cyrillic, cyrillic-ext, vietnamese, latin-ext, symbols2, ...), each with
// its own unicode-range-scoped .woff2/.woff. Vite's default
// assetsInlineLimit (4096 bytes) then base64-inlines the small subset files
// straight into the built CSS — nobody using this English-only UI ever
// needs those subsets, but every one of them still ends up on the
// render-blocking stylesheet. `latin-<weight>.css` imports only the single
// subset this app actually uses. The .woff2 files land content-hashed
// under dist/assets/ via Vite's normal asset pipeline (same-origin, so they
// work on an air-gapped host either way) — NOT covered by the Workbox
// precache today (vite-plugin-pwa's generateSW globPatterns default
// excludes woff2/woff), so there's no "works fully offline on first visit"
// claim being made here, only "no third-party CDN dependency or ping".
import "@fontsource/geist/latin-400.css";
import "@fontsource/geist/latin-500.css";
import "@fontsource/geist/latin-600.css";
import "@fontsource/geist/latin-700.css";
import "@fontsource/geist-mono/latin-400.css";
import "@fontsource/geist-mono/latin-500.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "./styles/index.css";
import { claimPostUpdateReload } from "./postUpdateReload.js";

// A retriable lazy() (lib/retriableLazy.ts) fixes the case where a dynamic
// import() rejects for a reason a fresh attempt can recover from (a flaky
// network blip, an ad-blocker). It can't fix a stale chunk reference: after
// a deploy rotates content hashes, this tab's already-loaded index.html
// still points at the OLD hashed filename, which the server no longer
// serves — 404, every time, no matter how many times it's retried. Vite
// fires this event for that case (a dynamic import failing to even fetch
// its target chunk); the only real fix there is a hard reload to pick up
// the new index.html and its current hashes.
//
// Vite's own preload-helper wraps EVERY dynamic import() the build has
// code-split, not just this specific "stale chunk" case — so this fires for
// the exact same transient failures (a flaky network blip) the retriable
// lazy panels above are built to recover from locally, via their own
// ErrorBoundary's "Reload pane". This listener deliberately does NOT call
// event.preventDefault(): leaving it unprevented means Vite still re-throws
// the original error into the promise chain afterward (see its own
// `if (!e.defaultPrevented) throw err` — preventing it would instead
// resolve that chain with `undefined`, which is worse: `lazy()`'s own
// `.then((m) => ({ default: m.X }))` would then throw a confusing "Cannot
// read properties of undefined" instead of the real error), so a panel's
// local retry machinery still gets a fair, undisturbed shot at the error
// exactly as if this listener didn't exist. The reload below just runs
// alongside that as a second line of defense for the one case local retry
// can't fix — a panel briefly showing "This pane crashed" right before the
// reload lands is an acceptable trade for not permanently blinding the
// local retry path.
//
// Guarded the same way api/client.ts's recentlyAttemptedAuthExpiryReload /
// recordAuthExpiryReloadAttempt guard a reload-on-expiry: a wall-clock
// window (not an unconditional one-shot) so a genuinely later, unrelated
// preload failure still gets its own reload attempt, and the sessionStorage
// access itself is try/catched — storage can throw in privacy mode / with
// storage disabled, and if recording the attempt fails there is no way to
// remember "a reload was already tried," so this deliberately skips
// reloading at all rather than risking an unbounded loop.
const PRELOAD_ERROR_RELOAD_GUARD_KEY = "mullion:preload-error-reload-attempted-at";
const PRELOAD_ERROR_RELOAD_GUARD_WINDOW_MS = 3 * 60 * 1000;
window.addEventListener("vite:preloadError", () => {
  try {
    const last = sessionStorage.getItem(PRELOAD_ERROR_RELOAD_GUARD_KEY);
    const recentlyAttempted =
      last !== null && Date.now() - Number(last) < PRELOAD_ERROR_RELOAD_GUARD_WINDOW_MS;
    if (recentlyAttempted) return;
    sessionStorage.setItem(PRELOAD_ERROR_RELOAD_GUARD_KEY, String(Date.now()));
  } catch {
    return;
  }
  window.location.reload();
});

// Issue #87 — registerType: "autoUpdate" (vite.config.ts) only makes the
// SERVICE WORKER itself take over immediately (skipWaiting/clientsClaim);
// it does nothing to an already-open tab's already-loaded JS on its own.
// Without this explicit registerSW() call, vite-plugin-pwa falls back to
// injecting a bare navigator.serviceWorker.register() with no
// update-reload wiring at all — reviewed and confirmed against the
// plugin's own client source (workbox-window's Workbox class fires
// "activated" with isUpdate/isExternal, which registerSW()'s default
// behavior turns into window.location.reload() when no onNeedReload is
// given). That reload is the actual fix for this PR's stated hazard: a
// tab left open across a scripts/self-update.sh backend swap would
// otherwise keep running stale JS against a new backend indefinitely.
// Safe here specifically because this app's reconnect path (WS backoff,
// PTY reattach/redraw) is already a first-class, tested scenario — a
// reload just triggers the same reconnect a network blip would.
//
// `onNeedReload` (issue #1008) routes the reload through
// claimPostUpdateReload() instead of registerSW()'s own unconditional
// `window.location.reload()` default — this trigger and
// ServerInfoSection.tsx's update-status-poll trigger are otherwise
// unaware of each other, and the tab that initiated an update usually has
// both wired up at once.
if (import.meta.env.PROD) {
  void import("virtual:pwa-register").then(({ registerSW }) =>
    registerSW({
      onNeedReload: () => {
        if (claimPostUpdateReload()) window.location.reload();
      },
    }),
  );
}

// Root-level ErrorBoundary (issue #959). The existing ErrorBoundary
// in App.tsx only wraps the dockview area (its own comment: "scope:
// dockview only") — a 429 on a render-blocking fetch OUTSIDE that
// scope (hydrateSettings, refreshWorkspaces, etc.) previously
// produced a blank page with only chrome rendered. Wrapping root
// catches a 429 anywhere in the render tree and surfaces it as the
// "Too many requests — try again in N seconds" UI. `onReset` is a
// full-page reload: the breaker is module-level state and the only
// way to guarantee a clean slate (the count-down's auto-retry would
// re-mount the subtree, but the breaker entry would still be live if
// the user landed here mid-window).
class RootErrorBoundary extends ErrorBoundary {}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootErrorBoundary
      onReset={() => {
        window.location.reload();
      }}
    >
      <AuthGate />
    </RootErrorBoundary>
  </StrictMode>,
);
