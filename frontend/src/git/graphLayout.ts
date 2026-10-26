// Lane assignment for the commit graph. Pure: takes commits newest-first in
// topological order (every commit appears before its parents — what
// `git log --topo-order` yields) and says, per row, which lane the commit
// sits in and which lines to draw above/below it. The renderer
// (HistoryGraph) just turns that into SVG.
//
// Each lane holds the sha it is "waiting for" — the next commit expected in
// that column. A commit takes the (first) lane waiting for it; its first
// parent then continues in that lane, extra parents (merges) claim a lane
// already waiting for them or a free one, and any other lanes that were also
// waiting for this commit converge into it.

export interface GraphCommit {
  sha: string;
  parents: string[];
}

export interface GraphRow {
  sha: string;
  /** Column the commit's dot sits in. */
  lane: number;
  /** True if a line enters the dot from above (it was awaited by a lane). */
  fromAbove: boolean;
  /** Lanes with an unrelated line running straight through this row. */
  passThrough: number[];
  /** Other lanes whose lines converge into this commit from above. */
  mergeFrom: number[];
  /** Lanes the commit's parents continue in (first parent is `lane` itself). */
  parentLanes: number[];
  /** Number of columns needed to draw this row. */
  width: number;
}

export interface GraphLayout {
  rows: GraphRow[];
  /** Columns needed across the whole graph. */
  width: number;
}

/** Lanes drawn individually; every lane past this folds into one overflow lane. */
export const MAX_LANES = 6;

/** Stroke colour for a lane: the `--lane-*` tokens, dimmed past the cap. */
export function laneColour(lane: number): string {
  return lane >= MAX_LANES ? "var(--lane-more)" : `var(--lane-${lane + 1})`;
}

/** A row's lanes clamped to {@link MAX_LANES} visible columns plus an overflow column. */
export interface FoldedRow {
  lane: number;
  fromAbove: boolean;
  passThrough: number[];
  mergeFrom: number[];
  parentLanes: number[];
  /** Columns to draw: at most `MAX_LANES + 1`. */
  width: number;
  /** How many lanes were folded into the overflow lane (0 = none). */
  hidden: number;
}

/**
 * Folds every lane >= `cap` into column `cap` (the dimmed overflow lane) so a
 * row's width is bounded however wide the history gets. Works per row: a row
 * only pays for the lanes it actually draws, not the graph-wide maximum.
 */
export function foldRow(row: GraphRow, cap: number = MAX_LANES): FoldedRow {
  const fold = (l: number) => Math.min(l, cap);
  const uniq = (ls: number[]) => [...new Set(ls.map(fold))];
  const width = Math.min(row.width, cap + 1);
  return {
    lane: fold(row.lane),
    fromAbove: row.fromAbove,
    passThrough: uniq(row.passThrough),
    mergeFrom: uniq(row.mergeFrom),
    parentLanes: uniq(row.parentLanes),
    width,
    hidden: Math.max(0, row.width - cap),
  };
}

export function computeGraphLayout(commits: readonly GraphCommit[]): GraphLayout {
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];
  let maxWidth = 0;

  const freeLane = (): number => {
    const free = lanes.indexOf(null);
    if (free !== -1) return free;
    lanes.push(null);
    return lanes.length - 1;
  };

  for (const commit of commits) {
    const waiting = lanes.reduce<number[]>(
      (acc, s, i) => (s === commit.sha ? [...acc, i] : acc),
      [],
    );
    const fromAbove = waiting.length > 0;
    const lane = fromAbove ? waiting[0] : freeLane();
    const mergeFrom = waiting.slice(1);

    const passThrough: number[] = [];
    lanes.forEach((s, i) => {
      if (s !== null && s !== commit.sha) passThrough.push(i);
    });

    // Lanes that converged into this commit are free from here down.
    for (const i of mergeFrom) lanes[i] = null;

    const parentLanes: number[] = [];
    if (commit.parents.length === 0) {
      lanes[lane] = null;
    } else {
      lanes[lane] = commit.parents[0];
      parentLanes.push(lane);
      for (const parent of commit.parents.slice(1)) {
        const existing = lanes.indexOf(parent);
        if (existing !== -1) {
          parentLanes.push(existing);
        } else {
          const target = freeLane();
          lanes[target] = parent;
          parentLanes.push(target);
        }
      }
    }

    // Trim trailing free lanes so the graph doesn't stay wide after a branch ends.
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();

    const width = Math.max(
      lane + 1,
      ...passThrough.map((i) => i + 1),
      ...mergeFrom.map((i) => i + 1),
      ...parentLanes.map((i) => i + 1),
    );
    maxWidth = Math.max(maxWidth, width);
    rows.push({ sha: commit.sha, lane, fromAbove, passThrough, mergeFrom, parentLanes, width });
  }

  return { rows, width: maxWidth };
}
