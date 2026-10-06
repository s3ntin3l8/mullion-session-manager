import { describe, it, expect } from "vitest";
import { TerminalModeTracker } from "../../src/services/terminal-mode-tracker.js";

describe("TerminalModeTracker", () => {
  it("builds an alt-screen-exit-only preamble by default", () => {
    expect(new TerminalModeTracker().buildPreamble().toString()).toBe("\x1b[?1049l");
  });

  it("detects an alt-screen flip once, ignoring a re-assertion", () => {
    const t = new TerminalModeTracker();
    const first = t.applyAltScreen("x\x1b[?1049hy");
    expect(first).toMatchObject({ mode: "alt", flipped: true, exited: false });
    expect(t.inAltScreen).toBe(true);
    expect(t.applyAltScreen("\x1b[?1049h")).toMatchObject({ flipped: false, exited: false });
    const exit = t.applyAltScreen("\x1b[?1049l");
    expect(exit).toMatchObject({ mode: "primary", flipped: true, exited: true });
    expect(exit!.endIndex).toBe("\x1b[?1049l".length);
    expect(t.inAltScreen).toBe(false);
    expect(t.applyAltScreen("plain")).toBeNull();
  });

  it("tracks mouse + bracketed paste and synthesizes them into the preamble", () => {
    const t = new TerminalModeTracker();
    t.applyInputModes("\x1b[?1003h" + "\x1b[?1006h\x1b[?2004h");
    expect(t.mouseTracking).toEqual({ protocol: "ANY", encoding: "SGR" });
    expect(t.bracketedPaste).toBe(true);
    t.applyAltScreen("\x1b[?1049h");
    expect(t.buildPreamble().toString()).toBe("\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[?2004h");
    t.applyInputModes("\x1b[?2004l");
    expect(t.bracketedPaste).toBe(false);
  });

  it("carries an unterminated escape across chunks and reports carry state", () => {
    const t = new TerminalModeTracker();
    expect(t.carriesEmpty).toBe(true);
    const chunk = t.detectChunk("abc\x1b[?10");
    t.applyInputModes(chunk);
    expect(t.carriesEmpty).toBe(false);
    expect(t.detectCarryLength).toBeGreaterThan(0);
    // the split sequence completes on the next chunk
    const next = t.detectChunk("49h");
    expect(t.applyAltScreen(next)).toMatchObject({ mode: "alt", flipped: true });
    t.clearDetectCarry();
    expect(t.detectCarryLength).toBe(0);
    expect(t.carriesEmpty).toBe(true);
  });

  it("detects OSC 7 cwd across a split payload using its own carry", () => {
    const t = new TerminalModeTracker();
    expect(t.detectCwd("\x1b]7;file://host/home/us")).toBeNull();
    expect(t.carriesEmpty).toBe(false);
    expect(t.detectCwd("er/proj\x07")).toBe("/home/user/proj");
    t.clearCwdDetectCarry();
    expect(t.carriesEmpty).toBe(true);
  });

  describe("restore", () => {
    it("restores valid alt-screen and mouse state", () => {
      const t = new TerminalModeTracker();
      t.restore({ inAltScreen: true, mouseTracking: { protocol: "ANY", encoding: "SGR" } });
      expect(t.inAltScreen).toBe(true);
      expect(t.mouseTracking).toEqual({ protocol: "ANY", encoding: "SGR" });
    });

    it("skips a malformed mouse value but still restores inAltScreen", () => {
      const t = new TerminalModeTracker();
      t.restore({
        inAltScreen: true,
        mouseTracking: { protocol: "BOGUS", encoding: "SGR" } as never,
      });
      expect(t.inAltScreen).toBe(true);
      expect(t.mouseTracking).toEqual({ protocol: "NONE", encoding: "DEFAULT" });
    });

    it("ignores a missing/malformed termModes without throwing", () => {
      const t = new TerminalModeTracker();
      t.restore(undefined);
      t.restore(null);
      t.restore({ inAltScreen: "yes" } as never);
      expect(t.inAltScreen).toBe(false);
    });

    it("never restores bracketedPaste as true (issue #1155)", () => {
      const t = new TerminalModeTracker();
      t.bracketedPaste = true;
      t.restore({
        inAltScreen: false,
        mouseTracking: { protocol: "NONE", encoding: "DEFAULT" },
        bracketedPaste: true,
      });
      expect(t.bracketedPaste).toBe(false);
    });
  });

  it("snapshot round-trips through restore (bracketedPaste aside)", () => {
    const a = new TerminalModeTracker();
    a.applyAltScreen("\x1b[?1049h");
    a.applyInputModes("\x1b[?1002h\x1b[?2004h");
    const snap = a.snapshot();
    expect(snap).toEqual({
      inAltScreen: true,
      mouseTracking: { protocol: "DRAG", encoding: "DEFAULT" },
      bracketedPaste: true,
    });
    const b = new TerminalModeTracker();
    b.restore(snap);
    expect(b.inAltScreen).toBe(true);
    expect(b.mouseTracking).toEqual(snap.mouseTracking);
    expect(b.bracketedPaste).toBe(false);
  });
});
