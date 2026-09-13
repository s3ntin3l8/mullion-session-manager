import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useDashboardStore } from "./store/index.js";
import { ChevronDownIcon, DockIcon } from "./ui/icons.js";
import { useDragResize } from "./hooks/useDragResize.js";
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
  dockLogPaneComfortHeightPx,
  dockMonitorMinHeightPx,
  dockMonitorMinWidthPx,
} from "./dock/dockHelpers.js";
import { DockProjectGroup } from "./dock/DockProjectGroup.js";
import { AddColumnControl } from "./dock/AddColumnControl.js";
import { useCoarsePointer } from "./lib/layoutTier.js";

// Dock master-detail rework — everything below dock-header chrome the dock
// needs before the log pane gets any room at all. Not exact (padding/border
// rounding), just enough to land DEFAULT_DOCK_HEIGHT near a sane starting
// size rather than picking one out of the air.
//
// Unified-rail dock rework — this used to also budget a per-column
// `.dock-column-header` that sat ABOVE that column's own `.dock-split`; the
// unified rail has no such element (a project's own header is now a rail
// ROW, alongside the monitor rows, not chrome above the split), so the true
// figure shrank slightly. Left at 85 anyway — a slightly-too-generous
// default height is harmless (the user's own drag preference, once set,
// wins from then on), while a too-small one would under-budget a
// first-install log pane, which `dockLogPaneComfortHeightPx` exists
// specifically to avoid.
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
// Default width of the rail before any drag, and the floor a drag can't go
// below — see the rail-divider drag handler below.
const DEFAULT_RAIL_WIDTH = 280;
const RAIL_MIN_WIDTH = 216;
// `.dock-rail-divider`'s own fixed CSS width (dock.css) — the stacked-layout
// threshold below needs this same number in JS to reproduce what the CSS
// actually costs.
const RAIL_DIVIDER_WIDTH_PX = 6;
// `.dock-pane-divider`'s own fixed CSS width (dock.css) — issue #1244's
// draggable divider between the primary and pinned log panes.
// `twoPaneThresholdPx` below needs this same number for the same reason
// `RAIL_DIVIDER_WIDTH_PX` does: without it, a dock sized exactly at
// `railWidth + RAIL_DIVIDER_WIDTH_PX + 2 * logPaneMinWidth` satisfies the
// threshold in JS but is still `PANE_DIVIDER_WIDTH_PX` too narrow to
// actually hold both panes side by side without one of them clipping below
// its own `min-width` floor.
const PANE_DIVIDER_WIDTH_PX = 6;

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

// Unified-rail dock rework — which project's rail section drives the dock's
// single primary pane, keyed by workspace (see STORAGE_KEYS.dockActiveProject's
// own doc comment). `null` when there's no active workspace or no stored
// entry — the render below falls back to the first tiled project in that
// case, purely as a derived value (never written back), so a later
// explicit activation is what actually persists a choice.
function readActiveProjectId(workspaceId: number | null): number | null {
  if (workspaceId === null) return null;
  const all = readJSON<Record<string, number>>(STORAGE_KEYS.dockActiveProject, {});
  const stored = all[String(workspaceId)];
  return typeof stored === "number" && Number.isFinite(stored) ? stored : null;
}

type PersistedPin = { projectId: number; rowKey: string } | null;

// Unified-rail dock rework — the dock's single cross-project pin, keyed by
// workspace (see STORAGE_KEYS.dockPinnedRow's own doc comment). Malformed/
// hand-edited storage collapses to `null` rather than propagating a
// half-shaped value into the render below.
function readPinnedRow(workspaceId: number | null): PersistedPin {
  if (workspaceId === null) return null;
  const all = readJSON<Record<string, PersistedPin>>(STORAGE_KEYS.dockPinnedRow, {});
  const stored = all[String(workspaceId)];
  if (
    stored &&
    typeof stored === "object" &&
    typeof stored.projectId === "number" &&
    typeof stored.rowKey === "string"
  ) {
    return stored;
  }
  return null;
}

