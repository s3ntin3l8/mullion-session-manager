import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { api } from "./api.js";
import type {
  DockControl,
  DockerUpdateCheckResult,
  GitBranchesResult,
  GitHubPRsStatus,
  GitHubStatus,
  Project,
  Session,
} from "./api.js";
import { useDashboardStore } from "./store.js";
import { useShallow } from "zustand/react/shallow";
import {
  ChevronDownIcon,
  ContainerIcon,
  DockIcon,
  GitHubIcon,
  GlobeIcon,
  PlusIcon,
  RefreshIcon,
} from "./icons.js";
import { TerminalPane } from "./TerminalPane.js";
import { CustomSelect } from "./CustomSelect.js";
import { KebabMenu } from "./KebabMenu.js";
import { dockerServiceStatus, isUpdateStillAvailable } from "./dockerServiceStatus.js";
import {
  STORAGE_KEYS,
  readBool,
  readJSON,
  readNumber,
  writeBool,
  writeJSON,
  writeNumber,
} from "./lib/persistedState.js";

// Issue #73 — how often a column with at least one discovered Docker
// control re-fetches GET .../dock while the dock is expanded, so a
// container's state/image reflects `docker ps` reality without the user
// having to toggle anything. The backend's own getComposeServices() cache
// (docker-service-detect.ts) TTLs at 10s specifically so this 15s interval
// only pays for a fresh `docker ps` roughly once per poll, not once per
// column.
const DOCKER_POLL_INTERVAL_MS = 15_000;

/** Last path segment, then the tag after its final `:` — "latest" when the
 * ref carries no explicit tag (compose's own default). A `name@sha256:...`
 * digest reference is handled first (Hermes review — splitting on `:`
 * alone would wrongly return the bare string "sha256" for one), shown as a
 * short digest prefix instead. Not exhaustive beyond that (doesn't handle a
 * registry host with a literal port, e.g. "host:5000/repo" with no tag),
 * but good enough for a compact pill; the full ref is always available via
 * the pill's own title attribute. */
