// Issue #87 / A5 — iOS reads apple-mobile-web-app-status-bar-style ONCE at
// standalone launch and never re-reads it, so a React effect can't correct
// it: it always runs after iOS has already applied the static value in
// index.html's <head>, which forces white status-bar glyphs
// unconditionally — unreadable against the light theme's near-white
// toolbar. This has to run synchronously during initial parse, before
// iOS's read, hence a plain classic (non-module, non-deferred, non-async)
// script rather than app code.
//
// This used to be an inline <script> block directly in index.html, but the
// production CSP (src/plugins/security.ts's helmet config) sends
// `script-src 'self'` with no 'unsafe-inline'/nonce/hash, which silently
// blocks inline scripts outright — this file's whole job never ran in
// production (A5). A same-origin external file loaded via a plain
// `<script src="/theme-hint.js">` is allowed by 'self' and is still
// render-blocking/parser-blocking like the inline block was, so the
// synchronous, pre-(iOS-)read timing this depends on is preserved — see
// index.html, positioned AFTER the apple-mobile-web-app-status-bar-style
// meta tag it corrects (document order, so document.querySelector below
// can actually find it — it wouldn't exist yet if this script sat any
// earlier) but still well before iOS's own separate read of that attribute
// at standalone launch. Do NOT add defer/async/type="module" here or on
// the <script src> tag in index.html — any of those would let iOS read the
// meta tag before this runs, reintroducing the bug this file exists to
// fix. Do NOT move this <script> tag before the meta tag either — that
// would make the querySelector below return null instead.
//
// "crs.themeHint" must match store.ts's THEME_HINT_KEY — this script can't
// import it (it's not part of Vite's module graph, and must stay a classic
// script per the above).
//
// Second, independent job added for the sign-in screen (AuthGate.tsx):
// mirror the resolved theme onto <html data-theme-hint="light"|"dark">,
// written UNCONDITIONALLY, because tokens.css uses it to paint <html>'s
// background before <body> and AuthGate's own themed .login-root have
// painted anything — <html> sits outside .cmux-root, so none of that
// file's custom properties resolve on it directly. Without this, a
// dark-theme user gets a flash of the browser's default white background
// while GET /api/auth/me is in flight.
//
// `resolved` is computed ONCE and drives BOTH jobs — the iOS meta fix above
// used to check `hint === "light"` directly, which only reacted to a
// *stored* "light" and, on a genuinely first-ever visit (no stored hint at
// all, the common case for a login page), left the status bar at its
// black-translucent default even when prefers-color-scheme resolved this
// same visit to light for <html>'s background. Driving both off the one
// `resolved` value means a first-ever light-OS visit gets a light <html>
// background AND a corrected status bar, not one without the other.
// Any error (missing localStorage, disabled storage, etc.) defaults
// `resolved` to dark rather than guessing light.
(function () {
  function systemPrefersLight() {
    return (
      !!window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches === false
    );
  }
  var resolved = "dark";
  try {
    var hint = localStorage.getItem("crs.themeHint");
    resolved =
      hint === null
        ? systemPrefersLight()
          ? "light"
          : "dark"
        : hint === "light"
          ? "light"
          : "dark";
  } catch {
    /* localStorage/matchMedia unavailable — resolved stays "dark". */
  }
  if (resolved === "light") {
    var meta = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
    if (meta) meta.setAttribute("content", "default");
  }
  document.documentElement.setAttribute("data-theme-hint", resolved);
})();
