import { ProjectPreviewMenu } from "../ProjectPreviewMenu.js";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DockControl, Session } from "../api/index.js";
import { useDashboardStore } from "../store/index.js";
import { ChevronDownIcon, GlobeIcon } from "../ui/icons.js";
import { STORAGE_KEYS, readJSON, writeJSON } from "../lib/persistedState.js";
import { dockRowKey } from "./dockHelpers.js";
import { useDockGithubStatus } from "./useDockGithubStatus.js";
import { DockGithubRow } from "./DockGithubRow.js";
import { DockMonitor } from "./DockMonitor.js";
import { DockLogPane } from "./DockLogPane.js";
import { DockStackHeader } from "./DockStackHeader.js";
import { useDockProject } from "./useDockProject.js";

// How long `pendingSelectKeyRef` exempts a just-requested row from the
// reconciliation's "no matching row, fall back" rule before giving up on
// it — generous relative to a normal local createSession round trip, short
// enough that a genuinely hung request doesn't wedge the log pane on its
// empty hint indefinitely.
const PENDING_SELECT_TIMEOUT_MS = 15_000;

// Issue #1238 — shape of `STORAGE_KEYS.dockSelectedRows`'s stored value,
// keyed by `String(projectId)`. `pinned` is a stale field from before the
// unified-rail dock rework (the pin is now cross-project, Dock-level state
// under `STORAGE_KEYS.dockPinnedRow` — see that key's own doc comment) —
// kept in the type only so a read-modify-write here doesn't clobber it for
// a browser that still has it, never written by this file again.
type PersistedDockSelection = Record<string, { selected: string | null; pinned?: string | null }>;

