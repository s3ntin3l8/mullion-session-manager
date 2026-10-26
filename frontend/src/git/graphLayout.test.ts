import { describe, expect, it } from "vitest";
import { computeGraphLayout, foldRow, laneColour, MAX_LANES } from "./graphLayout.js";

const c = (sha: string, ...parents: string[]) => ({ sha, parents });

describe("computeGraphLayout", () => {
  it("keeps a linear history in one lane with a line above every row but the first", () => {
    const { rows, width } = computeGraphLayout([c("c", "b"), c("b", "a"), c("a")]);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(rows.map((r) => r.fromAbove)).toEqual([false, true, true]);
    expect(rows.map((r) => r.parentLanes)).toEqual([[0], [0], []]);
    expect(width).toBe(1);
  });

  it("draws a merge: the second parent gets its own lane, which converges at the fork point", () => {
    // m merges f (feature) into main; both descend from base.
    const { rows, width } = computeGraphLayout([
      c("m", "x", "f"),
      c("f", "base"),
      c("x", "base"),
      c("base"),
    ]);
    expect(rows[0]).toMatchObject({ sha: "m", lane: 0, parentLanes: [0, 1] });
    // f continues in lane 1 while x's lane 0 passes through.
    expect(rows[1]).toMatchObject({ sha: "f", lane: 1, fromAbove: true, passThrough: [0] });
    expect(rows[2]).toMatchObject({ sha: "x", lane: 0, fromAbove: true, passThrough: [1] });
    // Both lanes were waiting for base: it sits in lane 0 and lane 1 merges in.
    expect(rows[3]).toMatchObject({ sha: "base", lane: 0, mergeFrom: [1] });
    expect(width).toBe(2);
  });

  it("handles parallel branches that never merge in this window", () => {
    const { rows, width } = computeGraphLayout([
      c("b2", "b1"),
      c("a2", "a1"),
      c("b1", "r"),
      c("a1", "r"),
      c("r"),
    ]);
    expect(rows[0].lane).toBe(0); // b2
    expect(rows[1].lane).toBe(1); // a2 not awaited -> new lane
    expect(rows[1].passThrough).toEqual([0]);
    expect(rows[2]).toMatchObject({ sha: "b1", lane: 0, passThrough: [1] });
    expect(rows[3]).toMatchObject({ sha: "a1", lane: 1, passThrough: [0] });
    expect(rows[4]).toMatchObject({ sha: "r", lane: 0, mergeFrom: [1] });
    expect(width).toBe(2);
  });

  it("handles an octopus merge across three parents", () => {
    const { rows, width } = computeGraphLayout([
      c("o", "p1", "p2", "p3"),
      c("p1", "r"),
      c("p2", "r"),
      c("p3", "r"),
      c("r"),
    ]);
    expect(rows[0].parentLanes).toEqual([0, 1, 2]);
    expect(rows[3]).toMatchObject({ sha: "p3", lane: 2 });
    expect(rows[4]).toMatchObject({ sha: "r", lane: 0, mergeFrom: [1, 2] });
    expect(width).toBe(3);
  });

  it("reuses a lane already waiting for a merge parent, and frees lanes once a branch ends", () => {
    // m2 merges a parent that another lane is already waiting for.
    const { rows } = computeGraphLayout([c("t", "s"), c("m2", "u", "s"), c("u"), c("s")]);
    expect(rows[1].parentLanes).toEqual([1, 0]); // second parent s -> existing lane 0
    // After u (a root) ends its lane, nothing lingers below.
    expect(rows[2]).toMatchObject({ sha: "u", parentLanes: [] });
    expect(rows[3].passThrough).toEqual([]);
  });

  it("returns an empty layout for no commits", () => {
    expect(computeGraphLayout([])).toEqual({ rows: [], width: 0 });
  });

  it("colours lanes from the --lane-* tokens and dims everything past the cap", () => {
    expect(laneColour(0)).toBe("var(--lane-1)");
    expect(laneColour(MAX_LANES - 1)).toBe(`var(--lane-${MAX_LANES})`);
    expect(laneColour(MAX_LANES)).toBe("var(--lane-more)");
    expect(laneColour(40)).toBe("var(--lane-more)");
  });
});

describe("foldRow", () => {
  const wide = (n: number) => {
    // n unrelated branch tips, then a commit on the last lane they all pass.
    const tips = Array.from({ length: n }, (_, i) => c(`t${i}`, `p${i}`));
    return computeGraphLayout([...tips, c("p0")]).rows;
  };

  it("leaves a row within the cap untouched", () => {
    const row = wide(3)[2];
    const f = foldRow(row);
    expect(f).toMatchObject({ lane: row.lane, width: row.width, hidden: 0 });
    expect(f.passThrough).toEqual(row.passThrough);
  });

  it("folds lanes past the cap into one overflow lane and counts them", () => {
    const rows = wide(10);
    const row = rows[9]; // tenth tip: ten lanes wide
    expect(row.width).toBe(10);
    const f = foldRow(row);
    expect(f.width).toBe(MAX_LANES + 1);
    expect(f.hidden).toBe(10 - MAX_LANES);
    expect(f.lane).toBe(MAX_LANES); // the dot itself sits in the overflow lane
    expect(Math.max(...f.passThrough, ...f.parentLanes)).toBe(MAX_LANES);
    // Several folded lanes draw as a single line.
    expect(new Set(f.passThrough).size).toBe(f.passThrough.length);
  });

  it("is per row: a narrow row stays narrow when the graph is wide elsewhere", () => {
    const rows = wide(10);
    expect(foldRow(rows[0]).width).toBe(1);
    expect(foldRow(rows[9]).width).toBeGreaterThan(foldRow(rows[0]).width);
  });
});
