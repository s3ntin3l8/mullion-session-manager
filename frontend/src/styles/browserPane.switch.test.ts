import { describe, expect, it } from "vitest";

// import.meta.glob rather than node:fs, as taskBoard.metaRow.test.ts does (browser-only tsconfig).
const files = import.meta.glob("./companion-views.css", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;
const css = files["./companion-views.css"]!;

// jsdom has no layout, so this pins the CSS contract for where the Browser
// pane's mode switch sits (#3371, decision 6): at the left of the address row
// in a wide pane, on its own row above the address in a narrow one, with
// "narrow" measured on the pane itself. The switch is the toolbar's first
// child (BrowserPaneHost.test.tsx), so the order needs no rule of its own.

function block(start: string): string {
  const at = css.indexOf(start);
  expect(at, `${start} exists`).toBeGreaterThanOrEqual(0);
  // The block runs to the brace that closes it.
  let depth = 0;
  for (let i = css.indexOf("{", at); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(at, i + 1);
  }
  throw new Error(`unclosed ${start}`);
}

describe("the Browser pane's mode switch", () => {
  it("measures the pane, under a name of its own, not the window", () => {
    expect(block(".browser-host {")).toMatch(/container:\s*browser-host\s*\/\s*inline-size/);
    expect(css).not.toMatch(/@media[^{]*\{[^}]*browser-mode-switch/);
  });

  it("shares the address row in a wide pane", () => {
    const rule = block(".browser-mode-switch {");
    expect(rule).toMatch(/flex:\s*0 1 auto/);
    expect(rule).toMatch(/max-width:\s*45%/);
  });

  it("takes a row of its own in a narrow pane", () => {
    const query = block("@container browser-host (max-width: 559.98px)");
    expect(query).toMatch(/\.browser-host \.browser-panel-toolbar \{\s*flex-wrap:\s*wrap;/);
    expect(query).toMatch(/\.browser-host \.browser-mode-switch \{\s*flex:\s*1 0 100%;/);
  });

  it("hides the mode that is not shown", () => {
    expect(block(".browser-host-body[hidden] {")).toMatch(/display:\s*none/);
  });
});
