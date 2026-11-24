import { describe, expect, it } from "vitest";

// import.meta.glob rather than node:fs, as taskBoard.metaRow.test.ts does.
const files = import.meta.glob(["./terminal.css", "./sidebar-kit.css"], {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;
const css = files["./terminal.css"]!;
const kit = files["./sidebar-kit.css"]!;

function rule(src: string, selector: string): string {
  const start = src.indexOf(`${selector} {`);
  expect(start, `${selector} rule exists`).toBeGreaterThanOrEqual(0);
  return src.slice(start, src.indexOf("}", start));
}

// jsdom has no layout; this pins the contract that keeps the tab's x and … actions
// clear of the branch/status/unread text at 190-260px tab widths (#3388).
describe("pane tab leading row (#3388)", () => {
  it("hard-stops at its own box so nothing paints over the actions", () => {
    const r = rule(css, ".pane-tab-leading");
    expect(r).toMatch(/overflow:\s*clip/);
    expect(r).toMatch(/overflow-clip-margin:\s*4px/);
  });
  it("lets the branch and the optional badges shrink with an ellipsis", () => {
    const branch = rule(css, ".pane-tab-branch");
    expect(branch).toMatch(/flex-shrink:\s*1/);
    expect(branch).toMatch(/min-width:\s*0/);
    expect(branch).toMatch(/text-overflow:\s*ellipsis/);
    const more = rule(
      css,
      ".pane-tab-leading .setup-badge,\n.pane-tab-leading .host-derived-status",
    );
    expect(more).toMatch(/min-width:\s*0/);
    expect(more).toMatch(/text-overflow:\s*ellipsis/);
  });
  it("keeps a few characters of the title", () => {
    expect(rule(css, ".pane-tab-name")).toMatch(/min-width:\s*2\.5rem/);
  });
});

// #3356: Delete shares the sidebar actions row with the routine buttons.
describe("sidebar task actions row (#3356)", () => {
  it("is a wrapping flex row, not a stack", () => {
    const r = rule(kit, ".sb-actions-block");
    expect(r).toMatch(/display:\s*flex/);
    expect(r).toMatch(/flex-wrap:\s*wrap/);
  });
  it("no longer forces Delete onto its own row", () => {
    expect(kit).not.toMatch(/\.sb-actions-block \.task-detail-actions-delete/);
  });
});
