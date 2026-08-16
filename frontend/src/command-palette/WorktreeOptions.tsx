import type { Dispatch, SetStateAction } from "react";
import { GitBranchIcon } from "../ui/icons.js";
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
// (`prev => prev || defaultBranch || currentBranch || branches[0] || ""`) the
// pre-extraction effect had — reading the parent's latest `baseRef` via `prev`
// rather than a possibly-stale value captured in this component's own
// closure. `prev ||` here is NOT the #680 production bug PromoteDialog.tsx's
// own header comment describes: this component has no competing
// auto-populated model suggestion racing the branches load, so `prev` really
// is "the user already picked something," not a stale suggestion silently
// pinned in place. Default preference order matches PromoteDialog's (issue
// #271 follow-up): the repo's default branch first, current branch as
// fallback.
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
  const { branches, currentBranch, defaultBranch, error } = useGitBranches(projectId, {
    enabled,
    onLoaded: ({ branches, currentBranch, defaultBranch }) => {
      onBaseRefChange((prev) => prev || defaultBranch || currentBranch || branches[0] || "");
    },
  });

  // Hermes review, PR #695 — `baseRef` can be seeded to `defaultBranch`
  // (or, on a later manual pick, anything) before it's actually present in
  // `branches`: `resolveDefaultBaseRefNoFetch` now verifies a symbolic-ref
  // target resolves to a real commit before returning it, but that's a
  // different check than "listRemoteBranches enumerated this exact ref" —
  // and unlike PromoteDialog, this picker had no fallback for the gap. A
  // native `<select>` given a `value` that isn't among its `<option>`s
  // renders the first option while React state still holds the mismatched
  // value — same prepend-if-missing fix PromoteDialog.tsx's own
  // `dropdownOptions` already uses.
  const dropdownOptions = (
    baseRef && !branches.includes(baseRef) ? [baseRef, ...branches] : branches
  ).map((name) => {
    const tag = name === defaultBranch ? "default" : name === currentBranch ? "current" : null;
    return { value: name, label: tag ? `${name} (${tag})` : name };
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
          <Dropdown small value={baseRef} onChange={onBaseRefChange} options={dropdownOptions} />
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
