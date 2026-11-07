import type { Theme } from "./types.js";

// The class every themed surface must carry, and the one that carries the
// palette's CSS custom properties (`--fg`, `--bg`, `--border`, ...).
const THEME_ROOT_CLASS = "cmux-root";

// The light-theme companion class. `.cmux-root.light` is the selector the
// token files key the light palette on (see styles/tokens.css) — the class
// is only meaningful next to `cmux-root`.
const THEME_LIGHT_CLASS = "light";

// Anything a caller may want to append. `false`/`null`/`undefined` are
// dropped, so a call site can pass a conditional class inline
// (`sidebarOpen && "sb-open"`) without building a string first.
export type ThemeClassExtra = string | false | null | undefined;

// Builds the class list for a surface that has to carry the theme itself.
//
// Anything portaled to `document.body` leaves the app's own `.cmux-root`
// subtree, so it has to re-apply the theme classes — without `light` the
// CSS custom properties are undefined and the surface renders transparent.
// That is exactly the bug fixed for tooltips in #2513 (`TooltipBubble`).
//
// The expression was hand-copied at eight call sites, so the next portal can
// forget it the same way. This is the one place that spells it out.
//
// `theme` is the *resolved* theme (`"dark" | "light"`), never the
// `"system"` preference — callers read the store's resolved `theme`, or
// resolve the preference themselves (see `resolveTheme()` in helpers.ts).
export function themeClassName(theme: Theme, ...extra: ThemeClassExtra[]): string {
  const classes = [THEME_ROOT_CLASS];
  if (theme === "light") classes.push(THEME_LIGHT_CLASS);
  for (const cls of extra) {
    if (cls) classes.push(cls);
  }
  return classes.join(" ");
}
