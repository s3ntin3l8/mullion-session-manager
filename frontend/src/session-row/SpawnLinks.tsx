import type { CrossProjectParent } from "../sidebarHierarchy.js";

// #3456 — the cross-project parent/child markers on a session row. Each
// project's tree stays self-contained, so a child spawned into another
// project from a coordinator is only tied back to it by this label.

// The child's marker: "spawned by <title> · <project>". A live or exited
// parent is a link (an exited one dimmed, with an "ended" suffix: it can still
// be opened); a killed or missing one is plain text, since nothing can be
// opened. The click opens the parent and must not also open this row.
export function SpawnedByChip({
  parent,
  onOpenParent,
}: {
  parent: CrossProjectParent;
  onOpenParent?: () => void;
}) {
  if (parent.state === "killed" || parent.state === "missing" || !onOpenParent) {
    return (
      <span className="session-spawned-by removed">
        {parent.state === "killed" || parent.state === "missing"
          ? "spawned by a removed session"
          : `spawned by ${parent.title}`}
      </span>
    );
  }
  const exited = parent.state === "exited";
  // One string for the accessible name (and tests): the visible text is split
  // across spans below.
  const label = `spawned by ${parent.title}${parent.projectName ? ` · ${parent.projectName}` : ""}${
    exited ? " · ended" : ""
  }`;
  return (
    <button
      type="button"
      className={`session-spawned-by link${exited ? " exited" : ""}`}
      aria-label={label}
      title={`Open ${parent.title}`}
      onClick={(e) => {
        e.stopPropagation();
        onOpenParent();
      }}
    >
      {/* Split so a long title ellipsizes while the project name stays whole. */}
      <span className="session-spawned-by-part">spawned by </span>
      <span className="session-spawned-by-title">{parent.title}</span>
      {parent.projectName && (
        <span className="session-spawned-by-part"> · {parent.projectName}</span>
      )}
      {exited && <span className="session-spawned-by-part"> · ended</span>}
    </button>
  );
}

// The parent's side: a count of its live children in other projects, with the
// project names in the tooltip. Not interactive.
export function OtherProjectsBadge({
  count,
  projectNames,
}: {
  count: number;
  projectNames: string[];
}) {
  if (count <= 0) return null;
  return (
    <span className="session-other-projects" title={`In ${projectNames.join(", ")}`}>
      +{count} in other projects
    </span>
  );
}
