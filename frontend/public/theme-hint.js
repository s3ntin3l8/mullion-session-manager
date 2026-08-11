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
// script per the above). Defaults to the black-translucent/dark-theme value
// on any error (missing localStorage, disabled storage, etc.) rather than
// guessing light.
(function () {
  try {
    if (localStorage.getItem("crs.themeHint") === "light") {
      var meta = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
      if (meta) meta.setAttribute("content", "default");
    }
  } catch {
    /* localStorage unavailable — keep the static black-translucent default */
  }
})();
