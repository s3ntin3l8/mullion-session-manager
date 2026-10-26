// Issue #1886 — an ended session's status label is `var(--dim)`, and the
// row it sits in used to carry `opacity: 0.5` as well. Opacity on an
// ancestor multiplies, so the label composited to about 2.3:1 (dark) and
// 2.0:1 (light) against `--sidebar`: under the 3:1 the issue asks for.
//
// The fix moves that fade onto the row's other children and leaves
// `.session-status-label` alone. This file pins both halves against the
// stylesheets as written — sidebar.css and the later files that also
// style `.session-item` — and measures the composite with
// scripts/lib/color-math.mjs rather than a hand-computed ratio. A full
// CSS engine is deliberately not involved: the selectors in play are
// class compounds, `:hover`, `:not(.class)`, and the two combinators, and
// a matcher that does not understand a selector which might touch the row
// fails closed instead of reporting a comfortable pass.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseColor, renderSample } from "../../scripts/lib/color-math.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const STYLES_DIR = path.join(REPO_ROOT, "frontend", "src", "styles");
// styles/index.css import order. sidebar.css owns the ended-row fade.
// compact.css, tablet.css and sidebar-density.css come later; the last
// two already style `.session-item`. An opacity added to any of the three
// multiplies with the label the same way one in sidebar.css does.
const ENDED_ROW_STYLESHEETS = [
  "sidebar.css",
  "compact.css",
  "tablet.css",
  "sidebar-density.css",
] as const;
const TOKENS_CSS = path.join(STYLES_DIR, "tokens.css");

function endedRowStylesheetCss(extra?: {
  file: (typeof ENDED_ROW_STYLESHEETS)[number];
  css: string;
}): string {
  return ENDED_ROW_STYLESHEETS.map((name) => {
    const text = fs.readFileSync(path.join(STYLES_DIR, name), "utf8");
    return extra?.file === name ? `${text}\n${extra.css}\n` : text;
  }).join("\n");
}

/** The floor the issue asks of the label. Not WCAG AA's 4.5:1 for text. */
const LABEL_MIN_RATIO = 3;

interface ElementNode {
  classes: string[];
  parent: ElementNode | null;
}

interface Chunk {
  compound: string;
  /** How this compound attaches to the compound before it. */
  combToPrev: "start" | "child" | "desc";
}

interface Rule {
  selector: string;
  declarations: Map<string, string>;
  index: number;
}

/** Outermost ancestor first, the element itself last. */
function chain(classLists: string[][]): ElementNode {
  let parent: ElementNode | null = null;
  let node: ElementNode | null = null;
  for (const classes of classLists) {
    node = { classes, parent };
    parent = node;
  }
  if (!node) throw new Error("empty element chain");
  return node;
}

function endedRow(rowClass: string): {
  label: ElementNode;
  name: ElementNode;
  nowLine: ElementNode;
} {
  const row = ["session-item", rowClass];
  return {
    // Sidebar.tsx wraps the label in `.session-status-group`, inside
    // Header.tsx's `.session-item-row`, inside `.session-item`. Header.test.tsx
    // renders that nesting; this chain is the same shape. The exited tone is
    // the one an ended session actually paints (sessionStatus.ts).
    // `.status-killed` is not a row class `rowClassNameForSeverity` returns.
    label: chain([
      row,
      ["session-item-row"],
      ["session-status-group"],
      ["session-status-label", "exited"],
    ]),
    name: chain([row, ["session-item-row"], ["session-name"]]),
    nowLine: chain([row, ["session-now-line"]]),
  };
}

