import { useCallback, useState } from "react";
import { api, LOCAL_HOST_ID } from "./api.js";
import type { GitFileStatus, GitStatus } from "./api.js";
import { useDashboardStore } from "./store.js";
import { parseUnifiedDiff, type DiffLine } from "./diffUtils.js";
import { useAsyncData } from "./hooks/useAsyncData.js";
import { Dropdown } from "./ui/primitives.js";
import { ChevronDownIcon, GitBranchIcon } from "./icons.js";
import { resolveActiveProjectId } from "./panelUtils.js";
import { STORAGE_KEYS, readBool, writeBool } from "./lib/persistedState.js";

// Sentinel Dropdown value meaning "go back to following the active panel" —
// distinct from any real project id (Dropdown is generic over string, and
// project ids stringify to plain digits, so this can't collide).
const FOLLOW_SENTINEL = "__follow__";

// Same threshold/reasoning as Sidebar.tsx's own BEHIND_STALE_THRESHOLD for
// the project row badge — kept as a separate constant (not exported/shared)
// since this file and Sidebar.tsx duplicate several small conventions
// already (see the file-diff component below), matching the repo's own
// "small guards get duplicated, not shared" precedent.
const BEHIND_STALE_THRESHOLD = 10;

function statusDotClass(status: GitFileStatus["status"]): string {
  switch (status) {
    case "A":
      return "good";
    case "D":
      return "bad";
    case "U":
      return "bad";
    default:
      return "pending";
  }
}

