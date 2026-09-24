import { describe, it, expect } from "vitest";
import { applyCtrl, applyCtrlToChunk, nextCtrlMode } from "./ctrlModifier.js";

describe("applyCtrl", () => {
  it.each([
    ["c", "\x03"],
    ["C", "\x03"],
    ["a", "\x01"],
    ["z", "\x1a"],
    ["[", "\x1b"],
    ["@", "\x00"],
    [" ", "\x00"],
    ["?", "\x7f"],
  ])("maps %j to its control code", (input, expected) => {
    expect(applyCtrl(input)).toBe(expected);
  });

  it("leaves characters without a control code, and multi-char input, alone", () => {
    expect(applyCtrl("1")).toBeNull();
    expect(applyCtrl("\x1b")).toBeNull();
    expect(applyCtrl("ab")).toBeNull();
    expect(applyCtrl("")).toBeNull();
  });
});

describe("nextCtrlMode", () => {
  it("cycles off → once → locked → off", () => {
    expect(nextCtrlMode("off")).toBe("once");
    expect(nextCtrlMode("once")).toBe("locked");
    expect(nextCtrlMode("locked")).toBe("off");
  });
});

describe("applyCtrlToChunk (soft-keyboard word commits)", () => {
  it("applies Ctrl to a lone character", () => {
    expect(applyCtrlToChunk("c")).toBe("\x03");
  });

  it("drops the committing space an IME sends after the letter", () => {
    expect(applyCtrlToChunk("c ")).toBe("\x03");
  });

  it("applies Ctrl to the first character of a longer chunk and keeps the rest", () => {
    expect(applyCtrlToChunk("cat")).toBe("\x03at");
  });

  it("returns null when the first character has no control code", () => {
    expect(applyCtrlToChunk("1 ")).toBeNull();
    expect(applyCtrlToChunk("\x1b[A")).toBeNull();
    expect(applyCtrlToChunk("")).toBeNull();
  });
});
