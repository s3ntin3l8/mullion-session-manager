import { describe, it, expect } from "vitest";
import launcherProjectsCss from "../styles/launcher-projects.css?raw";

// The rule body of the first `selector {…}` block in a stylesheet.
function rule(css: string, selector: string): string {
  // vitest.config.ts's css.include must list the stylesheet, or `?raw` is "".
  if (css === "")
    throw new Error("stylesheet loaded empty: add it to vitest.config.ts css.include");
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(css);
  if (!match) throw new Error(`no rule for ${selector}`);
  return match[1];
}

// #3212 — the Add/Edit project view sits in the launcher's body, a flex
// column that scrolls (modals.css's .create-modal-body). jsdom does no layout, so the
// rules that keep the form at its content height are pinned here; the
// overlap itself was checked in the demo (see the pull request).
describe("LauncherProjectView layout (#3212)", () => {
  it("the view and the form never shrink below their content", () => {
    for (const selector of [".launcher-project-view", ".embedded-form"]) {
      const body = rule(launcherProjectsCss, selector);
      expect(body, selector).toMatch(/flex-shrink:\s*0/);
      // min-height: 0 is what let the form collapse under the Discover list.
      expect(body, selector).not.toMatch(/min-height:\s*0/);
    }
  });

  it("the form's body takes its content height and does not scroll itself", () => {
    const body = rule(launcherProjectsCss, ".embedded-form-body");
    expect(body).toMatch(/flex:\s*none/);
    expect(body).toMatch(/overflow-y:\s*visible/);
  });
});