function syncSummary(status: GitStatus): string {
  return [
    status.ahead > 0 ? `↑${status.ahead}` : null,
    status.behind > 0 ? `↓${status.behind}` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

interface ProjectFileDiffProps {
  projectId: number;
  filePath: string;
}

// Sibling of Sidebar.tsx's own SessionFileDiff, not a shared abstraction —
// same "small guards get duplicated, not shared" precedent as
// lib/sidebarStatus.ts's sessionGitDotClass doc comment (PR 27 phase 1),
// and the two fetch from genuinely different endpoints (project- vs
// session-scoped).
function ProjectFileDiff({ projectId, filePath }: ProjectFileDiffProps) {
  const [diffLines, setDiffLines] = useState<DiffLine[] | null | undefined>(undefined);

  // No explicit "reset to undefined on filePath change" here — the call
  // site (below) only ever renders one ProjectFileDiff at a time, keyed by
  // its position under the matching file row, so switching which file is
  // expanded unmounts this instance and mounts a fresh one rather than
  // reusing it. Same shape as Sidebar.tsx's own SessionFileDiff.
  useAsyncData(
    () => api.getProjectGitFileDiff(projectId, filePath),
    (r) => setDiffLines(r.patch ? parseUnifiedDiff(r.patch) : null),
    () => setDiffLines(null),
    [projectId, filePath],
  );

  if (diffLines === undefined) {
    return (
      <div className="session-file-change-diff">
        <span className="session-diff-spinner">…</span>
      </div>
    );
  }

  if (diffLines === null || diffLines.length === 0) {
    return (
      <div className="session-file-change-diff">
        <span className="session-diff-empty">No changes</span>
      </div>
    );
  }

  return (
    <div className="session-file-change-diff">
      {diffLines.map((line, i) => (
        <span key={i} className={`session-diff-line session-diff-${line.type}`}>
          {line.text}
        </span>
      ))}
    </div>
  );
}

export interface SourceControlSectionProps {
  onOpenGit: (projectId: number) => void;
}

// Always-visible complement to the dockview GitPanel (issue #433 scope B) —
// branch, ahead/behind, per-file change list with inline diff, Fetch, and
// "Open Git Panel", for whichever project the sidebar currently considers
// "active". Collapsed by default; persists that across reloads the same way
// Sidebar.tsx's own row-expand state does (single boolean here, since this
// is one section rather than one entry per id).
export function SourceControlSection({ onOpenGit }: SourceControlSectionProps) {
  const projects = useDashboardStore((s) => s.projects);
  const sessions = useDashboardStore((s) => s.sessions);
  const activePanelId = useDashboardStore((s) => s.activePanelId);
  const gitStatuses = useDashboardStore((s) => s.gitStatuses);
  const fetchProjectGit = useDashboardStore((s) => s.fetchProjectGit);

  const [collapsed, setCollapsed] = useState(() =>
    readBool(STORAGE_KEYS.sourceControlCollapsed, true),
  );
  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      writeBool(STORAGE_KEYS.sourceControlCollapsed, next);
      return next;
    });
  }, []);

  // Pin (explicit user choice via the picker) and follow (the dockview
  // panel currently in focus) are deliberately separate pieces of state —
  // collapsing them into one would mean focusing a panel in another project
  // silently clobbers a pin. `lastDerivedId` exists only so the section
  // doesn't blank out when a non-project panel (Settings, Tasks) is
  // focused. Resolution order: pin > derived > last-derived > first project.
  //
  // Adjusts state during render (React's own recommended pattern — see
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  // and Sidebar.tsx's own promoteOpen/prevPromoteState for the identical
  // shape) rather than a `useEffect` + setState, which the project's lint
  // config (react-hooks/set-state-in-effect) rejects as a cascading-render
  // risk.
  const [pinnedProjectId, setPinnedProjectId] = useState<number | null>(null);
  const derivedId = resolveActiveProjectId(activePanelId, sessions);
  const [lastDerivedId, setLastDerivedId] = useState<number | null>(derivedId);
  if (derivedId != null && derivedId !== lastDerivedId) {
    setLastDerivedId(derivedId);
  }

  // A pinned or last-derived project can be deleted out from under this
  // section (Hermes review, PR #506) — release it rather than let the
  // Dropdown's value keep pointing at an option that no longer exists and
  // the body keep showing a project that's gone. `derivedId` doesn't need
  // this guard: it's recomputed fresh every render straight from
  // activePanelId/sessions, never held as stale state.
  if (pinnedProjectId != null && !projects.some((p) => p.id === pinnedProjectId)) {
    setPinnedProjectId(null);
  }
  if (lastDerivedId != null && !projects.some((p) => p.id === lastDerivedId)) {
    setLastDerivedId(null);
  }

  const effectiveProjectId =
    pinnedProjectId ?? derivedId ?? lastDerivedId ?? projects[0]?.id ?? null;
  const effectiveProject = projects.find((p) => p.id === effectiveProjectId);

  const gitStatus = effectiveProjectId != null ? (gitStatuses[effectiveProjectId] ?? null) : null;
  // gitStatuses[id] === null collapses three distinct states the store
  // itself can't tell apart (Hermes review, PR #506): durably not a repo,
  // never fetched yet, and — for a remote-hosted project only — the agent
  // host being unreachable (store.ts's refreshGitStatuses keeps the last-
  // known-good value for a *transient* failure, but a project that's never
  // had a successful fetch still lands on this same `null`). A local
  // project's host is this process itself, so "not a repo" is always the
  // honest read there; a remote-hosted project's null is genuinely
  // ambiguous, so its label says so rather than asserting a specific cause
  // that might be wrong.
  const isRemoteProject = effectiveProject != null && effectiveProject.hostId !== LOCAL_HOST_ID;

  // Same render-time-adjustment shape as lastDerivedId above — collapses
  // any expanded diff when the section switches to a different project.
  const [expandedFilePath, setExpandedFilePath] = useState<string | null>(null);
  const [expandedFileProjectId, setExpandedFileProjectId] = useState(effectiveProjectId);
  if (effectiveProjectId !== expandedFileProjectId) {
    setExpandedFileProjectId(effectiveProjectId);
    setExpandedFilePath(null);
  }

  const [isFetching, setIsFetching] = useState(false);
  const handleFetch = useCallback(async () => {
    if (effectiveProjectId == null) return;
    setIsFetching(true);
    try {
      await fetchProjectGit(effectiveProjectId);
      // Two separate staleness traps, both avoided here:
      //  1. Deliberately NOT store.refreshGitStatuses() — that batch call
      //     dedupes against the 4s live-refresh's own in-flight request
      //     (gitStatusesRefreshInFlight in store.ts), so a click mid-tick
      //     would await a request issued *before* this fetch landed.
      //  2. `fresh: true` bypasses the backend's own ~5s git-status cache
      //     (git-status.ts's CACHE_TTL_MS) — without it, the direct call
      //     below would typically just hand back that same pre-fetch cached
      //     read anyway, and `behind` still wouldn't visibly move (Hermes
      //     review, PR #506).
      // Writing the result straight into the shared store (rather than
      // separate local state) keeps this section and the sidebar's own
      // ahead/behind badge in sync without either going stale.
      const status = await api.getProjectGitStatus(effectiveProjectId, { fresh: true });
      useDashboardStore.setState((s) => ({
        gitStatuses: { ...s.gitStatuses, [effectiveProjectId]: status ?? null },
      }));
    } catch (err) {
      console.debug("[SourceControlSection] fetch failed", err);
    } finally {
      setIsFetching(false);
    }
  }, [effectiveProjectId, fetchProjectGit]);

  const dropdownOptions = [
    { value: FOLLOW_SENTINEL, label: "Follow active panel" },
    ...projects.map((p) => ({ value: String(p.id), label: p.name })),
  ];
  const dropdownValue = pinnedProjectId != null ? String(pinnedProjectId) : FOLLOW_SENTINEL;

  // Sticky combined sync summary — visible even while collapsed, since it's
  // the one number worth surfacing without expanding the section. `null`
  // entries in gitStatuses (not a repo, or never fetched) are routine, not
  // an error state, so they're silently skipped rather than treated as 0.
  const totals = Object.values(gitStatuses).reduce(
    (acc, s) => (s ? { ahead: acc.ahead + s.ahead, behind: acc.behind + s.behind } : acc),
    { ahead: 0, behind: 0 },
  );
  const hasTotals = totals.ahead > 0 || totals.behind > 0;

  if (projects.length === 0) return null;

  return (
    <div className="source-control-section">
      <div className="sidebar-section-header source-control-header" onClick={toggleCollapsed}>
        <ChevronDownIcon
          size={12}
          className={collapsed ? "ws-group-chevron collapsed" : "ws-group-chevron"}
        />
        <span className="sidebar-section-title">Source Control</span>
        {hasTotals && (
          <span
            className={`source-control-totals${totals.behind > BEHIND_STALE_THRESHOLD ? " stale" : ""}`}
            title={`${totals.ahead} ahead, ${totals.behind} behind origin across all projects (as of last fetch)`}
          >
            {totals.ahead > 0 && <span className="project-git-ahead">↑{totals.ahead}</span>}
            {totals.behind > 0 && <span className="project-git-behind">↓{totals.behind}</span>}
          </span>
        )}
      </div>
      {!collapsed && effectiveProjectId != null && (
        <div className="source-control-body">
          <div onClick={(e) => e.stopPropagation()}>
            <Dropdown
              small
              options={dropdownOptions}
              value={dropdownValue}
              onChange={(v) =>
                setPinnedProjectId(v === FOLLOW_SENTINEL ? null : Number.parseInt(v, 10))
              }
            />
          </div>

          {/* Same last-known-good convention as the store's batched
              gitStatuses map elsewhere (ProjectSection's own gitDotClass,
              GitPanel's pre-first-poll state): "not fetched yet" and
              "durably not a repo" both render as this one empty state
              rather than a distinct loading spinner, since a project that's
              never been a repo would otherwise flash "Loading…" forever. A
              remote-hosted project additionally can't rule out "host
              unreachable" here (see isRemoteProject's own comment above),
              so its label doesn't claim more than the data actually
              supports. */}
          {gitStatus === null ? (
            <div className="github-panel-empty-row" title={effectiveProject?.cwd}>
              {isRemoteProject
                ? "Not a git repository, or the host is unreachable."
                : "Not a git repository."}
            </div>
          ) : (
            <>
              <div className="source-control-branch-row">
                <GitBranchIcon size={13} />
                <span className="source-control-branch-name">{gitStatus.branch}</span>
                {(gitStatus.ahead > 0 || gitStatus.behind > 0) && (
                  <span
                    className="git-panel-ahead-behind"
                    title={`${syncSummary(gitStatus)} (as of last fetch)`}
                  >
                    {syncSummary(gitStatus)}
                  </span>
                )}
              </div>

              <div className="source-control-actions">
                <button className="git-panel-fetch-btn" onClick={handleFetch} disabled={isFetching}>
                  {isFetching ? "⟳" : "↻"} Fetch
                </button>
                <button
                  className="git-panel-fetch-btn"
                  onClick={() => onOpenGit(effectiveProjectId)}
                >
                  Open Git Panel
                </button>
              </div>

              {gitStatus.isClean ? (
                <div className="github-panel-empty-row">Working tree clean</div>
              ) : (
                <div className="github-panel-section">
                  {gitStatus.files.map((file) => (
                    <div key={file.path}>
                      <button
                        type="button"
                        className="github-panel-row source-control-file-row"
                        onClick={() =>
                          setExpandedFilePath((prev) => (prev === file.path ? null : file.path))
                        }
                      >
                        <span className={`github-panel-ci-dot ${statusDotClass(file.status)}`} />
                        <span className="github-panel-row-number">{file.status}</span>
                        <span className="github-panel-row-title">{file.path}</span>
                      </button>
                      {expandedFilePath === file.path && (
                        <ProjectFileDiff projectId={effectiveProjectId} filePath={file.path} />
                      )}
                    </div>
                  ))}
                </div>
              )}

              {gitStatus.hasConflicts && (
                <div className="github-panel-empty-row github-panel-conflicts">
                  This checkout has unresolved merge conflicts.
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
