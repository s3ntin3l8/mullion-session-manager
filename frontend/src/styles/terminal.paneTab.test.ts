import { describe, expect, it } from "vitest";

// import.meta.glob rather than node:fs (browser-only tsconfig), as taskBoard.metaRow.test.ts does.
const files = import.meta.glob("./terminal.css", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;
const css = files["./terminal.css"]!;

// jsdom has no layout, so this pins the CSS contract that keeps a long task title from running
// behind the close/kebab buttons. It is only a CSS contract: no visual scene opens a tab with a long task title.

function rule(selector: string, src: string = css): string {
  const start = src.indexOf(`\n${selector} {`);
  expect(start, `${selector} rule exists`).toBeGreaterThanOrEqual(0);
  return src.slice(start, src.indexOf("}", start));
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
  it("keeps the actions in their own auto-sized track", () => {
    expect(rule(".pane-tab")).toMatch(/grid-template-columns:[^;]*\sauto\s*;/);
  });
});

// #3388 / #3356 — the x and … actions stay clear of the branch/status/unread text at 190-260px
// tab widths, and Delete shares the sidebar actions row. Same jsdom caveat: a CSS contract only.
const kitFiles = import.meta.glob("./sidebar-kit.css", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;
const kit = kitFiles["./sidebar-kit.css"]!;

describe("pane tab leading row (#3388)", () => {
  it("hard-stops at its own box so nothing paints over the actions", () => {
    const r = rule(".pane-tab-leading");
    expect(r).toMatch(/overflow:\s*clip/);
    expect(r).toMatch(/overflow-clip-margin:\s*4px/);
  });
  it("lets the branch and the optional badges shrink with an ellipsis", () => {
    const branch = rule(".pane-tab-branch");
    expect(branch).toMatch(/flex-shrink:\s*1/);
    expect(branch).toMatch(/min-width:\s*0/);
    expect(branch).toMatch(/text-overflow:\s*ellipsis/);
    const more = rule(".pane-tab-leading .setup-badge,\n.pane-tab-leading .host-derived-status");
    expect(more).toMatch(/min-width:\s*0/);
    expect(more).toMatch(/text-overflow:\s*ellipsis/);
  });
  it("keeps a few characters of the title", () => {
    expect(rule(".pane-tab-name")).toMatch(/flex:\s*1 0 1\.75rem/);
  });
});

describe("sidebar task actions row (#3356)", () => {
  it("is a wrapping flex row, not a stack", () => {
    const r = rule(".sb-actions-block", kit);
    expect(r).toMatch(/display:\s*flex/);
    expect(r).toMatch(/flex-wrap:\s*wrap/);
  });
  it("no longer forces Delete onto its own row", () => {
    expect(kit).not.toContain("\n.sb-actions-block .task-detail-actions-delete {");
  });
});
