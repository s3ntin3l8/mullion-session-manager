import { useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { api } from "../api/index.js";
import { useAsyncData } from "../hooks/useAsyncData.js";
import { Dropdown } from "../ui/primitives.js";

// #3071 — the launcher's Worktree row: a switch and the base-branch dropdown
// beside it, one row that never changes height. The dropdown is always
// there, disabled while the switch is off; a launch placed on another host
// shows "the host's default branch" in its place (the server picks it, #2237);
// a project without branches (not a git repository, or the list failed)
// disables the row with a one-line reason instead of an empty dropdown.
//
// The command palette keeps command-palette/WorktreeOptions.tsx, which only
// fetches once its checkbox is ticked. This row needs to know up front
// whether there is anything to branch from, so it fetches on every project.

type Branches =
  | {
      projectId: number;
      status: "ready";
      options: string[];
      current: string | null;
      def: string | null;
    }
  | { projectId: number; status: "none"; reason: string };

export function LauncherWorktreeRow({
  projectId,
  labelId,
  enabled,
  onEnabledChange,
  baseRef,
  onBaseRefChange,
  baseOnPlacedHost,
  coarse,
}: {
  projectId: number;
  // The row's visible "Worktree" label, which names the dropdown.
  labelId: string;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  baseRef: string;
  onBaseRefChange: Dispatch<SetStateAction<string>>;
  baseOnPlacedHost: boolean;
  coarse: boolean;
}) {
  const [loaded, setLoaded] = useState<Branches | null>(null);
  useAsyncData(
    () => api.getProjectGitBranches(projectId),
    (result) => {
      const local = (result?.branches ?? []).map((b) => b.name);
      const options = [...local, ...(result?.remoteBranches ?? [])];
      if (options.length === 0) {
        setLoaded({ projectId, status: "none", reason: "Not a git repository" });
        onEnabledChange(false);
        return;
      }
      const current = result?.branches?.find((b) => b.isCurrent)?.name ?? null;
      const def = result?.defaultBranch ?? null;
      setLoaded({ projectId, status: "ready", options, current, def });
      // A ref picked for this project is kept; one left over from another
      // project is replaced by this one's default (then its current branch).
      onBaseRefChange((prev) =>
        prev && options.includes(prev) ? prev : (def ?? current ?? options[0] ?? ""),
      );
    },
    (err: unknown) => {
      console.debug("[LauncherWorktreeRow] getProjectGitBranches failed", err);
      const detail = err instanceof Error ? err.message : null;
      setLoaded({
        projectId,
        status: "none",
        reason: detail ? `Could not list branches: ${detail}` : "Could not list branches",
      });
      onEnabledChange(false);
    },
    [projectId],
    { enabled: !baseOnPlacedHost },
  );
  // Another project's result is no result: still loading this one.
  const branches = loaded?.projectId === projectId ? loaded : null;
  const unavailable = !baseOnPlacedHost && branches?.status === "none";

  let control;
  if (baseOnPlacedHost) {
    control = <span className="launcher-form-note">the host&apos;s default branch</span>;
  } else if (branches?.status === "none") {
    control = (
      <span className="launcher-form-note" title={branches.reason}>
        {branches.reason}
      </span>
    );
  } else {
    const options =
      branches === null
        ? [{ value: baseRef, label: "Loading branches…" }]
        : (baseRef && !branches.options.includes(baseRef)
            ? [baseRef, ...branches.options]
            : branches.options
          ).map((name) => {
            const tag =
              name === branches.def ? "default" : name === branches.current ? "current" : null;
            return { value: name, label: tag ? `${name} (${tag})` : name };
          });
    control = (
      <>
        <span className="launcher-form-from" aria-hidden="true">
          from
        </span>
        <Dropdown
          className="launcher-form-fill"
          ariaLabel="Base branch"
          value={baseRef}
          onChange={onBaseRefChange}
          options={options}
          disabled={!enabled || branches === null}
        />
      </>
    );
  }

  return (
    <div className="launcher-form-control launcher-worktree">
      <button
        type="button"
        role="switch"
        aria-checked={enabled && !unavailable}
        aria-label="Isolate in a new worktree"
        aria-describedby={labelId}
        // aria-disabled, not disabled: focus must not drop out of the dialog.
        aria-disabled={unavailable || undefined}
        className={`settings-toggle session-launcher-switch${enabled && !unavailable ? " on" : ""}${
          coarse ? " coarse" : ""
        }`}
        onClick={() => {
          if (!unavailable) onEnabledChange(!enabled);
        }}
      >
        <span className="settings-toggle-knob" />
      </button>
      {control}
    </div>
  );
}
