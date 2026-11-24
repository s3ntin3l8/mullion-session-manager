import { describe, expect, it } from "vitest";

// import.meta.glob rather than node:fs, as taskBoard.metaRow.test.ts does.
const files = import.meta.glob("./tablet.css", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;
const css = files["./tablet.css"]!;

// #3443: jsdom has no layout, so pin the contract. Every control in the
// browser toolbars gets the 44px touch floor under a coarse pointer.
describe("browser toolbar touch floor (#3443)", () => {
  const coarse = css.slice(css.indexOf("@media (pointer: coarse)"));

  // The declaration body of the rule whose selector list is exactly `selector`.
  function ruleFor(selector: string): string {
    const at = coarse.indexOf(`${selector} {`);
    expect(at, `${selector} rule exists`).toBeGreaterThanOrEqual(0);
    return coarse.slice(coarse.indexOf("{", at) + 1, coarse.indexOf("}", at));
  }

  it("floors the icon buttons at 44x44", () => {
    const rule = ruleFor(".browser-panel-toolbar .browser-panel-reload");
    expect(rule).toMatch(/min-width:\s*44px/);
    expect(rule).toMatch(/min-height:\s*44px/);
  });

  it("floors Go, the URL dropdown, follow and the mode switch segments at 44px tall", () => {
    const rule = ruleFor(".browser-panel-toolbar .browser-mode-switch-seg");
    expect(rule).toMatch(/min-height:\s*44px/);
    const at = coarse.indexOf(".browser-panel-toolbar .browser-panel-go,");
    const selectors = coarse.slice(at, coarse.indexOf("{", at));
    for (const c of [".browser-panel-go", ".browser-panel-dropdown-btn", ".browser-panel-follow"]) {
      expect(selectors).toContain(c);
    }
  });

  it("wraps and keeps the address usable", () => {
    expect(ruleFor(".browser-panel-toolbar")).toMatch(/flex-wrap:\s*wrap/);
    const at = coarse.indexOf(".browser-panel-toolbar .browser-panel-address,");
    expect(coarse.slice(at, coarse.indexOf("}", at))).toMatch(/min-width:/);
  });
});
