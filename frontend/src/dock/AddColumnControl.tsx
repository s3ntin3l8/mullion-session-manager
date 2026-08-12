import type { Project } from "../api.js";
import { PlusIcon } from "../icons.js";
import { CustomSelect } from "../CustomSelect.js";

// Split out of Dock.tsx (Wave 5 / PR 28 of
// .claude/plans/can-we-do-a-warm-cocke.md) — the "+ Add project column"
// control in the dock's own header, for pinning a project not currently
// tiled in the active workspace.
export function AddColumnControl({
  projects,
  shownIds,
  onAdd,
}: {
  projects: Project[];
  shownIds: number[];
  onAdd: (id: number) => void;
}) {
  const remaining = projects.filter((p) => !shownIds.includes(p.id));
  return (
    <div className="dock-add-select-wrap" title="Add a project column">
      <PlusIcon size={12} strokeLinecap="round" />
      <CustomSelect
        className="dock-add-select"
        value=""
        placeholder="Add project column"
        label="Add project column"
        disabled={remaining.length === 0}
        menuPlacement="top"
        options={remaining.map((p) => ({ value: String(p.id), label: p.name }))}
        onChange={(v) => {
          if (v) onAdd(Number(v));
        }}
      />
    </div>
  );
}
