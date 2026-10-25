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
// A declaration that truly cannot be rem may keep px with a same-line
// `font-size-px-ok` marker. Nothing in frontend/src/styles needs one: the
// terminal grid's size is a number passed to xterm, not a stylesheet rule.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const STYLES_DIR = path.join(REPO_ROOT, "frontend", "src", "styles");

const ESCAPE = "font-size-px-ok";

// The character before `font` must not be a word char or a hyphen, so
// `font-size` / `font-family` are not read as the `font` shorthand.
const FONT_SIZE_PX = /(?:^|[^\w-])font-size\s*:\s*[^;{}]*?\d+(?:\.\d+)?px\b/gi;
const FONT_SHORTHAND_PX = /(?:^|[^\w-])font\s*:\s*[^;{}]*?\d+(?:\.\d+)?px\b/gi;

function lineNumberAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

/** px font-size declarations in one stylesheet. Empty when the file is clean. */
function pxFontSizeViolations(source: string, file = "fixture.css"): string[] {
  const lines = source.split("\n");
  const found: string[] = [];
  for (const pattern of [FONT_SIZE_PX, FONT_SHORTHAND_PX]) {
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

function stylesheetViolations(): string[] {
  const out: string[] = [];
  const files = fs.readdirSync(STYLES_DIR).filter((name) => name.endsWith(".css"));
  for (const name of files) {
    const full = path.join(STYLES_DIR, name);
    const source = fs.readFileSync(full, "utf8");
    out.push(...pxFontSizeViolations(source, path.posix.join("frontend/src/styles", name)));
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
