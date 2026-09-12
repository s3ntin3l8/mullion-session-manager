import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { api } from "./api/index.js";
import type { DockControl, DockerUpdateCheckResult, GitBranchesResult } from "./api/index.js";
import { useDashboardStore } from "./store/index.js";
import { useShallow } from "zustand/react/shallow";
import { ChevronDownIcon, DockIcon, GlobeIcon } from "./ui/icons.js";
import { dockerServiceStatus, isUpdateStillAvailable } from "./dockerServiceStatus.js";
import { useDragResize } from "./hooks/useDragResize.js";
import { usePolling } from "./hooks/usePolling.js";
import {
  STORAGE_KEYS,
  readBool,
  readJSON,
  readNumber,
  writeBool,
  writeJSON,
  writeNumber,
} from "./lib/persistedState.js";
import {
  clamp,
  composeProjectForControl,
  composeProjectFromContainerName,
  dockLogPaneComfortHeightPx,
  dockMonitorMinHeightPx,
  dockMonitorMinWidthPx,
  dockRowKey,
  dockerSessionIdentity,
  groupDockerControls,
  holdVanishedDockerControls,
  isDockPreviewPath,
  resolveSelectedValue,
  runningSessionFor,
} from "./dock/dockHelpers.js";
import { DOCKER_STACK_SESSION_NAME_PREFIX } from "../../src/shared/constants.js";
import { useDockGithubStatus } from "./dock/useDockGithubStatus.js";
import { DockGithubRow } from "./dock/DockGithubRow.js";
import { useArmedKill } from "./dock/useArmedKill.js";
import { useTransientStatus } from "./dock/useTransientStatus.js";
import { DockMonitor } from "./dock/DockMonitor.js";
import { DockLogPane } from "./dock/DockLogPane.js";
import { DockStackHeader } from "./dock/DockStackHeader.js";
import { AddColumnControl } from "./dock/AddColumnControl.js";
import { useCoarsePointer } from "./lib/layoutTier.js";

// Issue #73 — how often a column with at least one discovered Docker
// control re-fetches GET .../dock while the dock is expanded, so a
// container's state/image reflects `docker ps` reality without the user
// having to toggle anything. The backend's own getComposeServices() cache
// (docker-service-detect.ts) TTLs at 10s specifically so this 15s interval
// only pays for a fresh `docker ps` roughly once per poll, not once per
// column.
const DOCKER_POLL_INTERVAL_MS = 15_000;

// Discovery is `docker ps -a`-driven (docker-service-detect.ts's
// probeComposeServices), not compose-config-driven — a `compose up -d`
// recreate genuinely deletes the old container before creating the new one,
// so a service can be absent from a poll for a few seconds mid-rebuild with
// nothing wrong. Without holding its row across that gap, a stack group's
// row LIST churns every recreate: the row vanishes and its terminal (or,
// pre-dock-master-detail-rework, the group's own `flexGrow`) has to
// reconstruct or resize every time — this is the mechanism behind
// "rebuilding a stack makes the whole dock flicker/resize repeatedly," and
// holding the row (and, per dockRowKey's own doc comment, the SELECTION,
// since it's keyed on the same stable identity) across the gap is still
// what prevents it, even though the group no longer resizes siblings the
// way it used to. Two poll intervals plus a small margin:
// long enough to outlast one missed poll if the container is a little slow
// to reappear, short enough that a service actually removed via
// `compose down` still disappears from the Dock promptly. The margin (vs.
// a flat 2x) is deliberate — Hermes review, PR #1176: a recreate finishing
// just after the exact 2x-interval poll would otherwise expire on that very
// poll and reproduce the flicker for one more cycle. Expiry is only
// re-checked ON a poll (not continuously), so this margin's real effect is
// coarser than "+5s" sounds — it pushes the worst case past the 30s poll
// entirely, to the 45s one, buying a full extra poll cycle of slack rather
// than a few seconds of it. See holdVanishedDockerControls (dockHelpers.ts)
// for the derivation this feeds.
const RECREATE_GRACE_MS = 2 * DOCKER_POLL_INTERVAL_MS + 5_000;

// Dock master-detail rework — everything below dock-header/column-header/
// stack-header chrome a column needs around `.dock-split` before the log
// pane gets any room at all. Not exact (padding/border rounding, and
// DockGithubRow's own 26px+gap is excluded — present for some projects, not
// a baseline every column pays), just enough to land DEFAULT_DOCK_HEIGHT
// near a sane starting size rather than picking one out of the air.
const DOCK_CHROME_PX = 85;
// dockLogPaneComfortHeightPx(14, 4) (dockHelpers.ts) + DOCK_CHROME_PX — a
// genuinely readable log pane by default, not merely a non-clipping one.
// dockMonitorMinHeightPx (also dockHelpers.ts) is the SEPARATE, smaller hard
// floor `.dock-log-pane`'s own CSS min-height enforces regardless of this
// default — see that function's own doc comment for why conflating the two
// would silently ship every new user a 10-row log pane forever (the server
// clamps UP to MIN_TERMINAL_ROWS, it never clamps down).
const DEFAULT_DOCK_HEIGHT = dockLogPaneComfortHeightPx(14, 4) + DOCK_CHROME_PX;
const DOCK_MIN_HEIGHT = 120;
// Must equal .dockview-container's min-height in styles.css — the resize
// drag's clamp and the CSS floor have to agree, or the CSS floor silently
// wins and the drag looks like it stopped responding partway through.
const GRID_MIN_HEIGHT = 160;
const COLUMN_MIN_WIDTH = 200;
// Default width of the rail before any drag, and the floor a drag can't go
// below — see the rail-divider drag handler below.
const DEFAULT_RAIL_WIDTH = 280;
const RAIL_MIN_WIDTH = 216;
// `.dock-rail-divider`'s own fixed CSS width (dock.css) — DockColumn's own
// stacked-layout threshold below needs this same number in JS to reproduce
// what the CSS actually costs.
const RAIL_DIVIDER_WIDTH_PX = 6;
// `.dock-pane-divider`'s own fixed CSS width (dock.css) — issue #1244's
// draggable divider between the primary and pinned log panes, which
// replaced #1239's fixed `.dock-log-pane + .dock-log-pane` margin rule (an
// adjacent-sibling selector that stopped matching once a real divider
// element sits between the two panes). `twoPaneThresholdPx` below needs
// this same number for the same reason `RAIL_DIVIDER_WIDTH_PX` does:
// without it, a column sized exactly at
// `railWidth + RAIL_DIVIDER_WIDTH_PX + 2 * logPaneMinWidth` satisfies the
// threshold in JS but is still `PANE_DIVIDER_WIDTH_PX` too narrow to
// actually hold both panes side by side without one of them clipping below
// its own `min-width` floor — mullion-reviewer caught this on the first
// version of this threshold (then measuring the CSS margin, not a divider),
// which omitted the gap entirely.
const PANE_DIVIDER_WIDTH_PX = 6;
// How long `pendingSelectKeyRef` (DockColumn) exempts a just-requested row
// from the reconciliation's "no matching row, fall back" rule before giving
// up on it — generous relative to a normal local createSession round trip,
// short enough that a genuinely hung request (a dead remote host with no
// timeout on this path) doesn't wedge the log pane on its empty hint
// indefinitely.
const PENDING_SELECT_TIMEOUT_MS = 15_000;

// Issue #1244 — reads the shared pane-split ratio for a given workspace out
// of `STORAGE_KEYS.dockPaneSplitRatio` (`Record<string, number>` keyed by
// `String(workspaceId)`), falling back to an even 50/50 split when there's
// no active workspace (`workspaceId === null`) OR no stored/valid entry for
// this one yet. A stored value outside `(0, 1)` (corrupt/hand-edited
// localStorage) collapses to the same 0.5 default rather than propagating a
// nonsensical ratio into the render-time clamp below.
function readPaneSplitRatio(workspaceId: number | null): number {
  if (workspaceId === null) return 0.5;
  const all = readJSON<Record<string, number>>(STORAGE_KEYS.dockPaneSplitRatio, {});
  const stored = all[String(workspaceId)];
  return typeof stored === "number" && Number.isFinite(stored) && stored > 0 && stored < 1
    ? stored
    : 0.5;
}

