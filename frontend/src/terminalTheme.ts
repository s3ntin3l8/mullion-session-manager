import type { ITheme } from "@xterm/xterm";
import { getTerminalScheme } from "./terminalSchemes.js";

// xterm's `theme` option is passed straight to the renderer (canvas fillStyle
// for the DOM renderer, a texture atlas for the WebGL renderer) — every
// color has to be a literal, not a CSS custom property.
//
// Previously this derived colors from the app's dark/light CSS variables
// (getComputedStyle on `--term`/`--fg`/etc.). The Settings rework makes
// terminal color entirely scheme-driven instead (Appearance -> Color
// scheme's 6 swatches) and deliberately decoupled from the app chrome's own
// dark/light theme — see the plan's "color schemes recolor the terminal
// only" decision. So this now takes just a scheme id and needs no DOM
// access at all.
//
// All 6 schemes are dark-background palettes (this is a terminal palette
// picker, not a light-mode terminal), so black/white/bright-black/
// bright-white are shared literals rather than derived per scheme — mirrors
// the values the old dark-theme branch used. Bright ANSI colors are a
// simple programmatic lighten of each scheme's base color: none of the
// reference's 6 palettes specify bright variants (its preview only uses 8
// colors), so this is the closest reasonable approximation rather than a
// byte-exact port.
function lighten(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.round(((n >> 16) & 0xff) + 255 * amount));
  const g = Math.min(255, Math.round(((n >> 8) & 0xff) + 255 * amount));
  const b = Math.min(255, Math.round((n & 0xff) + 255 * amount));
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

export function buildXtermTheme(schemeId: string): ITheme {
  const scheme = getTerminalScheme(schemeId);

  return {
    background: scheme.bg,
    foreground: scheme.fg,
    cursor: scheme.fg,
    cursorAccent: scheme.bg,
    selectionBackground: `${scheme.blue}4D`,
    black: "#1c1c1e",
    red: scheme.red,
    green: scheme.green,
    yellow: scheme.yellow,
    blue: scheme.blue,
    magenta: scheme.magenta,
    cyan: scheme.cyan,
    white: "#c7c7cc",
    brightBlack: "#666670",
    brightRed: lighten(scheme.red, 0.2),
    brightGreen: lighten(scheme.green, 0.2),
    brightYellow: lighten(scheme.yellow, 0.2),
    brightBlue: lighten(scheme.blue, 0.2),
    brightMagenta: lighten(scheme.magenta, 0.2),
    brightCyan: lighten(scheme.cyan, 0.2),
    brightWhite: "#ffffff",
  };
}