function splitSelectors(selector: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  for (const ch of selector) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseSelector(selector: string): Chunk[] {
  const chunks: Chunk[] = [];
  let rest = selector.trim();
  let combToPrev: Chunk["combToPrev"] = "start";
  while (rest.length > 0) {
    let depth = 0;
    let i = 0;
    while (i < rest.length) {
      const ch = rest[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth = Math.max(0, depth - 1);
      else if (depth === 0 && (ch === ">" || /\s/.test(ch))) break;
      i++;
    }
    const compound = rest.slice(0, i).trim();
    if (!compound) break;
    chunks.push({ compound, combToPrev });
    rest = rest.slice(i).trimStart();
    if (rest.length === 0) break;
    if (rest.startsWith(">")) {
      combToPrev = "child";
      rest = rest.slice(1).trimStart();
    } else {
      combToPrev = "desc";
    }
  }
  return chunks;
}

const COMPOUND_TOKEN = /:not\(\.[_a-zA-Z][\w-]*\)|:[_a-zA-Z][\w-]*|\.[_a-zA-Z][\w-]*/g;

function compoundTokens(compound: string): string[] | null {
  const tokens = compound.match(COMPOUND_TOKEN);
  if (!tokens || tokens.join("") !== compound) return null;
  return tokens;
}

function selectorUnderstood(selector: string): boolean {
  const parts = splitSelectors(selector);
  if (parts.length === 0) return false;
  return parts.every((part) => {
    const chunks = parseSelector(part);
    return chunks.length > 0 && chunks.every((chunk) => compoundTokens(chunk.compound) !== null);
  });
}

function matchesCompound(compound: string, node: ElementNode, hovered: boolean): boolean {
  const tokens = compoundTokens(compound);
  if (!tokens) return false;
  for (const token of tokens) {
    if (token.startsWith(".")) {
      if (!node.classes.includes(token.slice(1))) return false;
    } else if (token === ":hover") {
      if (!hovered) return false;
    } else if (token.startsWith(":not(.")) {
      const cls = token.slice(":not(.".length, -1);
      if (node.classes.includes(cls)) return false;
    } else {
      // :focus, :active, and anything else this matcher does not model.
      return false;
    }
  }
  return true;
}

function matchesChain(chunks: Chunk[], node: ElementNode, hovered: boolean): boolean {
  if (chunks.length === 0) return false;
  const last = chunks[chunks.length - 1];
  if (!matchesCompound(last.compound, node, hovered)) return false;
  const rest = chunks.slice(0, -1);
  if (rest.length === 0) return last.combToPrev === "start";
  if (last.combToPrev === "child") {
    return node.parent ? matchesChain(rest, node.parent, hovered) : false;
  }
  if (last.combToPrev === "desc") {
    let parent = node.parent;
    while (parent) {
      if (matchesChain(rest, parent, hovered)) return true;
      parent = parent.parent;
    }
    return false;
  }
  return false;
}

function matches(selector: string, node: ElementNode, hovered: boolean): boolean {
  return splitSelectors(selector).some((part) => matchesChain(parseSelector(part), node, hovered));
}

function matchingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error("unbalanced brace in stylesheet");
}

function declarationsIn(body: string): Map<string, string> {
  // Nested rule blocks are not declarations of THIS rule.
  const flat = body.replace(/\{[^{}]*\}/g, " ");
  const out = new Map<string, string>();
  for (const part of flat.split(";")) {
    const idx = part.indexOf(":");
    if (idx === -1) continue;
    const prop = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (prop && !prop.includes("{") && value) out.set(prop, value);
  }
  return out;
}

function extractRules(css: string): Rule[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  let index = 0;
  const walk = (text: string): void => {
    let i = 0;
    while (i < text.length) {
      while (i < text.length && /\s/.test(text[i] ?? "")) i++;
      if (i >= text.length) break;
      const open = text.indexOf("{", i);
      if (open === -1) break;
      const selector = text.slice(i, open).trim();
      const close = matchingBrace(text, open);
      const body = text.slice(open + 1, close);
      if (selector.startsWith("@")) {
        walk(body);
      } else {
        if (selector && !selector.includes(";") && !selector.includes("{")) {
          rules.push({ selector, declarations: declarationsIn(body), index: index++ });
        }
        if (body.includes("{")) walk(body);
      }
      i = close + 1;
    }
  };
  walk(stripped);
  return rules;
}

function specificity(selectorPart: string): [number, number, number] {
  const classes = selectorPart.match(/\.[\w-]+/g)?.length ?? 0;
  // :not() contributes its argument (already counted as a class), not itself.
  const pseudos = selectorPart.match(/:(?!not\b)[\w-]+/g)?.length ?? 0;
  return [0, classes + pseudos, 0];
}

function compareSpec(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function winningValue(
  rules: Rule[],
  node: ElementNode,
  prop: string,
  hovered: boolean,
): string | null {
  let best: { value: string; spec: [number, number, number]; index: number } | null = null;
  for (const rule of rules) {
    const value = rule.declarations.get(prop);
    if (value === undefined) continue;
    for (const part of splitSelectors(rule.selector)) {
      if (!matches(part, node, hovered)) continue;
      const spec = specificity(part);
      if (
        !best ||
        compareSpec(spec, best.spec) > 0 ||
        (compareSpec(spec, best.spec) === 0 && rule.index >= best.index)
      ) {
        best = { value, spec, index: rule.index };
      }
    }
  }
  return best?.value ?? null;
}

function readOpacity(value: string | null): number {
  if (value === null) return 1;
  if (!/^(?:0|1|0?\.\d+)$/.test(value)) {
    throw new Error(`opacity is not a plain number: ${value}`);
  }
  return Number(value);
}

/** Own opacity times every ancestor's, which is what the screen paints. */
function effectiveOpacity(rules: Rule[], node: ElementNode, hovered: boolean): number {
  let product = 1;
  let current: ElementNode | null = node;
  while (current) {
    product *= readOpacity(winningValue(rules, current, "opacity", hovered));
    current = current.parent;
  }
  return product;
}

function themeBlock(css: string, selector: string): string {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`missing ${selector} in tokens.css`);
  const open = css.indexOf("{", start);
  return css.slice(open + 1, matchingBrace(css, open));
}

function tokenHex(block: string, name: string): string {
  const match = new RegExp(`--${name}\\s*:\\s*(#[0-9a-fA-F]{3,8})`).exec(block);
  if (!match) throw new Error(`missing --${name}`);
  return match[1];
}

function mightTouchEndedRow(selector: string): boolean {
  return /session-item|session-status|status-exited|status-killed/.test(selector);
}

describe("ended session status label contrast (#1886)", () => {
  const rules = extractRules(endedRowStylesheetCss());
  const tokensCss = fs.readFileSync(TOKENS_CSS, "utf8");
  const darkBlock = themeBlock(tokensCss, ".cmux-root {");
  const lightBlock = themeBlock(tokensCss, ".cmux-root.light {");
  const themes = [
    {
      name: "dark",
      dim: tokenHex(darkBlock, "dim"),
      fg: tokenHex(darkBlock, "fg"),
      sidebar: tokenHex(darkBlock, "sidebar"),
      // --dim at opacity 1, and the same colour at the old row opacity of
      // 0.5. Pinned so a token edit that moves the composite is visible
      // here, not only the 3:1 floor.
      resting: 5.29,
      faded: 2.26,
      liveName: 15.45,
      endedName: 4.68,
    },
    {
      name: "light",
      dim: tokenHex(lightBlock, "dim"),
      fg: tokenHex(lightBlock, "fg"),
      sidebar: tokenHex(lightBlock, "sidebar"),
      resting: 5.21,
      faded: 2.04,
      liveName: 16.28,
      endedName: 3.33,
    },
  ] as const;

  it("rejects an opacity rule the matcher cannot prove misses the label", () => {
    const offenders = rules.filter(
      (rule) =>
        rule.declarations.has("opacity") &&
        mightTouchEndedRow(rule.selector) &&
        !selectorUnderstood(rule.selector),
    );
    expect(offenders.map((rule) => rule.selector)).toEqual([]);
  });

  // The same check the real stylesheets pass, pointed at a copy of one of
  // the sibling files with the old row fade appended. Not written back:
  // the files on disk stay as they are, and this is what fails if the
  // scanner goes back to reading sidebar.css alone.
  for (const file of ["compact.css", "tablet.css", "sidebar-density.css"] as const) {
    it(`sees an ended-row opacity appended to ${file} cover the label`, () => {
      const mutated = extractRules(
        endedRowStylesheetCss({
          file,
          css: ".session-item.status-exited { opacity: .5 }",
        }),
      );
      const { label } = endedRow("status-exited");
      let row = label;
      while (row.parent) {
        row = row.parent;
      }
      expect(winningValue(mutated, row, "opacity", false)).toBe(".5");
      expect(effectiveOpacity(mutated, label, false)).toBe(0.5);
    });
  }

  describe(".session-item.status-exited", () => {
    const { label, name, nowLine } = endedRow("status-exited");

    it("does not let a row opacity cover the status label, at rest or hovered", () => {
      // Any opacity on the label OR an ancestor fails this. That is the
      // regression: `.session-item.status-exited { opacity: 0.5 }` matches
      // the row, which is an ancestor, and the label cannot paint above it.
      for (const hovered of [false, true]) {
        let current: ElementNode | null = label;
        while (current) {
          expect(winningValue(rules, current, "opacity", hovered)).toBeNull();
          current = current.parent;
        }
        expect(effectiveOpacity(rules, label, hovered)).toBe(1);
      }
    });

    it("still fades the name and the meta line relative to a live row", () => {
      expect(effectiveOpacity(rules, name, false)).toBe(0.5);
      expect(effectiveOpacity(rules, name, true)).toBe(0.7);
      expect(effectiveOpacity(rules, nowLine, false)).toBe(0.5);
      expect(effectiveOpacity(rules, nowLine, true)).toBe(0.7);
    });
  });

  it("paints the exited label in --dim", () => {
    const { label } = endedRow("status-exited");
    expect(winningValue(rules, label, "color", false)).toBe("var(--dim)");
  });

  it("composites the resting label to at least 3:1 against --sidebar in both themes", () => {
    const { label } = endedRow("status-exited");
    const opacity = effectiveOpacity(rules, label, false);
    expect(opacity).toBe(1);
    for (const theme of themes) {
      const sample = renderSample({
        color: theme.dim,
        layers: [parseColor(theme.sidebar)],
        opacity,
      });
      expect(sample.resolved).toBe(true);
      expect(sample.ratio).toBeGreaterThanOrEqual(LABEL_MIN_RATIO);
      expect(sample.ratio).toBeCloseTo(theme.resting, 2);
    }
  });

  it("documents that the old row opacity of 0.5 puts --dim under 3:1", () => {
    for (const theme of themes) {
      const sample = renderSample({
        color: theme.dim,
        layers: [parseColor(theme.sidebar)],
        opacity: 0.5,
      });
      expect(sample.ratio).toBeLessThan(LABEL_MIN_RATIO);
      expect(sample.ratio).toBeCloseTo(theme.faded, 2);
    }
  });

  it("keeps an ended row's name quieter than a live row's name", () => {
    const { name } = endedRow("status-exited");
    const opacity = effectiveOpacity(rules, name, false);
    expect(opacity).toBeLessThan(1);
    for (const theme of themes) {
      const ended = renderSample({
        color: theme.fg,
        layers: [parseColor(theme.sidebar)],
        opacity,
      });
      const live = renderSample({
        color: theme.fg,
        layers: [parseColor(theme.sidebar)],
        opacity: 1,
      });
      expect(ended.ratio).not.toBeNull();
      expect(live.ratio).not.toBeNull();
      expect(ended.ratio as number).toBeLessThan(live.ratio as number);
      expect(ended.ratio).toBeCloseTo(theme.endedName, 2);
      expect(live.ratio).toBeCloseTo(theme.liveName, 2);
    }
  });
});
