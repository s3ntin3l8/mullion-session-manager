import { describe, expect, it } from "vitest";

// import.meta.glob rather than node:fs: tsconfig.app.json is a browser-only
// type universe (same pattern as primitives.a11y.test.tsx).
const sources = import.meta.glob("./tokens.css", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;
const css = sources["./tokens.css"];

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

// `color-mix(in srgb, A P%, B)` the same way resolve() reads a token.
// A transparent tint over a surface composites to this mix.
function tint(color: Rgb, surface: Rgb, percent: number): Rgb {
  const t = percent / 100;
  return color.map((c, i) => c * t + surface[i] * (1 - t)) as Rgb;
}

const TONES = ["success", "danger", "warn", "info", "neutral", "merged"] as const;

// Every text role styles/motion.css remaps inside material (#3038).
const MATERIAL_TEXT = [
  "--muted",
  "--dim",
  "--accent",
  "--accent-solid",
  "--ring",
  "--r",
  "--g",
  "--b",
  "--c",
  "--y",
  "--p",
  "--o",
  ...TONES.map((t) => `--status-${t}-fg`),
];

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

  // #1981 — --y is 10px/9.5px warning copy, so it has the text-role bar,
  // not the 3:1 a status dot would get. Flat surfaces only; the self-tint
  // case below is separate because neither this list nor the lint guard
  // can see a color-mix composite.
  it("--y warning text clears AA on the flat surfaces that copy sits on", () => {
    const y = resolve(vars, "--y");
    for (const surface of ["--sidebar", "--surface", "--surface-hover", "--pane-hd", "--chrome"]) {
      expect(contrast(y, resolve(vars, surface)), `--y on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  // Badges paint `color-mix(in srgb, var(--y) N%, transparent)` over the
  // sidebar: in-progress/reviewing at 16%, the blocked-column count at 14%.
  // That composite is darker than the flat sidebar, so it is the tight case.
  it("--y warning text clears AA on its own tint over the sidebar", () => {
    const y = resolve(vars, "--y");
    const sidebar = resolve(vars, "--sidebar");
    for (const percent of [16, 14]) {
      expect(
        contrast(y, tint(y, sidebar, percent)),
        `--y on color-mix(in srgb, var(--y) ${percent}%, var(--sidebar))`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  // Kit rows paint on --surface-hover (hover/selected), headers on --pane-hd.
  for (const surface of ["--surface", "--surface-hover", "--pane-hd"]) {
    it(`--muted, --dim and status text clear AA on ${surface}`, () => {
      const bg = resolve(vars, surface);
      for (const fg of ["--fg", "--muted", "--dim", ...TONES.map((t) => `--status-${t}-fg`)]) {
        expect(contrast(resolve(vars, fg), bg), `${fg} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  // #3045/#3055 — rows paint a --seg hover tint of --fg over the sidebar, and
  // some stack a second one (a workspace section header's 5% under its
  // button's --seg). --dim and --muted were 3.58:1 / 3.87:1 on that stack, the
  // root of every "--dim below 4.5" finding verify-ui's C3 reported.
  it("--dim and --muted clear AA on a hover tint, and on two stacked", () => {
    const fg = resolve(vars, "--fg");
    const sidebar = resolve(vars, "--sidebar");
    const seg = Number(vars.get("--seg")!.match(/(\d+)%/)![1]);
    const hovered = tint(fg, sidebar, seg);
    const stacked = tint(fg, tint(fg, sidebar, 5), seg);
    for (const [label, bg] of [
      ["--seg over --sidebar", hovered],
      ["--seg over a 5% header hover", stacked],
    ] as const) {
      for (const name of ["--dim", "--muted"]) {
        expect(contrast(resolve(vars, name), bg), `${name} on ${label}`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    }
  });

  it("--muted stays a step stronger than --dim", () => {
    const sidebar = resolve(vars, "--sidebar");
    expect(contrast(resolve(vars, "--muted"), sidebar)).toBeGreaterThan(
      contrast(resolve(vars, "--dim"), sidebar) + 0.5,
    );
  });

  it("--border is visibly stronger than the old ~1.1:1 hairline", () => {
    const sidebar = resolve(vars, "--sidebar");
    expect(contrast(resolve(vars, "--border"), sidebar)).toBeGreaterThanOrEqual(1.3);
    expect(contrast(resolve(vars, "--border"), sidebar)).toBeGreaterThan(
      contrast(resolve(vars, "--border-soft"), sidebar),
    );
  });

  // #3015/#3038 — sheets and popovers are a translucent layer (--material)
  // over whatever is behind them: a white web preview under the dark theme, a
  // black terminal under the light one. Compositing is monotone, so pure white
  // and pure black are the worst backdrops (blur and saturation stay inside
  // that range). Inside material every text role is remapped to its
  // --material-* value (styles/motion.css), and each of those must clear AA
  // over material on either backdrop.
  const materialPercent = () => {
    const raw = vars.get("--material") ?? "";
    const m = raw.match(/^color-mix\(in srgb,\s*var\(--term\)\s+(\d+)%,\s*transparent\)$/);
    expect(m, `--material is a translucent mix of --term: ${raw}`).not.toBeNull();
    return Number(m![1]);
  };
  const materialSurfaces = () => {
    const term = resolve(vars, "--term");
    const percent = materialPercent();
    return [
      ["white", tint(term, [255, 255, 255], percent)],
      ["black", tint(term, [0, 0, 0], percent)],
    ] as const;
  };

  it("material is visibly translucent, and stays a sheet rather than a tint", () => {
    const percent = materialPercent();
    expect(percent).toBeLessThan(100);
    expect(percent).toBeGreaterThanOrEqual(80);
  });

  it.each(MATERIAL_TEXT)("%s on material clears AA over a white or a black backdrop", (name) => {
    const fg = resolve(vars, `--material-${name.slice(2)}`);
    for (const [backdrop, surface] of materialSurfaces()) {
      expect(contrast(fg, surface), `${name} on material over ${backdrop}`).toBeGreaterThanOrEqual(
        4.5,
      );
    }
    // Reduced transparency paints solid --chrome under the same remap.
    expect(contrast(fg, resolve(vars, "--chrome")), `${name} on --chrome`).toBeGreaterThanOrEqual(
      4.5,
    );
  });

  it("--fg needs no material value: it clears AA on material as it is", () => {
    for (const [backdrop, surface] of materialSurfaces()) {
      expect(
        contrast(resolve(vars, "--fg"), surface),
        `--fg over ${backdrop}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  // Rows inside sheets and popovers paint the same --seg hover/selected tint
  // as the sidebar, so the two grey text roles hold on that too.
  it("--dim and --muted on material clear AA under a --seg tint", () => {
    const fg = resolve(vars, "--fg");
    const seg = Number(vars.get("--seg")!.match(/(\d+)%/)![1]);
    for (const [backdrop, surface] of materialSurfaces()) {
      for (const name of ["--dim", "--muted"]) {
        expect(
          contrast(resolve(vars, `--material-${name.slice(2)}`), tint(fg, surface, seg)),
          `${name} on --seg over material over ${backdrop}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  for (const tone of TONES) {
    it(`material status-${tone} text still clears AA on its own tint`, () => {
      const fg = resolve(vars, `--material-status-${tone}-fg`);
      expect(contrast(fg, resolve(vars, `--status-${tone}-bg`))).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("defines eight graph lanes", () => {
    for (let i = 1; i <= 6; i++) expect(vars.has(`--lane-${i}`)).toBe(true);
    expect(vars.has("--lane-more")).toBe(true);
  });
});

// The light map above inherits the dark block, so a material value the light
// block forgot would be tested with the dark hex. Each theme defines its own.
describe("material text tokens", () => {
  it.each([".cmux-root", ".cmux-root.light"])("are all defined in %s itself", (selector) => {
    const own = block(selector);
    for (const name of MATERIAL_TEXT) {
      expect(own.has(`--material-${name.slice(2)}`), `--material-${name.slice(2)}`).toBe(true);
    }
  });
});

// The tokens above only help if material actually uses them.
const motionSources = import.meta.glob("./motion.css", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

describe("styles/motion.css remaps text inside material", () => {
  const motion = motionSources["./motion.css"].replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = [...motion.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(
    ([, selector]) =>
      selector.includes(".cmux-root .mobile-session-sheet") &&
      selector.includes(".cmux-root.pane-tab-overflow-menu"),
  );

  it("on sheets and on popovers that are their own theme root", () => {
    expect(rule, "a .cmux-root-scoped remap rule for sheets and popovers").toBeDefined();
  });

  it.each(MATERIAL_TEXT)("%s", (name) => {
    expect(rule![2]).toContain(`${name}: var(--material-${name.slice(2)});`);
  });
});
