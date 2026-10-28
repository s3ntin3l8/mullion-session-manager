import { afterEach, describe, it, expect } from "vitest";
import {
  buildStartupQueryReplies,
  getTerminalPalette,
  resetTerminalPalette,
  setTerminalPalette,
} from "../../src/services/terminal-query-reply.js";

const LIGHT = { foreground: "#1d1d1d", background: "#f2f2f2", cursor: "#1d1d1d" };

describe("buildStartupQueryReplies", () => {
  afterEach(() => resetTerminalPalette());

  it("answers OSC 10/11/12 queries in rgb: doubled-hex form", () => {
    expect(buildStartupQueryReplies("\x1b]11;?\x07", LIGHT)).toBe("\x1b]11;rgb:f2f2/f2f2/f2f2\x07");
    expect(buildStartupQueryReplies("\x1b]10;?\x1b\\", LIGHT)).toBe(
      "\x1b]10;rgb:1d1d/1d1d/1d1d\x07",
    );
    expect(buildStartupQueryReplies("\x1b]12;?\x07", LIGHT)).toBe("\x1b]12;rgb:1d1d/1d1d/1d1d\x07");
  });

  it("answers a DA1 the way xterm does, in the order asked (OSC 11 query, then its DA1 sentinel)", () => {
    expect(buildStartupQueryReplies("\x1b]11;?\x07\x1b[c", LIGHT)).toBe(
      "\x1b]11;rgb:f2f2/f2f2/f2f2\x07\x1b[?1;2c",
    );
    expect(buildStartupQueryReplies("\x1b[0c", LIGHT)).toBe("\x1b[?1;2c");
  });

  it("ignores colour sets, DA2, other queries and plain text", () => {
    expect(buildStartupQueryReplies("\x1b]11;#112233\x07", LIGHT)).toBe("");
    expect(buildStartupQueryReplies("\x1b[>c\x1b[6n\x1b[?u", LIGHT)).toBe("");
    expect(buildStartupQueryReplies("hello world", LIGHT)).toBe("");
  });

  it("answers nothing until a palette is known, then uses the cached one", () => {
    expect(getTerminalPalette()).toBeNull();
    expect(buildStartupQueryReplies("\x1b]11;?\x07\x1b[c")).toBe("");

    setTerminalPalette(LIGHT);
    expect(getTerminalPalette()).toEqual(LIGHT);
    expect(buildStartupQueryReplies("\x1b]11;?\x07")).toBe("\x1b]11;rgb:f2f2/f2f2/f2f2\x07");
  });
});