// The dock: persistent monitors (dev server, git status, logs) — distinct
// from one-shot session launches. Config is read-only (.crs/dock.json /
// global CRS_CONFIG_DIR/dock.json), so a project section can't create a
// monitor that isn't already configured; a control here toggles an
// already-configured monitor on/off, which is just a session with
// kind:"dock" (sessions.ts) that this component keeps out of the normal
// per-project session inventory.
//
// One rail section per project — auto-derived from whichever projects have
// a session tiled in the active workspace (workspaceProjectIds, computed in
// App.tsx from the live dockview panels), plus any manually pinned via
// "+ Add project" for a project not currently in the workspace. There's no
// workspace<->project link in the DB, so the auto set is purely derived at
// render time, not persisted; only the manual additions and the dock's own
// region height are (localStorage, same pattern as the existing collapse
// flag below).
//
// Unified-rail dock rework (.claude/plans/we-have-an-unintended-jaunty-globe.md)
// — this used to render one FULL `.dock-column` (its own rail AND its own
// log pane) per project, side by side; two or more tiled projects made the
// dock wider than the screen. Now there's exactly ONE `.dock-split` for the
// whole dock: a single scrollable rail holding every project's rows as a
// collapsible section, and a single primary (+ optional pinned) log pane
// shared across all of them. Only one project is "active" at a time — its
// own selection drives the primary pane — while the pin can point at a row
// in ANY project, independent of which one is active. Split into dock/*.tsx
// (Wave 5 / PR 28 of .claude/plans/can-we-do-a-warm-cocke.md, continued by
// the dock master-detail rework and this one) — this file keeps the dock's
// own project-list orchestration, region-height/rail/pane-divider drag
// handles, collapse, and manual pinning; DockProjectGroup.tsx owns
// everything genuinely per-project (dock-control CRUD, Docker discovery,
// the GitHub widget, and — load bearing — each project's own row-selection
// state, which can't be lifted here; see that file's own header comment).
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
  // P1 perf fix — individual selectors, not a whole-store subscription, so
  // this only re-renders when one of THESE fields changes identity.
  const projects = useDashboardStore((s) => s.projects);
  const sessions = useDashboardStore((s) => s.sessions);
  const activeWorkspaceId = useDashboardStore((s) => s.activeWorkspaceId);
  // Unified-rail dock rework — `logPaneMinWidth`/`logPaneMinHeight` used to
  // be computed per column (DockColumn's own `settings` subscription); now
  // there's one shared pane, so Dock computes them once and passes them
  // down to whichever project group is rendering into the pane host(s).
  const terminalFontSize = useDashboardStore((s) => s.settings.terminal.fontSize);
  const terminalPadding = useDashboardStore((s) => s.settings.terminal.padding);
  const logPaneMinWidth = dockMonitorMinWidthPx(terminalFontSize, terminalPadding);
  // Deliberately `dockMonitorMinHeightPx` (the BODY-only number), NOT
  // `dockMonitorFullMinHeightPx` — see `.dock-log-pane`'s own doc comment
  // (empty-states.css) for why using the full number here would reintroduce
  // a review-caught "wrong element, wrong number" bug on the other side of
  // this rework.
  const logPaneMinHeight = dockMonitorMinHeightPx(terminalFontSize, terminalPadding);

  // Bug fix (independent review, tablet tier plan PR 4) — tablet.css's own
  // `.dock { display: none }` under `(pointer: coarse)` only hides this
  // element visually; it doesn't stop React from mounting DockProjectGroup
  // below, which is what actually calls TerminalPane's
  // registerTerminalInput() for every running dock monitor. This actually
  // skips mounting DockProjectGroup (and therefore registering) under a
  // coarse pointer, rather than just hiding the result.
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
  // Dock master-detail rework — the rail width (`.dock-rail`, dock.css),
  // dragged via `.dock-rail-divider`. One shared value (persisted,
  // `crs.dockRailWidth`) rather than per-project: a user who widens the
  // rail almost certainly wants the same width regardless of which
  // project's rows happen to be showing.
  const [railWidth, setRailWidth] = useState(() => {
    const n = readNumber(STORAGE_KEYS.dockRailWidth, NaN);
    return Number.isFinite(n) && n > 0 ? clamp(n, RAIL_MIN_WIDTH, Infinity) : DEFAULT_RAIL_WIDTH;
  });

  // Issue #1244 — the shared pane-split ratio, one value for the whole
  // dock, keyed by `activeWorkspaceId` rather than `projectId` — a
  // workspace can hold several projects and this ratio applies uniformly
  // regardless of which one is active.
  const [paneSplitRatio, setPaneSplitRatio] = useState<number>(() =>
    readPaneSplitRatio(activeWorkspaceId),
  );
  // Switching workspaces while the dock stays mounted must re-read the
  // ratio (and, below, the active project / pin) from storage for the NEW
  // workspace, not carry the previous workspace's in-memory value over.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPaneSplitRatio(readPaneSplitRatio(activeWorkspaceId));
  }, [activeWorkspaceId]);
  const persistPaneSplitRatio = (ratio: number) => {
    if (activeWorkspaceId === null) return;
    const all = readJSON<Record<string, number>>(STORAGE_KEYS.dockPaneSplitRatio, {});
    writeJSON(STORAGE_KEYS.dockPaneSplitRatio, { ...all, [String(activeWorkspaceId)]: ratio });
  };

  // ---- Active project (unified-rail dock rework) ----
  // The RAW persisted/explicitly-set value — `activeProjectId` below
  // derives the value actually used for rendering, falling back to the
  // first tiled project without ever writing that fallback back here. That
  // means a project that's briefly untiled (e.g. temporarily removed from
  // the workspace) and later comes back keeps its remembered active state,
  // the same "degrade the rendering, keep the state" posture `railWidth`/
  // `pinned` elsewhere in this file already use.
  const [activeProjectIdRaw, setActiveProjectIdRaw] = useState<number | null>(() =>
    readActiveProjectId(activeWorkspaceId),
  );
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveProjectIdRaw(readActiveProjectId(activeWorkspaceId));
  }, [activeWorkspaceId]);
  const setActiveProjectId = (id: number) => {
    setActiveProjectIdRaw(id);
    if (activeWorkspaceId === null) return;
    const all = readJSON<Record<string, number>>(STORAGE_KEYS.dockActiveProject, {});
    writeJSON(STORAGE_KEYS.dockActiveProject, { ...all, [String(activeWorkspaceId)]: id });
  };

  // ---- Cross-project pin (unified-rail dock rework, issue #1239 extended) ----
  // Same raw-vs-derived split as `activeProjectId` above.
  const [pinnedRaw, setPinnedRaw] = useState<PersistedPin>(() => readPinnedRow(activeWorkspaceId));
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPinnedRaw(readPinnedRow(activeWorkspaceId));
  }, [activeWorkspaceId]);
  const setPinned = (pin: PersistedPin) => {
    setPinnedRaw(pin);
    if (activeWorkspaceId === null) return;
    const all = readJSON<Record<string, PersistedPin>>(STORAGE_KEYS.dockPinnedRow, {});
    writeJSON(STORAGE_KEYS.dockPinnedRow, { ...all, [String(activeWorkspaceId)]: pin });
  };

  const dockRef = useRef<HTMLDivElement>(null);

  const toggleCollapsed = () => {
    setCollapsed((v) => {
      const next = !v;
      writeBool(STORAGE_KEYS.dockCollapsed, next);
      return next;
    });
  };

  // Workspace-derived projects first (in their existing order), then any
  // manually-pinned project not already in that set — dropping ids for
  // projects that no longer exist (e.g. deleted since the id was pinned).
  const columnIds = useMemo(() => {
    const ids = [...workspaceProjectIds];
    for (const id of manualIds) {
      if (!ids.includes(id)) ids.push(id);
    }
    return ids.filter((id) => projects.some((p) => p.id === id));
  }, [workspaceProjectIds, manualIds, projects]);

  // Pure derivation, never written back — see `activeProjectIdRaw`'s own
  // doc comment above for why a project temporarily dropping out of
  // `columnIds` shouldn't discard the remembered choice.
  const activeProjectId =
    activeProjectIdRaw !== null && columnIds.includes(activeProjectIdRaw)
      ? activeProjectIdRaw
      : (columnIds[0] ?? null);
  const pinned = pinnedRaw !== null && columnIds.includes(pinnedRaw.projectId) ? pinnedRaw : null;

  const persistManual = (next: number[]) => {
    setManualIds(next);
    writeJSON(STORAGE_KEYS.dockManualProjects, next);
  };
  const addColumn = (id: number) => {
    if (!manualIds.includes(id)) persistManual([...manualIds, id]);
  };
  const removeColumn = (id: number) => persistManual(manualIds.filter((x) => x !== id));
  // A project section only gets a remove-x when it's pinned AND not also
  // derived from the workspace — otherwise it would just reappear on the
  // next render.
  const manualOnly = (id: number) => manualIds.includes(id) && !workspaceProjectIds.includes(id);

  const liveCount = sessions.filter(
    (s) =>
      s.kind === "dock" &&
      s.status === "active" &&
      columnIds.includes(s.projectId) &&
      (s.activity === "working" || s.alive),
  ).length;

  // ---- Dock region height (drag handle on the top border) ----
  const getDockMaxHeight = () => {
    const dockEl = dockRef.current;
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

  useLayoutEffect(() => {
    const max = getDockMaxHeight();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHeight((h) => (h > max ? max : h));
  }, []);

  // ---- Split-width measurement (unified-rail dock rework) ----
  // A single ResizeObserver on `.dock-split` — replaces what used to be one
  // per `.dock-column`. Same "measure via a callback ref for the first
  // commit, then a ResizeObserver for every one after" pattern as before
  // (and PaneTab.tsx's own `narrow`/`tight` observer) — see that
  // component's comment for why a CSS container query can't replace this
  // (a too-narrow rail/pane's own overflow-x escape hatch depends on a
  // child's min-content propagating up through ordinary flex containers,
  // which `container-type: inline-size` would break).
  const splitRef = useRef<HTMLDivElement | null>(null);
  const [splitStacked, setSplitStacked] = useState(false);
  const lastSplitWidthRef = useRef<number | null>(null);
  const [splitWidthPx, setSplitWidthPx] = useState<number | null>(null);

  // Dock master-detail rework — below this width, `.dock-split` flips to
  // `flex-direction: column` (rail above, log pane below) instead of side
  // by side: below that width neither the rail nor `.dock-log-pane`'s own
  // floor can hold without one clipping the other. Derived from the live
  // `railWidth` plus the divider plus `logPaneMinWidth` (recomputed from
  // live font settings) rather than a static literal.
  const stackedThresholdPx = railWidth + RAIL_DIVIDER_WIDTH_PX + logPaneMinWidth;
  // Issue #1239 — the second (pinned) pane needs room for the rail PLUS
  // TWO log panes PLUS the divider between them.
  const twoPaneThresholdPx =
    railWidth + RAIL_DIVIDER_WIDTH_PX + 2 * logPaneMinWidth + PANE_DIVIDER_WIDTH_PX;
  const stackedThresholdRef = useRef(stackedThresholdPx);
  useEffect(() => {
    stackedThresholdRef.current = stackedThresholdPx;
    if (lastSplitWidthRef.current !== null) {
      setSplitStacked(lastSplitWidthRef.current < stackedThresholdPx);
    }
  }, [stackedThresholdPx]);
  useEffect(() => {
    const el = splitRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width === undefined) return;
      lastSplitWidthRef.current = width;
      setSplitWidthPx(width);
      setSplitStacked(width < stackedThresholdRef.current);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // The callback-ref form runs during React's commit phase, before the
  // browser paints — measuring here and calling setSplitStacked
  // synchronously avoids a one-frame flash of the WRONG layout on a dock
  // that mounts already narrower (or wider) than the threshold. The same
  // reasoning applies to `setPrimaryPaneHost`/`setPinnedPaneHost` below:
  // each is a plain `useState` setter used directly as a ref callback, so
  // the state update they schedule on mount is likewise a commit-phase,
  // pre-paint update, not a passive-effect one — a project group's own
  // portal into a freshly-mounted host lands in the SAME commit its host
  // div does, not one frame later.
  const setSplitRef = useCallback((el: HTMLDivElement | null) => {
    splitRef.current = el;
    if (!el) return;
    const width = el.getBoundingClientRect().width;
    lastSplitWidthRef.current = width;
    setSplitWidthPx(width);
    setSplitStacked(width < stackedThresholdRef.current);
  }, []);

  // Issue #1239 — gates the SECOND log pane: never alongside stacked mode,
  // and only once the live split width actually clears
  // `twoPaneThresholdPx`. Deliberately does NOT clear `pinned` when this is
  // false — narrowing back past the threshold hides the second pane
  // without discarding the pin.
  const canShowSecondPane =
    !splitStacked && splitWidthPx !== null && splitWidthPx >= twoPaneThresholdPx;
  // Whether the pinned pane should actually render right now — kept
  // separate from `canShowSecondPane` (a dock-wide width fact) since it
  // also depends on whether anything is pinned at all.
  const showPinnedPane = pinned !== null && canShowSecondPane;

  // ---- Pane hosts (unified-rail dock rework) ----
  // Empty portal targets Dock owns; whichever project group is active (or
  // owns the pin) renders its own resolved `DockLogPane` into these via
  // `createPortal` — see DockProjectGroup.tsx's own header comment for why
  // the SELECTION state that resolves that session can't simply be lifted
  // here instead.
  const [primaryPaneHost, setPrimaryPaneHost] = useState<HTMLDivElement | null>(null);
  const [pinnedPaneHost, setPinnedPaneHost] = useState<HTMLDivElement | null>(null);

  // ---- Rail-divider resize (dock master-detail rework) ----
  // One shared `.dock-rail-divider` now (there's only one rail) — no longer
  // needs the "which column was dragged" ref indirection the per-column
  // version required; `lastSplitWidthRef` (above) is always the right thing
  // to measure.
  const { onMouseDown: onRailDividerMouseDown } = useDragResize({
    axis: "x",
    min: RAIL_MIN_WIDTH,
    // 40% of the dock's own split width — the plan's own clamp — floored at
    // RAIL_MIN_WIDTH so a very narrow dock (already in stacked layout at
    // that point) never computes a max below the min.
    getMax: () => Math.max(RAIL_MIN_WIDTH, (lastSplitWidthRef.current ?? 0) * 0.4),
    value: railWidth,
    onChange: setRailWidth,
    onCommit: (v) => writeNumber(STORAGE_KEYS.dockRailWidth, v),
    cursor: "col-resize",
  });

  // ---- Pane-divider resize (issue #1244) ----
  // The width actually available to the two log panes plus the divider
  // between them — the dock's own measured split width, minus the rail and
  // the rail-to-primary divider, minus the primary-to-pinned divider TOO
  // but only when that divider actually renders (`showPinnedPane`). Hermes
  // review — subtracting `PANE_DIVIDER_WIDTH_PX` unconditionally (as the
  // pre-unified-rail per-column version of this also did) makes
  // `paneAreaWidth`, and therefore `paneFloorRatio`, jump by 6px the moment
  // a pin actually appears, a one-frame glitch a single-pane render never
  // needed to pay for since there's no second divider to reserve room for
  // yet.
  const paneAreaWidth = Math.max(
    0,
    (splitWidthPx ?? 0) -
      railWidth -
      RAIL_DIVIDER_WIDTH_PX -
      (showPinnedPane ? PANE_DIVIDER_WIDTH_PX : 0),
  );
  // Capped at 0.5 — once `paneAreaWidth` drops below `2 * logPaneMinWidth`,
  // neither pane can actually fit at its floor side by side at all; see the
  // pre-unified-rail version of this comment (git history) for the
  // "why not just clamp without capping" derivation this preserves
  // unchanged.
  const paneFloorRatio = paneAreaWidth > 0 ? Math.min(0.5, logPaneMinWidth / paneAreaWidth) : 0.5;
  const effectiveRatio = Math.min(Math.max(paneSplitRatio, paneFloorRatio), 1 - paneFloorRatio);
  const effectivePanePx = Math.round(effectiveRatio * paneAreaWidth);

  const draggedRef = useRef(false);
  const { onMouseDown: onPaneDividerMouseDown } = useDragResize({
    axis: "x",
    min: logPaneMinWidth,
    getMax: () => paneAreaWidth - logPaneMinWidth,
    value: effectivePanePx,
    onChange: (px) => {
      draggedRef.current = true;
      if (paneAreaWidth > 0) setPaneSplitRatio(px / paneAreaWidth);
    },
    onCommit: (px) => {
      const dragged = draggedRef.current;
      draggedRef.current = false;
      if (paneAreaWidth > 0 && dragged) {
        persistPaneSplitRatio(px / paneAreaWidth);
      }
    },
    cursor: "col-resize",
  });

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
        {
          // Hermes review — also gated on `!isCoarsePointer`, matching the
          // split below: under a coarse pointer, nothing renders there at
          // all (no DockProjectGroup ever mounts, so a newly-pinned
          // project has nowhere to show up until the pointer changes
          // back). Persisting `manualIds` from a control the user can't
          // see the effect of is harmless but pointless — hiding it here
          // matches that reality instead of offering an action with no
          // visible result.
        }
        {!collapsed && !isCoarsePointer && (
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
      {!collapsed &&
        !isCoarsePointer &&
        (columnIds.length === 0 ? (
          <div className="dock-empty dock-empty-workspace">
            No projects tiled in this workspace yet
          </div>
        ) : (
          <div
            ref={setSplitRef}
            className={`dock-split${splitStacked ? " dock-split--stacked" : ""}`}
          >
            <div
              className="dock-rail cmux-scroll"
              style={splitStacked ? undefined : { flex: `0 0 ${railWidth}px` }}
            >
              {columnIds.map((id) => (
                <DockProjectGroup
                  key={id}
                  projectId={id}
                  activeWorkspaceId={activeWorkspaceId}
                  isActive={id === activeProjectId}
                  isPinOwner={pinned?.projectId === id}
                  pinnedRowKey={pinned?.projectId === id ? pinned.rowKey : null}
                  canShowSecondPane={canShowSecondPane}
                  showPinnedPane={showPinnedPane}
                  effectivePanePx={effectivePanePx}
                  logPaneMinWidth={logPaneMinWidth}
                  logPaneMinHeight={logPaneMinHeight}
                  primaryPaneHost={primaryPaneHost}
                  pinnedPaneHost={pinnedPaneHost}
                  onActivate={() => setActiveProjectId(id)}
                  onPinRow={(rowKey) => setPinned({ projectId: id, rowKey })}
                  onUnpin={() => setPinned(null)}
                  onOpenGitHub={onOpenGitHub}
                  onOpenBrowser={onOpenBrowser}
                  onRemove={manualOnly(id) ? () => removeColumn(id) : undefined}
                />
              ))}
            </div>
            {!splitStacked && (
              <div
                className="dock-rail-divider"
                role="separator"
                aria-orientation="vertical"
                onMouseDown={onRailDividerMouseDown}
              />
            )}
            <div ref={setPrimaryPaneHost} className="dock-pane-host" />
            {showPinnedPane && (
              <div
                className="dock-pane-divider"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize log panes"
                onMouseDown={onPaneDividerMouseDown}
              />
            )}
            {showPinnedPane && <div ref={setPinnedPaneHost} className="dock-pane-host" />}
          </div>
        ))}
    </div>
  );
}