// One project's section of the dock's single shared rail — extracted from
// what used to be `DockColumn` (Wave 5 / PR 28 of
// .claude/plans/can-we-do-a-warm-cocke.md, then the dock master-detail
// rework) by the unified-rail dock rework
// (.claude/plans/we-have-an-unintended-jaunty-globe.md): a dock with N
// tiled projects used to render N full `.dock-split`s (rail + log pane)
// side by side, which is what made two or more projects blow out the
// dock's width. Now there's exactly ONE `.dock-split` for the whole dock
// (owned by Dock.tsx), and this component renders only its own project's
// rail rows plus — via `createPortal`, only while `isActive`/`isPinOwner`
// — the log pane(s) that live in Dock's shared pane host(s).
//
// This still owns every genuinely PER-PROJECT concern: the dock-config
// poll, Docker discovery/grouping, the armed-kill/transient-status/GitHub-
// status widgets, every launch/kill/worktree/stack-action handler, and —
// load-bearing — `selectedKey`'s own render-phase reconciliation. That
// reconciliation calls `setSelectedKey` synchronously during render so a
// same-commit correction is possible (see its own comment below); that
// pattern is only safe for a component's OWN state, so it stays here
// rather than lifting to Dock, which only ever learns the RESOLVED session
// via `onActivate`/the portaled `DockLogPane`, never `selectedKey` itself.
export function DockProjectGroup({
  projectId,
  activeWorkspaceId,
  isActive,
  isPinOwner,
  pinnedRowKey,
  canShowSecondPane,
  showPinnedPane,
  effectivePanePx,
  logPaneMinWidth,
  logPaneMinHeight,
  primaryPaneHost,
  pinnedPaneHost,
  onActivate,
  onPinRow,
  onUnpin,
  onOpenGitHub,
  onOpenBrowser,
  onOpenBlankBrowser,
  onManagePreviews,
  onOpenSession,
  onRemove,
}: {
  projectId: number;
  // Only for scoping the collapse-state storage key to the active
  // workspace — same "one shared value per workspace" pattern as Dock's
  // own `paneSplitRatio`/`activeProjectId`/`pinned`.
  activeWorkspaceId: number | null;
  // Whether THIS project's own `selectedKey` drives Dock's primary pane.
  isActive: boolean;
  // Whether THIS project owns Dock's single cross-project pin.
  isPinOwner: boolean;
  // The pinned row's key, only meaningful when `isPinOwner` — Dock passes
  // `null` for every other group so a stale key can't leak across projects.
  pinnedRowKey: string | null;
  canShowSecondPane: boolean;
  // Whether the pinned pane should actually render right now
  // (`pinned !== null && canShowSecondPane`, computed once in Dock) — kept
  // separate from `canShowSecondPane` because THIS group not owning the
  // pin doesn't mean no group does; only the owning group's portal should
  // gate on it.
  showPinnedPane: boolean;
  effectivePanePx: number;
  logPaneMinWidth: number;
  logPaneMinHeight: number;
  // The DOM nodes Dock's own `.dock-split` renders as portal targets —
  // `null` until Dock's first commit measures/mounts them (see Dock.tsx's
  // own `setPrimaryPaneHost`/`setPinnedPaneHost` callback-ref comment).
  primaryPaneHost: HTMLElement | null;
  pinnedPaneHost: HTMLElement | null;
  onActivate: () => void;
  onPinRow: (rowKey: string) => void;
  onUnpin: () => void;
  onOpenGitHub: (projectId: number) => void;
  onOpenBrowser: (projectId: number) => void;
  onOpenBlankBrowser?: () => void;
  onManagePreviews?: (projectId: number) => void;
  // Issue #2069 — "Open holder" on a port-in-use row.
  onOpenSession?: (session: Session) => void;
  // Present only for a manually-pinned project not also derived from the
  // workspace — see Dock's manualOnly().
  onRemove?: () => void;
}) {
  const prsRefreshTrigger = useDashboardStore((s) => s.prsRefreshTriggerByProject[projectId] ?? 0);
  // The project's Dock data and every action on it (#3012): useDockProject.ts,
  // shared with the right sidebar's Dock view. Only this bottom Dock runs the
  // auto-attach effect (see that hook's header comment).
  const {
    project,
    configuredControls,
    ungroupedDockerControls,
    standaloneOrphanControls,
    stackGroupRenderData,
    groupedOrphansByProject,
    orphanControls,
    dockerStackGroups,
    allRenderedControls,
    runningFor,
    controlView,
    stackActions,
  } = useDockProject(projectId, { autoAttach: true, onOpenSession });

  // ---- Collapsible project section (unified-rail dock rework) ----
  // Expanded by default; persisted per project per workspace so a user's
  // "I don't need to see this project's rows right now" choice survives
  // reload, mirroring `dockPaneSplitRatio`'s own per-workspace shape.
  const readCollapsed = (workspaceId: number | null) => {
    const all = readJSON<Record<string, number[]>>(STORAGE_KEYS.dockCollapsedGroups, {});
    return (all[String(workspaceId)] ?? []).includes(projectId);
  };
  const [collapsed, setCollapsed] = useState(() => readCollapsed(activeWorkspaceId));
  // A workspace switch while this project stays tiled must re-read for the
  // NEW workspace, not carry the previous one's in-memory value over — same
  // reasoning as Dock's own `paneSplitRatio` re-read effect.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCollapsed(readCollapsed(activeWorkspaceId));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- readCollapsed closes over projectId, which is this component's own stable prop key.
  }, [activeWorkspaceId]);
  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      // No active workspace — skip persisting rather than writing under a
      // literal `"null"` key, same convention every other per-workspace key
      // this rework introduced already follows (`dockActiveProject`/
      // `dockPinnedRow` in Dock.tsx, `dockPaneSplitRatio` before it). Still
      // toggles the in-memory `collapsed` state for this render — only the
      // persistence is skipped.
      if (activeWorkspaceId !== null) {
        const all = readJSON<Record<string, number[]>>(STORAGE_KEYS.dockCollapsedGroups, {});
        const ids = new Set(all[String(activeWorkspaceId)] ?? []);
        if (next) ids.add(projectId);
        else ids.delete(projectId);
        writeJSON(STORAGE_KEYS.dockCollapsedGroups, {
          ...all,
          [String(activeWorkspaceId)]: [...ids],
        });
      }
      return next;
    });
  };

  // ---- Selected rail row (dock master-detail rework) ----
  // dockRowKey(control) of whichever row this project would show in the
  // primary pane if it's active — component-local state, persisted to
  // `crs.dockSelectedRows` per project (issue #1238) so it survives a
  // reload rather than always falling back to the adopt-on-empty rule
  // below. Reconciled against the row set further down using the SAME
  // render-time "adjust state during render" pattern heldState below
  // already uses, not a passive `useEffect` — a first version of this used
  // an effect, and a real test failure caught why that's wrong: `controls`
  // only loads asynchronously (usePolling below), so the render where a
  // row's session is ALREADY running (e.g. reload-with-streams-already-
  // running) would otherwise paint the log pane's empty hint for one commit
  // before the effect's own follow-up render adopted it.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [persistedInitialKey] = useState<string | null>(() => {
    const all = readJSON<PersistedDockSelection>(STORAGE_KEYS.dockSelectedRows, {});
    return all[String(projectId)]?.selected ?? null;
  });
  // Mirrors `persistedInitialKey` into a ref so the reconciliation below can
  // consult "the mount-time seed" without re-reading storage — read-only
  // during render, written only here at mount.
  const initialPersistedKeyRef = useRef<string | null>(persistedInitialKey);
  // Exempts a row the user (or a stack action) just asked to START from the
  // reconciliation's "no matching row, fall back" rule for however many
  // renders it takes to become real — see PENDING_SELECT_TIMEOUT_MS's own
  // doc comment.
  const pendingSelectKeyRef = useRef<{ key: string; setAt: number } | null>(null);

  const { githubStatus, prsStatus } = useDockGithubStatus(projectId, prsRefreshTrigger);

  const rowKeys = allRenderedControls.map(dockRowKey);
  const liveRowKeys = allRenderedControls.filter((c) => runningFor(c)).map(dockRowKey);
  const rowKeysSignature = rowKeys.join(" ");
  const liveRowKeysSignature = liveRowKeys.join(" ");
  const [hasSeenRows, setHasSeenRows] = useState(false);
  if (rowKeys.length > 0 && !hasSeenRows) setHasSeenRows(true);

  // Reconciles `selectedKey` against the row set above — the render-time
  // "adjust state during render" pattern (react.dev), unchanged from the
  // pre-unified-rail `DockColumn`. See this component's own header comment
  // for why this can't be lifted to Dock.
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
      const persisted = initialPersistedKeyRef.current;
      if (persisted !== null && rowKeys.includes(persisted)) {
        return persisted;
      }
      return liveRowKeys[0] ?? null;
    });
  }

  // Unified-rail dock rework — the pin is now Dock-level state spanning
  // every project (`{projectId, rowKey}`), not this group's own local
  // state, so it can no longer be pruned/corrected in the SAME render-phase
  // "adjust state during render" pattern `selectedKey` above uses (that
  // pattern is only safe for a component's own state — calling a parent's
  // setter during render is a different, unsafe thing). This effect is the
  // deliberate, narrower replacement, covering the two cases the old
  // `DockColumn`'s unconditional `pinnedKey === selectedKey` check and its
  // reconciliation's own pin-pruning line used to cover together:
  //   1. this project's pinned row no longer exists at all — `rowKeys` is
  //      already held-inclusive (derived from `allRenderedControls`, which
  //      already splices a recently-vanished control back in via
  //      `heldMerge` above), so this doesn't drop a pin on a row that's
  //      merely mid-recreate;
  //   2. this project is ACTIVE and its own primary selection just landed
  //      on the very row that's pinned — most commonly via `selectedKey`'s
  //      own automatic neighbour-reassignment above, which (unlike a click
  //      on the pin tag or row body) has no chance to call `onUnpin` inline.
  // A user-initiated pin/select click already avoids ever CREATING this
  // collision (see `togglePin`/`selectRow`/`startAndSelect` below) — this
  // effect is strictly a backstop for the case those can't reach, so a
  // one-render-late correction here is an accepted rare-edge-case
  // tradeoff, not a repeat of the flicker `selectedKey`'s own render-phase
  // reconciliation exists to avoid.
  useEffect(() => {
    if (!isPinOwner || pinnedRowKey === null) return;
    // `hasSeenRows` guards the same gap `selectedKey`'s own persistence
    // effect (below) does: `controls` loads asynchronously (usePolling
    // above), so `rowKeys` is genuinely empty for this project's first few
    // commits, before the very first fetch resolves — not because the
    // pinned row vanished. Without this guard, a fresh mount with a
    // pin already persisted from a previous session would see "pinned row
    // not in rowKeys" on that empty first commit and immediately (and
    // wrongly) unpin it, before the fetch ever had a chance to prove
    // otherwise.
    if (!hasSeenRows) return;
    if (!rowKeys.includes(pinnedRowKey) || (isActive && pinnedRowKey === selectedKey)) {
      onUnpin();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rowKeys is a fresh array every render; rowKeysSignature is the real dependency, included below.
  }, [isPinOwner, pinnedRowKey, isActive, selectedKey, rowKeysSignature, hasSeenRows, onUnpin]);

  // Issue #1238 — persist this project's selection on change. Unlike the
  // reconciliation above, this IS a legitimate `useEffect`: writing to
  // `localStorage` is a genuine side effect, not derived render state.
  useEffect(() => {
    if (selectedKey === null && !hasSeenRows) return;
    const all = readJSON<PersistedDockSelection>(STORAGE_KEYS.dockSelectedRows, {});
    writeJSON(STORAGE_KEYS.dockSelectedRows, {
      ...all,
      [String(projectId)]: { ...all[String(projectId)], selected: selectedKey },
    });
  }, [projectId, selectedKey, hasSeenRows]);

  // A single monitor row's render — closes over this render's own
  // worktreePaths/toggleGenRef/allOptions/runningFor/etc.
  const renderMonitor = (control: DockControl) => {
    const view = controlView(control);
    const running = view.running;
    const rowKey = dockRowKey(control);
    // Unified-rail dock rework — every path that changes `selectedKey`
    // also calls `onActivate()` (making this project the dock's active
    // one) and, if this row happens to be the row THIS project currently
    // has pinned, `onUnpin()` — the cross-project analogue of the old
    // `DockColumn`'s inline `if (pinnedKey === rowKey) setPinnedKey(null)`
    // guards. See the pin-vanish/collision effect above for the one case
    // these inline guards can't reach (automatic neighbour reconciliation).
    const startAndSelect = () => {
      onActivate();
      if (isPinOwner && pinnedRowKey === rowKey) onUnpin();
      setSelectedKey(rowKey);
      pendingSelectKeyRef.current = { key: rowKey, setAt: Date.now() };
      void view.start().then((started) => {
        if (!started && pendingSelectKeyRef.current?.key === rowKey) {
          pendingSelectKeyRef.current = null;
        }
      });
    };
    // Wired to a rail row's own click/Enter/Space — always changes focus
    // (and, per `onActivate`, which project is active); only starts the
    // stream when it was off.
    const selectRow = () => {
      onActivate();
      if (isPinOwner && pinnedRowKey === rowKey) onUnpin();
      if (running) {
        setSelectedKey(rowKey);
        return;
      }
      startAndSelect();
    };
    // Wired to the pin-toggle affordance — pins this row as the dock's
    // SECOND, independently-selected log pane (which may belong to a
    // DIFFERENT project than the one currently active), replacing any
    // previous pin anywhere; clicking it again on the row that's already
    // pinned unpins instead. Never touches `selectedKey`/activation.
    const togglePin = () => {
      // Defensive — the pin affordance is already hidden on this exact row
      // via DockMonitor's own `!selected` gate (`selected` below is
      // `isActive && selectedKey === rowKey`), so this is unreachable from
      // the UI; kept so a pin can never be requested for the row currently
      // occupying the primary pane, matching the "pinning yourself is
      // meaningless" rule this dock has always had.
      if (isActive && selectedKey === rowKey) return;
      if (isPinOwner && pinnedRowKey === rowKey) {
        onUnpin();
        return;
      }
      onPinRow(rowKey);
    };
    // Wired to the trailing "logs on"/"logs off" tag — the ONLY place a
    // running stream gets killed from (useDockProject's `stop`), and it never
    // touches selection OR activation on that path.
    const toggleStream = () => {
      if (running) {
        view.stop();
        return;
      }
      startAndSelect();
    };

    return (
      <DockMonitor
        key={control.id}
        control={control}
        running={running}
        selected={isActive && selectedKey === rowKey}
        showSelector={view.showSelector}
        selectedValue={view.selectedValue}
        worktreeOptions={view.worktreeOptions}
        onWorktreeChange={view.changeWorktree}
        updateAvailable={view.updateAvailable}
        dockerStatus={view.dockerStatus}
        held={view.held}
        checkStatus={view.checkStatus}
        portConflict={view.portConflict}
        onOpenHolder={view.openHolder}
        onStopHolderAndStart={view.stopHolderAndStart}
        armed={view.armed}
        confirmBeforeKill={view.confirmBeforeKill}
        onSelect={selectRow}
        onToggleStream={toggleStream}
        pinned={isPinOwner && pinnedRowKey === rowKey}
        canShowSecondPane={canShowSecondPane}
        onTogglePin={togglePin}
        onCheckUpdate={view.checkUpdate}
        onServiceRestart={view.serviceRestart}
        onServiceStop={view.serviceStop}
        onServiceStart={view.serviceStart}
      />
    );
  };

  // Resolves the session behind whichever row this project would show —
  // looked up against `allRenderedControls` (the same list the
  // reconciliation above validates `selectedKey` against), same as before
  // this extraction.
  const selectedControl = allRenderedControls.find((c) => dockRowKey(c) === selectedKey) ?? null;
  const selectedSession = selectedControl ? runningFor(selectedControl) : undefined;
  const pinnedControl = isPinOwner
    ? (allRenderedControls.find((c) => dockRowKey(c) === pinnedRowKey) ?? null)
    : null;
  const pinnedSession = pinnedControl ? runningFor(pinnedControl) : undefined;

  return (
    <div className="dock-group">
      <div className="dock-group-header">
        <button
          className="dock-group-collapse-btn"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          title={collapsed ? "Expand" : "Collapse"}
          type="button"
        >
          <ChevronDownIcon
            size={12}
            style={{ transform: collapsed ? "rotate(-90deg)" : undefined }}
          />
        </button>
        <span className="dock-group-name">{project?.name ?? `#${projectId}`}</span>
        {githubStatus && (
          <DockGithubRow
            githubStatus={githubStatus}
            prsStatus={prsStatus}
            onOpen={() => onOpenGitHub(projectId)}
          />
        )}
        <ProjectPreviewMenu
          projectId={projectId}
          onOpenDefault={() => onOpenBrowser(projectId)}
          onBlank={onOpenBlankBrowser}
          onManage={() => onManagePreviews?.(projectId)}
        />
        {onRemove && (
          <button
            className="dock-column-remove"
            title="Remove project"
            onClick={onRemove}
            type="button"
          >
            ×
          </button>
        )}
      </div>
      {!collapsed && (
        <div className="dock-group-rows">
          {/* Passive detection (GET /api/projects) of a dev server a dock
              control started — shown whether or not the group has controls,
              unlike the empty-state below. Accepting goes through the same
              updateProject store action the Edit Project modal uses. */}
          {!project?.devServerUrl && project?.detectedDevServerPort && (
            <button
              className="dock-group-empty dock-detected-devserver"
              onClick={() =>
                void useDashboardStore
                  .getState()
                  .updateProject(projectId, { devServerUrl: project.detectedDevServerPort })
              }
              type="button"
            >
              <GlobeIcon size={11} />
              <span className="dock-monitor-url-text">
                Detected dev server on :{project.detectedDevServerPort} — use it?
              </span>
            </button>
          )}
          {configuredControls.length === 0 &&
            dockerStackGroups.length === 0 &&
            ungroupedDockerControls.length === 0 &&
            orphanControls.length === 0 && (
              <div className="dock-group-empty">No monitors configured</div>
            )}
          {configuredControls.map(renderMonitor)}
          {ungroupedDockerControls.map(renderMonitor)}
          {standaloneOrphanControls.map(renderMonitor)}
          {stackGroupRenderData.map(({ group, serviceControls, ephemeralControlsInGroup }) => {
            const stack = stackActions(group);
            return (
              <div key={group.composeProject} className="dock-stack-group">
                <DockStackHeader
                  composeProject={group.composeProject}
                  hasActions={stack.hasActions}
                  canPull={stack.canPull}
                  canRebuild={stack.canRebuild}
                  status={stack.status}
                  actionRunning={ephemeralControlsInGroup.length > 0}
                  onStackRestart={stack.restart}
                  onStackApply={stack.apply}
                  onPullAndRestart={stack.pullAndRestart}
                  onRebuildAndRestart={stack.rebuildAndRestart}
                  onStackStop={stack.stop}
                />
                {serviceControls.length > 0 && (
                  <div className="dock-stack-monitors">{serviceControls.map(renderMonitor)}</div>
                )}
                {ephemeralControlsInGroup.map(renderMonitor)}
                {(groupedOrphansByProject.get(group.composeProject) ?? []).map(renderMonitor)}
              </div>
            );
          })}
        </div>
      )}
      {
        // Unified-rail dock rework — this project's own resolved log
        // pane(s), portaled into Dock's shared host(s) rather than rendered
        // inline, and only while this project actually owns that slot.
      }
      {isActive &&
        primaryPaneHost &&
        createPortal(
          <DockLogPane
            key={selectedSession?.id ?? "empty"}
            sessionId={selectedSession?.id ?? null}
            minWidthPx={logPaneMinWidth}
            minHeightPx={logPaneMinHeight}
            flex={showPinnedPane ? `0 0 ${effectivePanePx}px` : undefined}
          />,
          primaryPaneHost,
        )}
      {isPinOwner &&
        showPinnedPane &&
        pinnedPaneHost &&
        createPortal(
          <DockLogPane
            key={pinnedSession?.id ?? "empty-pinned"}
            sessionId={pinnedSession?.id ?? null}
            minWidthPx={logPaneMinWidth}
            minHeightPx={logPaneMinHeight}
          />,
          pinnedPaneHost,
        )}
    </div>
  );
}
