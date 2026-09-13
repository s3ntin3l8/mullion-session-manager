import type { Project } from "../api/index.js";
import { PlusIcon } from "../ui/icons.js";
import { CustomSelect } from "../ui/CustomSelect.js";

// Split out of Dock.tsx (Wave 5 / PR 28 of
// .claude/plans/can-we-do-a-warm-cocke.md) — the "+ Add project" control in
// the dock's own header, for pinning a project not currently tiled in the
// active workspace as its own rail section. Renamed from "Add project
// column" by the unified-rail dock rework
// (.claude/plans/we-have-an-unintended-jaunty-globe.md) — there's no longer
// a per-project column to add, just a section in the dock's single shared
// rail.
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
    <div className="dock-add-select-wrap" title="Add a project to the dock">
      <PlusIcon size={12} strokeLinecap="round" />
      <CustomSelect
        className="dock-add-select"
        value=""
        placeholder="Add project"
        label="Add project"
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
