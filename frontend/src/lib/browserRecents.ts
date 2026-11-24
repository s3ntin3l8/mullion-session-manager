import { STORAGE_KEYS, readJSON, writeJSON } from "./persistedState.js";
import type { BrowserMode } from "./browserTitles.js";
import { isHttpAddress, isPreviewProxyAddress } from "./browserHandoff.js";

// #3003 — the Browser pane quick pick's "Recent" group: the addresses this
// browser opened lately, kept per mode, because the two engines see addresses
// differently (an iframe in your own browser, a Chromium on the server; see
// docs/design/one-browser-pane/note.md). Device-local, newest first, capped.
// A preview proxy address is never kept: it is the project's own preview
// (the "Saved" group lists it) and may carry the `__mullion_preview` token.

export const MAX_BROWSER_RECENTS = 8;

type Recents = Partial<Record<BrowserMode, string[]>>;

function readAll(): Recents {
  const raw = readJSON<unknown>(STORAGE_KEYS.browserRecents, {});
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Recents = {};
  for (const mode of ["preview", "agent"] as const) {
    const list = (raw as Record<string, unknown>)[mode];
    if (Array.isArray(list)) {
      out[mode] = list
        .filter((u): u is string => typeof u === "string")
        .slice(0, MAX_BROWSER_RECENTS);
    }
  }
  return out;
}

/** Whether an address belongs in the recent list at all. */
export function isRecordableAddress(url: string): boolean {
  return isHttpAddress(url) && !isPreviewProxyAddress(url);
}

/** The addresses `mode` opened lately, newest first. */
export function readBrowserRecents(mode: BrowserMode): string[] {
  return readAll()[mode] ?? [];
}

/** Puts `url` first in `mode`'s list; a no-op for an address not kept. */
export function recordBrowserRecent(mode: BrowserMode, url: string): void {
  if (!isRecordableAddress(url)) return;
  const all = readAll();
  const list = [url, ...(all[mode] ?? []).filter((u) => u !== url)].slice(0, MAX_BROWSER_RECENTS);
  if (list.join("\n") === (all[mode] ?? []).join("\n")) return;
  writeJSON(STORAGE_KEYS.browserRecents, { ...all, [mode]: list });
}
