import { useState } from "react";
import { useDashboardStore } from "../store/index.js";
import { KebabMenu } from "../ui/KebabMenu.js";
import { deleteProjectAndEndSessions, gitPullState, pullProject } from "./projectActions.js";
import { ProjectEditModal } from "./ProjectEditModal.js";
import { LOCAL_HOST_ID } from "../api/index.js";
import type { Host, Project, Session } from "../api/index.js";
import { HostStatusLabel } from "../HostStatusLabel.js";
import {
  ChevronDownIcon,
  CloseIcon,
  FolderIcon,
  HostsIcon,
  PlusIcon,
  PullIcon,
  RenameIcon,
  SkillIcon,
} from "../ui/icons.js";

// Above this many commits behind origin, the badge switches to a louder
// color (issue #433 scope A's "color the badge to draw attention" ask) — an
// arbitrary but reasonable line between "you'll want to pull soon" and
// "you're working from a very stale checkout".
const BEHIND_STALE_THRESHOLD = 10;

// Extracted out of ProjectSection so both the plain (below-threshold) and
// virtualized (above-threshold) rendering paths share the exact same header
// markup/behavior instead of two copies drifting apart. Collapse is now
// owned by the CALLER (ProjectSection in Sidebar.tsx, or Sidebar's own flatten step
// reading `projectCollapsedState` directly in the virtualized path) — this
// component is a pure function of `collapsed`/`onToggleCollapsed`, with no
// state of its own for it, so it doesn't matter which path is driving.
//
// P1 perf fix (carried over from ProjectSection's original header comment)
// — every field this component reads is either a prop (never a rendered
// whole-store subscription) or a single fine-grained selector
// (`gitStatuses[project.id]` below), and every write goes through
// `useDashboardStore.getState()` at its own call site rather than a
// destructured store hook — the same "selector or getState(), never a bare
// `useDashboardStore()`" rule Sidebar.tsx's other components follow.
export function ProjectHeader({
  project,
  sessions,
  hosts,
  collapsed,
  onToggleCollapsed,
  onOpenLauncher,
  onSessionEnded,
  onOpenProjectSetup,
  bodyId,
}: {
  project: Project;
  sessions: Session[];
  hosts: Host[];
  collapsed: boolean;
  // Omitted for a row with no body to open (#2075's "Other projects"): the
  // header is then plain content, not a disclosure button, so its own "+"
  // and menu are not nested inside a button.
  onToggleCollapsed?: () => void;
  onOpenLauncher: () => void;
  onSessionEnded: (session: Session) => void;
  // Phase 4 (Gap F) — "Scaffold Mullion" kebab-menu entry, bound to this
  // project at the call site (ProjectSection/VirtualizedProjectTree),
  // same shape as onOpenLauncher above.
  onOpenProjectSetup: () => void;
  // P10/P11 polish — id of the collapsible region this header's
  // `aria-expanded` governs, for `aria-controls` (the disclosure-button
  // pattern; see UnifiedBoard.tsx's `kanban-lane-body` precedent). Only
  // ProjectSection's plain (below-threshold) rendering path has a single
  // contiguous body element to point at — the virtualized path (Sidebar's
  // own flatten step, above) renders each project's session rows as
  // independent absolutely-positioned siblings within one shared
  // virtualizer container, with no per-project wrapper element to give an
  // id, so that call site leaves this undefined rather than pointing
  // `aria-controls` at a div that doesn't exist.
  bodyId?: string;
}) {
  const [editOpen, setEditOpen] = useState(false);
  // P9 — deleteProject used to be `void deleteProject(...).then(...)` with
  // no `.catch` at all: a failure (a 503 host-unreachable, a locked file on
  // the project's own cwd, ...) left the project sitting in the sidebar
  // with no explanation, indistinguishable from the click never having
  // registered. Local, inline error state — same shape as
  // UnifiedBoard.tsx's TasksToolbar — rendered as a second line under this
  // header, same slot SessionRow's own eventLine/endError use.
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Issue #431-adjacent — Git pull shortcut's own inline error, mirroring
  // deleteError's slot. A pull can fail for visible reasons (dirty tree,
  // detached HEAD, conflicts), and SourceControlSection's Pull button already
  // surfaces the same shape there — keep parity.
  const [pullError, setPullError] = useState<string | null>(null);

  const attentionCount = sessions.filter((s) => s.attention).length;
  // Only a remote project needs a badge at all — the common single-host
  // deployment never shows one, matching CreateProjectModal's own selector
  // only appearing once a remote host exists.
  const host = project.hostId !== LOCAL_HOST_ID ? hosts.find((h) => h.id === project.hostId) : null;

  // Per-project git dirty badge (issue #76) — sourced from the store's
  // gitStatuses map (polled alongside sessions, see store.ts's
  // startLiveRefresh). A missing entry (not fetched yet, right after mount,
  // or a project that's genuinely never been a repo) renders the same as
  // `null` — both read as "nothing to report" rather than a distinct loading
  // state, which would just flicker on every mount. A project that HAS had a
  // successful fetch keeps showing that last-known-good entry through any
  // later transient failure (refreshGitStatuses preserves it rather than
  // overwriting with null) — this is what stops the dot from flickering
  // green→grey on a single flaky poll tick.
  const gitStatus = useDashboardStore((s) => s.gitStatuses[project.id]);
  // Issue #730 — the New-session button is inert in the Task view (no
  // workspace to open a terminal in), so it reads viewMode to disable itself.
  const viewMode = useDashboardStore((s) => s.viewMode);
  const gitDotClass = !gitStatus
    ? "none"
    : gitStatus.hasConflicts
      ? "conflict"
      : gitStatus.isClean
        ? "clean"
        : "dirty";
  const gitDotTitle = !gitStatus
    ? "Not a git repository"
    : gitStatus.hasConflicts
      ? `${gitStatus.branch}: unresolved merge conflicts`
      : gitStatus.isClean
        ? `${gitStatus.branch}: clean`
        : `${gitStatus.branch}: ${gitStatus.files.length} changed file${gitStatus.files.length === 1 ? "" : "s"}`;

  // Ahead/behind sync badge (issue #433 scope A) — `behind` only advances on
  // a `git fetch`, so it's only ever as fresh as the last one (auto-fetch,
  // or a manual Fetch from the Source Control section). The title's
  // "as of last fetch" caveat is what keeps a stale `↓0` (auto-fetch off, or
  // a branch with no upstream, both of which report 0/0 the same way
  // Source Control's own ahead/behind row does) from silently reading as "you are
  // up to date" — see Source Control's own `> 0` guards for the same posture.
  const gitSyncTitle = gitStatus
    ? `${gitStatus.branch}: ` +
      [
        gitStatus.ahead > 0 ? `${gitStatus.ahead} ahead` : null,
        gitStatus.behind > 0 ? `${gitStatus.behind} behind origin` : null,
      ]
        .filter(Boolean)
        .join(", ") +
      " (as of last fetch)"
    : "";

  return (
    <>
      <div
        className="project-row-header"
        onClick={onToggleCollapsed}
        // #3106 — a plain container, not a role="button": it holds its own
        // "+ session" button and kebab menu, and a control inside a control
        // is axe's nested-interactive. A pointer still toggles by clicking
        // anywhere on it (each nested control stops its own click); the
        // keyboard gets the one real disclosure button below, first in tab
        // order — the session row's pattern (SessionRow.tsx).
      >
        {onToggleCollapsed && (
          // No onClick of its own: Enter/Space fire a click that bubbles to
          // the header's onClick, so the toggle runs exactly once. Named by
          // the project, the header's first visible word; it shows nothing
          // itself, so there is no visible text to mismatch.
          <button
            type="button"
            className="visually-hidden project-row-toggle"
            aria-label={project.name}
            aria-expanded={!collapsed}
            aria-controls={bodyId}
          />
        )}
        {onToggleCollapsed ? (
          <ChevronDownIcon
            size={12}
            className={collapsed ? "ws-group-chevron collapsed" : "ws-group-chevron"}
          />
        ) : null}
        <FolderIcon size={15} />
        <span
          className="project-row-name"
          // Sidebar declutter — the agent-rules presence icon (issue #431)
          // used to sit in the header as its own always-on glyph; since it
          // never changes state (it's just "does this project have rule
          // files"), it's folded into this tooltip instead, alongside the
          // cwd. The command palette's "Agent Rules: <project>" entry stays
          // the actual click target — this was never interactive.
          title={
            project.ruleFiles.length > 0
              ? `${project.cwd}\nAgent rules: ${project.ruleFiles.join(", ")}`
              : project.cwd
          }
        >
          {project.name}
        </span>
        <span className={`project-git-dot ${gitDotClass}`} title={gitDotTitle} />
        {/* Issue #433 scope A — ahead/behind vs. origin, already computed
          server-side into gitStatus.ahead/behind and already polled via
          the same gitStatuses map as the dot above; just not surfaced
          here until now. Renders nothing at 0/0 (a synced branch, or one
          with no upstream) — see Source Control's own ahead/behind row for
          the identical guard. */}
        {gitStatus && (gitStatus.ahead > 0 || gitStatus.behind > 0) && (
          <span
            className={`project-git-sync${gitStatus.behind > BEHIND_STALE_THRESHOLD ? " stale" : ""}`}
            title={gitSyncTitle}
          >
            {gitStatus.ahead > 0 && <span className="project-git-ahead">↑{gitStatus.ahead}</span>}
            {gitStatus.behind > 0 && (
              <span className="project-git-behind">↓{gitStatus.behind}</span>
            )}
          </span>
        )}
        {/* Phase 4 (Gap F) — `project.conventionsHash` (Phase 3) is null
          until the first successful Scaffold Mullion apply stamps it
          (schema.ts's own `conventionsHash` column, alongside `slug` in
          the same /setup/apply write), so this needs no new backend
          signal or frontend type change. Same non-interactive posture as
          the rule-files indicator above — the kebab menu's "Scaffold
          Mullion" entry below is the click target. */}
        {project.conventionsHash == null && (
          <span className="project-unscaffolded-indicator" title="Never scaffolded with Mullion">
            <SkillIcon size={11} />
          </span>
        )}
        {host && (
          <span className="project-host-badge" title={`Runs on host: ${host.name}`}>
            <HostsIcon size={10} />
            {host.name}
          </span>
        )}
        {/* Issue #1892 — outside the badge's own max-width, so a long host
            name cannot ellipsis the status words away. */}
        {host && <HostStatusLabel host={host} />}
        {attentionCount > 0 && <span className="project-attn-pill">{attentionCount}</span>}
        {/* Sidebar declutter — a project with no sessions at all doesn't need
          a "0" sitting in its header; the plain count only earns its place
          once there's something to count. */}
        {sessions.length > 0 && <span className="project-session-count">{sessions.length}</span>}
        <button
          className="project-add-session"
          title={
            viewMode === "kanban"
              ? "New session (unavailable in Task view)"
              : "New session in project"
          }
          disabled={viewMode === "kanban"}
          onClick={(e) => {
            e.stopPropagation();
            onOpenLauncher();
          }}
        >
          <PlusIcon size={13} strokeLinecap="round" strokeWidth={2.2} />
        </button>
        <span onClick={(e) => e.stopPropagation()}>
          <KebabMenu
            menuPlacement="auto"
            title="More…"
            items={[
              {
                key: "edit",
                label: "Edit",
                icon: <RenameIcon size={14} style={{ color: "var(--muted)" }} />,
                onClick: () => setEditOpen(true),
                // Opens the Edit-project modal, which traps focus itself.
                opensOverlay: true,
              },
              {
                key: "git-pull",
                // Issue #431-adjacent — sidebar shortcut for `git pull`,
                // mirrors the disabled-gating on SourceControlSection's Pull
                // button (which only enables when behind > 0, i.e. only when
                // the operation would do something). Disabled-state messages
                // route through KebabMenu's `title` field (issue #1106), so a
                // user hovering an inert item sees why it's inert — not the
                // "looks enabled but does nothing" surprise the same issue
                // fixed for the kill-session overflow item.
                label: "Git pull",
                icon: <PullIcon size={14} style={{ color: "var(--muted)" }} />,
                ...gitPullState(project, gitStatus),
                onClick: async () => {
                  setPullError(null);
                  setPullError(await pullProject(project.id));
                },
              },
              {
                key: "scaffold-mullion",
                label: "Scaffold Mullion",
                icon: <SkillIcon size={14} style={{ color: "var(--muted)" }} />,
                onClick: onOpenProjectSetup,
              },
              {
                key: "delete",
                label: "Delete project",
                armLabel: "Click again to delete",
                icon: <CloseIcon size={14} />,
                danger: true,
                confirm: true,
                onClick: async () => {
                  setDeleteError(null);
                  setDeleteError(
                    await deleteProjectAndEndSessions(project.id, sessions, onSessionEnded),
                  );
                },
              },
            ]}
          />
        </span>
        {editOpen && (
          <span onClick={(e) => e.stopPropagation()}>
            <ProjectEditModal project={project} hosts={hosts} onClose={() => setEditOpen(false)} />
          </span>
        )}
      </div>
      {deleteError && (
        <div className="project-row-error" title={deleteError}>
          {deleteError}
        </div>
      )}
      {pullError && (
        <div className="project-row-error" title={pullError}>
          {pullError}
        </div>
      )}
    </>
  );
}
