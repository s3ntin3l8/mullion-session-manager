import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// vitest.config.ts doesn't set `test.globals: true` (this repo's convention
// is explicit `import { describe, it, ... } from "vitest"` everywhere), so
// Testing Library's own auto-cleanup — which only registers itself when it
// detects an ambient global `afterEach` — never fires. Without this, a
// component left mounted by one test's render() is still in the DOM for
// the next test in the same file, breaking any query that expects a single
// match (e.g. getByLabelText across multiple `it()`s).
afterEach(cleanup);

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
