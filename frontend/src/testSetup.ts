import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import { __resetRateLimitBreakerForTests } from "./api/client.js";
import { __resetSessionRefreshBlockForTests } from "./store/slices/sessions.js";
import { __discardPendingSettingsPatchForTests } from "./store/slices/ui.js";

// vitest.config.ts doesn't set `test.globals: true` (this repo's convention
// is explicit `import { describe, it, ... } from "vitest"` everywhere), so
// Testing Library's own auto-cleanup — which only registers itself when it
// detects an ambient global `afterEach` — never fires. Without this, a
// component left mounted by one test's render() is still in the DOM for
// the next test in the same file, breaking any query that expects a single
// match (e.g. getByLabelText across multiple `it()`s).
afterEach(cleanup);

// Issue #959 — the api/client.ts per-endpoint 429 breaker and the
// store/slices/sessions.ts sessionRefreshBlockedUntil are module-scoped
// state. A test that intentionally mocks a 429 (e.g. PromoteDialog.test.tsx's
// "branches fetch fails" describe) leaves a breaker entry for
// /api/projects/N/git-branches behind, and the *next* test in the same
// file that doesn't mock a 429 would otherwise short-circuit at the
// breaker and silently fail with no useful diagnostic. Reset both at the
// end of every test as a defense-in-depth measure — the dedicated
// __resetXxxForTests helpers exist for tests that need a mid-test
// reset, but the per-test reset catches the common case (the 429 was
// intentional in test N, irrelevant in test N+1) without every test
// having to know about module-scoped state.
afterEach(() => {
  __resetRateLimitBreakerForTests();
  __resetSessionRefreshBlockForTests();
});

// The store/slices/ui.ts settings PATCH debounce is the third piece of
// module-scoped state, and the same cross-test leak applies to it: a test
// that toggles a setting arms a 400ms debounce timer, and if the test ends
// before it fires, the timer is still pending when the NEXT test in the
// same file installs its own fetch mock — so the previous test's PATCH
// lands in this one's assertions. The store's own resetStore() cannot reach
// it (the pending patch is closure state, not store state).
//
// DISCARDS the pending patch after every test, which closes the leak at the
// source: nothing is left pending to fire later. It discards rather than
// sends on purpose — a test's own afterEach usually runs
// `vi.unstubAllGlobals()` first, so by the time this runs the installed
// `fetch` is the REAL one, and sending would make a real HTTP request (a
// stray PATCH per leftover patch, swallowed by flushPendingPatch's catch).
// Cancelling without sending closes the leak just as well and sends
// nothing.
//
// A test that wants to assert on the PATCH calls
// __flushPendingSettingsPatchForTests() itself, and then the fetch has
// already been made — api.patchSettings reaches fetch() synchronously — so
// there is no wait left to race.
afterEach(() => {
  __discardPendingSettingsPatchForTests();
});

// jsdom provides no window.matchMedia at all, unlike every real browser
// target this app ships to — a real gap in the test environment, not
// something worth guarding against in production code the way an actually
// absent browser API would be. A plain assignment (not vi.stubGlobal, whose
// whole point is a per-test stub that vi.unstubAllGlobals() reverts) so this
// default survives every individual test's own unstubAllGlobals() call for
// the rest of a file's run — confirmed necessary: a component left with a
// pending async state transition by one test (e.g. BrowserPanel.tsx's
// mobile-breakpoint check on its empty-address-bar autoFocus, mobile UI/UX
// overhaul item B.5) can still re-render after that test's own afterEach has
// already unstubbed its local matchMedia override, and previously crashed
// with "window.matchMedia is not a function" when that happened. Individual
// tests that need `matches: true` still layer their own vi.stubGlobal on
// top, which correctly reverts back to this default, not to undefined.
//
// addListener/addEventListener are deliberate no-ops (independent code
// review, PR #615): this default exists to stop a stray render from
// crashing, not to simulate a live-updating media query. A future test that
// renders App.tsx and expects its isMobile state to actually flip on a
// simulated breakpoint change (App.tsx's own matchMedia(...).addEventListener
// ("change", ...) subscription) needs its own vi.stubGlobal("matchMedia", ...)
// with a real listener registry — this default will otherwise silently
// report "desktop forever" instead of erroring, rather than failing loudly.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

// jsdom leaves window.isSecureContext as `undefined` even for its default
// http://localhost/ test URL, unlike a real browser (localhost is always a
// secure context) — another real gap in the test environment, same
// category as matchMedia above, not something voice/support.ts's own
// isSecureContextForDictation() should special-case. A plain assignment,
// not vi.stubGlobal, for the same reason as matchMedia: it must survive
// every individual test file's own vi.unstubAllGlobals() so a component
// re-rendering after that cleanup doesn't suddenly see a falsy value it
// never asked to test. Tests that specifically exercise the insecure-
// context path (frontend/src/voice/useVoiceDictation.test.ts) override it
// directly via Object.defineProperty, which this plain assignment doesn't
// interfere with.
if (typeof window !== "undefined" && window.isSecureContext === undefined) {
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
}

// jsdom has no ResizeObserver or Range geometry, which CodeMirror's view
// reads on mount/measure. Plain assignments (not vi.stubGlobal) so they
// survive every test's own unstubAllGlobals(), like the matchMedia default
// above. Layout is meaningless in jsdom, so zero-size stubs are enough.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    // Accepts (and ignores) the callback real callers pass — without it
    // CodeQL flags every `new ResizeObserver(cb)` in the app as a call with a
    // superfluous argument to an anonymous class's default constructor.
    constructor(_callback?: ResizeObserverCallback) {}
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (typeof Range !== "undefined") {
  const emptyRect = {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    toJSON: () => ({}),
  } as DOMRect;
  Range.prototype.getBoundingClientRect ??= () => emptyRect;
  Range.prototype.getClientRects ??= () =>
    ({
      length: 0,
      item: () => null,
      [Symbol.iterator]: [][Symbol.iterator],
    }) as unknown as DOMRectList;
}
