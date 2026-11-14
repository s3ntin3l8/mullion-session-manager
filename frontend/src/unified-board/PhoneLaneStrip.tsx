import type { PhoneSegmentId } from "../tasksBoard.js";

// The phone board's lane strip (#3014, design frame 3a): it names every lane
// with its count, underlines the one on screen, and puts a dot on each lane
// that holds a task needing the owner. Lanes are statuses only; "Needs you" is
// the filter bar's chip, not a lane.
export function PhoneLaneStrip({
  lanes,
  current,
  needingYou,
  onSelect,
}: {
  lanes: ReadonlyArray<{ id: PhoneSegmentId; title: string; count: number }>;
  current: PhoneSegmentId;
  needingYou: ReadonlySet<PhoneSegmentId>;
  onSelect: (id: PhoneSegmentId) => void;
}) {
  return (
    <div
      className="tasks-phone-strip tasks-phone-strip--segmented"
      role="group"
      aria-label="Task status"
    >
      {lanes.map((lane) => (
        <button
          key={lane.id}
          type="button"
          className="tasks-phone-strip-chip"
          aria-pressed={lane.id === current}
          onClick={() => onSelect(lane.id)}
        >
          {lane.title}
          <span className="tasks-phone-strip-count">{lane.count}</span>
          {needingYou.has(lane.id) && (
            <span className="tasks-phone-strip-dot" role="img" aria-label="needs you" />
          )}
        </button>
      ))}
    </div>
  );
}
