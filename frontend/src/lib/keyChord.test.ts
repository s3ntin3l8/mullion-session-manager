// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  chordFromEvent,
  chordLabel,
  formatChord,
  matchesChord,
  parseChord,
  validateChord,
} from "./keyChord.js";

function fakeKeydown(init: Partial<KeyboardEvent> & { code: string }): KeyboardEvent {
  return {
    type: "keydown",
    key: init.code,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    repeat: false,
    ...init,
  } as KeyboardEvent;
}

describe("parseChord / formatChord round-trip", () => {
  it("round-trips the shipped default", () => {
    const chord = parseChord("Ctrl+Shift+Space");
    expect(chord).toEqual({ ctrl: true, shift: true, alt: false, meta: false, code: "Space" });
    expect(formatChord(chord!)).toBe("Ctrl+Shift+Space");
  });

  it("round-trips a bare letter to KeyX and back to the letter", () => {
    const chord = parseChord("Ctrl+V");
    expect(chord).toEqual({ ctrl: true, shift: false, alt: false, meta: false, code: "KeyV" });
    expect(formatChord(chord!)).toBe("Ctrl+V");
  });

  it("round-trips a digit to DigitN and back", () => {
    const chord = parseChord("Ctrl+Shift+1");
    expect(chord?.code).toBe("Digit1");
    expect(formatChord(chord!)).toBe("Ctrl+Shift+1");
  });

  it("passes non-letter/digit codes through verbatim (Backquote, F5, Insert, Comma)", () => {
    expect(parseChord("Ctrl+Shift+Backquote")?.code).toBe("Backquote");
    expect(parseChord("Ctrl+F5")?.code).toBe("F5");
    expect(parseChord("Ctrl+Insert")?.code).toBe("Insert");
    expect(formatChord(parseChord("Ctrl+Shift+Comma")!)).toBe("Ctrl+Shift+Comma");
  });

  it("modifier order in the output is always Ctrl, Shift, Alt, Meta regardless of input order", () => {
    expect(parseChord("Shift+Ctrl+Space")).toEqual(parseChord("Ctrl+Shift+Space"));
    expect(formatChord(parseChord("Meta+Alt+Shift+Ctrl+KeyV")!)).toBe("Ctrl+Shift+Alt+Meta+V");
  });

  it("returns null for an empty string, a bare modifier, or a duplicate modifier", () => {
    expect(parseChord("")).toBeNull();
    expect(parseChord("Ctrl")).toBeNull();
    expect(parseChord("Ctrl+Ctrl+Space")).toBeNull();
  });

  it("returns null for an unrecognized modifier token", () => {
    expect(parseChord("Cmd+Space")).toBeNull();
  });
});

describe("chordLabel", () => {
  it("space-pads for display", () => {
    expect(chordLabel(parseChord("Ctrl+Shift+Space")!)).toBe("Ctrl + Shift + Space");
  });
});

