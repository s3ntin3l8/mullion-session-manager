import type { ITheme } from "@xterm/xterm";
import { getTerminalScheme } from "./terminalSchemes.js";

// xterm's `theme` option is passed straight to the renderer (canvas fillStyle
// for the DOM renderer, a texture atlas for the WebGL renderer) — every
// color has to be a literal, not a CSS custom property.
//
// Each scheme carries both dark and light bg/fg values (see terminalSchemes.ts).
// When `theme` is "light" the scheme's bgLight/fgLight are used for background,
// foreground, cursor, and cursorAccent; the ANSI color palette stays the same
// across themes except for black and white (colors 0 and 7), which swap so
// that ANSI white text remains readable on a light background. brightBlack
// (color 8) stays medium-gray, readable on both backgrounds as-is; brightWhite
// (color 15) resolves to the scheme's foreground in light mode instead of
// staying pure white, which would be nearly invisible on a light background.
//
// Bright ANSI colors are a simple programmatic lighten/darken of each
// scheme's base color: none of the reference's 6 palettes specify bright
// variants (its preview only uses 8 colors), so this is the closest
// reasonable approximation rather than a byte-exact port. "Bright" means
// emphasized, not literally lighter — on a dark background that's lighter,
// but on a light background the same treatment washes out, so bright colors
// are darkened instead when the theme is light.
function lighten(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.round(((n >> 16) & 0xff) + 255 * amount));
  const g = Math.min(255, Math.round(((n >> 8) & 0xff) + 255 * amount));
  const b = Math.min(255, Math.round((n & 0xff) + 255 * amount));
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

function darken(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.round(((n >> 16) & 0xff) - 255 * amount));
  const g = Math.max(0, Math.round(((n >> 8) & 0xff) - 255 * amount));
  const b = Math.max(0, Math.round((n & 0xff) - 255 * amount));
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

export function buildXtermTheme(schemeId: string, theme: "dark" | "light" = "dark"): ITheme {
  const scheme = getTerminalScheme(schemeId);
  const bg = theme === "light" ? scheme.bgLight : scheme.bg;
  const fg = theme === "light" ? scheme.fgLight : scheme.fg;
  const isLight = theme === "light";
  // On a dark background "bright" means lighter; on a light background the
  // same treatment washes out, so bright colors darken instead.
  const intensify = isLight ? darken : lighten;

  return {
    background: bg,
    foreground: fg,
    cursor: fg,
    cursorAccent: bg,
    selectionBackground: `${scheme.blue}4D`,
    // In light mode ANSI black/white swap so white text (color 7) stays
    // readable on a light background. brightBlack (8) stays medium-gray,
    // visible on both backgrounds; brightWhite (15) resolves to `fg` in
    // light mode instead of pure white (see darken() comment above).
    black: isLight ? "#c7c7cc" : "#1c1c1e",
    red: scheme.red,
    green: scheme.green,
    yellow: scheme.yellow,
    blue: scheme.blue,
    magenta: scheme.magenta,
    cyan: scheme.cyan,
    white: isLight ? "#1c1c1e" : "#c7c7cc",
    brightBlack: "#666670",
    brightRed: intensify(scheme.red, 0.2),
    brightGreen: intensify(scheme.green, 0.2),
    brightYellow: intensify(scheme.yellow, 0.2),
    brightBlue: intensify(scheme.blue, 0.2),
    brightMagenta: intensify(scheme.magenta, 0.2),
    brightCyan: intensify(scheme.cyan, 0.2),
    brightWhite: isLight ? fg : "#ffffff",
  };
}