function imageTag(imageRef: string): string {
  const lastSegment = imageRef.split("/").pop() ?? imageRef;
  const atIndex = lastSegment.indexOf("@");
  if (atIndex !== -1) {
    const digest = lastSegment.slice(atIndex + 1);
    return digest.length > 19 ? digest.slice(0, 19) : digest; // "sha256:" + 12 hex chars
  }
  const colonIndex = lastSegment.lastIndexOf(":");
  return colonIndex === -1 ? "latest" : lastSegment.slice(colonIndex + 1);
}

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
  // P1 perf fix — `useDashboardStore()` with no selector subscribed to the
  // ENTIRE store even though only these two fields are read; individual
  // selectors mean this only re-renders when one of THEM changes identity.
  const projects = useDashboardStore((s) => s.projects);
  const sessions = useDashboardStore((s) => s.sessions);
  const [collapsed, setCollapsed] = useState(() => readBool(STORAGE_KEYS.dockCollapsed, false));
  const [height, setHeight] = useState(() => {
    const n = readNumber(STORAGE_KEYS.dockHeight, NaN);
    return Number.isFinite(n) && n > 0 ? clamp(n, DOCK_MIN_HEIGHT, Infinity) : DEFAULT_DOCK_HEIGHT;
  });
  const [manualIds, setManualIds] = useState<number[]>(() => {
    const raw = readJSON<unknown>(STORAGE_KEYS.dockManualProjects, []);
    return Array.isArray(raw) ? raw.filter((x): x is number => typeof x === "number") : [];
  });
  // Column widths from divider drags — ephemeral (not persisted): the
  // column set itself is mostly derived, so a stored width map would just
  // accumulate stale entries for projects that drift in and out of view.
  const [widths, setWidths] = useState<Record<number, number>>({});

  const dockRef = useRef<HTMLDivElement>(null);

  const toggleCollapsed = () => {
    setCollapsed((v) => {
      const next = !v;
      writeBool(STORAGE_KEYS.dockCollapsed, next);
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
    writeJSON(STORAGE_KEYS.dockManualProjects, next);
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
    if (!heightDragging) writeNumber(STORAGE_KEYS.dockHeight, height);
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
  // P1 perf fix — rendered here in one column PER PROJECT in the dock, so a
  // whole-store subscription's cost multiplied by column count on every
  // unrelated write. `createSession`/`deleteSession`/`refreshSessions` are
  // pure action-callers (used inside async handlers below, never read as a
  // value) — see the useDashboardStore.getState() calls at their own call
  // sites instead of subscribing to them here.
  const {
    projects,
    sessions,
    gitBranchesByProject,
    settings,
    dockConfigRefreshTrigger,
    prsRefreshTrigger,
  } = useDashboardStore(
    useShallow((s) => ({
      projects: s.projects,
      sessions: s.sessions,
      gitBranchesByProject: s.gitBranchesByProject,
      settings: s.settings,
      dockConfigRefreshTrigger: s.dockConfigRefreshTrigger,
      // P12 — GitHubPanel.tsx's own live-updating widget already reads
      // this (see its effect below's mirrored comment); the dock's own
      // GitHub widget fetched once per projectId and never again, so its
      // CI/PR counts froze at whatever they were when the panel first
      // mounted while GitHubPanel next to it kept updating live off the
      // same `/ws/github` push channel (store.ts's connectGitHubWS bumps
      // this counter on every message for a subscribed project).
      prsRefreshTrigger: s.prsRefreshTrigger,
    })),
  );
  // U8 — Settings -> Session management's "Confirm before kill" toggle,
  // same setting Sidebar.tsx's ConfirmButton and PaneTab.tsx's own kill gate
  // both read; the dock monitor header had no such gate at all before this.
  const confirmBeforeKill = settings.sessions.confirmBeforeKill;
  const [controls, setControls] = useState<DockControl[]>([]);
  // Issue #73 — a "Pull & restart stack" session's synthesized control
  // (POST .../docker/update's response), never returned by GET .../dock —
  // see api.ts's DockerUpdateResult doc comment for why. Kept separately
  // from `controls` rather than merged in there so the 15s poll below can
  // freely overwrite `controls` with the server's list without wiping an
  // in-flight update's own row; rendered while its session stays active
  // (checked against `dockSessions` below), dropped once the run exits.
  const [ephemeralControls, setEphemeralControls] = useState<DockControl[]>([]);
  const addEphemeralControl = (control: DockControl) =>
    setEphemeralControls((prev) => [...prev.filter((c) => c.id !== control.id), control]);
  // Per-control "Check for update" result (control.id -> result), issue #73.
  const [updateChecks, setUpdateChecks] = useState<Record<string, DockerUpdateCheckResult>>({});
  // Transient, human-readable outcome of the LAST "Check for update" click
  // (control.id -> message), auto-cleared after a few seconds — Hermes
  // review: `reason: "pull-failed"` (private registry, network failure, the
  // 45s pull timeout) was stored in `updateChecks` but never surfaced
  // anywhere, since the image pill only ever reacts to `updateAvailable`.
  // Without this, a failed or merely up-to-date check reads as "nothing
  // happened" after a real (and, before the timeout reduction above, up to
  // 120s-long) network round trip.
  const [checkStatusById, setCheckStatusById] = useState<
    Record<string, { message: string; isError: boolean }>
  >({});
  const checkStatusTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const showCheckStatus = (controlId: string, message: string, isError = false) => {
    setCheckStatusById((prev) => ({ ...prev, [controlId]: { message, isError } }));
    const existing = checkStatusTimersRef.current[controlId];
    if (existing) clearTimeout(existing);
    checkStatusTimersRef.current[controlId] = setTimeout(() => {
      setCheckStatusById((prev) => {
        const next = { ...prev };
        delete next[controlId];
        return next;
      });
      delete checkStatusTimersRef.current[controlId];
    }, 4000);
  };
  useEffect(
    () => () => {
      for (const timer of Object.values(checkStatusTimersRef.current)) clearTimeout(timer);
    },
    [],
  );
  // U8 — arm-then-confirm before a running monitor's header click actually
  // kills it, gated on the same settings.sessions.confirmBeforeKill toggle
  // Sidebar.tsx's ConfirmButton and PaneTab.tsx's own kill gate both read.
  // Not literally the shared <ConfirmButton> component: that renders a
  // <button>, and this header already hosts other real interactive elements
  // (the worktree <select>, the docker kebab menu) that would become an
  // illegal button-inside-button nest. So this mirrors the file's own
  // `checkStatusById`/`checkStatusTimersRef` idiom just above instead — a
  // per-control-id armed set plus a per-control-id disarm timer — rather
  // than either inventing a third shape or forcing every control in a
  // column to share one armed slot (which would silently disarm a SECOND
  // monitor's confirm step the instant a first one gets armed).
  const KILL_ARM_DISARM_MS = 6000; // matches ConfirmButton.tsx's own window
  const [killArmedIds, setKillArmedIds] = useState<Set<string>>(new Set());
  const killArmTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  useEffect(
    () => () => {
      for (const timer of Object.values(killArmTimersRef.current)) clearTimeout(timer);
    },
    [],
  );
  const armKill = (controlId: string) => {
    setKillArmedIds((prev) => new Set(prev).add(controlId));
    const existing = killArmTimersRef.current[controlId];
    if (existing) clearTimeout(existing);
    killArmTimersRef.current[controlId] = setTimeout(() => {
      setKillArmedIds((prev) => {
        if (!prev.has(controlId)) return prev;
        const next = new Set(prev);
        next.delete(controlId);
        return next;
      });
      delete killArmTimersRef.current[controlId];
    }, KILL_ARM_DISARM_MS);
  };
  const disarmKill = (controlId: string) => {
    const existing = killArmTimersRef.current[controlId];
    if (existing) {
      clearTimeout(existing);
      delete killArmTimersRef.current[controlId];
    }
    setKillArmedIds((prev) => {
      if (!prev.has(controlId)) return prev;
      const next = new Set(prev);
      next.delete(controlId);
      return next;
    });
  };
  // U5 — per-control "has the header been explicitly toggled since an
  // in-flight worktree-switch started" generation counter. The switch
  // handler below needs to know whether ITS OWN pending relaunch is still
  // wanted once its `deleteSession` await resolves — the original code
  // re-read live session status for that, but `store.deleteSession` itself
  // awaits `refreshSessions()` before returning, so by the time the check
  // ran the just-deleted row already read "killed" and the relaunch branch
  // was permanently dead (the bug this fixes). A plain counter bumped only
  // by an explicit header click (start OR kill — either supersedes a
  // pending automatic relaunch) survives that, because the switch's own
  // internal `deleteSession` call is never routed through this counter.
  const toggleGenRef = useRef<Map<string, number>>(new Map());
  const bumpToggleGen = (controlId: string) => {
    toggleGenRef.current.set(controlId, (toggleGenRef.current.get(controlId) ?? 0) + 1);
  };
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
    // `cancelled` guard (issue #73) — this effect now also re-fires on an
    // interval (below), so a slow response from a stale tick landing after a
    // newer one must not clobber it; same pattern as the GitHub effect right
    // below this one.
    let cancelled = false;
    const load = () => {
      api
        .listProjectDock(projectId)
        .then((next) => {
          if (!cancelled) setControls(next);
        })
        .catch(() => {
          if (!cancelled) setControls([]);
        });
    };
    load();
    // Polls so a discovered Docker service's container state/image tag
    // stays live without the user toggling anything — this component only
    // renders while the dock itself is expanded (Dock's own `!collapsed`
    // guard unmounts every DockColumn otherwise), so the interval is
    // implicitly paused/cleared for free whenever the dock is collapsed.
    const interval = setInterval(load, DOCKER_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // U4 — dockConfigRefreshTrigger in the dependency array means a save in
    // DockConfigPanel re-runs this effect immediately (same "bump a shared
    // counter, subscribers refetch" shape as GitHubPanel's own
    // prsRefreshTrigger dependency), instead of waiting out the
    // DOCKER_POLL_INTERVAL_MS poll above or a page reload — docs/dock.md's
    // own troubleshooting note calls that wait out explicitly.
  }, [projectId, dockConfigRefreshTrigger]);

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
    // P12 — prsRefreshTrigger in the deps means a live `/ws/github` push for
    // this project (a check completing, a new PR) re-fetches immediately,
    // exactly matching GitHubPanel.tsx's own identical effect — before this
    // fix the dock widget only ever fetched once per projectId and showed
    // stale CI/PR counts frozen at whatever they were when the column first
    // mounted, even while GitHubPanel elsewhere on the same page updated
    // live off the same push.
  }, [projectId, prsRefreshTrigger]);

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

  // Issue #73 — only an ephemeral control whose spawned session is STILL
  // active gets rendered; a finished/killed update run just disappears from
  // the column (its output stays visible in scrollback for anyone who had
  // it open, same as any other dock monitor). Computed at render time off
  // the store's own `sessions` (via dockSessions above) rather than pruned
  // in a separate effect — no need to duplicate that liveness check.
  const liveEphemeralControls = ephemeralControls.filter((c) => runningFor(c));
  const configuredControls = controls.filter((c) => c.source !== "docker");
  const discoveredControls = controls.filter((c) => c.source === "docker");
  const dockerGroupControls = [...liveEphemeralControls, ...discoveredControls];

  const handleCheckUpdate = async (control: DockControl) => {
    try {
      const result = await api.checkDockerUpdate(projectId, control.id);
      setUpdateChecks((prev) => ({ ...prev, [control.id]: result }));
      if (!result.updateAvailable && "reason" in result) {
        showCheckStatus(
          control.id,
          result.reason === "pull-failed" ? "Check failed — pull error" : "No image to check",
          true,
        );
      } else if (!result.updateAvailable) {
        showCheckStatus(control.id, "Up to date");
      }
      // updateAvailable:true needs no separate status message — the image
      // pill itself re-tints immediately (isUpdateStillAvailable).
    } catch {
      console.warn("[dock] docker check-update failed", control.id);
      showCheckStatus(control.id, "Check failed", true);
    }
  };

  const handlePullAndRestart = async (control: DockControl) => {
    try {
      const result = await api.updateDockerStack(projectId, control.id);
      addEphemeralControl(result.control);
      // The new session won't appear in the store's `sessions` list (and
      // hence `runningFor`/`dockSessions` above) until the next poll —
      // force one now so the monitor renders immediately instead of after
      // whatever's left of store.ts's live-refresh interval.
      await useDashboardStore.getState().refreshSessions();
    } catch {
      console.warn("[dock] docker pull & restart failed", control.id);
      showCheckStatus(control.id, "Failed to start update", true);
    }
  };

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
              ? `${prsStatus.prSummary.pass}✅ ${prsStatus.prSummary.fail}❌ ${prsStatus.prSummary.pending}⏳${prsStatus.prSummary.unknown > 0 ? ` ${prsStatus.prSummary.unknown}❓` : ""}`
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
      <div className="dock-body">
        {configuredControls.length === 0 && dockerGroupControls.length === 0 && (
          <div className="dock-empty">
            {project?.devServerUrl ? (
              <button
                className="dock-monitor-url"
                onClick={() => onOpenBrowser(projectId)}
                title={`Open preview for ${project.devServerUrl}`}
                type="button"
              >
                <GlobeIcon size={11} />
                <span className="dock-monitor-url-text">{project.devServerUrl}</span>
              </button>
            ) : (
              "No monitors configured for this project"
            )}
          </div>
        )}
        {[...configuredControls, ...dockerGroupControls].map((control, index) => {
          const running = runningFor(control);
          // A docker-sourced control's worktree/branch is meaningless — it's
          // a host-level `docker` command, not something running inside this
          // project's git checkout — so it never gets the selector, even
          // when the column otherwise has multiple worktrees/branches.
          const controlShowSelector = showSelector && control.source !== "docker";
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
          // Falls back to control.cwd when value is empty or unset. Returns
          // the create promise (rather than voiding it internally) so the
          // worktree-switch handler below can actually observe a failed
          // relaunch instead of it disappearing into an unhandled rejection
          // — the exact P9 class of bug, previously sitting inside the very
          // restart path U5 fixes.
          const launchForValue = (value: string) => {
            const effectiveCwd = value.length > 0 ? value : control.cwd;
            if (effectiveCwd && effectiveCwd.startsWith("branch:")) {
              const branchName = effectiveCwd.slice("branch:".length);
              return useDashboardStore.getState().createSession(projectId, control.command, {
                kind: "dock",
                worktree: { branch: branchName },
                worktreeRefresh: effectiveWorktreeRefresh,
              });
            }
            return useDashboardStore.getState().createSession(projectId, control.command, {
              ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
              kind: "dock",
            });
          };

          // Issue #73 — a small "Docker" group label ahead of the first
          // discovered/ephemeral control, mirroring the plan's "configured
          // controls first, then a Docker divider, then docker-sourced
          // controls" order. `index` is over the CONCATENATED
          // [...configuredControls, ...dockerGroupControls] array, so this
          // fires exactly once, right where the group actually starts.
          const isFirstDockerControl =
            dockerGroupControls.length > 0 && index === configuredControls.length;

          // isUpdateStillAvailable re-derives against the control's CURRENT
          // imageId rather than trusting the stored check result on its own
          // — see that function's doc comment for why (updateChecks is
          // never proactively invalidated).
          const updateAvailable = isUpdateStillAvailable(
            updateChecks[control.id],
            control.docker?.imageId,
          );
          const dockerStatus = control.docker ? dockerServiceStatus(control.docker.state) : null;

          // P10 — named so the header's new onKeyDown (Enter/Space) can call
          // the exact same action as a click, rather than dispatching a
          // synthetic `.click()` at the DOM node — matching how
          // UnifiedBoard.tsx's TaskCard and NotificationBell.tsx's EventRow
          // both call a plain function from both handlers.
          const handleHeaderActivate = () => {
            if (running) {
              // U8 — only the KILL half of this header needs
              // arm-then-confirm; the header doubles as the START
              // affordance when nothing is running (the `else`
              // branch below), and starting a session is never
              // destructive, so it always fires on the first click
              // regardless of confirmBeforeKill.
              if (!confirmBeforeKill || killArmedIds.has(control.id)) {
                disarmKill(control.id);
                bumpToggleGen(control.id);
                void useDashboardStore.getState().deleteSession(running.id);
              } else {
                armKill(control.id);
              }
            } else {
              bumpToggleGen(control.id);
              // Hermes review — this discarded the promise outright:
              // a failed createSession (dead remote host, a bad
              // worktree path, ...) became an unhandled rejection
              // with nothing on screen, the exact P9 silent-failure
              // class this PR fixes everywhere else. Reuses this
              // file's own showCheckStatus transient-message infra
              // (already rendered next to this same tag for
              // "Check for update"/"Pull & restart") rather than
              // introducing a new error-state shape.
              launchForValue(selectedValue).catch(() => {
                showCheckStatus(control.id, "Failed to start — try again", true);
              });
            }
          };

          return (
            <Fragment key={control.id}>
              {isFirstDockerControl && <div className="dock-group-label">Docker</div>}
              <div className="dock-monitor">
                <div
                  className="dock-monitor-header"
                  style={{ cursor: "pointer" }}
                  title={
                    running
                      ? killArmedIds.has(control.id)
                        ? "Click again to confirm — ends the running program"
                        : confirmBeforeKill
                          ? "Click to end this monitor"
                          : undefined
                      : undefined
                  }
                  // P10 — U8's own finding flags this same header as "one
                  // unconfirmed click kills a running dev server," and on
                  // top of that it was entirely unreachable from the
                  // keyboard. Same role="button"/tabIndex/Enter-Space
                  // pattern as Sidebar.tsx's SessionRow/ProjectHeader,
                  // including the `e.target !== e.currentTarget` guard —
                  // this header nests a CustomSelect (worktree picker), a
                  // "open preview" button, and (for a Docker-backed
                  // control) a KebabMenu, and without the guard tabbing to
                  // any of those and pressing Enter/Space would ALSO
                  // toggle/kill this monitor.
                  role="button"
                  tabIndex={0}
                  aria-label={`${control.title} — ${running ? "click to end" : "click to start"}`}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault();
                    handleHeaderActivate();
                  }}
                  onClick={handleHeaderActivate}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: dockerStatus
                        ? `var(${dockerStatus.colorToken})`
                        : running
                          ? "var(--g)"
                          : "var(--dim)",
                      flexShrink: 0,
                    }}
                    // Same "title carries the label a bare dot can't" — the
                    // dock-monitor-tag "on"/"off" text just below already
                    // labels the log-STREAM session; this dot instead
                    // reflects the CONTAINER's own state, which needs its
                    // own accessible label (sessionStatus.ts's "never color
                    // alone" rule) — same convention as this same header's
                    // GitHub CI dot (title="CI: ...") further up this file.
                    title={dockerStatus ? `Container: ${dockerStatus.label}` : undefined}
                  />
                  <span className="dock-monitor-name">{control.title}</span>
                  {controlShowSelector && (
                    <CustomSelect
                      className="dock-monitor-worktree-select"
                      value={selectedValue}
                      options={allOptions}
                      label={`${control.title} worktree`}
                      menuPlacement="top"
                      menuAlign="right"
                      onChange={(newValue) => {
                        setWorktreePaths((prev) => ({ ...prev, [control.id]: newValue }));
                        // If a monitor is running and the user switches,
                        // kill and restart in the new location.
                        if (running) {
                          // A stale armed kill from before the switch (the
                          // user armed the header, then picked a different
                          // worktree instead of confirming) must not go on
                          // reading "confirm?" for up to
                          // KILL_ARM_DISARM_MS after this delete+relaunch —
                          // this delete is a restart, not the armed kill.
                          disarmKill(control.id);
                          // Hermes review — bumped here too, BEFORE
                          // capturing genAtStart below: two rapid worktree
                          // switches on the same control each start their
                          // own delete-then-relaunch IIFE, and previously
                          // only a header click bumped this counter — so if
                          // both deletes happened to resolve, the FIRST
                          // switch's relaunch could still fire (with its
                          // now-stale path) after the SECOND switch had
                          // already moved the select on to a newer value.
                          // Bumping unconditionally on every switch means
                          // each one invalidates any still-in-flight
                          // predecessor's pending relaunch, the same way an
                          // explicit header click already did.
                          bumpToggleGen(control.id);
                          // U5 — capture the restart intent BEFORE the
                          // delete, not by re-deriving it from post-delete
                          // session state. `store.deleteSession` itself
                          // awaits `refreshSessions()` before resolving, so
                          // by the time an `await` on it here returns, this
                          // exact row already reads "killed" in the store —
                          // re-checking "is a matching session still active"
                          // at that point would always read false, making
                          // the relaunch below permanently unreachable
                          // (verified live; the original bug). `shouldRestart`
                          // is just `Boolean(running)`, read from this
                          // render's own closure, so it can't be corrupted
                          // by the delete it's about to trigger.
                          //
                          // The two cases that still have to suppress the
                          // relaunch — the user manually toggling THIS
                          // monitor (start or kill) from the header while
                          // this switch is in flight, OR a second, newer
                          // switch superseding this one — are both tracked
                          // via toggleGenRef instead of session status: any
                          // of the header's onClick, or this onChange
                          // itself (see the bump right above), bumps that
                          // counter on an actual toggle, so comparing it
                          // before/after the await detects an intervening
                          // action without depending on state the delete
                          // call itself mutates.
                          const shouldRestart = Boolean(running);
                          const genAtStart = toggleGenRef.current.get(control.id) ?? 0;
                          void (async () => {
                            try {
                              await useDashboardStore.getState().deleteSession(running.id);
                              const genUnchanged =
                                (toggleGenRef.current.get(control.id) ?? 0) === genAtStart;
                              if (shouldRestart && genUnchanged) {
                                await launchForValue(newValue);
                              }
                            } catch {
                              // Hermes review (suggestion) — reuses the same
                              // showCheckStatus transient-message infra as
                              // the header's own start-affordance catch
                              // above, instead of a console-only warning, so
                              // a failed switch is visible in the UI too.
                              showCheckStatus(control.id, "Failed to switch — try again", true);
                            }
                          })();
                        }
                      }}
                    />
                  )}
                  {project?.devServerUrl && (
                    <button
                      className="dock-monitor-url"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenBrowser(projectId);
                      }}
                      title={`Open preview for ${project.devServerUrl}`}
                      type="button"
                    >
                      <GlobeIcon size={11} />
                      <span className="dock-monitor-url-text">{project.devServerUrl}</span>
                    </button>
                  )}
                  {control.docker && (
                    <span
                      className={`dock-monitor-url dock-monitor-image${updateAvailable ? " dock-monitor-image-update" : ""}`}
                      title={
                        updateAvailable
                          ? `${control.docker.imageRef} — update available`
                          : control.docker.imageRef
                      }
                    >
                      <ContainerIcon size={11} />
                      <span className="dock-monitor-url-text">
                        {imageTag(control.docker.imageRef)}
                      </span>
                    </span>
                  )}
                  {control.docker && (
                    <span onClick={(e) => e.stopPropagation()}>
                      <KebabMenu
                        title={`${control.title} actions`}
                        items={[
                          {
                            key: "check-update",
                            label: "Check for update",
                            icon: <RefreshIcon size={12} />,
                            disabled: control.docker.buildOnly,
                            onClick: () => void handleCheckUpdate(control),
                          },
                          {
                            key: "pull-restart",
                            label: "Pull & restart stack",
                            armLabel: "Click again — restarts the whole stack",
                            icon: <ContainerIcon size={12} />,
                            danger: true,
                            confirm: true,
                            disabled: control.docker.buildOnly,
                            onClick: () => void handlePullAndRestart(control),
                          },
                        ]}
                      />
                    </span>
                  )}
                  {checkStatusById[control.id] && (
                    <span
                      className={`dock-monitor-tag dock-monitor-check-status${
                        checkStatusById[control.id]!.isError ? " error" : ""
                      }`}
                    >
                      {checkStatusById[control.id]!.message}
                    </span>
                  )}
                  <span
                    className={`dock-monitor-tag${killArmedIds.has(control.id) ? " armed" : ""}`}
                  >
                    {killArmedIds.has(control.id) ? "confirm?" : running ? "on" : "off"}
                  </span>
                </div>
                {running && (
                  <div className="dock-monitor-body">
                    <TerminalPane params={{ sessionId: running.id }} captureCtrlC={true} />
                  </div>
                )}
              </div>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
