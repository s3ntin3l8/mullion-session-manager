// Generic keyboard-chord descriptor: parse/format a human-readable string
// (the form stored in settings and shown in the UI) and match it against a
// live KeyboardEvent. Nothing in this codebase did this generically before
// voice dictation's hotkey became configurable (#1119) — every chord in
// terminalKeys.ts is a hand-written boolean conjunction, and
// useGlobalShortcuts.ts hand-rolls a second, incompatible convention
// (event.key rather than event.code). This module is the one piece the
// terminal handler and the settings UI both build on; don't reintroduce a
// third hand-rolled matcher elsewhere.

export interface KeyChord {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  // Always a KeyboardEvent.code value (e.g. "Space", "KeyV", "Digit1",
  // "Backquote", "F5") — never event.key. code is layout/IME independent,
  // the same property terminalKeys.ts's existing Ctrl+Shift+Space branch
  // was already built on and deliberately preserved here.
  code: string;
}

const MODIFIER_LABELS: Array<[keyof Omit<KeyChord, "code">, string]> = [
  ["ctrl", "Ctrl"],
  ["shift", "Shift"],
  ["alt", "Alt"],
  ["meta", "Meta"],
];

// Single letters/digits are stored as their bare character ("V", "1") for
// readability, but round-trip to the KeyA-Z/Digit0-9 `code` values — every
// other key (Space, Comma, Backquote, F5, Insert, ...) is stored and parsed
// as the `code` verbatim.
function codeToToken(code: string): string {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  return code;
}

function tokenToCode(token: string): string {
  if (/^[A-Za-z]$/.test(token)) return `Key${token.toUpperCase()}`;
  if (/^[0-9]$/.test(token)) return `Digit${token}`;
  return token;
}

/** Canonical storage form, e.g. "Ctrl+Shift+Space". Modifier order is fixed
 * (Ctrl, Shift, Alt, Meta) so two descriptors with the same chord always
 * serialise identically — needed for the `formatChord(a) === formatChord(b)`
 * comparisons validateChord uses against the reserved-chord list below. */
export function formatChord(chord: KeyChord): string {
  const parts: string[] = [];
  for (const [key, label] of MODIFIER_LABELS) {
    if (chord[key]) parts.push(label);
  }
  parts.push(codeToToken(chord.code));
  return parts.join("+");
}

/** Inverse of formatChord. Returns null for an unparseable string (empty,
 * no key token, or a duplicate/unknown modifier name) rather than throwing
 * — callers fall back to a default chord, matching voice.lang's existing
 * "" -> navigator.language convention rather than a hard schema rejection. */
export function parseChord(s: string): KeyChord | null {
  const tokens = s
    .split("+")
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) return null;
  const keyToken = tokens[tokens.length - 1];
  const modifierTokens = tokens.slice(0, -1);
  const chord: KeyChord = { ctrl: false, shift: false, alt: false, meta: false, code: "" };
  for (const token of modifierTokens) {
    const match = MODIFIER_LABELS.find(([, label]) => label.toLowerCase() === token.toLowerCase());
    if (!match) return null;
    const [key] = match;
    if (chord[key]) return null; // duplicate modifier
    chord[key] = true;
  }
  if (!keyToken || /^(ctrl|shift|alt|meta)$/i.test(keyToken)) return null; // bare modifier, no key
  chord.code = tokenToCode(keyToken);
  return chord;
}

/** A human-readable label for display, e.g. "Ctrl + Shift + Space" — same
 * ordering as formatChord but space-padded for the settings-kbd-chip style
 * (modals.css) rather than the compact storage form. */
export function chordLabel(chord: KeyChord): string {
  const parts: string[] = [];
  for (const [key, label] of MODIFIER_LABELS) {
    if (chord[key]) parts.push(label);
  }
  parts.push(codeToToken(chord.code));
  return parts.join(" + ");
}

/** Builds a descriptor from a live keydown, or null if the event doesn't
 * describe a real chord: a bare modifier (the user is still holding Ctrl,
 * hasn't pressed the key yet) or a missing/"Unidentified" code. The latter
 * shows up on some Android/IME keyboards and remote-desktop stacks — without
 * this guard it would round-trip into a KeyChord that matchesChord can never
 * satisfy, i.e. a silently dead hotkey, exactly the failure class #1119
 * exists to remove. */
