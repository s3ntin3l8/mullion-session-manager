// The type scale has to be rem so the OS text-size preference (which changes
// the document root font size) actually scales the UI. px ignores that
// preference. Browser zoom is a different mechanism and is not what this
// guards.
//
// rem is relative to `html`, not to `.app`. A px `font-size` on `html` or
// `body` would pin the root and cancel the preference, so it fails this
// scan the same way any other px font-size does. Geometry (padding, margin,
// width, radius) stays in px on purpose — this only looks at `font-size`
// and at a `font` shorthand that bakes a px size in.
//
// Inline styles are the other half. React treats a numeric `fontSize` as
// px, and `fontSize: "12px"` / `fontSize={12}` are px too, so
// `frontend/src/**/*.tsx` is held to the same rule. A number passed through
// to xterm is the grid size, not the app type scale: `new Terminal({
// fontSize })`, `terminal: { fontSize: 14 }` (the settings value and its
// test fixtures), and an identifier (`fontSize: prefs.fontSize`,
// `fontSize={t.fontSize}`) in TerminalPane / TerminalPreview. dockHelpers'
// PX_PER_COL ratio lives in a `.ts` module and is not a font-size.
//
// A declaration that truly cannot be rem may keep px with a same-line
// `font-size-px-ok` marker.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const STYLES_DIR = path.join(REPO_ROOT, "frontend", "src", "styles");
const FRONTEND_SRC = path.join(REPO_ROOT, "frontend", "src");

const ESCAPE = "font-size-px-ok";

// The character before `font` must not be a word char or a hyphen, so
// `font-size` / `font-family` are not read as the `font` shorthand.
const FONT_SIZE_PX = /(?:^|[^\w-])font-size\s*:\s*[^;{}]*?\d+(?:\.\d+)?px\b/gi;
const FONT_SHORTHAND_PX = /(?:^|[^\w-])font\s*:\s*[^;{}]*?\d+(?:\.\d+)?px\b/gi;

