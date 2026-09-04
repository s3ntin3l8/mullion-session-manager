// Issue #1008 — two independent triggers can each decide "the backend just
// finished a self-update, reload this tab":
//
//   1. main.tsx's registerSW() — every open tab, on service-worker
//      activation (workbox-window's "activated" event, isUpdate/isExternal).
//   2. ServerInfoSection.tsx's own update-status poll — only the tab that
//      initiated the update, once GET /api/updates/status first reports
//      phase: "done".
//
// Neither knows about the other. A tab that both initiated the update AND
// has the service worker registered (the common case — they're the same
// tab unless Settings was opened in a second tab) could reload twice for
// one update, paying the ~59-request cold-load cost (issue #1005) twice in
// quick succession. Whichever trigger fires first here wins; the other
// becomes a no-op. Module-level state is enough (not sessionStorage, unlike
// client.ts's AUTH_EXPIRY_RELOAD_GUARD) — both triggers live within the
// same page load, and an actual navigation away resets this file's module
// state along with everything else.
let reloadClaimed = false;

/**
 * Returns true the first time it's called — the caller should proceed with
 * `window.location.reload()`. Returns false on every call after that, from
 * either trigger, so only one of them ever actually reloads the page.
 */
export function claimPostUpdateReload(): boolean {
  if (reloadClaimed) return false;
  reloadClaimed = true;
  return true;
}

// Visible for tests: module-level state needs an explicit reset between
// cases, same pattern as api/client.ts's __resetRateLimitBreakerForTests.
export function __resetPostUpdateReloadForTests(): void {
  reloadClaimed = false;
}
