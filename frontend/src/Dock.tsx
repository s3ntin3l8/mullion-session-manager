import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { api } from "./api.js";
import type {
  DockControl,
  GitBranchesResult,
  GitHubPRsStatus,
  GitHubStatus,
  Project,
  Session,
} from "./api.js";
import { useDashboardStore } from "./store.js";
import { ChevronDownIcon, DockIcon, GitHubIcon, GlobeIcon, PlusIcon } from "./icons.js";
import { TerminalPane } from "./TerminalPane.js";
import { CustomSelect } from "./CustomSelect.js";

const DOCK_COLLAPSED_KEY = "crs.dockCollapsed";
const DOCK_HEIGHT_KEY = "crs.dockHeight";
const DOCK_MANUAL_KEY = "crs.dockManualProjects";
const DEFAULT_DOCK_HEIGHT = 220;
const DOCK_MIN_HEIGHT = 120;
// Must equal .dockview-container's min-height in styles.css — the resize
// drag's clamp and the CSS floor have to agree, or the CSS floor silently
// wins and the drag looks like it stopped responding partway through.
const GRID_MIN_HEIGHT = 160;
const COLUMN_MIN_WIDTH = 200;

function clamp(n: number, min: number, max: number) {
  return Math.min(Math.max(n, min), max);
}

// Maps the aggregate CI read (src/services/github.ts's computeCiStatus) to
// the same 3-color dot language GitHubPanel.tsx's Actions section uses
// (issue #27 phase 5) — `null` (Actions disabled/no runs) renders nothing
// at all, not a neutral dot, so this is only called when non-null.
function ciDotClass(status: "success" | "failure" | "in_progress"): "good" | "bad" | "pending" {
  if (status === "success") return "good";
  if (status === "failure") return "bad";
  return "pending";
}

// Mirrors src/services/git-worktree.ts's isDockPreviewWorktree/
// DOCK_PREVIEW_PREFIX — keep the two in sync. A dock preview worktree is
// transient and checked out with a DETACHED HEAD (PR #341 review), so
// listWorktrees reports its `branch` as null, meaning it no longer gets
// filtered out of the branch dropdown's own "<branch> (preview)" options
// (correct — that entry must stay available) but WOULD otherwise show up a
// second time in the worktree options, labeled with its raw path. Filtering
// it out here also closes a pre-existing gap: selecting a preview worktree
// by path created a session with a plain `cwd` and no `worktree` intent, so
// the backend never tracked it for sync/cleanup.
function isDockPreviewPath(worktreePath: string): boolean {
  return (worktreePath.split("/").pop() ?? "").startsWith("dock-preview-");
}

/**
 * Resolves which option value a monitor's worktree/branch `<select>` should
 * show. The result is always a member of `optionValues` when one exists at
 * all — a dock-preview worktree is deliberately absent from those options
 * (see `isDockPreviewPath`), so naively preferring a running session's raw
 * `cwd` would render the select blank whenever that cwd happens to be a
 * preview path. Order of preference:
 *
 * 1. A running preview session's `previewBranch`, re-expressed as the
 *    `branch:<name>` option value — the only way to resolve a running
 *    preview session back to an option, since its `cwd` is never one.
 * 2. A running session's `cwd`, when that cwd matches a real option (the
 *    common case: running in the main checkout or a real worktree).
 * 3. The user's last manual selection, when it still matches an option.
 * 4. An escape hatch for the moment right after a launch, before
 *    `refreshGitRefs` has picked up a brand-new worktree/branch — but never
 *    for a dock-preview path, which must never be the select's value.
 * 5. The main checkout, then the control's own configured cwd, then "".
 */
function resolveSelectedValue(params: {
  running: Session | undefined;
  storedValue: string | undefined;
  optionValues: Set<string>;
  mainCheckoutPath: string | undefined;
  controlCwd: string | undefined;
}): string {
  const { running, storedValue, optionValues, mainCheckoutPath, controlCwd } = params;

  const previewValue = running?.previewBranch ? `branch:${running.previewBranch}` : null;
  if (previewValue && optionValues.has(previewValue)) return previewValue;

  if (running?.cwd && optionValues.has(running.cwd)) return running.cwd;

  if (storedValue && optionValues.has(storedValue)) return storedValue;

  if (running?.cwd && !isDockPreviewPath(running.cwd)) return running.cwd;
  if (storedValue && !storedValue.startsWith("branch:") && !isDockPreviewPath(storedValue)) {
    return storedValue;
  }

  return mainCheckoutPath ?? controlCwd ?? "";
}