// React's numeric fontSize is px. A quoted Npx string is px too. Rem
// strings and identifiers (xterm's prefs.fontSize) do not match.
const INLINE_FONT_SIZE_NUMBER = /fontSize\s*:\s*\d+(?:\.\d+)?(?![\w.])/g;
const INLINE_FONT_SIZE_PX_STRING = /fontSize\s*:\s*(["'])\d+(?:\.\d+)?px\1/gi;
const JSX_FONT_SIZE_NUMBER = /fontSize\s*=\s*\{\s*\d+(?:\.\d+)?(?![\w.])/g;
const JSX_FONT_SIZE_PX_STRING = /fontSize\s*=\s*\{\s*(["'])\d+(?:\.\d+)?px\1/gi;

// xterm consumes this object as a CSS-pixel grid size.
const XTERM_FONT_OBJECT = /(?:\bterminal\s*:\s*\{|new\s+Terminal\s*\(\s*\{)/g;

type Span = readonly [number, number];

function lineNumberAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

function inSpan(index: number, spans: readonly Span[]): boolean {
  for (const [start, end] of spans) {
    if (index >= start && index < end) return true;
  }
  return false;
}

/** Comments and string/template literals, so a mention in prose is not a hit. */
function nonCodeSpans(source: string): Span[] {
  const spans: Span[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      spans.push([i, stop]);
      i = stop;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      spans.push([i, stop]);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      const start = i;
      i++;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      spans.push([start, i]);
      continue;
    }
    i++;
  }
  return spans;
}

/** Index of the `}` that closes the `{` at `openBrace`, skipping strings and comments. */
function braceEnd(source: string, openBrace: number): number {
  let depth = 0;
  let i = openBrace;
  while (i < source.length) {
    const c = source[i];
    if (c === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return source.length;
}

/** Spans of `terminal: { ... }` and `new Terminal({ ... })` — the xterm grid size. */
function xtermGridSpans(source: string, nonCode: readonly Span[]): Span[] {
  const spans: Span[] = [];
  XTERM_FONT_OBJECT.lastIndex = 0;
  for (const match of source.matchAll(XTERM_FONT_OBJECT)) {
    const start = match.index ?? 0;
    if (inSpan(start, nonCode)) continue;
    const open = start + match[0].lastIndexOf("{");
    spans.push([open, braceEnd(source, open)]);
  }
  return spans;
}

/** px font-size declarations in one stylesheet. Empty when the file is clean. */
function pxFontSizeViolations(source: string, file = "fixture.css"): string[] {
  const lines = source.split("\n");
  const found: string[] = [];
  for (const pattern of [FONT_SIZE_PX, FONT_SHORTHAND_PX]) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      const startLine = lineNumberAt(source, start);
      const endLine = lineNumberAt(source, end);
      let escaped = false;
      for (let n = startLine; n <= endLine; n++) {
        if (lines[n - 1]?.includes(ESCAPE)) escaped = true;
      }
      if (escaped) continue;
      const text = lines[startLine - 1]?.trim() ?? match[0].trim();
      found.push(`${file}:${startLine}: ${text}`);
    }
  }
  return found;
}

/** Relative paths of `extension` files under `dir`, including subdirectories. */
function filesUnder(dir: string, extension: string): string[] {
  const entries = fs.readdirSync(dir, { recursive: true, encoding: "utf8" });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(extension)) continue;
    const full = path.join(dir, entry);
    if (!fs.statSync(full).isFile()) continue;
    files.push(entry.split(path.sep).join("/"));
  }
  return files.sort();
}

function violationsInCssTree(dir: string, labelPrefix: string): string[] {
  const out: string[] = [];
  for (const name of filesUnder(dir, ".css")) {
    const source = fs.readFileSync(path.join(dir, name), "utf8");
    out.push(...pxFontSizeViolations(source, path.posix.join(labelPrefix, name)));
  }
  return out;
}

function stylesheetViolations(): string[] {
  return violationsInCssTree(STYLES_DIR, "frontend/src/styles");
}

/**
 * Numeric `fontSize` / `fontSize: "Npx"` / `fontSize={N}` in one tsx source.
 * Empty when the file is clean. xterm's grid size is not a violation.
 */
function inlinePxFontSizeViolations(source: string, file = "fixture.tsx"): string[] {
  const lines = source.split("\n");
  const nonCode = nonCodeSpans(source);
  const xterm = xtermGridSpans(source, nonCode);
  const found: string[] = [];
  for (const pattern of [
    INLINE_FONT_SIZE_NUMBER,
    INLINE_FONT_SIZE_PX_STRING,
    JSX_FONT_SIZE_NUMBER,
    JSX_FONT_SIZE_PX_STRING,
  ]) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const start = match.index ?? 0;
      if (inSpan(start, nonCode) || inSpan(start, xterm)) continue;
      const end = start + match[0].length;
      const startLine = lineNumberAt(source, start);
      const endLine = lineNumberAt(source, end);
      let escaped = false;
      for (let n = startLine; n <= endLine; n++) {
        if (lines[n - 1]?.includes(ESCAPE)) escaped = true;
      }
      if (escaped) continue;
      const text = lines[startLine - 1]?.trim() ?? match[0].trim();
      found.push(`${file}:${startLine}: ${text}`);
    }
  }
  return found;
}

function tsxFontSizeViolations(): string[] {
  const out: string[] = [];
  for (const name of filesUnder(FRONTEND_SRC, ".tsx")) {
    const source = fs.readFileSync(path.join(FRONTEND_SRC, name), "utf8");
    out.push(...inlinePxFontSizeViolations(source, path.posix.join("frontend/src", name)));
  }
  return out;
}

describe("frontend/src/styles type scale", () => {
  it("rejects a px font-size", () => {
    expect(pxFontSizeViolations(".badge { font-size: 9.5px; }")).toEqual([
      "fixture.css:1: .badge { font-size: 9.5px; }",
    ]);
  });

  it("rejects a px size baked into the font shorthand", () => {
    expect(pxFontSizeViolations(".a { font: 12px/1.4 Geist, sans-serif; }")).toEqual([
      "fixture.css:1: .a { font: 12px/1.4 Geist, sans-serif; }",
    ]);
  });

  it("does not treat geometry, inherit, or rem as a px font-size", () => {
    const css = [
      ".app { font-size: 0.875rem; padding: 14px; border-radius: 9.5px; }",
      ".row { font-size: inherit; font: inherit; width: 10.5px; }",
      "/* the unread badge is 9.5px at the default root */",
      "html, body { margin: 0; }",
    ].join("\n");
    expect(pxFontSizeViolations(css)).toEqual([]);
  });

  it("allows a px font-size only with the same-line escape marker", () => {
    expect(
      pxFontSizeViolations(".a { font-size: 14px; /* font-size-px-ok: not a type scale */ }"),
    ).toEqual([]);
    expect(pxFontSizeViolations(".a { font-size: 14px; /* not an escape */ }")).toHaveLength(1);
  });

  it("scans a stylesheet nested under the styles directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "font-size-rem-"));
    try {
      fs.mkdirSync(path.join(root, "nested"));
      fs.writeFileSync(path.join(root, "top.css"), ".a { font-size: 1rem; }\n");
      fs.writeFileSync(path.join(root, "nested", "deep.css"), ".b { font-size: 9px; }\n");
      fs.writeFileSync(path.join(root, "nested", "skip.txt"), ".c { font-size: 9px; }\n");
      expect(violationsInCssTree(root, "styles")).toEqual([
        "styles/nested/deep.css:1: .b { font-size: 9px; }",
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("has no px font-size left in frontend/src/styles", () => {
    expect(stylesheetViolations()).toEqual([]);
  });

  // Exact fractions of 16, so a default root still paints the old pixels:
  // 14px → 0.875rem, 9.5px → 0.59375rem, 10.5px → 0.65625rem, 12.5px → 0.78125rem.
  it("keeps the shell and the dense chrome the same size at a 16px root", () => {
    const app = fs.readFileSync(path.join(STYLES_DIR, "app-shell.css"), "utf8");
    expect(app).toContain("font-size: 0.875rem;");
    expect(app).not.toMatch(/font-size:\s*14px/);
    const sidebar = fs.readFileSync(path.join(STYLES_DIR, "sidebar.css"), "utf8");
    expect(sidebar).toContain("font-size: 0.59375rem;");
    expect(sidebar).toContain("font-size: 0.65625rem;");
    expect(sidebar).toContain("font-size: 0.78125rem;");
  });
});

describe("frontend/src inline type scale", () => {
  it("rejects a numeric fontSize and a px string", () => {
    expect(inlinePxFontSizeViolations(`<i style={{ fontSize: 12 }} />`)).toEqual([
      "fixture.tsx:1: <i style={{ fontSize: 12 }} />",
    ]);
    expect(inlinePxFontSizeViolations(`<i style={{ fontSize: "12px" }} />`)).toEqual([
      `fixture.tsx:1: <i style={{ fontSize: "12px" }} />`,
    ]);
    expect(inlinePxFontSizeViolations(`<i style={{ fontSize: '9.5px' }} />`)).toEqual([
      "fixture.tsx:1: <i style={{ fontSize: '9.5px' }} />",
    ]);
    expect(inlinePxFontSizeViolations(`<i fontSize={9} />`)).toEqual([
      "fixture.tsx:1: <i fontSize={9} />",
    ]);
    expect(inlinePxFontSizeViolations(`<i fontSize={"9px"} />`)).toEqual([
      `fixture.tsx:1: <i fontSize={"9px"} />`,
    ]);
  });

  it("does not treat rem, identifiers, comments, or the xterm grid as a px font-size", () => {
    const tsx = [
      `const chrome = { fontSize: "0.75rem" };`,
      `new Terminal({ fontSize: prefs.fontSize, fontFamily });`,
      `term.options.fontSize = terminalSettings.fontSize;`,
      `<TerminalPreview fontSize={t.fontSize} />`,
      `// the old call site was <div style={{ fontSize: 12, color: "var(--r)" }}>`,
      `const noted = "fontSize: 12px was the pre-rem shape";`,
      `const settings = {`,
      `  terminal: {`,
      `    clipboardKeys: { ctrlV: false, ctrlC: false },`,
      `    fontSize: 14,`,
      `  },`,
      `};`,
      `style={{ fontFamily: "Geist Mono", fontSize }}`,
    ].join("\n");
    expect(inlinePxFontSizeViolations(tsx)).toEqual([]);
  });

  it("still flags a type-scale fontSize beside a closed terminal settings object", () => {
    const tsx = [
      `const settings = { terminal: { clipboardKeys: { ctrlV: false }, fontSize: 14 } };`,
      `<span style={{ fontSize: 12 }} />`,
    ].join("\n");
    expect(inlinePxFontSizeViolations(tsx)).toEqual([
      "fixture.tsx:2: <span style={{ fontSize: 12 }} />",
    ]);
  });

  it("allows a numeric px fontSize only with the same-line escape marker", () => {
    expect(
      inlinePxFontSizeViolations(
        `<i style={{ fontSize: 12 }} /> {/* font-size-px-ok: not a type scale */}`,
      ),
    ).toEqual([]);
    expect(
      inlinePxFontSizeViolations(`<i style={{ fontSize: 12 }} /> {/* not an escape */}`),
    ).toHaveLength(1);
  });

  it("has no numeric px fontSize left in frontend/src tsx", () => {
    expect(tsxFontSizeViolations()).toEqual([]);
  });
});
