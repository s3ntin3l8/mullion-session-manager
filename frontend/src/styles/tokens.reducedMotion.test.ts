import { describe, expect, it } from "vitest";

// import.meta.glob rather than node:fs: tsconfig.app.json is a browser-only
// type universe (same pattern as tokens.contrast.test.ts).
const tokens = import.meta.glob("./tokens.css", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;
const css = tokens["./tokens.css"];

const appSources = import.meta.glob(["../**/*.ts", "../**/*.tsx", "!../**/*.test.*"], {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

/** The body of the `@media (prefers-reduced-motion: reduce)` block in tokens.css. */
function reducedMotionBlock(): string {
  const start = css.indexOf("@media (prefers-reduced-motion: reduce) {");
  if (start < 0) throw new Error("no prefers-reduced-motion block in tokens.css");
  const end = css.indexOf("\n}\n", start);
  return css.slice(start, end);
}

// Issue #2567: under prefers-reduced-motion the terminal's WebGL text canvas stayed at 1x on a
// 2x display. Measured: transition-duration 0s -> 2x, but 1ms and 10ms -> 1x (and the authored
// durations -> 2x), so a transition that starts and ends almost at once is what breaks it.
describe("the reduced-motion reset", () => {
  it("zeroes transitions instead of shortening them", () => {
    const block = reducedMotionBlock();
    expect(block).toMatch(/transition-duration:\s*0s\s*!important/);
    expect(block).not.toMatch(/transition-duration:\s*[0-9.]+ms/);
  });

  it("can drop transitionend because nothing in the app listens for it", () => {
    // Guards against a glob that matched nothing and so proves nothing.
    expect(Object.keys(appSources).length).toBeGreaterThan(100);
    const listeners = Object.entries(appSources)
      .filter(([, source]) => /transitionend|transitionrun|onTransition(End|Start)/.test(source))
      .map(([file]) => file);
    expect(listeners).toEqual([]);
  });
});
