// Only rewrites scheme names literally ending in " Dark" (Mullion Dark, One Dark).
// Theme-neutral names like "Solarized", "Dracula", "Gruvbox", "Tokyo Night" are
// intentionally unchanged — they carry no dark/light bias in their base name.
import type { Theme } from "../store.js";

const DARK_SUFFIX_RE = /^(.*)\s+Dark$/;

export function schemeLabel(name: string, theme: Theme): string {
  if (theme === "light") {
    const m = DARK_SUFFIX_RE.exec(name);
    if (m) return `${m[1]} Light`;
  }
  return name;
}
