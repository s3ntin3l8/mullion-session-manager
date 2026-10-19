import { describe, expect, it } from "vitest";
import {
  parseSttySize,
  ptySizeFile,
  terminalGeometryProblems,
} from "../../scripts/demo/geometry.mjs";

// The desktop dashboard's terminal as measured in a good capture: a
// 1248x864 box at devicePixelRatio 2, 14 px font, 18 px rows.
const screen = { width: 1248, height: 864 };
const canvas = { cssWidth: 1248, cssHeight: 864, width: 2496, height: 1728 };
const good = {
  screen,
  canvases: [canvas, canvas],
  dpr: 2,
  pty: { rows: 48, cols: 148 },
  fontSize: 14,
};

describe("ptySizeFile", () => {
  it("sits next to the release file", () => {
    expect(ptySizeFile("/s/fake-agent.release")).toBe("/s/fake-agent.release.size");
  });
});

describe("parseSttySize", () => {
  it("reads rows then cols", () => {
    expect(parseSttySize("48 148\n")).toEqual({ rows: 48, cols: 148 });
  });

  it("rejects anything that isn't a positive size", () => {
    expect(parseSttySize("")).toBeNull();
    expect(parseSttySize("stty: 'standard input': Inappropriate ioctl for device\n")).toBeNull();
    expect(parseSttySize("0 0\n")).toBeNull();
  });
});

describe("terminalGeometryProblems", () => {
  it("accepts a fitted terminal at the configured font", () => {
    expect(terminalGeometryProblems(good)).toEqual([]);
  });

  it("accepts the DOM renderer (no canvases) and an unrecorded PTY size", () => {
    expect(terminalGeometryProblems({ ...good, canvases: [], pty: null })).toEqual([]);
  });

  it("flags cells twice the font's size in an unchanged box", () => {
    const problems = terminalGeometryProblems({ ...good, pty: { rows: 24, cols: 76 } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("76x24 cells");
  });

  it("flags a drawing surface out of step with the box", () => {
    const wide = { cssWidth: 2496, cssHeight: 1728, width: 4992, height: 3456 };
    const problems = terminalGeometryProblems({ ...good, canvases: [wide] });
    expect(problems).toEqual(["canvas 0 is 2496x1728 css px in a 1248x864 box"]);
  });

  it("flags a surface drawn for the wrong devicePixelRatio", () => {
    const blurry = { ...canvas, width: 1248, height: 864 };
    expect(terminalGeometryProblems({ ...good, canvases: [blurry] })).toEqual([
      "canvas 0 is drawn at 1.00x for a devicePixelRatio of 2",
    ]);
  });

  it("tolerates a sub-pixel box", () => {
    const close = { ...canvas, cssWidth: 1248.5 };
    expect(terminalGeometryProblems({ ...good, canvases: [close] })).toEqual([]);
  });
});