export function chordFromEvent(event: KeyboardEvent): KeyChord | null {
  if (!event.code || event.code === "Unidentified") return null;
  if (/^(Control|Shift|Alt|Meta)(Left|Right)$/.test(event.code)) return null;
  return {
    ctrl: event.ctrlKey,
    shift: event.shiftKey,
    alt: event.altKey,
    meta: event.metaKey,
    code: event.code,
  };
}

/** Exact modifier equality (not "at least these") — matches how every
 * existing chord branch in terminalKeys.ts spells out its negated
 * modifiers (e.g. `!event.metaKey && !event.altKey`) rather than ignoring
 * them. */
export function matchesChord(event: KeyboardEvent, chord: KeyChord): boolean {
  return (
    event.code === chord.code &&
    event.ctrlKey === chord.ctrl &&
    event.shiftKey === chord.shift &&
    event.altKey === chord.alt &&
    event.metaKey === chord.meta
  );
}

export type ChordValidation = { ok: true } | { ok: false; reason: string };

// All three lists below are written in formatChord's own output form
// (letters/digits as their bare token — "F", "V" — not the raw KeyF/KeyV
// `code`) and compared against formatChord(chord), the single canonical
// serialization, rather than each hand-rolling its own — see that
// function's own doc comment on why two independent "canonical form"
// implementations that must be kept in sync by convention is a drift risk
// worth avoiding.

// Chords the browser owns above the page — preventDefault() in page JS is a
// silent no-op against these, the same class terminalKeys.ts's own Ctrl+F
// (scrollback search is deliberately Ctrl+Shift+F, not bare Ctrl+F, for
// exactly this reason) and Ctrl+Shift+C (DevTools "Inspect Element")
// comments already document.
const BROWSER_RESERVED = [
  "Ctrl+W",
  "Ctrl+T",
  "Ctrl+N",
  "Ctrl+F",
  "Ctrl+Shift+W",
  "Ctrl+Shift+T",
  "Ctrl+Shift+N",
  "Ctrl+Shift+Q",
  "Ctrl+Shift+C",
];

// Chords attachKeyConflictHandler already claims unconditionally, regardless
// of any settings toggle — see terminalKeys.ts's own paste/find/copy
// branches for the rationale behind each. Ctrl+V is here even though its
// terminal-paste use is itself opt-in (settings.terminal.clipboardKeys.
// ctrlV, default off): attachKeyConflictHandler's isPasteChord branch runs
// BEFORE the voice branch, so if a user later turns that setting on while
// voice happens to be bound to Ctrl+V, the voice hotkey would silently stop
// firing with no indication why — the exact silently-dead-hotkey failure
// class #1119 exists to eliminate, just moved from "collides with an
// OS-level app" to "collides with Mullion's own paste handling". Ctrl+C and
// Ctrl+R/L/K are NOT listed here even though they're also conditionally
// claimed: their branches run AFTER voice, so binding voice to one of them
// means voice wins, not that it silently dies.
const ALWAYS_CLAIMED: Array<[string, string]> = [
  ["Ctrl+Shift+F", "the scrollback find bar"],
  ["Ctrl+Insert", "copy"],
  ["Shift+Insert", "paste"],
  ["Meta+V", "paste"],
  ["Ctrl+V", 'paste (if the opt-in "Ctrl+V paste" setting is ever turned on)'],
];

/** Rejects chords that can't work (no modifier) or that collide with
 * something attachKeyConflictHandler already owns unconditionally — either
 * always (ALWAYS_CLAIMED) or at the browser-chrome level, where
 * preventDefault() in page JS is a silent no-op (BROWSER_RESERVED).
 * Ctrl+C/Ctrl+R/L/K are conditionally claimed by other settings but
 * deliberately still allowed through — see ALWAYS_CLAIMED's own comment. */
export function validateChord(chord: KeyChord): ChordValidation {
  if (!chord.ctrl && !chord.shift && !chord.alt && !chord.meta) {
    return { ok: false, reason: "Needs at least one modifier key (Ctrl, Shift, Alt, or Meta)." };
  }
  const canonical = formatChord(chord);
  if (BROWSER_RESERVED.includes(canonical)) {
    return {
      ok: false,
      reason: "This combo is reserved by the browser itself and can't be overridden.",
    };
  }
  const claimed = ALWAYS_CLAIMED.find(([combo]) => combo === canonical);
  if (claimed) {
    return { ok: false, reason: `This combo is already used for ${claimed[1]}.` };
  }
  return { ok: true };
}
