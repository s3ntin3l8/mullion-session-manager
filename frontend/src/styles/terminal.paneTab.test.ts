import { describe, expect, it } from "vitest";

// import.meta.glob rather than node:fs (browser-only tsconfig), as taskBoard.metaRow.test.ts does.
const files = import.meta.glob("./terminal.css", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;
const css = files["./terminal.css"];

// jsdom has no layout, so this pins the CSS contract that keeps a long task title from running
// behind the close/kebab buttons; the rendered result is covered by the visual scenes.

function rule(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `${selector} rule exists`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
}

describe("pane tab title truncation", () => {
  it("lets the left grid track shrink below its content", () => {
    expect(rule(".pane-tab")).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/);
  });
  it("lets the leading cluster shrink", () => {
    expect(rule(".pane-tab-leading")).toMatch(/min-width:\s*0/);
  });
  it("ellipsizes the name", () => {
    const name = rule(".pane-tab-name");
    expect(name).toMatch(/overflow:\s*hidden/);
    expect(name).toMatch(/text-overflow:\s*ellipsis/);
    expect(name).toMatch(/min-width:\s*0/);
  });
  it("never shrinks the actions", () => {
    expect(rule(".pane-tab-actions")).toMatch(/flex-shrink:\s*0/);
  });
});
