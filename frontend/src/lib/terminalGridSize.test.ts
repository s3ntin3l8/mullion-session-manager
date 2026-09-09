import { describe, expect, it } from "vitest";
import { clampTerminalGridSize, MAX_TERMINAL_COLS, MAX_TERMINAL_ROWS } from "./terminalGridSize.js";

describe("clampTerminalGridSize", () => {
  it("passes through a size already within bounds", () => {
    expect(clampTerminalGridSize(80, 24)).toEqual({ cols: 80, rows: 24 });
  });

  it("passes through a size exactly at the ceiling", () => {
    expect(clampTerminalGridSize(MAX_TERMINAL_COLS, MAX_TERMINAL_ROWS)).toEqual({
      cols: MAX_TERMINAL_COLS,
      rows: MAX_TERMINAL_ROWS,
    });
  });

  it("clamps a runaway proposal at the ceiling", () => {
    // The actual magnitude observed live in the dock resize-runaway bug.
    expect(clampTerminalGridSize(35_140, 9_000)).toEqual({
      cols: MAX_TERMINAL_COLS,
      rows: MAX_TERMINAL_ROWS,
    });
  });

  it("clamps a degenerate zero/negative proposal up to 1, not down further", () => {
    expect(clampTerminalGridSize(0, -5)).toEqual({ cols: 1, rows: 1 });
  });

  it("clamps each axis independently", () => {
    // cols within bounds, rows over — each axis must clamp on its own,
    // not fall back to some combined ratio.
    expect(clampTerminalGridSize(80, 9_000)).toEqual({ cols: 80, rows: MAX_TERMINAL_ROWS });
  });
});
