import { describe, expect, it } from "vitest";
import {
  checkTerminalGeometry,
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
    expect(problems[0].kind).toBe("cells");
    expect(problems[0].message).toContain("76x24 cells");
  });

  it("flags a drawing surface out of step with the box", () => {
    const wide = { cssWidth: 2496, cssHeight: 1728, width: 4992, height: 3456 };
    const problems = terminalGeometryProblems({ ...good, canvases: [wide] });
    expect(problems).toEqual([
      { kind: "canvas", message: "canvas 0 is 2496x1728 css px in a 1248x864 box" },
    ]);
  });

  it("flags a surface drawn for the wrong devicePixelRatio", () => {
    const blurry = { ...canvas, width: 1248, height: 864 };
    expect(terminalGeometryProblems({ ...good, canvases: [blurry] })).toEqual([
      { kind: "canvas", message: "canvas 0 is drawn at 1.00x for a devicePixelRatio of 2" },
    ]);
  });

  it("flags a box that isn't laid out", () => {
    const empty = { width: 0, height: 0 };
    expect(terminalGeometryProblems({ ...good, screen: empty, canvases: [] })).toEqual([
      { kind: "canvas", message: "the terminal box is 0x0" },
    ]);
  });

  it("tolerates a sub-pixel box", () => {
    const close = { ...canvas, cssWidth: 1248.5 };
    expect(terminalGeometryProblems({ ...good, canvases: [close] })).toEqual([]);
  });
});

describe("checkTerminalGeometry", () => {
  const measured = { terminals: 1, screen, canvases: [canvas], dpr: 2 };
  const wide = { cssWidth: 2496, cssHeight: 1728, width: 4992, height: 3456 };

  /** Runs the check over a scripted sequence of measurements. */
  function run(measurements: object[], pty: { rows: number; cols: number } | null = good.pty) {
    const logs: string[] = [];
    let refits = 0;
    let i = 0;
    const result = checkTerminalGeometry({
      name: "shot.png",
      measure: async () => measurements[Math.min(i++, measurements.length - 1)],
      refit: async () => {
        refits++;
      },
      pty,
      fontSize: 14,
      log: (line: string) => logs.push(line),
    });
    return { result, logs, refits: () => refits };
  }

  it("passes a good terminal without re-fitting, logging its geometry", async () => {
    const r = run([measured]);
    await expect(r.result).resolves.toMatchObject({ pty: good.pty, fontSize: 14 });
    expect(r.refits()).toBe(0);
    expect(r.logs).toHaveLength(1);
    expect(r.logs[0]).toContain("shot.png terminal:");
  });

  it("throws on anything but exactly one mounted terminal", async () => {
    await expect(run([{ terminals: 2 }]).result).rejects.toThrow(
      "expected one mounted terminal, found 2",
    );
    await expect(run([{ terminals: 0 }]).result).rejects.toThrow("found 0");
  });

  it("fails oversized cells at once rather than re-fitting", async () => {
    const r = run([measured], { rows: 24, cols: 76 });
    await expect(r.result).rejects.toThrow("terminal geometry is off: 76x24 cells");
    expect(r.refits()).toBe(0);
  });

  it("re-fits a canvas out of step and passes once it's back", async () => {
    const r = run([{ ...measured, canvases: [wide] }, measured]);
    await expect(r.result).resolves.toBeDefined();
    expect(r.refits()).toBe(1);
    expect(r.logs.some((l) => l.includes("re-fitting the terminal"))).toBe(true);
  });

  it("gives up after the bounded re-fits", async () => {
    const r = run([{ ...measured, canvases: [wide] }]);
    await expect(r.result).rejects.toThrow("canvas 0 is 2496x1728 css px");
    expect(r.refits()).toBe(2);
  });

  it("says so when there's no PTY size, and checks the canvases alone", async () => {
    const r = run([measured], null);
    await expect(r.result).resolves.toBeDefined();
    expect(r.logs[0]).toContain("no PTY size recorded");
  });

  it("refuses a missing or non-numeric font size rather than skipping the cell check", async () => {
    const check = (fontSize: unknown) =>
      checkTerminalGeometry({
        name: "shot.png",
        measure: async () => measured,
        refit: async () => {},
        pty: good.pty,
        fontSize,
        log: () => {},
      });
    await expect(check(undefined)).rejects.toThrow("no usable terminal font size (undefined)");
    await expect(check(Number.NaN)).rejects.toThrow("(NaN)");
  });
});
