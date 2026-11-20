import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MOTION_EASE,
  MOTION_EASE_PRESS,
  MOTION_FADE_MS,
  MOTION_LAYOUT_MS,
  MOTION_PRESS_MS,
  prefersReducedMotion,
} from "./motion.js";

// import.meta.glob rather than node:fs, as in styles/tokens.reducedMotion.test.ts.
const tokens = import.meta.glob("../styles/tokens.css", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;
const css = tokens["../styles/tokens.css"];

function token(name: string): string {
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(css);
  if (!match) throw new Error(`${name} is not declared in tokens.css`);
  return match[1].trim();
}

describe("motion tokens", () => {
  it("carry the same values in tokens.css and lib/motion.ts", () => {
    expect(token("--motion-press")).toBe(`${MOTION_PRESS_MS}ms`);
    expect(token("--motion-fade")).toBe(`${MOTION_FADE_MS}ms`);
    expect(token("--motion-layout")).toBe(`${MOTION_LAYOUT_MS}ms`);
    expect(token("--motion-ease")).toBe(MOTION_EASE);
    expect(token("--motion-ease-press")).toBe(MOTION_EASE_PRESS);
  });

  it("keep the approved house values", () => {
    expect(MOTION_PRESS_MS).toBe(110);
    expect(MOTION_LAYOUT_MS).toBeGreaterThanOrEqual(300);
    expect(MOTION_LAYOUT_MS).toBeLessThanOrEqual(500);
  });

  it("are declared once, with no reduced-motion variant that would shorten them", () => {
    expect(css.match(/--motion-fade:/g)).toHaveLength(1);
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).not.toMatch(/--motion-/);
  });
});

describe("prefersReducedMotion", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is false where there is no window to ask", () => {
    expect(prefersReducedMotion()).toBe(false);
  });

  it("follows the OS setting", () => {
    let reduce = true;
    vi.stubGlobal("window", {
      matchMedia: (query: string) => ({
        matches: reduce && query === "(prefers-reduced-motion: reduce)",
      }),
    });
    expect(prefersReducedMotion()).toBe(true);
    reduce = false;
    expect(prefersReducedMotion()).toBe(false);
  });
});