// The dock: persistent monitors (dev server, git status, logs) — distinct
// from one-shot session launches. Config is read-only (.crs/dock.json /
// global CRS_CONFIG_DIR/dock.json), so a column can't create a monitor that
// isn't already configured; a control here toggles an already-configured
// monitor on/off, which is just a session with kind:"dock" (sessions.ts) that
// this component keeps out of the normal per-project session inventory.
//
// One column per project — auto-derived from whichever projects have a
// session tiled in the active workspace (workspaceProjectIds, computed in
// App.tsx from the live dockview panels), plus any manually pinned via
// "+ Add project column" for a project not currently in the workspace.
// There's no workspace<->project link in the DB, so the auto set is purely
// derived at render time, not persisted; only the manual additions and the
// dock's own region height are (localStorage, same pattern as the existing
// collapse flag below).
export function Dock({
  workspaceProjectIds,
  onOpenGitHub,
  onOpenBrowser,
}: {
  workspaceProjectIds: number[];
  onOpenGitHub: (projectId: number) => void;
  // Issue #28 — same "glance row opens the fuller panel" shape as
  // onOpenGitHub above, but gated on the project having a devServerUrl
  // configured (see the row below) rather than a fetched status, since
  // there's no server round-trip needed to know whether it's applicable.
  onOpenBrowser: (projectId: number) => void;
}) {
  const { projects, sessions } = useDashboardStore();
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(DOCK_COLLAPSED_KEY) === "1",
  );
  const [height, setHeight] = useState(() => {
    const n = Number(localStorage.getItem(DOCK_HEIGHT_KEY));
    return Number.isFinite(n) && n > 0 ? clamp(n, DOCK_MIN_HEIGHT, Infinity) : DEFAULT_DOCK_HEIGHT;
  });
  const [manualIds, setManualIds] = useState<number[]>(() => {
    try {
      const raw: unknown = JSON.parse(localStorage.getItem(DOCK_MANUAL_KEY) ?? "[]");
      return Array.isArray(raw) ? raw.filter((x): x is number => typeof x === "number") : [];
    } catch {
      return [];
    }
  });
  // Column widths from divider drags — ephemeral (not persisted): the
  // column set itself is mostly derived, so a stored width map would just
  // accumulate stale entries for projects that drift in and out of view.
  const [widths, setWidths] = useState<Record<number, number>>({});

  const dockRef = useRef<HTMLDivElement>(null);

  const toggleCollapsed = () => {
    setCollapsed((v) => {
      const next = !v;
      localStorage.setItem(DOCK_COLLAPSED_KEY, next ? "1" : "0");
      return next;
    });
  };

  // Workspace-derived columns first (in their existing order), then any
  // manually-pinned project not already in that set — dropping ids for
  // projects that no longer exist (e.g. deleted since the id was pinned).
  const columnIds = useMemo(() => {
    const ids = [...workspaceProjectIds];
    for (const id of manualIds) {
      if (!ids.includes(id)) ids.push(id);
    }
    return ids.filter((id) => projects.some((p) => p.id === id));
  }, [workspaceProjectIds, manualIds, projects]);

  const persistManual = (next: number[]) => {
    setManualIds(next);
    localStorage.setItem(DOCK_MANUAL_KEY, JSON.stringify(next));
  };
  const addColumn = (id: number) => {
    if (!manualIds.includes(id)) persistManual([...manualIds, id]);
  };
  const removeColumn = (id: number) => persistManual(manualIds.filter((x) => x !== id));
  // A column only gets a remove-x when it's pinned AND not also derived from
  // the workspace — otherwise it would just reappear on the next render.
  const manualOnly = (id: number) => manualIds.includes(id) && !workspaceProjectIds.includes(id);

  const liveCount = sessions.filter(
    (s) =>
      s.kind === "dock" &&
      s.status === "active" &&
      columnIds.includes(s.projectId) &&
      (s.activity === "working" || s.alive),
  ).length;

  // ---- Dock region height (drag handle on the top border) ----
  const heightDragRef = useRef<{ startY: number; startH: number; maxH: number } | null>(null);
  const [heightDragging, setHeightDragging] = useState(false);

  const onHeightHandleMouseDown = (e: ReactMouseEvent) => {
    e.preventDefault();
    const dockEl = dockRef.current;
    // Measure the two flex siblings directly (not the shared parent's
    // clientHeight, which also includes the mobile-only tab bar / sidebar
    // toggle) so the available-space math stays correct regardless of
    // which of those happen to be rendered.
    const dockviewEl = dockEl?.parentElement?.querySelector<HTMLElement>(".dockview-container");
    const available = (dockEl?.clientHeight ?? 0) + (dockviewEl?.clientHeight ?? 0);
    const maxH = Math.max(DOCK_MIN_HEIGHT, available - GRID_MIN_HEIGHT);
    heightDragRef.current = { startY: e.clientY, startH: height, maxH };
    setHeightDragging(true);
  };

  useEffect(() => {
    if (!heightDragging) return;
    const onMove = (e: MouseEvent) => {
      const d = heightDragRef.current;
      if (!d) return;
      // Handle sits on the TOP border: dragging up (clientY decreases) grows
      // the dock, matching the direction the border itself moves.
      setHeight(clamp(d.startH + (d.startY - e.clientY), DOCK_MIN_HEIGHT, d.maxH));
    };
    const onUp = () => setHeightDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "ns-resize";
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [heightDragging]);

  const heightMountedRef = useRef(false);
  useEffect(() => {
    // Skip the initial mount (heightDragging starts false) so a user who
    // never touches the resize handle doesn't get the clamped/defaulted
    // height silently written back to localStorage — persist on drag end
    // only. Reads the latest `height` intentionally, so this can't be keyed
    // on it too.
    if (!heightMountedRef.current) {
      heightMountedRef.current = true;
      return;
    }
    if (!heightDragging) localStorage.setItem(DOCK_HEIGHT_KEY, String(height));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- persist-on-drag-end, height read intentionally
  }, [heightDragging]);

  // ---- Column divider resize ----
  const widthDragRef = useRef<{
    leftId: number;
    rightId: number;
    startX: number;
    leftW: number;
    rightW: number;
  } | null>(null);
  const [colDragging, setColDragging] = useState(false);

  const onDividerMouseDown = (e: ReactMouseEvent, rightIndex: number) => {
    e.preventDefault();
    const cols = dockRef.current?.querySelectorAll<HTMLElement>(".dock-column");
    const leftEl = cols?.[rightIndex - 1];
    const rightEl = cols?.[rightIndex];
    if (!leftEl || !rightEl) return;
    widthDragRef.current = {
      leftId: columnIds[rightIndex - 1],
      rightId: columnIds[rightIndex],
      startX: e.clientX,
      leftW: leftEl.getBoundingClientRect().width,
      rightW: rightEl.getBoundingClientRect().width,
    };
    setColDragging(true);
  };

  useEffect(() => {
    if (!colDragging) return;
    const onMove = (e: MouseEvent) => {
      const d = widthDragRef.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const total = d.leftW + d.rightW;
      const newLeft = clamp(d.leftW + dx, COLUMN_MIN_WIDTH, total - COLUMN_MIN_WIDTH);
      setWidths((w) => ({ ...w, [d.leftId]: newLeft, [d.rightId]: total - newLeft }));
    };
    const onUp = () => setColDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [colDragging]);

  return (
    <div
      ref={dockRef}
      className={`dock${collapsed ? " collapsed" : ""}`}
      style={collapsed ? undefined : { height }}
    >
      {!collapsed && <div className="dock-resize-handle" onMouseDown={onHeightHandleMouseDown} />}
      <div className="dock-header">
        <DockIcon size={14} style={{ color: collapsed ? "var(--muted)" : "var(--dim)" }} />
        <span className="dock-title">
          Dock{!collapsed && columnIds.length > 0 ? " · Monitors" : ""}
        </span>
        {collapsed && <span className="dock-monitor-tag">collapsed</span>}
        {!collapsed && liveCount > 0 && (
          <span className="dock-live-count">
            <span className="dock-live-dot" />
            {liveCount} live
          </span>
        )}
        <div className="dock-header-rule" />
        {!collapsed && (
          <AddColumnControl projects={projects} shownIds={columnIds} onAdd={addColumn} />
        )}
        <button
          className="toolbar-icon-btn"
          style={{ width: 22, height: 22 }}
          onClick={toggleCollapsed}
          title={collapsed ? "Expand dock" : "Collapse dock"}
        >
          <ChevronDownIcon
            size={14}
            style={{ transform: collapsed ? "rotate(-90deg)" : undefined }}
          />
        </button>
      </div>
      {!collapsed && (
        <div className="dock-columns">
          {columnIds.length === 0 && (
            <div className="dock-empty dock-empty-workspace">
              No projects tiled in this workspace yet
            </div>
          )}
          {columnIds.map((id, i) => (
            <Fragment key={id}>
              {i > 0 && (
                <div
                  className="dock-column-divider"
                  onMouseDown={(e) => onDividerMouseDown(e, i)}
                />
              )}
              <DockColumn
                projectId={id}
                width={widths[id]}
                onOpenGitHub={onOpenGitHub}
                onOpenBrowser={onOpenBrowser}
                onRemove={manualOnly(id) ? () => removeColumn(id) : undefined}
              />
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

function AddColumnControl({
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
        disabled={remaining.length === 0}
        options={remaining.map((p) => ({ value: String(p.id), label: p.name }))}
        onChange={(v) => {
          if (v) onAdd(Number(v));
        }}
      />
    </div>
  );
}

function DockColumn({
  projectId,
  width,
  onOpenGitHub,
  onOpenBrowser,
  onRemove,
}: {
  projectId: number;
  width: number | undefined;
  onOpenGitHub: (projectId: number) => void;
  onOpenBrowser: (projectId: number) => void;
  // Present only for a manually-pinned column not also derived from the
  // workspace — see Dock's manualOnly() above.
  onRemove?: () => void;
}) {
  const { projects, sessions, createSession, deleteSession, gitBranchesByProject, settings } =
    useDashboardStore();
  const [controls, setControls] = useState<DockControl[]>([]);
  // Per-monitor selected worktree path (by monitor config id) — kept in
  // component state so a user's choice survives re-renders within the
  // current dock session; not persisted to localStorage since the worktree
  // list itself can change (worktrees are created/deleted externally).
  const [worktreePaths, setWorktreePaths] = useState<Record<string, string>>({});
  // null covers both "still loading" and the 204 "not applicable" case
  // (no github.com remote, no account connected, a GitHub API error) —
  // this widget just renders nothing either way, same degrade-to-nothing
  // rule GitHubPanel.tsx follows for the same endpoint.
  const [githubStatus, setGithubStatus] = useState<GitHubStatus | null>(null);
  const [prsStatus, setPrsStatus] = useState<GitHubPRsStatus | null>(null);

  useEffect(() => {
    api
      .listProjectDock(projectId)
      .then(setControls)
      .catch(() => setControls([]));
  }, [projectId]);

  useEffect(() => {
    // Guards against a stale response on a fast project switch — same
    // `cancelled` pattern GitHubPanel.tsx uses for the same endpoint
    // (Hermes review, PR #40).
    let cancelled = false;
    api
      .getProjectGitHub(projectId)
      .then((status) => {
        if (!cancelled) setGithubStatus(status ?? null);
      })
      .catch(() => {
        if (!cancelled) setGithubStatus(null);
      });

    api
      .getProjectGitHubPRs(projectId)
      .then((s) => {
        if (!cancelled) setPrsStatus(s ?? null);
      })
      .catch(() => {
        if (!cancelled) setPrsStatus(null);
      });

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const project = projects.find((p) => p.id === projectId) ?? null;
  const dockSessions = sessions.filter(
    (s) => s.kind === "dock" && s.projectId === projectId && s.status === "active",
  );

  const gitRefs: GitBranchesResult | undefined = gitBranchesByProject[projectId];
  const worktrees = gitRefs?.worktrees ?? [];
  const branches = gitRefs?.branches ?? [];
  const mainCheckout = worktrees.find((w) => w.isMain) ?? worktrees[0];

  // Build unified options from worktrees + remaining branches
  const branchesWithWorktrees = new Set(worktrees.map((w) => w.branch).filter((b) => b !== null));
  const branchOptions = branches
    .filter((b) => !branchesWithWorktrees.has(b.name))
    .map((b) => ({ label: `${b.name} (preview)`, value: `branch:${b.name}`, branch: b.name }));
  const worktreeOptions = worktrees
    .filter((wt) => !isDockPreviewPath(wt.path))
    .map((wt) => ({
      label: wt.branch ?? wt.path,
      value: wt.path,
      branch: wt.branch ?? "",
    }));
  const allOptions = [...worktreeOptions, ...branchOptions];
  const showSelector = allOptions.length > 1;

  // Match by command alone within a project — the session might have been
  // created with a worktree-specific cwd override (see worktree selector
  // below), which would mismatch the old (control.cwd ?? project.cwd) check.
  const runningFor = (control: DockControl) =>
    dockSessions.find((s) => s.command === control.command);

  return (
    <div className="dock-column" style={{ flex: width != null ? `0 0 ${width}px` : "1 1 0" }}>
      <div className="dock-column-header">
        <span className="dock-column-name">{project?.name ?? `#${projectId}`}</span>
        {onRemove && (
          <button className="dock-column-remove" title="Remove column" onClick={onRemove}>
            ×
          </button>
        )}
      </div>
      {githubStatus && (
        <button
          className="dock-github-row"
          onClick={() => onOpenGitHub(projectId)}
          title={`Open GitHub panel for ${githubStatus.repo.owner}/${githubStatus.repo.repo}`}
        >
          <GitHubIcon size={13} />
          <span className="dock-github-repo">
            {githubStatus.repo.owner}/{githubStatus.repo.repo}
          </span>
          <span className="dock-github-stat">
            {githubStatus.openIssues} issue{githubStatus.openIssues === 1 ? "" : "s"}
          </span>
          <span className="dock-github-stat">
            {prsStatus
              ? `${prsStatus.prSummary.pass}✅ ${prsStatus.prSummary.fail}❌ ${prsStatus.prSummary.pending}⏳`
              : `${githubStatus.openPRs} PR${githubStatus.openPRs === 1 ? "" : "s"}`}
          </span>
          {githubStatus.ciStatus && (
            <span
              className={`github-panel-ci-dot ${ciDotClass(githubStatus.ciStatus)}`}
              title={`CI: ${githubStatus.ciStatus}`}
            />
          )}
        </button>
      )}
      {project?.devServerUrl && (
        <button
          className="dock-browser-row"
          onClick={() => onOpenBrowser(projectId)}
          title={`Open browser preview for ${project.devServerUrl}`}
        >
          <GlobeIcon size={13} />
          <span className="dock-browser-url">{project.devServerUrl}</span>
        </button>
      )}
      <div className="dock-body">
        {controls.length === 0 && (
          <div className="dock-empty">No monitors configured for this project</div>
        )}
        {controls.map((control) => {
          const running = runningFor(control);
          // Determine effective worktreeRefresh: control config > settings default
          const effectiveWorktreeRefresh =
            control.worktreeRefresh ?? settings.dock?.defaultWorktreeRefresh ?? false;

          // Resolve the currently selected option value — see
          // resolveSelectedValue's doc comment for the full precedence.
          const optionValues = new Set(allOptions.map((o) => o.value));
          const selectedValue = resolveSelectedValue({
            running,
            storedValue: worktreePaths[control.id],
            optionValues,
            mainCheckoutPath: mainCheckout?.path,
            controlCwd: control.cwd,
          });

          // Helper: create or restart a session for a given option value.
          // Falls back to control.cwd when value is empty or unset.
          const launchForValue = (value: string) => {
            const effectiveCwd = value.length > 0 ? value : control.cwd;
            if (effectiveCwd && effectiveCwd.startsWith("branch:")) {
              const branchName = effectiveCwd.slice("branch:".length);
              void createSession(projectId, control.command, {
                kind: "dock",
                worktree: { branch: branchName },
                worktreeRefresh: effectiveWorktreeRefresh,
              });
            } else {
              void createSession(projectId, control.command, {
                ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
                kind: "dock",
              });
            }
          };

          return (
            <div key={control.id} className="dock-monitor">
              <div
                className="dock-monitor-header"
                style={{ cursor: "pointer" }}
                onClick={() => {
                  if (running) {
                    void deleteSession(running.id);
                  } else {
                    launchForValue(selectedValue);
                  }
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: running ? "var(--g)" : "var(--dim)",
                    flexShrink: 0,
                  }}
                />
                <span className="dock-monitor-name">{control.title}</span>
                {showSelector && (
                  <CustomSelect
                    className="dock-monitor-worktree-select"
                    value={selectedValue}
                    options={allOptions}
                    onChange={(newValue) => {
                      setWorktreePaths((prev) => ({ ...prev, [control.id]: newValue }));
                      // If a monitor is running and the user switches,
                      // kill and restart in the new location.
                      // Check the live store after delete resolves to
                      // avoid restarting if the user manually toggled
                      // the monitor off during the async window.
                      if (running) {
                        void (async () => {
                          try {
                            await deleteSession(running.id);
                            const stillRunning = useDashboardStore
                              .getState()
                              .sessions.some(
                                (s) =>
                                  s.kind === "dock" &&
                                  s.projectId === projectId &&
                                  s.status === "active" &&
                                  s.command === control.command,
                              );
                            if (stillRunning) {
                              launchForValue(newValue);
                            }
                          } catch {
                            console.warn("[dock] worktree switch delete+create failed", control.id);
                          }
                        })();
                      }
                    }}
                  />
                )}
                <span className="dock-monitor-tag">{running ? "on" : "off"}</span>
              </div>
              {running && (
                <div className="dock-monitor-body">
                  <TerminalPane params={{ sessionId: running.id }} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
