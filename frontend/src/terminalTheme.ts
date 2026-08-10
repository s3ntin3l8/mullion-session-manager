import type { ITheme } from "@xterm/xterm";
import type { ISearchDecorationOptions } from "@xterm/addon-search";
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

// Medium-gray, readable on both a dark and a light background as-is — the
// one ANSI color that intentionally does NOT change between themes (see the
// file-level comment above). Exported (rather than a private magic string)
// so terminalTheme.test.ts's assertions reference the same value instead of
// duplicating the literal.
export const BRIGHT_BLACK = "#666670";

// The dark/light background pick, factored out so callers that only need a
// background color (e.g. App.tsx's dockview-chrome sync, issue #132) don't
// have to duplicate this ternary or build a full ITheme just to read
// `.background` off it.
export function getSchemeBackground(schemeId: string, theme: "dark" | "light" = "dark"): string {
  const scheme = getTerminalScheme(schemeId);
  return theme === "light" ? scheme.bgLight : scheme.bg;
}

export function buildXtermTheme(schemeId: string, theme: "dark" | "light" = "dark"): ITheme {
  const scheme = getTerminalScheme(schemeId);
  const bg = getSchemeBackground(schemeId, theme);
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
    brightBlack: BRIGHT_BLACK,
    brightRed: intensify(scheme.red, 0.2),
    brightGreen: intensify(scheme.green, 0.2),
    brightYellow: intensify(scheme.yellow, 0.2),
    brightBlue: intensify(scheme.blue, 0.2),
    brightMagenta: intensify(scheme.magenta, 0.2),
    brightCyan: intensify(scheme.cyan, 0.2),
    brightWhite: isLight ? fg : "#ffffff",
  };
}

// Search-match highlight colors for @xterm/addon-search's `decorations`
// option (terminal scrollback search, U1) — same reasoning as
// buildXtermTheme above: the addon wants literal #RRGGBB values, not CSS
// custom properties, so this reads from the terminal's own scheme (not the
// app chrome's --fg/--bg tokens) so a highlight reads correctly against
// every one of the six schemes rather than being tuned for just one.
//
// All (non-active) matches are built from the scheme's own yellow — the
// conventional "search hit" color across editors/terminals, and already
// part of every scheme's palette, so there's no extra color to keep in sync
// as schemes are added or edited. The *active* match is built from the
// scheme's blue rather than a brighter/bolder yellow: a hue change reads as
// "this is the current one" at a glance even for users who can't reliably
// distinguish two shades of the same hue, which a mere intensity/lightness
// difference would rely on.
//
// Unlike buildXtermTheme's ANSI colors, the *fill* backgrounds here can't
// stay theme-invariant: the addon's decorations paint a background behind
// the terminal's own already-colored text (there's no `foregroundColor` in
// ISearchDecorationOptions — see DecorationManager in @xterm/addon-search),
// so a mid-lightness accent straight from the scheme reads fine as an ANSI
// *foreground* color but is often poor contrast as a *fill* behind that same
// scheme's near-white dark-mode text (or near-black light-mode text) sitting
// on top of it unchanged. `forFill` below is buildXtermTheme's `intensify`
// with the direction flipped: `intensify` pushes a color away from its own
// theme's background to make an accent stand out against it; a decoration
// fill instead needs to move *toward* contrast with the terminal's
// foreground *text*, which is roughly the opposite lightness direction (dark
// theme -> near-white text -> darken the fill; light theme -> near-black
// text -> lighten the fill). This is a flat programmatic shift, the same
// rigor as `intensify` above (not a full WCAG-contrast solver per scheme) —
// it clears comfortable contrast for most scheme/theme pairs but a couple of
// the lower-contrast palettes (e.g. Solarized, whose light-mode foreground
// is a muted gray rather than true black) may still read as a soft rather
// than a punchy highlight. Only the *fill* backgrounds get this treatment;
// the border/overview-ruler colors stay the plain accent — a 1px outline
// doesn't sit under glyph pixels the way a full-cell fill does, so it can
// stay at full saturation for a crisper marker without the same legibility
// risk.
export function buildSearchDecorations(
  schemeId: string,
  theme: "dark" | "light" = "dark",
): ISearchDecorationOptions {
  const scheme = getTerminalScheme(schemeId);
  const isLight = theme === "light";
  const forFill = isLight ? lighten : darken;
  return {
    matchBackground: forFill(scheme.yellow, 0.3),
    matchBorder: scheme.yellow,
    matchOverviewRuler: scheme.yellow,
    activeMatchBackground: forFill(scheme.blue, 0.3),
    activeMatchBorder: scheme.blue,
    activeMatchColorOverviewRuler: scheme.blue,
  };
}
