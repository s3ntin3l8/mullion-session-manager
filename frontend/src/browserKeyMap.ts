// Cmd→Ctrl chord mapping for BrowserPane (#1503). The streamed page lives in
// headless *Linux* Chromium, where Meta+A / Meta+Z / ... are not editing
// shortcuts, so a macOS client's Cmd chords would otherwise do nothing.
// The mapping lives here in the client rather than in routes/browser.ts's
// dispatchInput: only the client knows it's on macOS, and the server can't
// tell a Cmd key from a real Win/Meta key on another platform.

export function isMacPlatform(nav: Navigator = navigator): boolean {
  const uaData = (nav as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  // iPadOS in desktop mode reports "MacIntel" and its Cmd key behaves the
  // same way, so a plain /^mac/ match is right for both.
  const platform = uaData?.platform || nav.platform || "";
  return /^mac/i.test(platform);
}

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock"]);

// Cmd+arrow/backspace have no 1:1 Ctrl equivalent on Linux: Ctrl+Left/Right
// jump a *word*, while Cmd+Left/Right go to the line start/end (Home/End).
// Cmd+Backspace deletes to line start on macOS; Ctrl+Backspace deletes the
// previous word on Linux — the closest cheap equivalent, an approximation.
const MAPPED_KEYS: Record<string, string> = {
  ArrowLeft: "Home",
  ArrowRight: "End",
  ArrowUp: "Control+Home",
  ArrowDown: "Control+End",
  Backspace: "Control+Backspace",
};

interface KeyEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

/**
 * For a macOS client's keydown with Cmd held, the key string to send as a
 * server-side `press` (a self-contained chord), or null when the event isn't
 * a Cmd chord this mapping handles and should be forwarded as-is.
 *
 * The Cmd (Meta) keydown itself is never forwarded on a macOS client (the
 * caller swallows it), so Playwright never has Control or Meta held — each
 * chord is one atomic `press`, which can't leave a modifier stuck down. Shift
 * is deliberately NOT included in the chord string: the client already
 * forwarded the real Shift keydown, so Playwright has it held, and a chord
 * naming Shift again would release it on completion (the same desync class as
 * #1491).
 */
export function macChordPress(event: KeyEventLike): string | null {
  if (!event.metaKey || event.ctrlKey || event.altKey) return null;
  if (MODIFIER_KEYS.has(event.key)) return null;
  const mapped = MAPPED_KEYS[event.key];
  if (mapped) return mapped;
  // Single characters go out lowercase: with Shift already held in
  // Playwright, Cmd+Shift+Z becomes Ctrl+Shift+z, not a doubly-shifted key.
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  return `Control+${key}`;
}
