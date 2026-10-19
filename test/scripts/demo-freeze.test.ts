import { describe, expect, it } from "vitest";
import { lastChangeSeconds } from "../../scripts/demo/freeze.mjs";

const line = (key: string, value: number) =>
  `[freezedetect @ 0x5e53] lavfi.freezedetect.freeze_${key}: ${value}`;

describe("lastChangeSeconds", () => {
  it("returns the start of the freeze that runs to the end", () => {
    const log = [
      line("start", 1.76),
      line("duration", 1.24),
      line("end", 3),
      line("start", 10),
    ].join("\n");
    expect(lastChangeSeconds(log)).toBe(10);
  });

  it("returns null when the last freeze ends before the video does", () => {
    const log = [line("start", 4.04), line("duration", 1.24), line("end", 5.28)].join("\n");
    expect(lastChangeSeconds(log)).toBeNull();
  });

  it("returns null with no freezes at all", () => {
    expect(lastChangeSeconds("frame=  600 fps=0.0 q=-0.0 size=0kB")).toBeNull();
  });
});
