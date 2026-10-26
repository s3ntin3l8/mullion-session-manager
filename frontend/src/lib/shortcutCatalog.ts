import { chordLabel, matchesChord, parseChord } from "./keyChord.js";
import type { KeyChord } from "./keyChord.js";
import { DEFAULT_VOICE_CHORD } from "../api/index.js";

// The cheat sheet and the key listeners have to share one definition of
// each chord. useGlobalShortcuts.ts and attachKeyConflictHandler used to
// spell the same booleans out inline, and a Settings screen that copied
// those chords as text would drift the first time someone retuned a
// matcher. Labels below are formatted from the binding the matcher reads,
// not written next to it.
//
// The bindings stay in two shapes on purpose. Global shortcuts accept
// Ctrl or Cmd and, for the palette and Settings, do not consult Shift or
// Alt at all — tightening that would stop Ctrl+Shift+K opening the
// palette, which the old matcher allowed. The right-sidebar chord matches
// event.code because Option+B types a different event.key on macOS.
// Terminal find and copy match event.key with exact modifier equality
// (that is what the xterm handler did, and what its tests fire). Voice is
// a settings-stored KeyChord, matched by keyChord.ts, because the user
// can rebind it. Folding all of that into matchesChord would change which
// events fire.

export type ShortcutScope = "app" | "terminal";

/** How an extra modifier participates. "ignore" means the old matcher
 * never looked at it, so holding it still matches. */
type ModifierRole = "require" | "ignore" | "forbid";

export type ShortcutBinding =
  | {
      kind: "either-mod";
      /** Compared with event.key. Absent when `code` is what matches. */
      key?: string;
      /** Compared with event.code. Option+letter chords need this —
       * event.key is the typed character, which is not "b". */
      code?: string;
      /** ⌘K accepts "K" and "k". A comma has no case to fold. */
      ignoreCase?: boolean;
      alt: ModifierRole;
      shift: ModifierRole;
    }
  | {
      kind: "exact-key";
      /** Compared with event.key, case-insensitively — the xterm handler
       * lowercased event.key before comparing. */
      key: string;
      ctrl: boolean;
      shift: boolean;
      alt: boolean;
      meta: boolean;
    }
  | {
      /** event.key equality. Modifiers are not consulted: Escape closes
       * overlays however it was typed. */
      kind: "bare-key";
      key: string;
    }
  | {
      /** The dictation hotkey. The chord is terminal.voice.hotkey, not a
       * constant here — this entry only says "match the chord the listener
       * was given", so a rebind updates the sheet and the handler together. */
      kind: "voice";
    };

export interface ShortcutDefinition {
  id: string;
  /** Visible name in the cheat sheet. */
  action: string;
  /** One sentence under the action. */
  detail: string;
  scope: ShortcutScope;
  binding: ShortcutBinding;
}

function modifierOk(role: ModifierRole, held: boolean): boolean {
  if (role === "ignore") return true;
  if (role === "require") return held;
  return !held;
}

/** True when this keydown is that shortcut. `voiceChord` is only read for
 * the voice entry; pass null when dictation's hotkey is off so the entry
 * cannot match, which is the same gate getVoiceChord already applied. */
export function matchShortcut(
  shortcut: ShortcutDefinition,
  event: KeyboardEvent,
  voiceChord?: KeyChord | null,
): boolean {
  const binding = shortcut.binding;
  switch (binding.kind) {
    case "either-mod": {
      // Ctrl and Cmd are alternatives, and holding both still counts —
      // the old check was `metaKey || ctrlKey`, not exclusive-or.
      if (!(event.metaKey || event.ctrlKey)) return false;
      if (!modifierOk(binding.alt, event.altKey)) return false;
      if (!modifierOk(binding.shift, event.shiftKey)) return false;
      if (binding.code) return event.code === binding.code;
      if (binding.key === undefined) return false;
      const actual = binding.ignoreCase ? event.key.toLowerCase() : event.key;
      const expected = binding.ignoreCase ? binding.key.toLowerCase() : binding.key;
      return actual === expected;
    }
    case "exact-key":
      return (
        event.key.toLowerCase() === binding.key.toLowerCase() &&
        event.ctrlKey === binding.ctrl &&
        event.shiftKey === binding.shift &&
        event.altKey === binding.alt &&
        event.metaKey === binding.meta
      );
    case "bare-key":
      return event.key === binding.key;
    case "voice":
      return !!voiceChord && matchesChord(event, voiceChord);
    default: {
      const unexpected: never = binding;
      throw new Error(`Unknown shortcut binding: ${JSON.stringify(unexpected)}`);
    }
  }
}

/** The chord the voice listener will actually use. An unparseable stored
 * string falls back to the shipped default, matching TerminalPane — the
 * sheet must not advertise a chord the handler will not fire. */
export function resolveVoiceChord(hotkey: string): KeyChord {
  return parseChord(hotkey) ?? DEFAULT_VOICE_CHORD;
}

function keycap(key: string): string {
  if (key === "Escape") return "Esc";
  if (key.toLowerCase() === "insert") return "Insert";
  // Letters become their keycap ("k" → "K"). Punctuation (the comma that
  // opens Settings) has no case and is shown as typed.
  if (key.length === 1 && key.toLowerCase() !== key.toUpperCase()) return key.toUpperCase();
  return key;
}