describe("chordFromEvent", () => {
  it("builds a descriptor from a real keydown", () => {
    expect(chordFromEvent(fakeKeydown({ code: "Space", ctrlKey: true, shiftKey: true }))).toEqual({
      ctrl: true,
      shift: true,
      alt: false,
      meta: false,
      code: "Space",
    });
  });

  it("returns null for a bare-modifier keydown (still holding Ctrl, hasn't pressed the key)", () => {
    expect(chordFromEvent(fakeKeydown({ code: "ControlLeft", ctrlKey: true }))).toBeNull();
    expect(chordFromEvent(fakeKeydown({ code: "ShiftRight", shiftKey: true }))).toBeNull();
  });

  it("returns null for an empty or Unidentified code (Android/IME, remote desktop)", () => {
    expect(chordFromEvent(fakeKeydown({ code: "", ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(
      chordFromEvent(fakeKeydown({ code: "Unidentified", ctrlKey: true, shiftKey: true })),
    ).toBeNull();
  });
});

describe("matchesChord", () => {
  const ctrlShiftSpace = parseChord("Ctrl+Shift+Space")!;

  it("matches on exact modifier equality, not 'at least these'", () => {
    expect(
      matchesChord(fakeKeydown({ code: "Space", ctrlKey: true, shiftKey: true }), ctrlShiftSpace),
    ).toBe(true);
    // An extra modifier held down (Alt) must NOT match — every existing
    // chord branch in terminalKeys.ts spells out its negated modifiers
    // rather than accepting a superset.
    expect(
      matchesChord(
        fakeKeydown({ code: "Space", ctrlKey: true, shiftKey: true, altKey: true }),
        ctrlShiftSpace,
      ),
    ).toBe(false);
    // A missing modifier must not match either.
    expect(matchesChord(fakeKeydown({ code: "Space", ctrlKey: true }), ctrlShiftSpace)).toBe(false);
  });

  it("does not match on a different code even with identical modifiers", () => {
    expect(
      matchesChord(fakeKeydown({ code: "Comma", ctrlKey: true, shiftKey: true }), ctrlShiftSpace),
    ).toBe(false);
  });
});

describe("validateChord", () => {
  it("rejects a chord with no modifier at all", () => {
    const result = validateChord({
      ctrl: false,
      shift: false,
      alt: false,
      meta: false,
      code: "KeyV",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects browser-chrome-reserved combos (Ctrl+W/T/N/F and their Shift variants, and Ctrl+Shift+C)", () => {
    expect(validateChord(parseChord("Ctrl+W")!).ok).toBe(false);
    expect(validateChord(parseChord("Ctrl+T")!).ok).toBe(false);
    expect(validateChord(parseChord("Ctrl+N")!).ok).toBe(false);
    expect(validateChord(parseChord("Ctrl+Shift+N")!).ok).toBe(false);
    // Bare Ctrl+F is the browser's own "Find in page" — the reason
    // terminalKeys.ts's own scrollback search deliberately binds
    // Ctrl+Shift+F instead. Ctrl+Shift+C is DevTools "Inspect Element".
    // Both are silent-no-op-on-preventDefault the same way Ctrl+W/T/N are;
    // a voice hotkey bound to either would never fire and look broken with
    // no indication why.
    expect(validateChord(parseChord("Ctrl+F")!).ok).toBe(false);
    expect(validateChord(parseChord("Ctrl+Shift+C")!).ok).toBe(false);
  });

  it("rejects combos attachKeyConflictHandler already claims unconditionally", () => {
    expect(validateChord(parseChord("Ctrl+Shift+F")!).ok).toBe(false);
    expect(validateChord(parseChord("Ctrl+Insert")!).ok).toBe(false);
    expect(validateChord(parseChord("Shift+Insert")!).ok).toBe(false);
    expect(validateChord(parseChord("Meta+V")!).ok).toBe(false);
    // Ctrl+V's terminal-paste use is itself opt-in (clipboardKeys.ctrlV,
    // default off), but attachKeyConflictHandler's paste branch runs
    // BEFORE the voice branch regardless of that setting's current value —
    // so binding voice here would risk silently dying the moment that
    // setting is later turned on. Rejected unconditionally rather than
    // only when the setting happens to be on right now.
    expect(validateChord(parseChord("Ctrl+V")!).ok).toBe(false);
  });

  it("allows the shipped default and an arbitrary free combo", () => {
    expect(validateChord(parseChord("Ctrl+Shift+Space")!).ok).toBe(true);
    expect(validateChord(parseChord("Ctrl+Shift+Comma")!).ok).toBe(true);
  });

  it("allows Ctrl+C and Ctrl+R/L/K — conditionally claimed, but their branches run AFTER voice, so voice wins rather than silently dying", () => {
    expect(validateChord(parseChord("Ctrl+C")!).ok).toBe(true);
    expect(validateChord(parseChord("Ctrl+R")!).ok).toBe(true);
    expect(validateChord(parseChord("Ctrl+L")!).ok).toBe(true);
    expect(validateChord(parseChord("Ctrl+K")!).ok).toBe(true);
  });
});
