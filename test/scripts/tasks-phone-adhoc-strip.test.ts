// #3243 — on the phone, the Tasks screen's ad-hoc sessions strip
// (AdhocLane, `.kanban-unified-lane`, the last child of `.kanban-unified`)
// sits at the bottom of the screen, right above the mode bar, when the board
// is shorter than the screen. The board is a page scroll there
// (`.kanban-board-overlay` is the one scroller), so the rule is: the board is
// at least as tall as that scroller, and the task area grows into the spare
// height, pushing the strip down. A longer board grows past the minimum and
// the strip stays at the end of the page; it is never pinned over the lanes.
//
// jsdom does no layout, so this pins the contract against the stylesheets as
// written, parsed with postcss (which keeps the phone tier's nested rules).
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import type { Rule, Root } from "postcss";

const STYLES_DIR = fileURLToPath(new URL("../../frontend/src/styles/", import.meta.url));
const PHONE_TIER = ':where(.app[data-tier="phone"])';

function parse(name: string): Root {
  return postcss.parse(fs.readFileSync(path.join(STYLES_DIR, name), "utf8"));
}

// Every declaration of `prop` on a rule whose selector list contains
// `selector`, optionally only inside the phone tier's block.
function declsFor(root: Root, selector: string, prop: string, phoneOnly: boolean): string[] {
  const out: string[] = [];
  root.walkRules((rule: Rule) => {
    if (!rule.selectors.map((s) => s.trim()).includes(selector)) return;
    const parent = rule.parent as Rule | undefined;
    const inPhone = parent?.type === "rule" && parent.selector.trim() === PHONE_TIER;
    if (phoneOnly && !inPhone) return;
    rule.walkDecls(prop, (d) => {
      if (d.parent === rule) out.push(d.value.trim());
    });
  });
  return out;
}

describe("phone Tasks screen: the ad-hoc strip sits at the bottom (#3243)", () => {
  const mobile = parse("mobile.css");

  it("makes the board at least as tall as its scroller", () => {
    expect(declsFor(mobile, ".kanban-unified", "min-height", true)).toContain("100%");
    // The board stays a page scroll, not a fixed-height box of its own.
    expect(declsFor(mobile, ".kanban-unified", "height", true)).toContain("auto");
    expect(declsFor(mobile, ".kanban-unified", "overflow", true)).toContain("visible");
  });

  it("lets the task area grow into the spare height", () => {
    expect(declsFor(mobile, ".kanban-unified-tasks", "flex", true)).toContain("1 0 auto");
  });

  // With cards on the board, growing the lanes would spread the spare height
  // between the columns; only an empty board's lanes (the centred note's
  // containing block) grow.
  it("grows the lanes only when they hold the empty-state note", () => {
    expect(declsFor(mobile, ".kanban-unified-tasks .task-board-lanes", "flex", true)).toEqual([
      "0 0 auto",
    ]);
    expect(
      declsFor(
        mobile,
        ".kanban-unified-tasks .task-board-lanes:has(> .task-board-empty)",
        "flex",
        true,
      ),
    ).toContain("1 0 auto");
  });

  it("keeps the strip in the flow rather than pinning it over the lanes", () => {
    for (const name of ["mobile.css", "empty-states.css"]) {
      const root = parse(name);
      for (const prop of ["position", "bottom"]) {
        expect(declsFor(root, ".kanban-unified-lane", prop, false)).toEqual([]);
      }
    }
  });
});
