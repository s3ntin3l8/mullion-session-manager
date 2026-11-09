import { Segmented } from "../ui/primitives.js";
import type { CardDensity, GroupBy } from "./taskLanes.js";

// The Display menu's layout entries (epic #2847, #2841): how the columns are grouped into
// lanes and how roomy a card is. They slot into DisplayMenuPanel through TaskFilterBar's
// `displayExtra`. Group by is hidden on phone, which shows one column at a time.
export function DisplayLayoutControls({
  groupBy,
  onGroupBy,
  density,
  onDensity,
  showGroupBy = true,
}: {
  groupBy: GroupBy;
  onGroupBy: (next: GroupBy) => void;
  density: CardDensity;
  onDensity: (next: CardDensity) => void;
  showGroupBy?: boolean;
}) {
  return (
    <>
      {showGroupBy && (
        <>
          <div className="task-pop-h">Group by</div>
          <Segmented<GroupBy>
            ariaLabel="Group by"
            value={groupBy}
            onChange={onGroupBy}
            options={[
              { value: "none", label: "None" },
              { value: "epic", label: "Epic" },
              { value: "project", label: "Project" },
            ]}
          />
        </>
      )}
      <div className="task-pop-h">Card density</div>
      <Segmented<CardDensity>
        ariaLabel="Card density"
        value={density}
        onChange={onDensity}
        options={[
          { value: "compact", label: "Compact" },
          { value: "comfortable", label: "Comfortable" },
        ]}
      />
    </>
  );
}
