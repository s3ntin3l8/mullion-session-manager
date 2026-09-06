import { Fragment, useEffect, useMemo, useRef, useState } from "react";
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
  dockerSessionIdentity,
  isDockPreviewPath,
  resolveSelectedValue,
  runningSessionFor,
} from "./dock/dockHelpers.js";
import { useDockGithubStatus } from "./dock/useDockGithubStatus.js";
import { DockGithubRow } from "./dock/DockGithubRow.js";
import { useArmedKill } from "./dock/useArmedKill.js";
import { useTransientStatus } from "./dock/useTransientStatus.js";
import { DockMonitor } from "./dock/DockMonitor.js";
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

const DEFAULT_DOCK_HEIGHT = 220;
const DOCK_MIN_HEIGHT = 120;
// Must equal .dockview-container's min-height in styles.css — the resize
// drag's clamp and the CSS floor have to agree, or the CSS floor silently
// wins and the drag looks like it stopped responding partway through.
const GRID_MIN_HEIGHT = 160;
const COLUMN_MIN_WIDTH = 200;

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
  const { onMouseDown: onHeightHandleMouseDown } = useDragResize({
    axis: "y",
    invert: true,
    min: DOCK_MIN_HEIGHT,
    getMax: () => {
      const dockEl = dockRef.current;
      // Measure the two flex siblings directly (not the shared parent's
      // clientHeight, which also includes the mobile-only tab bar /
      // sidebar toggle) so the available-space math stays correct
      // regardless of which of those happen to be rendered.
      const dockviewEl = dockEl?.parentElement?.querySelector<HTMLElement>(".dockview-container");
      const available = (dockEl?.clientHeight ?? 0) + (dockviewEl?.clientHeight ?? 0);
      return Math.max(DOCK_MIN_HEIGHT, available - GRID_MIN_HEIGHT);
    },
    value: height,
    onChange: setHeight,
    onCommit: (v) => writeNumber(STORAGE_KEYS.dockHeight, v),
    cursor: "ns-resize",
  });

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
  const liveEphemeralControls = ephemeralControls.filter((c) => runningFor(c));
  const configuredControls = controls.filter((c) => c.source !== "docker");
  const discoveredControls = controls.filter((c) => c.source === "docker");
  const dockerGroupControls = [...liveEphemeralControls, ...discoveredControls];

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

  const handlePullAndRestart = async (control: DockControl) => {
    try {
      const result = await api.updateDockerStack(projectId, control.id);
      addEphemeralControl(result.control);
      // The new session won't appear in the store's `sessions` list (and
      // hence `runningFor`/`dockSessions` above) until the next poll —
      // force one now so the monitor renders immediately instead of after
      // whatever's left of store.ts's live-refresh interval.
      await useDashboardStore.getState().refreshSessions();
      if (result.willRecreate === true) showCheckStatus(control.id, "Pulling — will recreate");
    } catch {
      console.warn("[dock] docker pull & restart failed", control.id);
      showCheckStatus(control.id, "Failed to start update", true);
    }
  };

  const handleRebuildAndRestart = async (control: DockControl) => {
    try {
      const result = await api.rebuildDockerStack(projectId, control.id);
      addEphemeralControl(result.control);
      await useDashboardStore.getState().refreshSessions();
      if (result.willRecreate === true) showCheckStatus(control.id, "Rebuilding — will recreate");
    } catch {
      console.warn("[dock] docker rebuild & restart failed", control.id);
      showCheckStatus(control.id, "Failed to start rebuild", true);
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
  // handlePullAndRestart/handleRebuildAndRestart above.
  const handleStackAction = async (
    control: DockControl,
    action: (projectId: number, controlId: string) => ReturnType<typeof api.restartDockerStack>,
    failureMessage: string,
  ) => {
    try {
      const result = await action(projectId, control.id);
      addEphemeralControl(result.control);
      await useDashboardStore.getState().refreshSessions();
      if (result.willRecreate === true) showCheckStatus(control.id, "Applying — will recreate");
    } catch {
      console.warn("[dock] docker stack action failed", control.id);
      showCheckStatus(control.id, failureMessage, true);
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
        <DockGithubRow
          githubStatus={githubStatus}
          prsStatus={prsStatus}
          onOpen={() => onOpenGitHub(projectId)}
        />
      )}
      <div className="dock-body cmux-scroll">
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

          // P10 — named so the header's onKeyDown (Enter/Space) can call
          // the exact same action as a click, rather than dispatching a
          // synthetic `.click()` at the DOM node — matching how
          // unified-board/TaskCard.tsx and NotificationBell.tsx's EventRow
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
              isFirstDockerControl={isFirstDockerControl}
              showSelector={controlShowSelector}
              selectedValue={selectedValue}
              worktreeOptions={allOptions}
              onWorktreeChange={onWorktreeChange}
              devServerUrl={project?.devServerUrl}
              onOpenBrowser={() => onOpenBrowser(projectId)}
              updateAvailable={updateAvailable}
              dockerStatus={dockerStatus}
              checkStatus={checkStatusById[control.id]}
              armed={killArmedIds.has(control.id)}
              confirmBeforeKill={confirmBeforeKill}
              onHeaderActivate={handleHeaderActivate}
              onCheckUpdate={() => void handleCheckUpdate(control)}
              onPullAndRestart={() => void handlePullAndRestart(control)}
              onRebuildAndRestart={() => void handleRebuildAndRestart(control)}
              onServiceRestart={() =>
                void handleServiceAction(control, api.restartDockerService, "Restart failed")
              }
              onServiceStop={() =>
                void handleServiceAction(control, api.stopDockerService, "Stop failed")
              }
              onServiceStart={() =>
                void handleServiceAction(control, api.startDockerService, "Start failed")
              }
              onStackRestart={() =>
                void handleStackAction(control, api.restartDockerStack, "Failed to start restart")
              }
              onStackApply={() =>
                void handleStackAction(control, api.applyDockerStack, "Failed to apply config")
              }
              onStackStop={() =>
                void handleStackAction(control, api.stopDockerStack, "Failed to start stop")
              }
            />
          );
        })}
      </div>
    </div>
  );
}
