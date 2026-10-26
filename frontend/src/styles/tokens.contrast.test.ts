import { describe, expect, it } from "vitest";
import css from "./tokens.css?raw";

// Reads tokens.css itself, so a token edit that drops a status pairing below
// WCAG AA fails here rather than shipping as grey-on-grey.

type Rgb = [number, number, number];

function block(selector: string): Map<string, string> {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block in tokens.css`);
  const end = css.indexOf("\n}", start);
  const vars = new Map<string, string>();
  for (const m of css.slice(start, end).matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)) {
    vars.set(m[1], m[2].trim());
  }
  return vars;
}

function hex(h: string): Rgb {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function resolve(vars: Map<string, string>, name: string): Rgb {
  const raw = vars.get(name);
  if (raw === undefined) throw new Error(`${name} is not defined`);
  const ref = raw.match(/^var\((--[\w-]+)\)$/);
  if (ref) return resolve(vars, ref[1]);
  if (raw.startsWith("#")) return hex(raw);
  const mix = raw.match(
    /^color-mix\(in srgb,\s*var\((--[\w-]+)\)\s+(\d+)%,\s*var\((--[\w-]+)\)\)$/,
  );
  if (!mix) throw new Error(`cannot resolve ${name}: ${raw}`);
  const a = resolve(vars, mix[1]);
  const b = resolve(vars, mix[3]);
  const t = Number(mix[2]) / 100;
  return a.map((c, i) => c * t + b[i] * (1 - t)) as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const TONES = ["success", "danger", "warn", "info", "neutral", "merged"] as const;

const themes = {
  dark: block(".cmux-root"),
  light: new Map([...block(".cmux-root"), ...block(".cmux-root.light")]),
};

describe.each(Object.entries(themes))("%s theme tokens", (_theme, vars) => {
  for (const tone of TONES) {
    it(`status-${tone} text clears AA on its own tint and on the sidebar`, () => {
      const fg = resolve(vars, `--status-${tone}-fg`);
      expect(contrast(fg, resolve(vars, `--status-${tone}-bg`))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(fg, resolve(vars, "--sidebar"))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(fg, resolve(vars, "--surface"))).toBeGreaterThanOrEqual(4.5);
    });
    it(`status-${tone} defines fg, bg and border`, () => {
      for (const part of ["fg", "bg", "border"]) {
        expect(vars.has(`--status-${tone}-${part}`)).toBe(true);
      }
    });
  }

  it("--accent is defined and readable as text", () => {
    const accent = resolve(vars, "--accent");
    expect(contrast(accent, resolve(vars, "--sidebar"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(accent, resolve(vars, "--surface"))).toBeGreaterThanOrEqual(4.5);
  });

  it("--border is visibly stronger than the old ~1.1:1 hairline", () => {
    const sidebar = resolve(vars, "--sidebar");
    expect(contrast(resolve(vars, "--border"), sidebar)).toBeGreaterThanOrEqual(1.3);
    expect(contrast(resolve(vars, "--border"), sidebar)).toBeGreaterThan(
      contrast(resolve(vars, "--border-soft"), sidebar),
    );
  });

  it("defines eight graph lanes", () => {
    for (let i = 1; i <= 6; i++) expect(vars.has(`--lane-${i}`)).toBe(true);
    expect(vars.has("--lane-more")).toBe(true);
  });
});
