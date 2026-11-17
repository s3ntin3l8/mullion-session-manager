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
// written. A small brace parser keeps the phone tier's nested rules (no CSS
// library: the stylesheets are plain rules, at-rules and one level of nesting).
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STYLES_DIR = fileURLToPath(new URL("../../frontend/src/styles/", import.meta.url));
const PHONE_TIER = ':where(.app[data-tier="phone"])';

interface CssRule {
  selector: string;
  parent: CssRule | null;
  decls: Array<[string, string]>;
}

function parse(name: string): CssRule[] {
  const css = fs.readFileSync(path.join(STYLES_DIR, name), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: CssRule[] = [];
  const stack: CssRule[] = [];
  let buf = "";
  for (const ch of css) {
    if (ch === "{") {
      const rule: CssRule = { selector: buf.trim(), parent: stack.at(-1) ?? null, decls: [] };
      rules.push(rule);
      stack.push(rule);
      buf = "";
    } else if (ch === "}" || ch === ";") {
      const text = buf.trim();
      const colon = text.indexOf(":");
      const owner = stack.at(-1);
      if (owner && colon > 0 && !text.startsWith("@")) {
        owner.decls.push([text.slice(0, colon).trim(), text.slice(colon + 1).trim()]);
      }
      buf = "";
      if (ch === "}") stack.pop();
    } else {
      buf += ch;
    }
  }
  return rules;
}

// Every value of `prop` declared directly on a rule whose selector list
// contains `selector`, optionally only inside the phone tier's block.
function declsFor(rules: CssRule[], selector: string, prop: string, phoneOnly: boolean): string[] {
  return rules
    .filter((r) =>
      r.selector
        .split(",")
        .map((s) => s.trim())
        .includes(selector),
    )
    .filter((r) => !phoneOnly || r.parent?.selector === PHONE_TIER)
    .flatMap((r) => r.decls.filter(([p]) => p === prop).map(([, v]) => v));
}

describe("phone Tasks screen: the ad-hoc strip sits at the bottom (#3243)", () => {
  const mobile = parse("mobile.css");

  it("makes the board at least as tall as its scroller", () => {
    expect(declsFor(mobile, ".kanban-unified", "min-height", true)).toContain("100%");
    // The board stays a page scroll, not a fixed-height box of its own.
    expect(declsFor(mobile, ".kanban-unified", "height", true)).toContain("auto");
    expect(declsFor(mobile, ".kanban-unified", "overflow", true)).toContain("visible");
  });

  // `min-height: 100%` only resolves against a definite height: the board's
  // scroller is the overlay, sized by its inline `position: absolute;
  // inset: 0` at the KanbanBoardOverlay render site. If that became a flow
  // element the percentage would resolve to nothing and the strip would stop
  // moving down while the rule above stayed in place.
  it("keeps the board's scroller a definite-height box", () => {
    const registry = fs.readFileSync(
      fileURLToPath(new URL("../../frontend/src/panels/registry.tsx", import.meta.url)),
      "utf8",
    );
    const overlay = registry.slice(registry.indexOf("export function KanbanBoardOverlay"));
    expect(overlay).toMatch(
      /className="kanban-board-overlay"\s+style=\{\{ position: "absolute", inset: 0 \}\}/,
    );
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
    // Every stylesheet, not just the two that style the strip today: any of
    // them could reach the class.
    const sheets = fs.readdirSync(STYLES_DIR).filter((f) => f.endsWith(".css"));
    expect(sheets).toContain("empty-states.css");
    for (const name of sheets) {
      const root = parse(name);
      for (const prop of ["position", "bottom"]) {
        expect(declsFor(root, ".kanban-unified-lane", prop, false)).toEqual([]);
      }
    }
  });
});
