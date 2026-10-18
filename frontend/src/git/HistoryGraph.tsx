import { laneColour, type GraphRow } from "./graphLayout.js";

const LANE_W = 14;
export const ROW_H = 24;
const DOT_R = 4;

/** One row's slice of the commit graph, drawn as SVG from a GraphRow. */
export function HistoryGraph({ row, columns }: { row: GraphRow; columns: number }) {
  const x = (lane: number) => lane * LANE_W + LANE_W / 2;
  const mid = ROW_H / 2;
  const width = Math.max(columns, 1) * LANE_W;
  return (
    <svg
      className="gh-graph"
      width={width}
      height={ROW_H}
      viewBox={`0 0 ${width} ${ROW_H}`}
      aria-hidden
    >
      {row.passThrough.map((l) => (
        <line key={`p${l}`} x1={x(l)} y1={0} x2={x(l)} y2={ROW_H} stroke={laneColour(l)} />
      ))}
      {row.fromAbove && (
        <line x1={x(row.lane)} y1={0} x2={x(row.lane)} y2={mid} stroke={laneColour(row.lane)} />
      )}
      {row.mergeFrom.map((l) => (
        <line key={`m${l}`} x1={x(l)} y1={0} x2={x(row.lane)} y2={mid} stroke={laneColour(l)} />
      ))}
      {row.parentLanes.map((l) => (
        <line key={`c${l}`} x1={x(row.lane)} y1={mid} x2={x(l)} y2={ROW_H} stroke={laneColour(l)} />
      ))}
      <circle cx={x(row.lane)} cy={mid} r={DOT_R} fill={laneColour(row.lane)} />
    </svg>
  );
}
