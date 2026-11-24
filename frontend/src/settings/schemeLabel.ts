// Only rewrites scheme names literally ending in " Dark" (Mullion Dark, One Dark).
// ResolvedTheme-neutral names like "Solarized", "Dracula", "Gruvbox", "Tokyo Night" are
// intentionally unchanged — they carry no dark/light bias in their base name.
import type { ResolvedTheme } from "../store/index.js";

const DARK_SUFFIX_RE = /^(.*)\s+Dark$/;

export function schemeLabel(name: string, theme: ResolvedTheme): string {
  if (theme === "light") {
    const m = DARK_SUFFIX_RE.exec(name);
    if (m) return `${m[1]} Light`;
  }
  return name;
}
