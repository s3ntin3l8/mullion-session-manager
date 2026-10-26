// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { chordLabel, parseChord } from "./keyChord.js";
import {
  APP_SHORTCUTS,
  COMMAND_PALETTE_SHORTCUT,
  COPY_SHORTCUT,
  DISMISS_SHORTCUT,
  FIND_SHORTCUT,
  matchShortcut,
  resolveVoiceChord,
  RIGHT_SIDEBAR_SHORTCUT,
  SETTINGS_SHORTCUT,
  SHORTCUTS,
  shortcutLabels,
  VOICE_SHORTCUT,
} from "./shortcutCatalog.js";

function keydown(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return {
    type: "keydown",
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    repeat: false,
    code: "",
    ...init,
  } as KeyboardEvent;
}

describe("shortcutLabels", () => {
  it("formats each static chord from its binding, not a parallel string", () => {
    expect(shortcutLabels(COMMAND_PALETTE_SHORTCUT, "")).toEqual(["Ctrl + K", "⌘ + K"]);
    expect(shortcutLabels(SETTINGS_SHORTCUT, "")).toEqual(["Ctrl + ,", "⌘ + ,"]);
    expect(shortcutLabels(RIGHT_SIDEBAR_SHORTCUT, "")).toEqual(["Ctrl + Alt + B", "⌘ + Alt + B"]);
    expect(shortcutLabels(DISMISS_SHORTCUT, "")).toEqual(["Esc"]);
    expect(shortcutLabels(FIND_SHORTCUT, "")).toEqual(["Ctrl + Shift + F"]);
    expect(shortcutLabels(COPY_SHORTCUT, "")).toEqual(["Ctrl + Insert"]);
  });

  it("formats the voice chord with chordLabel, so the sheet and the hotkey field cannot disagree", () => {
    const stored = "Ctrl+Shift+Comma";
    expect(shortcutLabels(VOICE_SHORTCUT, stored)).toEqual([chordLabel(parseChord(stored)!)]);
  });

  it("falls back to the shipped default when the stored voice chord does not parse", () => {
    expect(shortcutLabels(VOICE_SHORTCUT, "not a chord")).toEqual([
      chordLabel(resolveVoiceChord("not a chord")),
    ]);
    expect(resolveVoiceChord("not a chord")).toEqual(parseChord("Ctrl+Shift+Space"));
  });
});

describe("matchShortcut", () => {
  it("keeps Shift and Alt from blocking the palette or Settings — the old matchers never looked at them", () => {
    expect(
      matchShortcut(COMMAND_PALETTE_SHORTCUT, keydown({ key: "K", ctrlKey: true, shiftKey: true })),
    ).toBe(true);
    expect(
      matchShortcut(SETTINGS_SHORTCUT, keydown({ key: ",", metaKey: true, altKey: true })),
    ).toBe(true);
  });

  it("matches the right sidebar on the physical key and rejects a shifted variant", () => {
    expect(
      matchShortcut(
        RIGHT_SIDEBAR_SHORTCUT,
        keydown({ key: "∫", code: "KeyB", metaKey: true, altKey: true }),
      ),
    ).toBe(true);
    expect(
      matchShortcut(
        RIGHT_SIDEBAR_SHORTCUT,
        keydown({ key: "B", code: "KeyB", ctrlKey: true, altKey: true, shiftKey: true }),
      ),
    ).toBe(false);
  });

  it("matches find and copy on event.key with exact modifiers", () => {
    expect(matchShortcut(FIND_SHORTCUT, keydown({ key: "F", ctrlKey: true, shiftKey: true }))).toBe(
      true,
    );
    // Bare Ctrl+F is the browser's find and was deliberately not claimed.
    expect(matchShortcut(FIND_SHORTCUT, keydown({ key: "f", ctrlKey: true }))).toBe(false);
    expect(matchShortcut(COPY_SHORTCUT, keydown({ key: "Insert", ctrlKey: true }))).toBe(true);
    expect(
      matchShortcut(COPY_SHORTCUT, keydown({ key: "Insert", ctrlKey: true, shiftKey: true })),
    ).toBe(false);
  });

  it("matches Escape with no modifier requirement", () => {
    expect(matchShortcut(DISMISS_SHORTCUT, keydown({ key: "Escape", shiftKey: true }))).toBe(true);
    expect(matchShortcut(DISMISS_SHORTCUT, keydown({ key: "Esc" }))).toBe(false);
  });

  it("matches only the voice chord it was given, and nothing when that chord is off", () => {
    const chord = parseChord("Ctrl+Shift+Space")!;
    const event = keydown({ key: " ", code: "Space", ctrlKey: true, shiftKey: true });
    expect(matchShortcut(VOICE_SHORTCUT, event, chord)).toBe(true);
    expect(matchShortcut(VOICE_SHORTCUT, event, null)).toBe(false);
    expect(matchShortcut(VOICE_SHORTCUT, event, parseChord("Ctrl+Shift+Comma"))).toBe(false);
  });
});

describe("SHORTCUTS", () => {
  it("lists every app shortcut the window listener wires, in the order it tries them", () => {
    expect(APP_SHORTCUTS.map((shortcut) => shortcut.id)).toEqual([
      "command-palette",
      "settings",
      "right-sidebar",
      "dismiss",
    ]);
    expect(SHORTCUTS.map((shortcut) => shortcut.id)).toEqual([
      ...APP_SHORTCUTS.map((shortcut) => shortcut.id),
      "find",
      "copy",
      "voice",
    ]);
  });
});
