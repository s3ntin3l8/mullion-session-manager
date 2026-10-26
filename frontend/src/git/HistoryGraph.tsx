import { foldRow, laneColour, MAX_LANES, type GraphRow } from "./graphLayout.js";

const LANE_W = 9;
const PAD = 7;
export const ROW_H = 28;
const DOT_R = 4;

/** Widest a graph column can get: the capped lanes, the overflow lane, padding. */
export const MAX_GRAPH_W = (MAX_LANES + 1) * LANE_W + PAD;

/**
 * One row's slice of the commit graph, drawn as SVG. The width is this row's
 * own (capped at {@link MAX_LANES} lanes plus a dimmed overflow lane), never the
 * graph-wide maximum, so a deep branch elsewhere in the log cannot squeeze the
 * subject column.
 */
export function HistoryGraph({ row }: { row: GraphRow }) {
  const f = foldRow(row);
  const x = (lane: number) => PAD + lane * LANE_W;
  const mid = ROW_H / 2;
  const width = Math.max(f.width, 1) * LANE_W + PAD;
  const lineProps = (lane: number) => ({
    style: { stroke: laneColour(lane) },
    strokeWidth: lane >= MAX_LANES ? 1.5 : 2,
    strokeDasharray: lane >= MAX_LANES ? "2 2" : undefined,
  });
  return (
    <svg className="gh-graph" width={width} height={ROW_H} aria-hidden>
      {f.passThrough.map((l) => (
        <line key={`p${l}`} x1={x(l)} y1={0} x2={x(l)} y2={ROW_H} {...lineProps(l)} />
      ))}
      {f.fromAbove && <line x1={x(f.lane)} y1={0} x2={x(f.lane)} y2={mid} {...lineProps(f.lane)} />}
      {f.mergeFrom.map((l) => (
        <line key={`m${l}`} x1={x(l)} y1={0} x2={x(f.lane)} y2={mid} {...lineProps(l)} />
      ))}
      {f.parentLanes.map((l) => (
        <line key={`c${l}`} x1={x(f.lane)} y1={mid} x2={x(l)} y2={ROW_H} {...lineProps(l)} />
      ))}
      <circle
        cx={x(f.lane)}
        cy={mid}
        r={DOT_R}
        style={{ fill: laneColour(f.lane) }}
        className="gh-graph-dot"
      />
      {f.hidden > 0 && (
        <text className="gh-graph-more" x={x(MAX_LANES) - 3} y={9}>
          +{f.hidden}
        </text>
      )}
    </svg>
  );
}