function codeCap(code: string): string {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  return code;
}

function eitherModLabels(binding: Extract<ShortcutBinding, { kind: "either-mod" }>): string[] {
  const parts: string[] = [];
  if (binding.shift === "require") parts.push("Shift");
  if (binding.alt === "require") parts.push("Alt");
  parts.push(binding.code ? codeCap(binding.code) : keycap(binding.key ?? ""));
  const tail = parts.join(" + ");
  // Two chips, not one "Ctrl/⌘" glyph: each chip is a chord that matches
  // on its own, which is what `metaKey || ctrlKey` means.
  return [`Ctrl + ${tail}`, `⌘ + ${tail}`];
}

function exactKeyLabel(binding: Extract<ShortcutBinding, { kind: "exact-key" }>): string {
  const parts: string[] = [];
  // Same order formatChord uses, so a terminal chord reads like the voice
  // chip beside it.
  if (binding.ctrl) parts.push("Ctrl");
  if (binding.shift) parts.push("Shift");
  if (binding.alt) parts.push("Alt");
  if (binding.meta) parts.push("Meta");
  parts.push(keycap(binding.key));
  return parts.join(" + ");
}

/** Display labels for one shortcut, derived from its binding. `voiceHotkey`
 * is the stored settings string; ignored for every other entry. */
export function shortcutLabels(shortcut: ShortcutDefinition, voiceHotkey: string): string[] {
  const binding = shortcut.binding;
  switch (binding.kind) {
    case "either-mod":
      return eitherModLabels(binding);
    case "exact-key":
      return [exactKeyLabel(binding)];
    case "bare-key":
      return [keycap(binding.key)];
    case "voice":
      return [chordLabel(resolveVoiceChord(voiceHotkey))];
    default: {
      const unexpected: never = binding;
      throw new Error(`Unknown shortcut binding: ${JSON.stringify(unexpected)}`);
    }
  }
}

export const COMMAND_PALETTE_SHORTCUT: ShortcutDefinition = {
  id: "command-palette",
  action: "Command palette",
  detail:
    "Open the launcher. ⌘ + K also opens it in a terminal; Ctrl + K goes to the shell (kill-line) and does not open the palette. Key-conflict handling → Ctrl + K (“Reserved for command palette”), when on, gives that chord to the terminal instead of the browser and does not open the palette.",
  scope: "app",
  binding: { kind: "either-mod", key: "k", ignoreCase: true, alt: "ignore", shift: "ignore" },
};

export const SETTINGS_SHORTCUT: ShortcutDefinition = {
  id: "settings",
  action: "Settings",
  detail: "Open Settings.",
  scope: "app",
  binding: { kind: "either-mod", key: ",", alt: "ignore", shift: "ignore" },
};

export const RIGHT_SIDEBAR_SHORTCUT: ShortcutDefinition = {
  id: "right-sidebar",
  action: "Right sidebar",
  detail: "Show or hide it. Not on phone, where the sidebar isn't shown.",
  scope: "app",
  // code, not key: Option+B types "∫" on macOS. Shift is forbidden so
  // this doesn't swallow a shifted variant the terminal should still see.
  binding: { kind: "either-mod", code: "KeyB", alt: "require", shift: "forbid" },
};

export const DISMISS_SHORTCUT: ShortcutDefinition = {
  id: "dismiss",
  action: "Dismiss",
  detail: "Close the command palette, Settings, or a pending split.",
  scope: "app",
  binding: { kind: "bare-key", key: "Escape" },
};

export const FIND_SHORTCUT: ShortcutDefinition = {
  id: "find",
  action: "Find in scrollback",
  detail:
    "Search the terminal scrollback. Not Ctrl+F — the browser keeps that. The scrollback copy view opens from this bar; copy mode has no chord of its own.",
  scope: "terminal",
  binding: { kind: "exact-key", key: "f", ctrl: true, shift: true, alt: false, meta: false },
};

export const COPY_SHORTCUT: ShortcutDefinition = {
  id: "copy",
  action: "Copy selection",
  detail: "Copy the current selection.",
  scope: "terminal",
  binding: { kind: "exact-key", key: "insert", ctrl: true, shift: false, alt: false, meta: false },
};

export const VOICE_SHORTCUT: ShortcutDefinition = {
  id: "voice",
  action: "Voice dictation hotkey",
  detail: "Hold to dictate. Only while the hotkey below is on; rebind it there.",
  scope: "terminal",
  binding: { kind: "voice" },
};

// Order is the cheat sheet's order, and the order useGlobalShortcuts tries
// app chords in. App chords first because they win over a later check when
// a keydown could match more than one (it doesn't today, but the if/else
// chain depended on this order).
export const SHORTCUTS: readonly ShortcutDefinition[] = [
  COMMAND_PALETTE_SHORTCUT,
  SETTINGS_SHORTCUT,
  RIGHT_SIDEBAR_SHORTCUT,
  DISMISS_SHORTCUT,
  FIND_SHORTCUT,
  COPY_SHORTCUT,
  VOICE_SHORTCUT,
];

export const APP_SHORTCUTS: readonly ShortcutDefinition[] = SHORTCUTS.filter(
  (shortcut) => shortcut.scope === "app",
);
