import { describe, it, expect } from "vitest";
import {
  detectAttentionSignals,
  classifyActivityFromTitle,
} from "../../src/services/attention-detect.js";

const ESC = "\x1b";
const BEL = "\x07";
const ST = `${ESC}\\`;

describe("detectAttentionSignals", () => {
  it("returns all-clear for plain output with no escape sequences", () => {
    expect(detectAttentionSignals("just some regular output\n")).toEqual({
      bell: false,
      notification: false,
      titleChange: null,
    });
  });

  it("detects a bare bell byte", () => {
    expect(detectAttentionSignals(`done${BEL}`)).toEqual({
      bell: true,
      notification: false,
      titleChange: null,
    });
  });

  it("detects an OSC 9 notification terminated with BEL, without counting the terminator as a bare bell", () => {
    const chunk = `${ESC}]9;Build finished${BEL}`;
    const result = detectAttentionSignals(chunk);
    expect(result.notification).toBe(true);
    expect(result.bell).toBe(false); // BEL is just the OSC terminator here, not a bare bell
  });

  it("detects an OSC 777 notification terminated with ST", () => {
    const chunk = `${ESC}]777;notify;Title;Body${ST}`;
    const result = detectAttentionSignals(chunk);
    expect(result.notification).toBe(true);
    expect(result.bell).toBe(false); // ST terminator, no bare BEL byte
  });

  it("extracts the payload of an OSC 2 title-change sequence", () => {
    const chunk = `${ESC}]2;my-session — waiting${BEL}`;
    const result = detectAttentionSignals(chunk);
    expect(result.titleChange).toBe("my-session — waiting");
    expect(result.notification).toBe(false);
  });

  it("extracts the payload of an OSC 0 icon+title sequence", () => {
    const chunk = `${ESC}]0;claude: done${ST}`;
    expect(detectAttentionSignals(chunk).titleChange).toBe("claude: done");
  });

  it("keeps the LAST title when multiple OSC 0/2 sequences appear in one chunk", () => {
    const chunk = `${ESC}]2;first${BEL}${ESC}]2;second${BEL}`;
    expect(detectAttentionSignals(chunk).titleChange).toBe("second");
  });

  it("ignores OSC codes that aren't 0/2/9/777, and doesn't count their BEL terminator as a bell", () => {
    const chunk = `${ESC}]4;1;rgb:00/00/00${BEL}`; // OSC 4 = palette color
    expect(detectAttentionSignals(chunk)).toEqual({
      bell: false,
      notification: false,
      titleChange: null,
    });
  });

  it("still detects a bare bell alongside OSC-terminator BELs in the same chunk", () => {
    const chunk = `some output${ESC}]2;title${BEL}more output${BEL}${ESC}]9;notify${BEL}`;
    const result = detectAttentionSignals(chunk);
    expect(result.bell).toBe(true); // the standalone BEL between "more output" and the OSC 9 sequence
    expect(result.notification).toBe(true);
    expect(result.titleChange).toBe("title");
  });

  it("does not treat a title/notification OSC sequence's BEL terminator as a bare bell", () => {
    const chunk = `some output${ESC}]2;title${BEL}more output${ESC}]9;notify${BEL}`;
    const result = detectAttentionSignals(chunk);
    expect(result.bell).toBe(false);
    expect(result.notification).toBe(true);
    expect(result.titleChange).toBe("title");
  });
});

describe("classifyActivityFromTitle", () => {
  it("reads 'working' from an explicit status word", () => {
    expect(classifyActivityFromTitle("Thinking…", "claude")).toBe("working");
    expect(classifyActivityFromTitle("opencode: Generating", "opencode")).toBe("working");
  });

  it("reads 'working' from a trailing ellipsis", () => {
    expect(classifyActivityFromTitle("Compiling...", "make")).toBe("working");
  });

  it("reads 'idle' from an explicit status word", () => {
    expect(classifyActivityFromTitle("Waiting for input", "claude")).toBe("idle");
    expect(classifyActivityFromTitle("Ready", "opencode")).toBe("idle");
  });

  it("returns null for a plain shell title, leaving the caller's own heuristic to decide", () => {
    // Bash/zsh write `user@host:cwd` into the title on every prompt draw —
    // no status word, so this must NOT be misread as "idle" or "working".
    expect(classifyActivityFromTitle("bjoern@host:~/projects/tessera", "bash")).toBeNull();
  });

  it("returns null when there is no title yet", () => {
    expect(classifyActivityFromTitle(null, "bash")).toBeNull();
  });

  it("prefers 'idle' over a trailing ellipsis when a title contains both", () => {
    // "Waiting..." matches both the idle word "Waiting" and the working
    // pattern's trailing ellipsis — the idle word must win.
    expect(classifyActivityFromTitle("Waiting...", "opencode")).toBe("idle");
  });
});
