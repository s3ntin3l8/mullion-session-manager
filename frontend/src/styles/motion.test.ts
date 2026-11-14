import { describe, expect, it } from "vitest";

// import.meta.glob rather than node:fs, as tokens.reducedMotion.test.ts does
// (browser-only tsconfig). jsdom cannot evaluate `:active`, a media query or
// an animation, so this pins the CSS contract of styles/motion.css (#3015):
// which controls answer a press, that only cheap properties move, that every
// value comes from a token, and that reduced transparency makes material solid.
const motionFiles = import.meta.glob("./motion.css", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;
const indexFiles = import.meta.glob("./index.css", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;
const css = motionFiles["./motion.css"].replace(/\/\*[\s\S]*?\*\//g, "");
const index = indexFiles["./index.css"];

/** Every rule whose selector contains `needle`, as [selector, body]. */
function rules(source: string, needle: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const m of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].includes(needle)) out.push([m[1].trim(), m[2]]);
  }
  return out;
}

function mediaBlock(query: string): string {
  const start = css.indexOf(`@media (${query})`);
  expect(start, `${query} block`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(start, i);
  }
  throw new Error("unterminated block");
}

describe("styles/motion.css", () => {
  it("is imported last, above every component rule it refines", () => {
    const imports = [...index.matchAll(/@import "([^"]+)"/g)].map((m) => m[1]);
    expect(imports.at(-1)).toBe("./motion.css");
  });

  it("gives every shared control class press feedback on touch-down", () => {
    const press = rules(css, ":active");
    expect(press.length).toBeGreaterThan(0);
    const selectors = press.map(([s]) => s).join("\n");
    for (const control of [
      "button",
      '[role="button"]',
      '[role="tab"]',
      '[role="menuitem"]',
      '[role="option"]',
      ".session-item",
      ".task-card",
      ".rail-ws-row",
      ".phone-more-row",
      ".pane-tab-overflow-item",
    ]) {
      expect(selectors, control).toContain(control);
    }
    for (const [, body] of press) {
      expect(body).toMatch(/scale:\s*0\.9\d/);
      expect(body).toContain("var(--press-tint)");
    }
    // Disabled controls stay still; the key bar keeps its own JS press state.
    expect(selectors).toContain(":disabled");
    expect(selectors).toContain(".mobile-key-bar-btn");
  });

  it("eases the press over the press token, at zero specificity", () => {
    const [selector, body] = rules(css, ":where(")[0];
    expect(selector.startsWith(":where(")).toBe(true);
    expect(body).toMatch(/transition:\s*scale var\(--motion-press\) var\(--motion-ease-press\)/);
  });

  it("writes no literal duration or curve: every one comes from a token", () => {
    expect(css).not.toMatch(/\b\d+(\.\d+)?m?s\b/);
    expect(css).not.toMatch(
      /cubic-bezier|(?<![\w-])(ease|ease-in|ease-out|ease-in-out|linear)(?![\w-])/,
    );
  });

  it("animates only opacity, scale and translate", () => {
    const frames = [...css.matchAll(/@keyframes\s+(\w+)\s*\{([\s\S]*?)\n\}/g)];
    expect(frames.length).toBeGreaterThanOrEqual(6);
    for (const [, name, body] of frames) {
      for (const prop of body.matchAll(/([\w-]+)\s*:/g)) {
        expect(["opacity", "scale", "translate"], `${name} animates ${prop[1]}`).toContain(prop[1]);
      }
    }
  });

  it("plays an exit for every overlay that carries data-presence", () => {
    const leaving = rules(css, '[data-presence="leaving"]')
      .map(([s, body]) => `${s} ${body}`)
      .join("\n");
    for (const surface of [".pane-tab-overflow-menu", ".custom-select-menu", ".motion-scrim"]) {
      expect(leaving).toContain(surface);
    }
    expect(leaving).toMatch(/motionPopOut var\(--motion-fade\)/);
    expect(leaving).toMatch(/motionDialogOut var\(--motion-fade\)/);
    expect(leaving).toMatch(/pointer-events:\s*none/);
  });

  it("puts sheets and popovers on translucent material with a blur", () => {
    for (const surface of [".mobile-session-sheet", ".pane-tab-overflow-menu"]) {
      const body = rules(css, surface)
        .map(([, b]) => b)
        .join("\n");
      expect(body, surface).toContain("background: var(--material)");
      expect(body, surface).toContain("backdrop-filter: var(--material-blur)");
    }
  });

  it("never puts material on a rail or a sidebar", () => {
    for (const [selector, body] of rules(css, "")) {
      if (!/backdrop-filter:\s*var/.test(body)) continue;
      expect(selector).not.toMatch(/rail|sidebar(?!-)|right-sidebar|left-rail/);
    }
  });

  it("makes material solid under reduced transparency", () => {
    const block = mediaBlock("prefers-reduced-transparency: reduce");
    const body = rules(block, ".mobile-session-sheet")
      .map(([, b]) => b)
      .join("\n");
    expect(body).toContain("background: var(--chrome)");
    expect(body).toMatch(/backdrop-filter:\s*none/);
    expect(rules(block, ".pane-tab-overflow-menu").length).toBeGreaterThan(0);
  });
});
