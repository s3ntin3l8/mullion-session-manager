import { describe, expect, it } from "vitest";

// jsdom does not render native select popups; pin their CSS contract here.
const files = import.meta.glob(["./modals.css", "./tokens.css"], {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

function rule(file: string, selector: string): string {
  const css = files[file];
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} rule exists`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
}

describe("Native select popup theme", () => {
  it("themes Dropdown and standalone select options in dark mode, excluding light mode", () => {
    const option = rule("./modals.css", ".cmux-root:not(.light) select option");
    expect(option).toMatch(/background-color:\s*var\(--field\)/);
    expect(option).toMatch(/color:\s*var\(--fg\)/);
  });

  it("keeps disabled dark options readable with the muted text token", () => {
    expect(rule("./modals.css", ".cmux-root:not(.light) select option:disabled")).toMatch(
      /color:\s*var\(--muted\)/,
    );
  });

  it("lets native highlighting and disabled states use the active theme's color scheme", () => {
    expect(rule("./tokens.css", ".cmux-root")).toMatch(/color-scheme:\s*dark/);
    expect(rule("./tokens.css", ".cmux-root.light")).toMatch(/color-scheme:\s*light/);
  });
});
