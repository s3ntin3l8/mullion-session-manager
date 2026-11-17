// Issue #3286 — the session row's second line (SessionRow.tsx's
// `.session-meta-line`) always shows the status word, at 10.5px, and often
// over a tinted row: the active row, the hovered active row, an attention
// or a finished row. The raw tone tokens were tuned for the flat sidebar
// and fall under AA's 4.5:1 on those tints (light --g on the hovered active
// row was 3.42:1, dark --r on the attention row 3.41:1), so sidebar.css
// mixes each tone toward --fg for this line. This pins that every tone, as
// the stylesheet writes it, clears 4.5:1 on every row tint in both themes.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contrast, over, parseColor } from "../../scripts/lib/color-math.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const STYLES_DIR = path.join(REPO_ROOT, "frontend", "src", "styles");
const SIDEBAR_CSS = fs.readFileSync(path.join(STYLES_DIR, "sidebar.css"), "utf8");
const TOKENS_CSS = fs.readFileSync(path.join(STYLES_DIR, "tokens.css"), "utf8");

const AA_TEXT = 4.5;

// Every tone SessionRow can paint the status word in that is not --dim
// (idle, exited and suspended are --dim already and pass on their own).
const TONES = ["attention", "working", "error", "plan", "permission", "finished"] as const;

type Rgb = { r: number; g: number; b: number; a: number };

function themeTokens(selector: string): Record<string, string> {
  const start = TOKENS_CSS.indexOf(selector);
  if (start === -1) throw new Error(`missing ${selector} in tokens.css`);
  const open = TOKENS_CSS.indexOf("{", start);
  const close = TOKENS_CSS.indexOf("\n}", open);
  const block = TOKENS_CSS.slice(open + 1, close);
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\b/g)) out[m[1]] = m[2];
  return out;
}

function hex(value: string): Rgb {
  const c = parseColor(`rgb(${[1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16))})`);
  if (!c) throw new Error(`not a colour: ${value}`);
  return c;
}

/** `color-mix(in srgb, A p%, B)`, opaque inputs. */
function mix(a: Rgb, b: Rgb, p: number): Rgb {
  return {
    r: a.r * p + b.r * (1 - p),
    g: a.g * p + b.g * (1 - p),
    b: a.b * p + b.b * (1 - p),
    a: 1,
  };
}

/** A translucent `color-mix(in srgb, X p%, transparent)` tint over `base`. */
function tint(color: Rgb, p: number, base: Rgb): Rgb {
  return over({ ...color, a: p }, base);
}

/** The colour sidebar.css gives the meta line's status word for one tone. */
function metaToneRule(tone: string): { token: string; pct: number; toward: string } {
  const re = new RegExp(
    `\\.session-meta-line > \\.session-status-label\\.${tone}\\s*\\{\\s*color:\\s*color-mix\\(in srgb, var\\(--([\\w-]+)\\) (\\d+)%, var\\(--([\\w-]+)\\)\\);`,
  );
  const m = re.exec(SIDEBAR_CSS);
  if (!m) throw new Error(`sidebar.css has no meta-line colour for .${tone}`);
  return { token: m[1], pct: Number(m[2]) / 100, toward: m[3] };
}

describe("session meta line status word contrast (#3286)", () => {
  for (const theme of [
    { name: "dark", selector: ".cmux-root {" },
    { name: "light", selector: ".cmux-root.light {" },
  ]) {
    const t = themeTokens(theme.selector);
    const sidebar = hex(t.sidebar);
    const fg = hex(t.fg);
    // The row tints sidebar.css paints under the line (`.session-item.active`
    // 9% --fg, plus the hover 6% over it; attention and finished at their
    // hovered 18%).
    const backgrounds = {
      flat: sidebar,
      "active, hovered": tint(fg, 0.06, tint(fg, 0.09, sidebar)),
      "attention, hovered": tint(hex(t.ring), 0.18, sidebar),
      "finished, hovered": tint(hex(t.c), 0.18, sidebar),
    };

    for (const tone of TONES) {
      it(`${theme.name}: .${tone} clears ${AA_TEXT}:1 on every row tint`, () => {
        const rule = metaToneRule(tone);
        expect(rule.toward).toBe("fg");
        const color = mix(hex(t[rule.token]), hex(t[rule.toward]), rule.pct);
        for (const [where, bg] of Object.entries(backgrounds)) {
          const ratio = contrast(color, bg);
          expect(ratio, `${theme.name} .${tone} on ${where}`).toBeGreaterThanOrEqual(AA_TEXT);
        }
      });
    }
  }

  it("documents that the raw tone tokens fail there, which is why the mix exists", () => {
    const t = themeTokens(".cmux-root.light {");
    const sidebar = hex(t.sidebar);
    const fg = hex(t.fg);
    const activeHovered = tint(fg, 0.06, tint(fg, 0.09, sidebar));
    expect(contrast(hex(t.g), activeHovered)).toBeLessThan(AA_TEXT);
  });
});