// Issue #1238 — shape of `STORAGE_KEYS.dockSelectedRows`'s stored value,
// keyed by `String(projectId)`. `pinned` is carried in the type even though
// nothing in this file writes it yet, so #1239 can start writing it without
// a storage migration; DockColumn's own persist effect below preserves
// whatever is already there on read-modify-write.
type PersistedDockSelection = Record<string, { selected: string | null; pinned?: string | null }>;

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
//
// Split into dock/*.tsx (Wave 5 / PR 28 of
// .claude/plans/can-we-do-a-warm-cocke.md) — this file keeps Dock's own
// column-list orchestration (the height/column-divider drag handles,
// collapse, manual pinning) plus DockColumn's dock-control CRUD (fetching/
// launching/killing monitors, the worktree-switch and check-update/
// pull-restart handlers), while the GitHub status widget
// (dock/DockGithubRow.tsx + dock/useDockGithubStatus.ts), the armed-kill
// confirm gate (dock/useArmedKill.ts), the transient check-status message
// (dock/useTransientStatus.ts), and a single monitor's own row markup
// (dock/DockMonitor.tsx) are now focused, mostly-presentational pieces.
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
  // Bug fix (independent review, tablet tier plan PR 4) — tablet.css's own
  // `.dock { display: none }` under `(pointer: coarse)` only hides this
  // element visually; it doesn't stop React from mounting DockColumn below,
  // which is what actually calls TerminalPane's registerTerminalInput() for
  // every running dock monitor. A CSS-only hide left the same
  // most-recent-registration-wins ambiguity terminalInputRegistry.ts's own
  // header comment documents (a key-bar tap could silently target an
  // invisible Dock monitor's terminal instead of the visible pane) fully
  // reachable underneath the hidden element — this actually skips mounting
  // DockColumn (and therefore registering) under a coarse pointer, rather
  // than just hiding the result.
  const isCoarsePointer = useCoarsePointer();
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
  // Dock master-detail rework — the rail width (`.dock-rail`, dock.css)
  // inside EVERY column's own `.dock-split`, dragged via that column's
  // `.dock-rail-divider`. Unlike `widths` above, this genuinely IS a stable
  // per-user preference (persisted, `crs.dockRailWidth`) rather than an
  // artifact of which projects happen to be tiled right now — see
  // STORAGE_KEYS.dockRailWidth's own doc comment. One shared value for
  // every column (not indexed by projectId) is deliberate: a user who
  // widens the rail on one stack almost certainly wants the same width on
  // every other column too, not a per-project setting to redo each time.
  const [railWidth, setRailWidth] = useState(() => {
    const n = readNumber(STORAGE_KEYS.dockRailWidth, NaN);
    return Number.isFinite(n) && n > 0 ? clamp(n, RAIL_MIN_WIDTH, Infinity) : DEFAULT_RAIL_WIDTH;
  });

  // Issue #1244 — the shared pane-split ratio lives here (one value for
  // every column in the workspace, mirroring `railWidth` above), keyed by
  // `activeWorkspaceId` rather than `projectId`: a workspace can hold
  // several projects, and this ratio is meant to apply uniformly across
  // that workspace's columns, not per-project like `dockSelectedRows`. Not
  // read via `WorkspaceSwitcher.tsx`-style prop threading — `Dock` doesn't
  // receive a workspace id as a prop today, but it already subscribes to
  // other store fields via selectors (`projects`/`sessions` above), so this
  // just adds one more.
  const activeWorkspaceId = useDashboardStore((s) => s.activeWorkspaceId);
  const [paneSplitRatio, setPaneSplitRatio] = useState<number>(() =>
    readPaneSplitRatio(activeWorkspaceId),
  );
  // Switching workspaces while the dock stays mounted must re-read the
  // ratio from storage for the NEW workspace, not carry the previous
  // workspace's in-memory value over — the lazy initializer above only ever
  // runs once, at Dock's own first mount, so a later workspace switch needs
  // its own read. Deliberately does NOT also write here (see
  // `persistPaneSplitRatio` below, called only from the drag's own
  // `onCommit`): an effect keyed on `[activeWorkspaceId, paneSplitRatio]`
  // that wrote unconditionally would, on the very commit a workspace switch
  // lands, still see THIS render's stale (previous-workspace) `paneSplitRatio`
  // value — since this read effect's own `setPaneSplitRatio` call only takes
  // effect on a LATER render — and silently overwrite the new workspace's
  // stored entry with the old workspace's ratio.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPaneSplitRatio(readPaneSplitRatio(activeWorkspaceId));
  }, [activeWorkspaceId]);
  // Called only from the pane divider's own `onCommit` (DockColumn, per
  // column) — never from a passive effect on `paneSplitRatio` itself, for
  // the same reason the read above isn't paired with a symmetric write
  // effect. `useDragResize`'s `onCommit` is read through a ref refreshed on
  // every render (see that hook's own doc comment), so by the time a drag
  // actually ends this closure always sees the CURRENT `activeWorkspaceId`,
  // not a stale one from whenever the drag started.
  const persistPaneSplitRatio = (ratio: number) => {
    if (activeWorkspaceId === null) return;
    const all = readJSON<Record<string, number>>(STORAGE_KEYS.dockPaneSplitRatio, {});
    writeJSON(STORAGE_KEYS.dockPaneSplitRatio, { ...all, [String(activeWorkspaceId)]: ratio });
  };

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
  // Handle sits on the TOP border: dragging up (clientY decreases) grows
  // the dock, matching the direction the border itself moves — hence
  // `invert: true`. Persists on drag end only via `onCommit` (never fires
  // on mount, so no separate "skip the initial mount" guard is needed the
  // way the pre-extraction effect had by hand).
  // Extracted so the mount-time clamp effect below can reuse the exact same
  // ceiling the drag itself enforces, rather than a second, possibly
  // drifting copy of the same math.
  const getDockMaxHeight = () => {
    const dockEl = dockRef.current;
    // Measure the two flex siblings directly (not the shared parent's
    // clientHeight, which also includes the mobile-only tab bar /
    // sidebar toggle) so the available-space math stays correct
    // regardless of which of those happen to be rendered.
    const dockviewEl = dockEl?.parentElement?.querySelector<HTMLElement>(".dockview-container");
    const available = (dockEl?.clientHeight ?? 0) + (dockviewEl?.clientHeight ?? 0);
    return Math.max(DOCK_MIN_HEIGHT, available - GRID_MIN_HEIGHT);
  };

  const { onMouseDown: onHeightHandleMouseDown } = useDragResize({
    axis: "y",
    invert: true,
    min: DOCK_MIN_HEIGHT,
    getMax: getDockMaxHeight,
    value: height,
    onChange: setHeight,
    onCommit: (v) => writeNumber(STORAGE_KEYS.dockHeight, v),
    cursor: "ns-resize",
  });

  // Dock master-detail rework — DEFAULT_DOCK_HEIGHT rose from 220 to ~400 to
  // give a fresh install's log pane real breathing room (see that
  // constant's own doc comment). The persisted-value branch of the `height`
  // initializer above can't run this same clamp inline: `dockRef` isn't
  // attached to anything yet during that useState initializer, so
  // `getDockMaxHeight()` would only ever see zeros. A short viewport could
  // otherwise open at a height taller than the drag handle would ever let
  // it reach — this brings a first-mount default (or a stale persisted
  // value from a since-shrunk window) in line with the same ceiling the
  // drag itself enforces, once refs actually resolve to real layout. Fires
  // once, not on every `height` change (an intentional user drag past this
  // "ceiling" mid-session — the window growing after mount — must not be
  // fought by this effect re-running).
  useLayoutEffect(() => {
    const max = getDockMaxHeight();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHeight((h) => (h > max ? max : h));
  }, []);

  // ---- Rail-divider resize (dock master-detail rework) ----
  // One `useDragResize` call here, shared by EVERY column's own
  // `.dock-rail-divider` (DockColumn passes this file's `onRailDividerMouseDown`
  // straight through) — `railWidth` is one value for the whole dock (see its
  // own doc comment above), so it only needs one drag driver, not one per
  // column. `getMax` can't be a plain closure over "the" column's width the
  // way `getDockMaxHeight` above closes over `dockRef`, though: which
  // column's own width bounds THIS drag depends on which column's divider
  // was actually grabbed, and that's only known at the moment of the
  // mousedown — `draggingColumnElRef`, set by `onRailDividerMouseDown`
  // itself just before delegating to the hook, is what lets `getMax` read
  // the right element on every drag regardless of which column started it.
  const draggingColumnElRef = useRef<HTMLElement | null>(null);
  const { onMouseDown: onRailDividerMouseDownRaw } = useDragResize({
    axis: "x",
    min: RAIL_MIN_WIDTH,
    getMax: () => {
      const colWidth = draggingColumnElRef.current?.getBoundingClientRect().width ?? 0;
      // 40% of the column — the plan's own clamp — floored at RAIL_MIN_WIDTH
      // so a very narrow column (already in stacked layout at that point,
      // per DockColumn's own stackedThresholdPx) never computes a max
      // below the min.
      return Math.max(RAIL_MIN_WIDTH, colWidth * 0.4);
    },
    value: railWidth,
    onChange: setRailWidth,
    onCommit: (v) => writeNumber(STORAGE_KEYS.dockRailWidth, v),
    cursor: "col-resize",
  });
  const onRailDividerMouseDown = (e: ReactMouseEvent, columnEl: HTMLElement | null) => {
    draggingColumnElRef.current = columnEl;
    onRailDividerMouseDownRaw(e);
  };

  // ---- Column divider resize ----
  // Deliberately NOT `useDragResize` — see that hook's own doc comment:
  // this splits a fixed total width between two adjacent columns from one
  // drag, not "clamp one value between a min and a max," a genuinely
  // different shape from every other drag handle in this file (and
  // UnifiedBoard.tsx's). Stays hand-written.
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
      {!collapsed && !isCoarsePointer && (
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
                railWidth={railWidth}
                onRailDividerMouseDown={onRailDividerMouseDown}
                paneSplitRatio={paneSplitRatio}
                onPaneSplitRatioChange={setPaneSplitRatio}
                onPaneSplitRatioCommit={persistPaneSplitRatio}
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

function DockColumn({
  projectId,
  width,
  railWidth,
  onRailDividerMouseDown,
  paneSplitRatio,
  onPaneSplitRatioChange,
  onPaneSplitRatioCommit,
  onOpenGitHub,
  onOpenBrowser,
  onRemove,
}: {
  projectId: number;
  width: number | undefined;
  // Dock master-detail rework — shared across every column, see Dock's own
  // `railWidth` state comment for why this isn't per-column.
  railWidth: number;
  onRailDividerMouseDown: (e: ReactMouseEvent, columnEl: HTMLElement | null) => void;
  // Issue #1244 — the STORED, unclamped ratio, shared across every column
  // in the workspace (Dock's own state, see its doc comment). Each
  // DockColumn clamps this against its OWN measured width at render time
  // (`effectiveRatio` below) rather than trusting it directly — see that
  // derivation's own comment for why the clamp has to live here, per
  // column, even though the value itself doesn't.
  paneSplitRatio: number;
  // Fired on every `mousemove` during a pane-divider drag — updates Dock's
  // shared `paneSplitRatio` state so every column re-renders with (and
  // re-clamps) the new value, mirroring `onRailDividerMouseDown`'s "one
  // shared driver" shape.
  onPaneSplitRatioChange: (ratio: number) => void;
  // Fired once on drag end — Dock's own closure decides whether/where to
  // persist (skipped while `activeWorkspaceId` is null).
  onPaneSplitRatioCommit: (ratio: number) => void;
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
    sessionsLoaded,
    gitBranchesByProject,
    settings,
    dockConfigRefreshTrigger,
    prsRefreshTrigger,
  } = useDashboardStore(
    useShallow((s) => ({
      projects: s.projects,
      sessions: s.sessions,
      sessionsLoaded: s.sessionsLoaded,
      gitBranchesByProject: s.gitBranchesByProject,
      settings: s.settings,
      dockConfigRefreshTrigger: s.dockConfigRefreshTrigger,
      // P12 — GitHubPanel.tsx's own live-updating widget already reads
      // this (see dock/useDockGithubStatus.ts's mirrored comment); the
      // dock's own GitHub widget fetched once per projectId and never
      // again, so its CI/PR counts froze at whatever they were when the
      // panel first mounted while GitHubPanel next to it kept updating
      // live off the same `/ws/github` push channel (store.ts's
      // connectGitHubWS bumps this counter on every message for a
      // subscribed project).
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
  // Transient, human-readable outcome of the LAST "Check for update"/kill/
  // start action — dock/useTransientStatus.ts (Hermes review: a
  // `reason: "pull-failed"`/up-to-date check result used to be stored but
  // never surfaced anywhere, since the image pill only ever reacts to
  // `updateAvailable`).
  const { statusById: checkStatusById, show: showCheckStatus } = useTransientStatus(4000);
  // U8 — arm-then-confirm before a running monitor's header click actually
  // kills it, gated on confirmBeforeKill above — see dock/useArmedKill.ts's
  // own doc comment for why this isn't the shared <ConfirmButton>.
  const KILL_ARM_DISARM_MS = 6000; // matches ConfirmButton.tsx's own window
  const {
    armedIds: killArmedIds,
    arm: armKill,
    disarm: disarmKill,
  } = useArmedKill(KILL_ARM_DISARM_MS);
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

  // ---- Selected rail row (dock master-detail rework) ----
  // dockRowKey(control) of whichever row DockLogPane is currently showing —
  // component-local state, persisted to `crs.dockSelectedRows` per project
  // (issue #1238) so it survives a reload rather than always falling back
  // to the adopt-on-empty rule below. Reconciled against the row set
  // further down (after allRenderedControls is computed) using the SAME
  // render-time "adjust state during render" pattern heldState above
  // already uses, not a passive `useEffect` — a first version of this used
  // an effect, and a real test failure caught why that's wrong: `controls`
  // only loads asynchronously (usePolling below), so the render where a
  // row's session is ALREADY running (e.g. reload-with-streams-already-
  // running) would otherwise paint the log pane's empty hint for one commit
  // before the effect's own follow-up render adopted it — a real,
  // user-visible flicker on every reload with a live stream, not just test
  // flakiness. Reconciling during render means the row and its correct
  // selection land in the SAME commit. Every direct assignment beyond that
  // happens in renderMonitor's own selectRow/toggleStream closures below.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // Issue #1238 — this column's persisted selection, read from
  // `localStorage` exactly once per mount via `useState`'s lazy initializer
  // (not on every render), then held in a ref so the reconciliation below
  // can consult it without re-reading storage. `useRef`'s constructor has no
  // lazy-init form of its own — writing `useRef(() => {...})()` would call
  // the ref object itself as a function and throw — so the read has to go
  // through this `useState` first.
  //
  // One shared type for both the read here and the persist effect further
  // down, rather than two independently hand-written literals for the same
  // storage shape — the two call sites can't drift out of sync with each
  // other this way. Not exported from persistedState.ts: that module's own
  // header describes itself as general-purpose read/write primitives, not a
  // per-key schema registry, and Dock.tsx is (and, per #1239, will remain)
  // the only consumer.
  const [persistedInitialKey] = useState<string | null>(() => {
    const all = readJSON<PersistedDockSelection>(STORAGE_KEYS.dockSelectedRows, {});
    return all[String(projectId)]?.selected ?? null;
  });
  // Mirrors `persistedInitialKey` into a ref rather than reading that state
  // value directly below — `persistedInitialKey` itself never changes after
  // mount, so reading it directly would be equally safe, but going through
  // a ref makes the reconciliation's intent legible at the call site:
  // "consult the mount-time seed," not "read live state that happens to be
  // frozen." Read-only during render (the reconciliation's adopt-on-empty
  // branch below), written only here at mount — never cleared afterward.
  // The adopt-on-empty branch only ever fires while `selectedKey` is
  // `null`, so once a selection lands this ref stops being consulted
  // regardless of whether it's cleared; clearing it would itself be a ref
  // write during render, which is exactly what heldState's own comment
  // above documents as unsafe under StrictMode's dev-only
  // double-invocation (the first pass would consume the seed and clear it,
  // the second pass would see it already `null` and the restored selection
  // would silently fail to apply). Same posture as `pendingSelectKeyRef`
  // below: read-only during render, safe to leave stale forever.
  const initialPersistedKeyRef = useRef<string | null>(persistedInitialKey);
  // Exempts a row the user (or a stack action) just asked to START from the
  // reconciliation's "no matching row, fall back" rule for however many
  // renders it takes to become real. Load-bearing specifically for a stack
  // action: `optimisticEphemeralControls` below filters on `runningFor(c)`,
  // so a freshly-added ephemeral control is invisible to
  // `allRenderedControls` until `refreshSessions()` (awaited after the POST
  // that starts it) lands — without this exemption the reconciliation would
  // see "selected key, no row" on the very next render and immediately fall
  // back, then re-select once the row appears a moment later: a visible
  // select→unselect→reselect flicker for every stack action.
  //
  // A plain ref, safely — it's only ever WRITTEN from an event handler
  // (renderMonitor's own start paths, never from inside this render body)
  // and only READ here during render, which is the one ref-during-render
  // pattern React's own rules actually permit (writing one during render is
  // what heldState's own comment above warns is unsafe under StrictMode's
  // double-invocation; reading a ref that's never written mid-render has no
  // such hazard). Deliberately never CLEARED once the row is observed
  // either, for the same reason — that clear would itself be a mid-render
  // ref write. Left set, it's harmless: every subsequent start overwrites it
  // with that start's own key, and the reconciliation below only ever
  // consults it as a narrow exemption for a key that's already missing from
  // `rowKeys`, so a stale value sitting here after its row long since
  // arrived is simply never read again for that key.
  //
  // Carries a timestamp, not just the key, so this exemption can't wedge
  // the reconciliation forever if the launch it's guarding never actually
  // settles — `startAndSelect`'s own `.catch()` clears it on an explicit
  // rejection, but a request that just HANGS (a dead remote host with no
  // request timeout on this path) never rejects at all, and without a
  // self-expiry a genuinely-vanished row would stay exempt from the
  // "fall back to a neighbour" rule indefinitely, leaving `.dock-log-pane`
  // stuck on its empty hint until the user clicks something else by hand.
  const pendingSelectKeyRef = useRef<{ key: string; setAt: number } | null>(null);

  // ---- Pinned second rail row (issue #1239) ----
  // dockRowKey(control) of whichever row DockLogPane's SECOND pane shows, or
  // null when nothing is pinned. Unlike `selectedKey` above, this needs no
  // adopt-on-empty fallback and no persisted-seed ref indirection: it's
  // simple state, seeded once at mount from the same `crs.dockSelectedRows`
  // object (`#1238`'s own storage key — purely additive, no new key), and
  // pruned (never reassigned to a neighbour) by the SAME render-time
  // reconciliation block below that already validates `selectedKey` — see
  // that block's own comment for why "adjust state during render" is used
  // instead of a passive `useEffect` here too.
  const [pinnedKey, setPinnedKey] = useState<string | null>(() => {
    const all = readJSON<PersistedDockSelection>(STORAGE_KEYS.dockSelectedRows, {});
    return all[String(projectId)]?.pinned ?? null;
  });

  // Recomputed from the user's LIVE terminal settings on every render
  // (cheap — a few arithmetic ops, no measurement) rather than trusting
  // `.dock-log-pane`'s own static CSS floor, which is only correct at the
  // default 14px/4px — see dockMonitorMinWidthPx's own doc comment. Dock
  // master-detail rework — this used to size every `.dock-monitor` card;
  // now there's one terminal per column, so it sizes `.dock-log-pane`
  // instead (still the same derivation, same pinned 364px at defaults).
  // Computed here (not down by `renderMonitor`, where the analogous
  // pre-rework value lived) because the stacked-layout threshold right
  // below needs it too.
  const logPaneMinWidth = dockMonitorMinWidthPx(
    settings.terminal.fontSize,
    settings.terminal.padding,
  );
  // Vertical counterpart — deliberately `dockMonitorMinHeightPx` (the
  // BODY-only number), NOT `dockMonitorFullMinHeightPx` (which adds back a
  // 28px header this box doesn't have) — see `.dock-log-pane`'s own doc
  // comment (empty-states.css) for why using the full number here would be
  // the exact review-caught "wrong element, wrong number" bug its own
  // history warns about, just re-introduced on the other side of this
  // rework.
  const logPaneMinHeight = dockMonitorMinHeightPx(
    settings.terminal.fontSize,
    settings.terminal.padding,
  );

  // Dock master-detail rework — below this width, this column's own
  // `.dock-split` flips to `flex-direction: column` (rail above, log pane
  // below) instead of side by side: below that width neither the rail nor
  // `.dock-log-pane`'s own floor can hold without one clipping the other.
  // Derived from the SAME two numbers that actually determine the
  // side-by-side layout's real minimum width — the user's live `railWidth`
  // (not a fixed default) plus the divider plus `logPaneMinWidth` above
  // (recomputed from live font settings, not a fixed 364) — rather than a
  // static literal: a fixed threshold would desync from reality the moment
  // either one changed (a wide dragged rail staying "unstacked" past the
  // point its own content genuinely overflows, or a shrunk font/padding
  // making the real floor narrower than a stale threshold assumed).
  const stackedThresholdPx = railWidth + RAIL_DIVIDER_WIDTH_PX + logPaneMinWidth;

  // Issue #1239 — the second (pinned) pane needs room for the rail PLUS
  // TWO log panes PLUS the divider between them: same terms as
  // `stackedThresholdPx` above, `logPaneMinWidth` counted twice, plus
  // `PANE_DIVIDER_WIDTH_PX` (issue #1244's draggable divider between the two
  // panes — see that constant's own comment), the ONE extra divider this
  // layout costs between exactly two panes. mullion-reviewer caught an
  // earlier version of this that omitted that term entirely: without it, a
  // column sized exactly at the threshold satisfies this comparison but is
  // still `PANE_DIVIDER_WIDTH_PX` too narrow to hold both panes without one
  // clipping below its own `min-width` floor. Independent of the SHARED
  // split ratio itself (#1244) — this only gates whether the second pane
  // renders at all, not how the two panes divide whatever room they get.
  const twoPaneThresholdPx =
    railWidth + RAIL_DIVIDER_WIDTH_PX + 2 * logPaneMinWidth + PANE_DIVIDER_WIDTH_PX;

  // A ResizeObserver (not a CSS container query) drives the stacked flip —
  // this dock's overflow-x escape hatch for a too-narrow rail/column
  // depends on a child's min-content propagating up through several
  // ordinary flex containers, which `container-type: inline-size` would
  // break by establishing containment on this box. Same pattern as
  // PaneTab.tsx's own `narrow`/`tight` ResizeObserver — see that
  // component's comment for the "why not a resize event on window"
  // reasoning, which applies here identically (a column can narrow from a
  // sidebar/divider drag with no window resize at all).
  //
  // `lastColumnWidthRef` plus the ref-mirrored `stackedThresholdPx` below
  // are what let `splitStacked` react to EITHER kind of change that can
  // make this column need to flip — a real column resize (only the
  // ResizeObserver ever sees this) or the threshold itself moving (a rail
  // drag or a font-size settings change, neither of which resizes the
  // column element at all). Re-deriving `splitStacked` from the last
  // measured width whenever the threshold changes, in the effect below,
  // covers the second case without a second ResizeObserver.
  const columnRef = useRef<HTMLDivElement>(null);
  const [splitStacked, setSplitStacked] = useState(false);
  const lastColumnWidthRef = useRef<number | null>(null);
  const stackedThresholdRef = useRef(stackedThresholdPx);
  // Issue #1239 — same last-measured width as `lastColumnWidthRef` above,
  // but held as REACTIVE state rather than a ref: `canShowSecondPane` below
  // has to re-derive on every resize that crosses `twoPaneThresholdPx` even
  // when `splitStacked`'s own boolean doesn't flip (`twoPaneThresholdPx` is
  // strictly above `stackedThresholdPx`, so a column can cross the former
  // while staying on the same side of the latter, which wouldn't change
  // `splitStacked` and so wouldn't otherwise trigger a re-render). Written
  // from the SAME two call sites as `lastColumnWidthRef` (the observer
  // callback and `setColumnRef` below) — not a second `ResizeObserver`.
  const [columnWidthPx, setColumnWidthPx] = useState<number | null>(null);
  useEffect(() => {
    stackedThresholdRef.current = stackedThresholdPx;
    if (lastColumnWidthRef.current !== null) {
      setSplitStacked(lastColumnWidthRef.current < stackedThresholdPx);
    }
  }, [stackedThresholdPx]);
  useEffect(() => {
    const el = columnRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width === undefined) return;
      lastColumnWidthRef.current = width;
      // Hermes review — `columnWidthPx` and `lastColumnWidthRef` mirror each
      // other from exactly these two sites (here and `setColumnRef` below).
      // Do not introduce a third writer (e.g. a future observer on a
      // sibling element) without updating BOTH here — a write to one alone
      // would let them silently drift apart.
      setColumnWidthPx(width);
      setSplitStacked(width < stackedThresholdRef.current);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // The callback-ref form (rather than plain useRef + a mount effect) runs
  // during React's commit phase, before the browser paints — measuring
  // here and calling setSplitStacked synchronously avoids a one-frame
  // flash of the WRONG layout on a column that mounts already narrower (or
  // wider) than the threshold, exactly the class of bug PaneTab.tsx's own
  // `setTabRef` callback-ref exists to avoid (see that component's own
  // comment). The ResizeObserver above still owns every resize after
  // mount. Wrapped in useCallback so React doesn't treat it as a new ref
  // on every re-render, which would detach/reattach (and re-measure) on
  // each one.
  const setColumnRef = useCallback((el: HTMLDivElement | null) => {
    columnRef.current = el;
    if (!el) return;
    const width = el.getBoundingClientRect().width;
    lastColumnWidthRef.current = width;
    setColumnWidthPx(width);
    setSplitStacked(width < stackedThresholdRef.current);
  }, []);

  // Issue #1239 — gates the SECOND `DockLogPane` (below): never alongside
  // stacked mode (there's no side-by-side row left to split in a column
  // layout), and only once the live column width actually clears
  // `twoPaneThresholdPx`. Deliberately does NOT clear `pinnedKey` when this
  // is false — narrowing back past the threshold hides the second pane
  // without discarding the pin, so widening the column again restores it
  // with no re-click (see `pinnedKey`'s own doc comment and this file's
  // `holdVanishedDockerControls`/`splitStacked` for the same "degrade the
  // rendering, keep the state" pattern elsewhere in this file).
  const canShowSecondPane =
    !splitStacked && columnWidthPx !== null && columnWidthPx >= twoPaneThresholdPx;

  // ---- Pane-divider resize (issue #1244) ----
  // The width actually available to the two log panes plus the divider
  // between them — this column's own measured width, minus the rail and
  // BOTH dividers (rail-to-primary and primary-to-pinned). `columnWidthPx`
  // is `null` until this column's own ResizeObserver (above) fires its
  // first callback, hence the `?? 0` floor rather than leaving this
  // `null`-typed — nothing below renders on that first commit anyway
  // (`canShowSecondPane` is false whenever `columnWidthPx` is null), and
  // `Math.max(0, …)` keeps a not-yet-measured or genuinely-too-narrow
  // column from going negative.
  const paneAreaWidth = Math.max(
    0,
    (columnWidthPx ?? 0) - railWidth - RAIL_DIVIDER_WIDTH_PX - PANE_DIVIDER_WIDTH_PX,
  );
  // Render-time clamp — the part #1244's own issue text doesn't cover: ONE
  // ratio is shared by every column in the workspace (Dock's own
  // `paneSplitRatio` state), but a ratio that's legal in a wide column can
  // push a pane below `logPaneMinWidth` in a narrower sibling, with no drag
  // involved at all (a resize, or simply two projects' columns differing in
  // width). Each column clamps the SHARED value against its OWN measured
  // width here, at render — never in a `useState` lazy initializer, which
  // would run before `columnWidthPx` is ever measured (same mount-time
  // re-clamp hazard `height`'s own effect above, and UnifiedBoard.tsx's
  // drawer width, both already guard against for a persisted value).
  // Deliberately does NOT feed this clamped value back into `paneSplitRatio`
  // itself: the STORED ratio stays whatever the user actually chose, so
  // widening this column (or looking at a wider sibling column showing the
  // same workspace) honors it again with no re-drag — the same "degrade the
  // rendering, keep the state, reflow when room returns" posture
  // `holdVanishedDockerControls` and `pinnedKey` (#1239) above already use.
  // Capped at 0.5 (not left to exceed it): once `paneAreaWidth` drops below
  // `2 * logPaneMinWidth`, neither pane can actually fit at its floor
  // side by side at all — `Math.min(Math.max(r, floor), 1 - floor)` would
  // otherwise INVERT (floor > 1 - floor) and return the LOWER bound,
  // silently defeating the very floor it's supposed to enforce. Unreachable
  // through the divider today (it only renders once `canShowSecondPane` is
  // true, which already requires room for both panes plus their floors —
  // see `twoPaneThresholdPx`), but `effectivePanePx` below is computed
  // unconditionally on every render (the hook itself must be called
  // unconditionally, per the rules of hooks), so this stays a defined,
  // non-inverting value even on a render where the divider itself doesn't
  // show.
  const paneFloorRatio = paneAreaWidth > 0 ? Math.min(0.5, logPaneMinWidth / paneAreaWidth) : 0.5;
  const effectiveRatio = Math.min(Math.max(paneSplitRatio, paneFloorRatio), 1 - paneFloorRatio);
  // Rounded once here and reused for BOTH the hook's own `value` (below) and
  // the rendered `flex-basis` (JSX below) — `effectiveRatio * paneAreaWidth`
  // on its own is only rarely a whole number (division then remultiplication
  // accumulates floating-point slop, e.g. 444.00000000000006), which would
  // otherwise make the drag's own starting pixel differ from the previous
  // render's actual `flex-basis` by a sub-pixel sliver, and would make an
  // exact CSS pixel value impossible to assert on. A single shared,
  // rounded source of truth keeps the two exactly in sync.
  const effectivePanePx = Math.round(effectiveRatio * paneAreaWidth);

  // `useDragResize` (see that hook's own doc comment) applies here the same
  // way it does to the rail divider: "clamp one value, let the sibling's
  // `flex: 1 1 0` absorb the remainder." Unlike the rail divider, this hook
  // call lives HERE, per column, not once in Dock shared via a
  // `draggingColumnElRef` indirection — `railWidth` is a plain px value with
  // no per-column meaning, so one shared hook call and a ref telling
  // `getMax` which column to measure is enough; this divider's `value` is
  // derived from a RATIO converted through THIS column's own paneAreaWidth,
  // and unlike `getMax` (called lazily, only at drag start), the hook's
  // `value` prop is read directly off of whatever render most recently
  // constructed its `onMouseDown` closure — so it has to already be correct
  // for a specific column before any drag starts, which a shared,
  // ref-indirected call site can't guarantee (the ref only reflects
  // whichever column was dragged LAST, not the one about to be). Keeping the
  // hook call per column sidesteps that entirely: `paneAreaWidth` above is
  // already this column's own live measurement.
  //
  // `value`/`onChange`/`onCommit` all convert through `effectiveRatio`
  // (the CLAMPED ratio), not the raw shared `paneSplitRatio` — starting a
  // drag from the clamped, actually-rendered position, not a value this
  // column can't currently honor, so the divider never jumps the instant a
  // drag begins on a column narrower than the one that last set the ratio.
  // A bare click (mousedown -> mouseup with no mousemove in between, an
  // entirely ordinary stray click on the handle) still fires `onCommit`
  // below: `useDragResize`'s own `lastValueRef` is seeded to `value` at
  // drag start and only ever updated by a real `mousemove`, so a no-op
  // "drag" commits with exactly that seed. Since `value` (`effectivePanePx`)
  // is the CLAMPED render value, not necessarily the raw stored ratio (see
  // `effectiveRatio`'s own comment above), persisting unconditionally would
  // silently overwrite the user's ACTUAL stored ratio with today's clamped
  // approximation on every stray click — for every column sharing this
  // workspace's ratio, not just this narrow one (which is expected to
  // degrade), but a wider sibling that was rendering the real ratio
  // correctly. That's exactly what the render-time clamp's own comment
  // above says never happens.
  //
  // Comparing `onCommit`'s own `px` against a px value captured at drag
  // start doesn't work either (an earlier version of this guard did
  // exactly that, caught in Hermes review): a user who drags away and back
  // to that exact same pixel before releasing has a completely real drag —
  // `onChange` fired, the divider visibly moved — that just happens to
  // settle back on its starting value. Comparing final-vs-start px can't
  // tell that apart from a stray click that never moved at all, and would
  // silently drop the persist for the former. Track whether `onChange`
  // fired at all during THIS drag instead — that's the actual distinction
  // being made ("did anything happen"), not "did the value net-change."
  const draggedRef = useRef(false);
  const { onMouseDown: onPaneDividerMouseDownRaw } = useDragResize({
    axis: "x",
    min: logPaneMinWidth,
    getMax: () => paneAreaWidth - logPaneMinWidth,
    value: effectivePanePx,
    onChange: (px) => {
      draggedRef.current = true;
      if (paneAreaWidth > 0) onPaneSplitRatioChange(px / paneAreaWidth);
    },
    onCommit: (px) => {
      const dragged = draggedRef.current;
      draggedRef.current = false;
      if (paneAreaWidth > 0 && dragged) {
        onPaneSplitRatioCommit(px / paneAreaWidth);
      }
    },
    cursor: "col-resize",
  });
  const onPaneDividerMouseDown = (e: ReactMouseEvent) => {
    draggedRef.current = false;
    onPaneDividerMouseDownRaw(e);
  };

  const { githubStatus, prsStatus } = useDockGithubStatus(projectId, prsRefreshTrigger);

  // Polls so a discovered Docker service's container state/image tag stays
  // live without the user toggling anything — this component only renders
  // while the dock itself is expanded (Dock's own `!collapsed` guard
  // unmounts every DockColumn otherwise), so the interval is implicitly
  // paused/cleared for free whenever the dock is collapsed.
  //
  // `dockConfigRefreshTrigger` in `deps` means a save in DockConfigPanel
  // restarts this poll immediately (same "bump a shared counter,
  // subscribers refetch" shape as GitHubPanel's own `prsRefreshTrigger`
  // dependency above), instead of waiting out DOCKER_POLL_INTERVAL_MS or a
  // page reload — docs/dock.md's own troubleshooting note calls that wait
  // out explicitly. Unlike most other usePolling call sites, this one's
  // `deps` genuinely can restart mid-lifetime (a save while a request is
  // still in flight is plausible, not just a defensive-programming
  // formality), so `isCancelled()` guards the response same as the
  // pre-extraction `cancelled` flag did (issue #73).
  usePolling(
    (isCancelled) => {
      api
        .listProjectDock(projectId)
        .then((next) => {
          if (!isCancelled()) setControls(next);
        })
        .catch(() => {
          if (!isCancelled()) setControls([]);
        });
    },
    DOCKER_POLL_INTERVAL_MS,
    { deps: [projectId, dockConfigRefreshTrigger] },
  );

  // PR2b — holds a docker-sourced control's row across the brief discovery
  // gap a compose recreate opens up (RECREATE_GRACE_MS's own comment has the
  // full mechanism). Computed HERE, in the render body — not in a
  // `useEffect` — because a passive effect's `setState` only takes effect on
  // the render AFTER the one that's already painted: for a compose group
  // whose only control just vanished, that stale commit has already dropped
  // the group's own `<div>` (and its `TerminalPane` child) by the time an
  // effect-driven correction would land, i.e. exactly the unmount/remount
  // flicker this mechanism exists to prevent. This is React's own documented
  // "adjust state during render" pattern (react.dev) — comparing `controls`
  // against a STATE-held previous value (never a ref) is what makes it safe
  // under StrictMode's dev-only double-invocation of the render body: a ref
  // mutated during the first invocation would be read back by the second as
  // its own "previous" value, computing a wrong diff, whereas React
  // guarantees both invocations see the identical prior state.
  // holdVanishedDockerControls is itself pure for the same reason — see its
  // own doc comment.
  const [heldState, setHeldState] = useState<{
    lastControls: DockControl[];
    prevDiscovered: DockControl[];
    vanishedAt: Map<string, number>;
    merge: { controls: DockControl[]; heldIds: Set<string> };
  }>({
    lastControls: [],
    prevDiscovered: [],
    vanishedAt: new Map(),
    merge: { controls: [], heldIds: new Set() },
  });
  if (controls !== heldState.lastControls) {
    const currentDiscovered = controls.filter((c) => c.source === "docker");
    // Date.now() during render is intentional here, not incidental impurity
    // the compiler's purity pass would otherwise be right to flag: this must
    // run synchronously in the render that first sees a new `controls`
    // reference (see this block's own comment above for why an effect one
    // commit later isn't good enough). A few ms of jitter in exactly which
    // render observes "now" has no visible effect on a 30s grace window.
    // eslint-disable-next-line react-hooks/purity
    const now = Date.now();
    const result = holdVanishedDockerControls(
      heldState.prevDiscovered,
      currentDiscovered,
      heldState.vanishedAt,
      now,
      RECREATE_GRACE_MS,
    );
    setHeldState({
      lastControls: controls,
      // `result.controls` (the MERGED, held-inclusive list), not the raw
      // `currentDiscovered` — a control that's still being held needs to
      // stay a candidate `holdVanishedDockerControls` re-examines on every
      // SUBSequent poll too, not just the one poll where it first vanished.
      // Feeding the raw list back in would drop it from `prev` the moment
      // it first disappears, so a second consecutive poll with it still
      // missing would see it in neither `prev` nor `next` — never
      // re-affirmed, never expired, just silently gone one poll early (or,
      // depending on timing, stuck forever if `vanishedAt`'s entry is never
      // revisited to prune it either). `vanishedAt` itself still carries the
      // real first-missing timestamp regardless of what's in `prev`, so
      // reusing the merged list here doesn't affect WHEN the grace window
      // expires — only whether the held id keeps getting looked at.
      prevDiscovered: result.controls,
      vanishedAt: result.vanishedAt,
      merge: { controls: result.controls, heldIds: result.heldIds },
    });
  }
  const heldMerge = heldState.merge;

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

  // PR3 (issue #73 follow-up) — delegates to dockHelpers.ts's
  // runningSessionFor, which matches a docker-sourced control by its stable
  // dockerSessionIdentity (containerName) rather than the reconstructed
  // `command` string alone; a non-docker control still matches by command
  // (the session might have been created with a worktree-specific cwd
  // override — see worktree selector below — which would mismatch the old
  // (control.cwd ?? project.cwd) check).
  const runningFor = (control: DockControl) => runningSessionFor(control, dockSessions);

  // Issue #73 — only an ephemeral control whose spawned session is STILL
  // active gets rendered; a finished/killed update run just disappears from
  // the column (its output stays visible in scrollback for anyone who had
  // it open, same as any other dock monitor). Computed at render time off
  // the store's own `sessions` (via dockSessions above) rather than pruned
  // in a separate effect — no need to duplicate that liveness check.
  const optimisticEphemeralControls = ephemeralControls.filter((c) => runningFor(c));
  // Dock log-streaming resize fix (symptom 3) — `ephemeralControls` above is
  // component-local `useState`, populated only by the POST response that
  // started a stack action (handlePullAndRestart/handleRebuildAndRestart/
  // handleStackAction below). A workspace switch unmounts this whole
  // DockColumn and loses that state even though the backend session
  // (`${DOCKER_STACK_SESSION_NAME_PREFIX}<composeProject>`, nameLocked —
  // stackSessionName, routes/projects.ts) survives untouched, which is what
  // made a still-running rebuild silently disappear on return. Reconstruct
  // one ephemeral control per such session that the optimistic list above
  // doesn't already cover (keyed by compose project, via issue #1112's
  // `composeProject` field — see composeProjectForControl's own doc
  // comment) — the whole reason that field exists is so this reconstruction
  // never has to parse an actionId out of an id it never had. `command`
  // stays exactly what the session was created with: display-only, per
  // AGENTS.md's opaque-blob invariant, never parsed to recover which of the
  // five actions started it (there is nothing to recover it FROM — the verb
  // was never persisted anywhere durable — so the title is deliberately
  // generic here rather than guessed).
  const optimisticComposeProjects = new Set(
    optimisticEphemeralControls
      .map((c) => composeProjectForControl(c))
      .filter((p): p is string => p !== null),
  );
  const reconstructedEphemeralControls: DockControl[] = dockSessions.flatMap((session) => {
    if (!session.name?.startsWith(DOCKER_STACK_SESSION_NAME_PREFIX)) return [];
    const composeProject = session.name.slice(DOCKER_STACK_SESSION_NAME_PREFIX.length);
    if (composeProject.length === 0 || optimisticComposeProjects.has(composeProject)) return [];
    return [
      {
        id: session.name,
        title: `Stack action running — ${composeProject}`,
        command: session.command,
        source: "docker" as const,
        composeProject,
      },
    ];
  });
  const liveEphemeralControls = [...optimisticEphemeralControls, ...reconstructedEphemeralControls];
  const configuredControls = controls.filter((c) => c.source !== "docker");
  const discoveredControls = controls.filter((c) => c.source === "docker");
  // One DockerStackGroup per compose project (dockHelpers.ts's own doc
  // comment on groupDockerControls has the full rationale — a column can
  // host more than one compose project, e.g. a dev + a prod stack, so a
  // single hoisted kebab next to the column title would be ambiguous).
  // `ungrouped` is a fallback for a control composeProjectForControl can't
  // place — none in practice today, but real rather than theoretical: an
  // ephemeral stack-action id this frontend doesn't recognize lands here
  // instead of being silently dropped.
  //
  // `heldMerge.controls` is `discoveredControls` with any currently-held
  // (recently-vanished, still within RECREATE_GRACE_MS) control spliced back
  // in — passing `heldMerge.heldIds` through lets groupDockerControls'
  // selectRepresentatives exclude a held control from anyRep/pullRep/
  // rebuildRep candidacy (its docker.state is frozen at whatever it was
  // before it vanished) while still including it in each group's own
  // `controls` for rendering/sizing — see holdVanishedDockerControls' and
  // selectRepresentatives' own doc comments (dockHelpers.ts).
  const { groups: dockerStackGroups, ungrouped: ungroupedDockerControls } = groupDockerControls(
    [...liveEphemeralControls, ...heldMerge.controls],
    heldMerge.heldIds,
  );
  // A live stack-action control still renders as its own rail row (below
  // its stack's service rows — see the group-rendering block further
  // down), same as any other control, now that the dock master-detail
  // rework removed the old `.dock-stack-action-strip` a stack action used
  // to get instead: every row costs the same 28px whether it's a service
  // or a stack action, so there's no longer a horizontal-space reason to
  // treat the two differently. `ephemeralIds` still tells the group-
  // rendering block which of a group's `controls` are ephemeral, purely so
  // it can render them in a visually distinct trailing position, not to
  // route them through a different mechanism. Derived from
  // liveEphemeralControls rather than re-parsing the id prefix so a
  // deliberately-colliding dock.json control (docs/dock.md's own escape
  // hatch) is never mis-classified as an ephemeral.
  const ephemeralIds = new Set(liveEphemeralControls.map((c) => c.id));

  // Dock master-detail rework — every group's own service/ephemeral split,
  // computed ONCE here rather than inline inside the JSX `.map` below, so
  // the selection reconciliation right after this and the actual render
  // (further down) can't drift apart on what counts as "a row."
  const stackGroupRenderData = dockerStackGroups.map((group) => ({
    group,
    serviceControls: group.controls.filter((c) => !ephemeralIds.has(c.id)),
    ephemeralControlsInGroup: group.controls.filter((c) => ephemeralIds.has(c.id)),
  }));

  // Every NON-orphan control that will actually render as a rail row this
  // render — computed first, before issue #1240's orphan detection below,
  // so that detection can check "is there already a row for this session"
  // against the exact same set the ordinary render path produces.
  const controlsBeforeOrphans: DockControl[] = [
    ...configuredControls,
    ...ungroupedDockerControls,
    ...stackGroupRenderData.flatMap((g) => [...g.serviceControls, ...g.ephemeralControlsInGroup]),
  ];

  // Issue #1240 — a `docker-logs:<containerName>` session can outlive its
  // own control: `docker compose down`, or holdVanishedDockerControls' own
  // RECREATE_GRACE_MS hold window (above) expiring, both drop a control from
  // discovery while its log-streaming session stays alive server-side. Such
  // a session has no rail row and therefore no UI affordance to stop it —
  // this block finds every one and synthesizes a standalone rail row for it.
  //
  // This MUST run after `controlsBeforeOrphans` (and therefore after
  // heldMerge's own hold-window merge earlier in this render) — a control
  // still inside its RECREATE_GRACE_MS hold window is already present in
  // `controlsBeforeOrphans` (dockerSessionIdentity already resolves it
  // there via its held `control.docker`), so it's correctly excluded from
  // `orphanedSessions` below. Getting this ordering backwards would double-
  // render a freshly-vanished-but-still-held row as BOTH held AND orphaned
  // in the same commit — see this file's own test coverage
  // (DockMonitor.test.tsx, "issue #1240") for a test that pins this.
  const orphanedSessions = dockSessions.filter(
    (s) =>
      s.name?.startsWith("docker-logs:") &&
      !controlsBeforeOrphans.some((c) => dockerSessionIdentity(c) === s.name),
  );
  const orphanControls: DockControl[] = orphanedSessions.map((s) => {
    const name = s.name as string;
    return {
      id: name,
      title: name.slice("docker-logs:".length),
      command: s.command,
      source: "docker" as const,
      // No `.docker` field at all — deliberate. Every existing docker-only
      // affordance (image pill, kebab menu, container-state label) is
      // already gated on `control.docker &&` (DockMonitor.tsx), so omitting
      // it naturally suppresses all three, leaving exactly "name + stream
      // toggle" — issue #1240's own "no container means no docker actions,
      // only stop-stream" requirement, for free.
    };
  });

  // Best-effort cosmetic grouping only — never identity or actions. Attach
  // an orphan under its former stack's group when composeProjectFromContainerName
  // resolves a project that's still a real, live group (see that function's
  // own doc comment for the `container_name:`-override case this can't
  // detect); otherwise it renders standalone, exactly like `ungroupedDockerControls`.
  const liveStackProjects = new Set(dockerStackGroups.map((g) => g.composeProject));
  const groupedOrphansByProject = new Map<string, DockControl[]>();
  const standaloneOrphanControls: DockControl[] = [];
  for (const orphan of orphanControls) {
    const containerName = orphan.id.slice("docker-logs:".length);
    const project = composeProjectFromContainerName(containerName);
    if (project !== null && liveStackProjects.has(project)) {
      const existing = groupedOrphansByProject.get(project);
      if (existing) existing.push(orphan);
      else groupedOrphansByProject.set(project, [orphan]);
    } else {
      standaloneOrphanControls.push(orphan);
    }
  }

  // Every control that will actually render as a rail row this render, in
  // render order — the single source of truth the reconciliation below and
  // DockLogPane's own sessionId lookup both read, so "does a row exist for
  // this key" can never disagree between the two.
  const allRenderedControls: DockControl[] = [...controlsBeforeOrphans, ...orphanControls];
  const rowKeys = allRenderedControls.map(dockRowKey);
  const liveRowKeys = allRenderedControls.filter((c) => runningFor(c)).map(dockRowKey);
  // Primitive signatures, not the arrays themselves, as the change-detection
  // trigger below — `allRenderedControls` is a fresh array every render
  // regardless of whether the actual row set changed, so comparing it by
  // reference (the way `heldState`'s own `controls !== heldState.
  // lastControls` check does for a genuine STATE array) would never skip;
  // joining to a string gives an equivalent cheap equality check for a
  // value that's recomputed from scratch every render instead.
  const rowKeysSignature = rowKeys.join(" ");
  const liveRowKeysSignature = liveRowKeys.join(" ");
  // Issue #1238 — has this column ever observed a non-empty row set. Read
  // by the persist effect further down, which otherwise can't distinguish
  // "controls haven't loaded yet" (rowKeys still empty on the very first
  // commit, `selectedKey` still `null` regardless of what's persisted) from
  // "controls loaded and genuinely nothing is selected" — without this,
  // that first commit's effect run would immediately overwrite a valid
  // persisted seed with `null`, before the reconciliation above ever gets a
  // chance to restore it (permanent if `controls` never loads at all — a
  // dead backend/failed fetch). The SAME "adjust state during render"
  // pattern `lastRows` below already uses, not a ref — a ref write during
  // render is flagged by this repo's own react-hooks/refs lint rule (it
  // only permits reading a ref mid-render, e.g. `pendingSelectKeyRef`
  // further down, never writing one), so this has to be state even though
  // it only ever flips one way.
  const [hasSeenRows, setHasSeenRows] = useState(false);
  if (rowKeys.length > 0 && !hasSeenRows) setHasSeenRows(true);

  // Reconciles `selectedKey` against the row set above — the render-time
  // "adjust state during render" pattern (react.dev), same idiom
  // `heldState` above already uses and for the SAME reason: a passive
  // `useEffect` version of this shipped first and a real test failure
  // (DockMonitor.test.tsx's PR2b pane-identity test, under full-suite
  // timing) caught why it's wrong here too — `controls` loads
  // asynchronously (usePolling below), so the render where a row's session
  // is ALREADY running (reload-with-streams-already-running) would paint
  // `.dock-log-pane`'s empty hint for one commit before an effect-driven
  // correction landed one tick later. Comparing against a STATE-held
  // previous signature (never a ref) is what makes this safe under
  // StrictMode's dev-only double-invocation, exactly as heldState's own
  // comment explains — `pendingSelectKeyRef` below is the one exception,
  // safe for the opposite reason: it's only ever WRITTEN from an event
  // handler, never during render, so there's nothing for a double-render to
  // corrupt.
  //
  // Two independent facts worth remembering across a render — the full row
  // set and its live subset — not three: the earlier version of this also
  // stored each one's own `.join(" ")` signature as a THIRD, separate
  // field, letting a future edit update the array without its signature
  // (or vice versa) and desync the two silently. Signatures are derived
  // fresh from these two arrays at comparison time instead.
  const [lastRows, setLastRows] = useState<{ rowKeys: string[]; liveRowKeys: string[] }>({
    rowKeys: [],
    liveRowKeys: [],
  });
  if (
    rowKeysSignature !== lastRows.rowKeys.join(" ") ||
    liveRowKeysSignature !== lastRows.liveRowKeys.join(" ")
  ) {
    const previousRowKeys = lastRows.rowKeys;
    setLastRows({ rowKeys, liveRowKeys });
    // Same "Date.now() during render is intentional here" reasoning as
    // heldState's own comment above — this has to run synchronously in the
    // render that first sees the row-set change, and a few ms of jitter in
    // exactly which render observes "now" has no visible effect on a 15s
    // timeout.
    // eslint-disable-next-line react-hooks/purity
    const nowForPendingCheck = Date.now();
    setSelectedKey((prev) => {
      if (prev !== null) {
        if (rowKeys.includes(prev)) return prev;
        const pending = pendingSelectKeyRef.current;
        if (
          pending !== null &&
          prev === pending.key &&
          nowForPendingCheck - pending.setAt < PENDING_SELECT_TIMEOUT_MS
        ) {
          return prev;
        }
        // Nearest surviving neighbour by the PREVIOUS render's index, not
        // the new one — "nearest to where the removed row used to be,"
        // matching a plain list's usual removal-selects-neighbour feel.
        // Bounded by `previousRowKeys.length` (the list `prevIndex` is
        // actually an index INTO), not `rowKeys.length` — a bulk removal
        // that shrinks a long rail down to a short one must still be able
        // to search the FULL old distance from `prevIndex` in both
        // directions, or a surviving neighbour past the new, shorter
        // length silently never gets checked.
        const prevIndex = previousRowKeys.indexOf(prev);
        if (prevIndex !== -1) {
          for (let offset = 0; offset < previousRowKeys.length; offset++) {
            const before = previousRowKeys[prevIndex - offset];
            if (before !== undefined && rowKeys.includes(before)) return before;
            const after = previousRowKeys[prevIndex + offset];
            if (after !== undefined && rowKeys.includes(after)) return after;
          }
        }
        return rowKeys[0] ?? null;
      }
      // Adopt-on-empty — nothing was selected (initial mount, or every row
      // vanished a moment ago) and at least one row now has a live stream:
      // covers reload-with-streams-already-running. Never fires merely
      // because `settings.dock.autoAttachDockerLogs`'s own effect started a
      // stream — that effect never touches `selectedKey` itself — but DOES
      // react when ITS session shows up here, same as any other stream
      // starting while nothing is selected; that's "adopt," not "steal,"
      // since there was no existing selection to steal from.
      //
      // Issue #1238 — before falling back to that rule, prefer whatever was
      // persisted for this column at mount, checked against `rowKeys`
      // (existence), deliberately NOT `liveRowKeys` (liveness) — the same
      // distinction the `prev !== null` branch above already draws
      // (`rowKeys.includes(prev)`, not `liveRowKeys.includes(prev)`):
      // selection has been orthogonal to whether a row is currently
      // streaming since the master-detail rework itself (the row body
      // selects; the trailing tag starts/stops the stream), and restoring a
      // persisted selection onto a row that exists but isn't currently live
      // is the exact same state a user already reaches by clicking that row
      // by hand. A row that no longer exists at all (its control was
      // removed, or never existed — a stale/hand-edited value) falls
      // through to the adopt-on-empty rule below unchanged.
      const persisted = initialPersistedKeyRef.current;
      if (persisted !== null && rowKeys.includes(persisted)) {
        return persisted;
      }
      return liveRowKeys[0] ?? null;
    });
    // Issue #1239 — same render-time reconciliation, same row-set change,
    // but no neighbour-search/reassignment the way `selectedKey` above gets:
    // a pin whose row vanished just drops, full stop. `rowKeys` (existence),
    // not `liveRowKeys` (liveness) — same distinction `selectedKey`'s own
    // reconciliation draws throughout this block; a pinned row that exists
    // but isn't currently streaming is still a valid pin (DockLogPane's own
    // empty state covers a not-currently-live pinned row exactly the way it
    // already does for the primary pane). The OTHER half of this guard — a
    // pin colliding with the primary selection — is handled separately,
    // below, unconditionally on every render rather than folded into this
    // signature-gated block; see that check's own comment for why.
    if (pinnedKey !== null && !rowKeys.includes(pinnedKey)) {
      setPinnedKey(null);
    }
  }
  // Issue #1239 — a pin must never coincide with the PRIMARY selection
  // (pinning "yourself" is meaningless — DockMonitor.tsx hides the pin
  // affordance on the selected row for exactly this reason). Deliberately
  // NOT folded into the row-set-gated block above: mullion-reviewer caught
  // that `selectedKey`'s own neighbour-search reconciliation (above) can
  // land the primary selection on the very row that's currently pinned
  // (e.g. the old primary's control vanishes and reconciliation reassigns
  // onto the pinned row) — a case a manual click already guards against
  // (`selectRow` below), but reconciliation doesn't run through that
  // handler. Capturing the reassigned value from inside `setSelectedKey`'s
  // own updater above (an earlier version of this fix did exactly that) —
  // trips this repo's `react-hooks/immutability` lint rule (mutating an
  // outer variable from inside a state updater); reading either
  // `pendingSelectKeyRef` or `initialPersistedKeyRef` OUTSIDE that updater
  // to recompute the value independently trips `react-hooks/refs` instead
  // (both rules assume a `setState` updater's body is only ever safe to
  // read refs from in place, never mirrored elsewhere). Running this
  // check unconditionally, one render later, sidesteps both: calling
  // `setSelectedKey` during render (as the block above does) makes React
  // immediately re-render this component with the new value BEFORE
  // painting, so this check still resolves in the same commit a user
  // would see, with no visible flash of the stale, colliding state.
  if (pinnedKey !== null && pinnedKey === selectedKey) {
    setPinnedKey(null);
  }

  // Issue #1238 (extended by #1239) — persist this column's selection AND
  // pinned row on change. Unlike the reconciliation above, this IS a
  // legitimate `useEffect`: writing to `localStorage` is a genuine side
  // effect, not derived render state. Read-modify-write against the
  // existing stored object (rather than overwriting the whole thing) so
  // multiple columns — multiple projects tiled in the dock at once — don't
  // clobber each other's entries; the `...all[String(projectId)]` spread
  // keeps this forward-compatible with any future field the same way it
  // already was for `pinned` itself before this issue.
  useEffect(() => {
    // See `hasSeenRows`'s own doc comment above — skips the write on the
    // very first commit(s) before `controls` has loaded at all, so a
    // not-yet-consumed persisted seed never gets clobbered with `null`
    // before the reconciliation above has had a chance to restore it.
    if (selectedKey === null && !hasSeenRows) return;
    const all = readJSON<PersistedDockSelection>(STORAGE_KEYS.dockSelectedRows, {});
    writeJSON(STORAGE_KEYS.dockSelectedRows, {
      ...all,
      [String(projectId)]: { ...all[String(projectId)], selected: selectedKey, pinned: pinnedKey },
    });
  }, [projectId, selectedKey, pinnedKey, hasSeenRows]);

  // Hermes review, round 2 — a transient failure (backend blip, briefly out
  // of PTY slots) otherwise recorded `eligible: true` right alongside
  // success, so the false→true edge that's supposed to retry never fires
  // again for that identity until the container itself cycles through
  // non-running or the setting is toggled — for a long-lived production
  // container, one bad attempt permanently and silently loses auto-attach.
  // Bounded per-identity cooldown instead of retrying every 15s (which
  // would be spammy for a genuinely dead host): `failedAt` records the last
  // failure, and a poll is allowed to retry once AUTO_ATTACH_RETRY_MS has
  // elapsed, without waiting for a real eligibility edge.
  const AUTO_ATTACH_RETRY_MS = 60_000;

  // PR3 (issue #73 follow-up) — settings.dock.autoAttachDockerLogs. Tracks
  // per-container whether it was "eligible" (setting on AND
  // docker.state === "running") the last time this ran, keyed by the same
  // dockerSessionIdentity used for matching above; a container's identity
  // outlives a single poll's `controls` array, so this lives in a ref, not
  // component state. Fires on a false→true edge of eligibility, or (see
  // AUTO_ATTACH_RETRY_MS above) once the cooldown has elapsed since a
  // recorded failure — never merely because eligibility is *holding* true
  // with no prior failure, which is what makes "don't fight a manual stop"
  // still true: a user manually stopping the log stream while the
  // container keeps running leaves `failedAt` untouched (null), so nothing
  // is due for retry. `runningFor` is still checked at the point of firing,
  // so a session that's already attached (manual click, or a still-live
  // stream that survived a plain `docker restart`) is never double-attached.
  const autoAttachStateRef = useRef<Map<string, { eligible: boolean; failedAt: number | null }>>(
    new Map(),
  );
  useEffect(() => {
    // `sessions` loads asynchronously (refreshSessions(), racing this
    // column's own `immediate: true` dock poll on first mount) — without
    // this gate, a poll that commits before sessions have ever loaded would
    // see `dockSessions` as `[]`, read every already-attached container as
    // "no session yet," and attach a duplicate that never gets cleaned up
    // (this effect doesn't re-run just because `sessions` arrives later).
    if (!sessionsLoaded) return;
    const autoAttachOn = settings.dock.autoAttachDockerLogs;
    // Hermes review — prune identities absent from THIS poll before
    // checking eligibility below. Without this, a `docker compose down`
    // (the container disappears from discovery entirely, not just its
    // state changing) leaves a stale entry behind forever; the container
    // coming back via `up -d` would then read as "already eligible last
    // time" and the edge that's supposed to re-attach it never fires —
    // exactly the down/up case the "re-attaches after a stopped service
    // comes back up" claim is meant to cover.
    const currentIdentities = new Set(
      discoveredControls
        .map((control) => dockerSessionIdentity(control))
        .filter((identity): identity is string => identity !== null),
    );
    for (const identity of autoAttachStateRef.current.keys()) {
      if (!currentIdentities.has(identity)) autoAttachStateRef.current.delete(identity);
    }
    // Hoisted out of the loop below — one call per poll, not per control.
    // effects (unlike render) are allowed side effects; this useEffect's own
    // exhaustive-deps suppression above appears to be what makes the
    // compiler's purity pass treat this callback as needing render-purity.
    // eslint-disable-next-line react-hooks/purity
    const nowMs = Date.now();
    for (const control of discoveredControls) {
      const identity = dockerSessionIdentity(control);
      if (identity === null) continue;
      const eligible = autoAttachOn && control.docker?.state === "running";
      const entry = autoAttachStateRef.current.get(identity);
      const wasEligible = entry?.eligible ?? false;
      const failedAt = entry?.failedAt ?? null;
      const dueForRetry = failedAt !== null && nowMs - failedAt >= AUTO_ATTACH_RETRY_MS;
      if (eligible && (!wasEligible || dueForRetry) && !runningFor(control)) {
        // Optimistic: marks eligible/not-yet-failed immediately so a poll
        // landing mid-flight doesn't also fire; the .then/.catch below
        // correct this once the attempt actually settles.
        autoAttachStateRef.current.set(identity, { eligible: true, failedAt });
        useDashboardStore
          .getState()
          .createSession(projectId, control.command, {
            kind: "dock",
            name: identity,
            nameLocked: true,
            ...(control.env ? { env: control.env } : {}),
          })
          .then(() => {
            autoAttachStateRef.current.set(identity, { eligible: true, failedAt: null });
          })
          .catch(() => {
            console.warn("[dock] auto-attach docker logs failed", control.id);
            showCheckStatus(control.id, "Auto-attach failed", true);
            autoAttachStateRef.current.set(identity, { eligible: true, failedAt: Date.now() });
          });
        continue;
      }
      autoAttachStateRef.current.set(identity, { eligible, failedAt });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runningFor/discoveredControls are recomputed fresh from `controls`/`sessions` every render; depending on `controls` (what actually changes on a poll) avoids re-running this effect on every unrelated re-render of a large, frequently-updated component.
  }, [controls, sessionsLoaded, settings.dock.autoAttachDockerLogs, projectId]);

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

  // `statusKey` defaults to `control.id` for the plain per-service call
  // sites that predate stack grouping; DockColumn's group rendering below
  // passes `stack:<composeProject>` instead, so a hoisted action's outcome
  // reports on the GROUP header rather than on whichever service happened
  // to be the representative — a failure keyed to the rep's own id would
  // otherwise surface on an arbitrary row with no connection to the button
  // that was actually clicked.
  const handlePullAndRestart = async (control: DockControl, statusKey = control.id) => {
    try {
      const result = await api.updateDockerStack(projectId, control.id);
      // Issue #73 follow-up plan (5a) — `reused: true` means a DIFFERENT
      // stack-wide action is already running on this compose project;
      // `result.control` describes the just-requested action, not
      // necessarily the one actually running, so adding it as an ephemeral
      // would render a row whose command never matches any live session
      // (runningSessionFor) and vanish again next render — see
      // addEphemeralControl's own reasoning below for why every OTHER
      // caller here still adds it unconditionally.
      if (result.reused) {
        showCheckStatus(statusKey, "Already running another stack action");
        return;
      }
      addEphemeralControl(result.control);
      // The new session won't appear in the store's `sessions` list (and
      // hence `runningFor`/`dockSessions` above) until the next poll —
      // force one now so the monitor renders immediately instead of after
      // whatever's left of store.ts's live-refresh interval.
      await useDashboardStore.getState().refreshSessions();
      if (result.willRecreate === true) showCheckStatus(statusKey, "Pulling — will recreate");
    } catch {
      console.warn("[dock] docker pull & restart failed", control.id);
      showCheckStatus(statusKey, "Failed to start update", true);
    }
  };

  const handleRebuildAndRestart = async (control: DockControl, statusKey = control.id) => {
    try {
      const result = await api.rebuildDockerStack(projectId, control.id);
      if (result.reused) {
        showCheckStatus(statusKey, "Already running another stack action");
        return;
      }
      addEphemeralControl(result.control);
      await useDashboardStore.getState().refreshSessions();
      if (result.willRecreate === true) showCheckStatus(statusKey, "Rebuilding — will recreate");
    } catch {
      console.warn("[dock] docker rebuild & restart failed", control.id);
      showCheckStatus(statusKey, "Failed to start rebuild", true);
    }
  };

  // Per-service, inline actions (restart/stop/start) — the backend runs
  // these synchronously and force-refreshes its own discovery cache on
  // success (projects.ts), so this immediately re-fetches .../dock rather
  // than waiting out the rest of DOCKER_POLL_INTERVAL_MS for the new
  // container state (dot color/state) to show up.
  const refreshControlsNow = async () => {
    try {
      setControls(await api.listProjectDock(projectId));
    } catch {
      // The next scheduled poll will retry — this is a "sooner," not a
      // "must succeed," refresh.
    }
  };

  const handleServiceAction = async (
    control: DockControl,
    action: (projectId: number, controlId: string) => Promise<{ success: boolean }>,
    failureMessage: string,
  ) => {
    try {
      const result = await action(projectId, control.id);
      if (result.success) {
        await refreshControlsNow();
      } else {
        showCheckStatus(control.id, failureMessage, true);
      }
    } catch {
      console.warn("[dock] docker service action failed", control.id);
      showCheckStatus(control.id, failureMessage, true);
    }
  };

  // Stack-wide restart/apply/stop — same ephemeral-session shape as
  // handlePullAndRestart/handleRebuildAndRestart above, same statusKey
  // override reasoning as those two.
  const handleStackAction = async (
    control: DockControl,
    action: (projectId: number, controlId: string) => ReturnType<typeof api.restartDockerStack>,
    failureMessage: string,
    statusKey = control.id,
  ) => {
    try {
      const result = await action(projectId, control.id);
      if (result.reused) {
        showCheckStatus(statusKey, "Already running another stack action");
        return;
      }
      addEphemeralControl(result.control);
      await useDashboardStore.getState().refreshSessions();
      if (result.willRecreate === true) showCheckStatus(statusKey, "Applying — will recreate");
    } catch {
      console.warn("[dock] docker stack action failed", control.id);
      showCheckStatus(statusKey, failureMessage, true);
    }
  };

  // A single monitor row's render — closes over this render's own
  // worktreePaths/toggleGenRef/allOptions/runningFor/etc., same as the
  // handlers above it. Called for configured controls, ungrouped docker
  // controls, and each compose-project group's own controls below; a group
  // needs to wrap several calls to this in its own
  // .dock-stack-group/.dock-stack-monitors box, which a flat `.map` alone
  // can't express (a per-group header can't be produced by mapping a flat
  // control list one at a time).
  const renderMonitor = (control: DockControl) => {
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
    // dock/dockHelpers.ts's resolveSelectedValue doc comment for the
    // full precedence.
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
    // PR3 — a docker-sourced control's session is named with its
    // stable dockerSessionIdentity (and locked) so a manual header
    // click matches the same way an auto-attached session does; see
    // dockHelpers.ts's own doc comment for why command-string
    // matching alone isn't reliable for these.
    const dockIdentity = dockerSessionIdentity(control);
    const identityOpts = dockIdentity ? { name: dockIdentity, nameLocked: true } : {};
    const launchForValue = (value: string) => {
      const effectiveCwd = value.length > 0 ? value : control.cwd;
      if (effectiveCwd && effectiveCwd.startsWith("branch:")) {
        const branchName = effectiveCwd.slice("branch:".length);
        return useDashboardStore.getState().createSession(projectId, control.command, {
          kind: "dock",
          worktree: { branch: branchName },
          worktreeRefresh: effectiveWorktreeRefresh,
          ...identityOpts,
          ...(control.env ? { env: control.env } : {}),
        });
      }
      return useDashboardStore.getState().createSession(projectId, control.command, {
        ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
        kind: "dock",
        ...identityOpts,
        ...(control.env ? { env: control.env } : {}),
      });
    };

    // isUpdateStillAvailable re-derives against the control's CURRENT
    // imageId rather than trusting the stored check result on its own
    // — see that function's doc comment for why (updateChecks is
    // never proactively invalidated).
    const updateAvailable = isUpdateStillAvailable(
      updateChecks[control.id],
      control.docker?.imageId,
    );
    const dockerStatus = control.docker ? dockerServiceStatus(control.docker.state) : null;

    // Dock master-detail rework — the old single `handleHeaderActivate`
    // (one click did both select AND kill/start — the exact thing U8/P10
    // flagged as "one unconfirmed click kills a running dev server") splits
    // into two named handlers, matching DockMonitor.tsx's own row-vs-tag
    // split. `startAndSelect` is the shared "not running yet" behavior both
    // land on — starting a stream always focuses it, regardless of which
    // affordance asked for it.
    const rowKey = dockRowKey(control);
    const startAndSelect = () => {
      // Issue #1239 — unlike `selectRow` below, this doesn't inline-check
      // "is `rowKey` the current pin" before calling `setSelectedKey` — a
      // pinned-but-not-yet-running row's trailing tag reaches this via
      // `toggleStream`, which is exactly that case. Still resolves
      // correctly: the unconditional `pinnedKey === selectedKey` check
      // further up this file (right after the render-time reconciliation
      // block) catches the resulting collision on the very next render,
      // before paint — see that check's own comment. No inline guard here
      // to mirror `selectRow`'s, deliberately: that check already covers
      // every path that can produce the collision, this one included.
      setSelectedKey(rowKey);
      pendingSelectKeyRef.current = { key: rowKey, setAt: Date.now() };
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
        // The row this was meant to focus will never arrive on its own —
        // release the reconciliation exemption so the NEXT render's effect
        // is free to fall back off this key instead of holding it forever.
        // (A request that HANGS instead of rejecting never reaches this
        // catch at all — PENDING_SELECT_TIMEOUT_MS above is what bounds
        // that case instead.)
        if (pendingSelectKeyRef.current?.key === rowKey) pendingSelectKeyRef.current = null;
      });
    };
    // Wired to a rail row's own click/Enter/Space (DockMonitor.tsx's
    // `onSelect`) — always changes focus; only starts the stream when it
    // was off. Selecting an already-running row is a pure focus change,
    // never a kill — that's the whole point of the split.
    const selectRow = () => {
      // Issue #1239 — selecting the currently-pinned row as the new PRIMARY
      // selection simply clears the pin (a deliberate simplification: no
      // auto-swap promoting the old primary into the now-empty pin slot).
      // Checked unconditionally, before the running/not-running branch below
      // — starting a stream via `startAndSelect()` is just as much "making
      // this row the primary" as focusing an already-running one.
      //
      // Hermes review — technically redundant with the unconditional
      // `pinnedKey === selectedKey` check further up this file (it would
      // clear this same collision on the very next render regardless), but
      // kept here too so the click that causes it also clears it in the
      // SAME commit, with no one-render flash of a stale, colliding pin.
      // That unconditional check is still the canonical cleanup, though —
      // don't add a FOURTH copy of this same guard at some future call site
      // that changes `selectedKey` outside `selectRow`/`startAndSelect`;
      // let the unconditional check catch it instead.
      if (pinnedKey === rowKey) setPinnedKey(null);
      if (running) {
        setSelectedKey(rowKey);
        return;
      }
      startAndSelect();
    };
    // Wired to the pin-toggle affordance (DockMonitor.tsx's `onTogglePin`) —
    // pins this row as the SECOND, independently-selected log pane,
    // replacing any previous pin; clicking it again on the row that's
    // already pinned unpins instead. Never touches `selectedKey` — pinning a
    // row only adds/changes the second pane, it never changes what the
    // primary pane shows.
    const togglePin = () => {
      setPinnedKey((prev) => (prev === rowKey ? null : rowKey));
    };
    // Wired to the trailing "logs on"/"logs off" tag (DockMonitor.tsx's
    // `onToggleStream`) — the ONLY place a running stream gets killed from,
    // and it never touches selection on that path: stopping the currently-
    // selected row's stream leaves it selected (the pane will show its own
    // empty state once `running` goes away), and stopping an UNselected
    // row's stream obviously shouldn't select it either.
    const toggleStream = () => {
      if (running) {
        // U8 — arm-then-confirm before actually killing; starting is never
        // destructive, so it always fires on the first click regardless of
        // confirmBeforeKill (see the `!running` branch below).
        if (!confirmBeforeKill || killArmedIds.has(control.id)) {
          disarmKill(control.id);
          bumpToggleGen(control.id);
          void useDashboardStore.getState().deleteSession(running.id);
        } else {
          armKill(control.id);
        }
        return;
      }
      startAndSelect();
    };

    // The worktree/branch select's own onChange — stays here rather
    // than moving into dock/DockMonitor.tsx along with the rest of
    // the header markup: it needs worktreePaths/toggleGenRef state,
    // launchForValue, and the deleteSession/showCheckStatus calls
    // above, all of which are this column's own CRUD state, not a
    // single monitor row's presentation.
    const onWorktreeChange = (newValue: string) => {
      setWorktreePaths((prev) => ({ ...prev, [control.id]: newValue }));
      // If a monitor is running and the user switches, kill and
      // restart in the new location.
      if (running) {
        // A stale armed kill from before the switch (the user armed
        // the header, then picked a different worktree instead of
        // confirming) must not go on reading "confirm?" for up to
        // KILL_ARM_DISARM_MS after this delete+relaunch — this
        // delete is a restart, not the armed kill.
        disarmKill(control.id);
        // Hermes review — bumped here too, BEFORE capturing
        // genAtStart below: two rapid worktree switches on the same
        // control each start their own delete-then-relaunch IIFE,
        // and previously only a header click bumped this counter —
        // so if both deletes happened to resolve, the FIRST switch's
        // relaunch could still fire (with its now-stale path) after
        // the SECOND switch had already moved the select on to a
        // newer value. Bumping unconditionally on every switch means
        // each one invalidates any still-in-flight predecessor's
        // pending relaunch, the same way an explicit header click
        // already did.
        bumpToggleGen(control.id);
        // U5 — capture the restart intent BEFORE the delete, not by
        // re-deriving it from post-delete session state.
        // `store.deleteSession` itself awaits `refreshSessions()`
        // before resolving, so by the time an `await` on it here
        // returns, this exact row already reads "killed" in the
        // store — re-checking "is a matching session still active"
        // at that point would always read false, making the
        // relaunch below permanently unreachable (verified live;
        // the original bug). `shouldRestart` is just
        // `Boolean(running)`, read from this render's own closure,
        // so it can't be corrupted by the delete it's about to
        // trigger.
        //
        // The two cases that still have to suppress the relaunch —
        // the user manually toggling THIS monitor (start or kill)
        // from the header while this switch is in flight, OR a
        // second, newer switch superseding this one — are both
        // tracked via toggleGenRef instead of session status: any
        // of the header's onClick, or this onChange itself (see the
        // bump right above), bumps that counter on an actual
        // toggle, so comparing it before/after the await detects an
        // intervening action without depending on state the delete
        // call itself mutates.
        const shouldRestart = Boolean(running);
        const genAtStart = toggleGenRef.current.get(control.id) ?? 0;
        void (async () => {
          try {
            await useDashboardStore.getState().deleteSession(running.id);
            const genUnchanged = (toggleGenRef.current.get(control.id) ?? 0) === genAtStart;
            if (shouldRestart && genUnchanged) {
              await launchForValue(newValue);
            }
          } catch {
            // Hermes review (suggestion) — reuses the same
            // showCheckStatus transient-message infra as the
            // header's own start-affordance catch above, instead of
            // a console-only warning, so a failed switch is visible
            // in the UI too.
            showCheckStatus(control.id, "Failed to switch — try again", true);
          }
        })();
      }
    };

    return (
      <DockMonitor
        key={control.id}
        control={control}
        running={running}
        selected={selectedKey === rowKey}
        showSelector={controlShowSelector}
        selectedValue={selectedValue}
        worktreeOptions={allOptions}
        onWorktreeChange={onWorktreeChange}
        devServerUrl={project?.devServerUrl}
        onOpenBrowser={() => onOpenBrowser(projectId)}
        updateAvailable={updateAvailable}
        dockerStatus={dockerStatus}
        held={heldMerge.heldIds.has(control.id)}
        checkStatus={checkStatusById[control.id]}
        armed={killArmedIds.has(control.id)}
        confirmBeforeKill={confirmBeforeKill}
        onSelect={selectRow}
        onToggleStream={toggleStream}
        pinned={pinnedKey === rowKey}
        canShowSecondPane={canShowSecondPane}
        onTogglePin={togglePin}
        onCheckUpdate={() => void handleCheckUpdate(control)}
        onServiceRestart={() =>
          void handleServiceAction(control, api.restartDockerService, "Restart failed")
        }
        onServiceStop={() =>
          void handleServiceAction(control, api.stopDockerService, "Stop failed")
        }
        onServiceStart={() =>
          void handleServiceAction(control, api.startDockerService, "Start failed")
        }
      />
    );
  };

  // Dock master-detail rework — resolves DockLogPane's own `sessionId` prop:
  // the selected control's running session, or null when nothing is
  // selected or the selected row's stream is off. Looked up against
  // `allRenderedControls` (the same list the reconciliation effect above
  // validates `selectedKey` against), not re-derived some other way, so
  // "the row DockLogPane shows" and "the row the reconciliation effect
  // thinks is selected" can never disagree about which control they mean.
  const selectedControl = allRenderedControls.find((c) => dockRowKey(c) === selectedKey) ?? null;
  const selectedSession = selectedControl ? runningFor(selectedControl) : undefined;
  // Issue #1239 — the pinned control/session, resolved the exact same way as
  // `selectedControl`/`selectedSession` above (same `allRenderedControls`
  // list, same "does a row exist for this key" source of truth the
  // reconciliation block validates `pinnedKey` against).
  const pinnedControl = allRenderedControls.find((c) => dockRowKey(c) === pinnedKey) ?? null;
  const pinnedSession = pinnedControl ? runningFor(pinnedControl) : undefined;

  return (
    <div
      ref={setColumnRef}
      className="dock-column"
      style={{ flex: width != null ? `0 0 ${width}px` : "1 1 0" }}
    >
      <div className="dock-column-header">
        <span className="dock-column-name">{project?.name ?? `#${projectId}`}</span>
        {onRemove && (
          <button className="dock-column-remove" title="Remove column" onClick={onRemove}>
            ×
          </button>
        )}
      </div>
      {githubStatus && (
        <DockGithubRow
          githubStatus={githubStatus}
          prsStatus={prsStatus}
          onOpen={() => onOpenGitHub(projectId)}
        />
      )}
      <div className={`dock-split${splitStacked ? " dock-split--stacked" : ""}`}>
        <div
          className="dock-rail cmux-scroll"
          // No `role="listbox"` here — DockMonitor.tsx's own comment on its
          // root `role="button"` explains why: a Docker-grouped row sits
          // several levels below this box (`.dock-stack-group` /
          // `.dock-stack-monitors` in between), which would make `option`
          // an invalid, non-direct listbox child. Plain rows with their own
          // aria-label carry the same information without claiming a tree
          // shape this markup doesn't have.
          //
          // Only in the normal side-by-side layout — stacked mode (rail
          // above the pane) wants the rail at full column width instead,
          // so this inline override is omitted there and `.dock-rail`'s
          // own CSS `flex: 0 0 auto` takes over (content-sized height on
          // what's now the vertical main axis — see that rule's own
          // comment, dock.css).
          style={splitStacked ? undefined : { flex: `0 0 ${railWidth}px` }}
        >
          {configuredControls.length === 0 &&
            dockerStackGroups.length === 0 &&
            ungroupedDockerControls.length === 0 &&
            orphanControls.length === 0 && (
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
          {configuredControls.map(renderMonitor)}
          {ungroupedDockerControls.map(renderMonitor)}
          {standaloneOrphanControls.map(renderMonitor)}
          {stackGroupRenderData.map(({ group, serviceControls, ephemeralControlsInGroup }) => {
            const statusKey = `stack:${group.composeProject}`;
            // anyRep is only null for a group of live ephemerals whose
            // originating service has since dropped out of discovery
            // (dockHelpers.ts's own doc comment) — the `rep &&`/`group.xRep &&`
            // short-circuit guards below are exactly as safe as the
            // `hasActions` check DockStackHeader itself gates its kebab on:
            // every handler they're attached to is unreachable unless anyRep
            // (and, per the same derivation, pullRep/rebuildRep when
            // relevant) is set.
            const rep = group.anyRep;
            return (
              <div key={group.composeProject} className="dock-stack-group">
                <DockStackHeader
                  composeProject={group.composeProject}
                  hasActions={rep !== null}
                  canPull={group.pullRep !== null}
                  canRebuild={group.rebuildRep !== null}
                  status={checkStatusById[statusKey]}
                  actionRunning={ephemeralControlsInGroup.length > 0}
                  onStackRestart={() =>
                    rep &&
                    void handleStackAction(
                      rep,
                      api.restartDockerStack,
                      "Failed to start restart",
                      statusKey,
                    )
                  }
                  onStackApply={() =>
                    rep &&
                    void handleStackAction(
                      rep,
                      api.applyDockerStack,
                      "Failed to apply config",
                      statusKey,
                    )
                  }
                  onPullAndRestart={() =>
                    group.pullRep && void handlePullAndRestart(group.pullRep, statusKey)
                  }
                  onRebuildAndRestart={() =>
                    group.rebuildRep && void handleRebuildAndRestart(group.rebuildRep, statusKey)
                  }
                  onStackStop={() =>
                    rep &&
                    void handleStackAction(
                      rep,
                      api.stopDockerStack,
                      "Failed to start stop",
                      statusKey,
                    )
                  }
                />
                {
                  // Skipped entirely, not just rendered empty, when a group
                  // has no service controls left (every one held past its
                  // own grace window or dropped from discovery, only the
                  // ephemeral row remaining below) — an empty content-sized
                  // column costs nothing layout-wise post-rework, but a
                  // pointless wrapper div is still pointless.
                  serviceControls.length > 0 && (
                    <div className="dock-stack-monitors">{serviceControls.map(renderMonitor)}</div>
                  )
                }
                {/* A live stack-action control renders as an ordinary rail
                    row too, right after its stack's own services — kept as
                    a SEPARATE map (not merged into serviceControls above)
                    purely so this stays visually last within the group and
                    DockStackHeader's own `actionRunning` above can still
                    key off `ephemeralControlsInGroup.length`, not so it
                    needs a different rendering MECHANISM the way the old
                    `.dock-stack-action-strip` did — every row costs the
                    same 28px now, service or not. */}
                {ephemeralControlsInGroup.map(renderMonitor)}
                {/* Issue #1240 — an orphaned session (its own control
                    dropped from discovery, but composeProjectFromContainerName
                    still resolves it back to THIS still-live stack) renders
                    last within the group, after any live stack action —
                    see groupedOrphansByProject's own comment above for why
                    this is a cosmetic-only grouping, never wired through
                    groupDockerControls/selectRepresentatives itself. */}
                {(groupedOrphansByProject.get(group.composeProject) ?? []).map(renderMonitor)}
              </div>
            );
          })}
        </div>
        {
          // A col-resize divider makes no sense once `.dock-split` has
          // flipped to a COLUMN (stacked mode, above) — there's no
          // horizontal split left to drag. The rail simply takes the
          // column's full width there instead (see `.dock-rail`'s own
          // inline style above).
        }
        {!splitStacked && (
          <div
            className="dock-rail-divider"
            role="separator"
            aria-orientation="vertical"
            onMouseDown={(e) => onRailDividerMouseDown(e, columnRef.current)}
          />
        )}
        <DockLogPane
          key={selectedSession?.id ?? "empty"}
          sessionId={selectedSession?.id ?? null}
          minWidthPx={logPaneMinWidth}
          minHeightPx={logPaneMinHeight}
          // Only overridden while the second pane actually renders (same
          // condition as that pane and its divider, below) — otherwise this
          // falls back to `.dock-log-pane`'s own `flex: 1 1 0` CSS default,
          // unchanged from before #1244. A pixel value, not a percentage —
          // see DockLogPane's own `flex` prop doc comment for why a
          // percentage would resolve against the wrong denominator.
          flex={pinnedKey !== null && canShowSecondPane ? `0 0 ${effectivePanePx}px` : undefined}
        />
        {
          // Issue #1244 — the draggable divider between the two panes,
          // rendered under the exact same condition as the second pane
          // itself (immediately below): no second pane, nothing to divide.
          // Replaces #1239's fixed `.dock-log-pane + .dock-log-pane` CSS
          // margin — see PANE_DIVIDER_WIDTH_PX's own comment for why that
          // adjacent-sibling rule had to go once a real element sits
          // between the two panes. No `tabIndex` — a non-focusable
          // `role="separator"` is valid ARIA; keyboard-driven resize is
          // filed separately as issue #1264, deliberately out of scope here.
        }
        {pinnedKey !== null && canShowSecondPane && (
          <div
            className="dock-pane-divider"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize log panes"
            onMouseDown={onPaneDividerMouseDown}
          />
        )}
        {
          // Issue #1239 — the pinned second pane. Rendered only with room
          // for it (`canShowSecondPane`, gated on the SAME measured column
          // width and ResizeObserver that already drives `splitStacked` —
          // see that boolean's own doc comment above) — below the
          // threshold this renders NOTHING extra rather than a
          // vertically-stacked pair (out of scope for this PR) or a
          // squeezed-below-floor pane; `pinnedKey` itself is untouched by
          // that, so widening the column back past the threshold restores
          // it with no re-click. Keeps its own `flex: 1 1 0` (no override
          // here) and absorbs whatever the primary pane's `effectiveRatio`
          // above doesn't take — issue #1244's draggable divider only ever
          // overrides the PRIMARY pane's share.
        }
        {pinnedKey !== null && canShowSecondPane && (
          <DockLogPane
            key={pinnedSession?.id ?? "empty-pinned"}
            sessionId={pinnedSession?.id ?? null}
            minWidthPx={logPaneMinWidth}
            minHeightPx={logPaneMinHeight}
          />
        )}
      </div>
    </div>
  );
}
