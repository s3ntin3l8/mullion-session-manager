import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { api } from "./api.js";
import type { DockControl, GitHubStatus, Project } from "./api.js";
import { useDashboardStore } from "./store.js";
import { ChevronDownIcon, DockIcon, GitHubIcon, GlobeIcon, PlusIcon } from "./icons.js";
import { TerminalPane } from "./TerminalPane.js";

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

  useEffect(() => {
    // Persist on drag end only (not every intermediate frame) — reads the
    // latest `height` intentionally, so this can't be keyed on it too.
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

// Repurposes the old disabled "Pin monitor" button: dock config itself stays
// read-only (.crs/dock.json), but pinning a project's column into view — one
// not currently tiled in the workspace — is something the UI can do. A
// native <select> mirrors the shape of the dropdown this replaces, so there's
// no new popover/menu code to introduce.
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
      <select
        className="dock-add-select"
        value=""
        disabled={remaining.length === 0}
        onChange={(e) => {
          if (e.target.value) onAdd(Number(e.target.value));
        }}
      >
        <option value="" disabled hidden>
          Add project column
        </option>
        {remaining.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
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
  const { projects, sessions, createSession, deleteSession } = useDashboardStore();
  const [controls, setControls] = useState<DockControl[]>([]);
  // null covers both "still loading" and the 204 "not applicable" case
  // (no github.com remote, no account connected, a GitHub API error) —
  // this widget just renders nothing either way, same degrade-to-nothing
  // rule GitHubPanel.tsx follows for the same endpoint.
  const [githubStatus, setGithubStatus] = useState<GitHubStatus | null>(null);

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
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const project = projects.find((p) => p.id === projectId) ?? null;
  const dockSessions = sessions.filter(
    (s) => s.kind === "dock" && s.projectId === projectId && s.status === "active",
  );

  const runningFor = (control: DockControl) =>
    dockSessions.find(
      (s) =>
        s.command === control.command && (control.cwd ?? project?.cwd) === (s.cwd ?? project?.cwd),
    );

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
            {githubStatus.openPRs} PR{githubStatus.openPRs === 1 ? "" : "s"}
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
          return (
            <div key={control.id} className="dock-monitor">
              <div
                className="dock-monitor-header"
                style={{ cursor: "pointer" }}
                onClick={() => {
                  if (running) {
                    void deleteSession(running.id);
                  } else {
                    void createSession(projectId, control.command, {
                      cwd: control.cwd,
                      kind: "dock",
                    });
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
