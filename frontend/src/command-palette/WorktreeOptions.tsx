import type { Dispatch, SetStateAction } from "react";
import { GitBranchIcon } from "../icons.js";
import { useGitBranches } from "../hooks/useGitBranches.js";
import { Dropdown } from "../ui/primitives.js";

// Issue #271, option 1 — the launcher's opt-in "isolate this session" toggle:
// launch directly into a fresh worktree instead of the target project's own
// cwd. Extracted verbatim from CommandPalette.tsx (PR 29, Wave 5 of
// .claude/plans/can-we-do-a-warm-cocke.md) — self-contained aside from
// `enabled`/`baseRef`, which CommandPalette's own `launch()` handler also
// reads at launch time, so those two stay lifted into the parent and are
// passed down as controlled props rather than owned here.
//
// `onBaseRefChange` takes the raw `Dispatch<SetStateAction<string>>` (not a
// plain `(ref: string) => void`) so this component's `useGitBranches` `onLoaded`
// callback can keep using the exact same functional update
// (`prev => prev || currentBranch || branches[0] || ""`) the pre-extraction
// effect had — reading the parent's latest `baseRef` via `prev` rather than a
// possibly-stale value captured in this component's own closure.
export interface WorktreeOptionsProps {
  projectId: number;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  baseRef: string;
  onBaseRefChange: Dispatch<SetStateAction<string>>;
}

export function WorktreeOptions({
  projectId,
  enabled,
  onEnabledChange,
  baseRef,
  onBaseRefChange,
}: WorktreeOptionsProps) {
  const { branches, error } = useGitBranches(projectId, {
    enabled,
    onLoaded: ({ branches, currentBranch }) => {
      onBaseRefChange((prev) => prev || currentBranch || branches[0] || "");
    },
  });

  return (
    <div className="cmd-palette-target-row cmd-palette-worktree-row">
      <label className="cmd-palette-worktree-toggle">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onEnabledChange(e.target.checked)}
        />
        <GitBranchIcon size={13} style={{ color: "var(--muted)" }} />
        <span>Isolate in a new worktree</span>
      </label>
      {enabled && (
        <div className="cmd-palette-worktree-picker">
          <Dropdown
            small
            value={baseRef}
            onChange={onBaseRefChange}
            options={branches.map((name) => ({ value: name, label: name }))}
          />
          {error && (
            <span className="cmd-palette-inline-error" title={error}>
              {error}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
