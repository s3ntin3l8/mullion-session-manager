import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api/index.js";
import type { DockControl, DockerUpdateCheckResult, GitBranchesResult } from "../api/index.js";
import { useDashboardStore } from "../store/index.js";
import { useShallow } from "zustand/react/shallow";
import { ChevronDownIcon, GlobeIcon } from "../ui/icons.js";
import { dockerServiceStatus, isUpdateStillAvailable } from "../dockerServiceStatus.js";
import { usePolling } from "../hooks/usePolling.js";
import { STORAGE_KEYS, readJSON, writeJSON } from "../lib/persistedState.js";
import {
  composeProjectForControl,
  composeProjectFromContainerName,
  dockRowKey,
  dockerSessionIdentity,
  groupDockerControls,
  holdVanishedDockerControls,
  isDockPreviewPath,
  resolveSelectedValue,
  runningSessionFor,
} from "./dockHelpers.js";
import { DOCKER_STACK_SESSION_NAME_PREFIX } from "../../../src/shared/constants.js";
import { useDockGithubStatus } from "./useDockGithubStatus.js";
import { DockGithubRow } from "./DockGithubRow.js";
import { useArmedKill } from "./useArmedKill.js";
import { useTransientStatus } from "./useTransientStatus.js";
import { DockMonitor } from "./DockMonitor.js";
import { DockLogPane } from "./DockLogPane.js";
import { DockStackHeader } from "./DockStackHeader.js";

// Issue #73 — how often a group with at least one discovered Docker control
// re-fetches GET .../dock while the dock is expanded, so a container's
// state/image reflects `docker ps` reality without the user having to
// toggle anything. The backend's own getComposeServices() cache
// (docker-service-detect.ts) TTLs at 10s specifically so this 15s interval
// only pays for a fresh `docker ps` roughly once per poll, not once per
// group.
const DOCKER_POLL_INTERVAL_MS = 15_000;

// Discovery is `docker ps -a`-driven (docker-service-detect.ts's
// probeComposeServices), not compose-config-driven — a `compose up -d`
// recreate genuinely deletes the old container before creating the new one,
// so a service can be absent from a poll for a few seconds mid-rebuild with
// nothing wrong. Without holding its row across that gap, a stack group's
// row LIST churns every recreate — see holdVanishedDockerControls
// (dockHelpers.ts) for the derivation this feeds. Two poll intervals plus a
// small margin: long enough to outlast one missed poll, short enough that a
// service actually removed via `compose down` still disappears promptly.
const RECREATE_GRACE_MS = 2 * DOCKER_POLL_INTERVAL_MS + 5_000;

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
  // Present only for a manually-pinned project not also derived from the
  // workspace — see Dock's manualOnly().
  onRemove?: () => void;
}) {
  // P1 perf fix — rendered here once PER PROJECT in the dock, so a
  // whole-store subscription's cost multiplied by project count on every
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
      prsRefreshTrigger: s.prsRefreshTrigger,
    })),
  );
  // U8 — Settings -> Session management's "Confirm before kill" toggle.
  const confirmBeforeKill = settings.sessions.confirmBeforeKill;
  const [controls, setControls] = useState<DockControl[]>([]);
  // Issue #73 — a "Pull & restart stack" session's synthesized control
  // (POST .../docker/update's response), never returned by GET .../dock.
  // Kept separately from `controls` so the 15s poll below can freely
  // overwrite `controls` without wiping an in-flight update's own row.
  const [ephemeralControls, setEphemeralControls] = useState<DockControl[]>([]);
  const addEphemeralControl = (control: DockControl) =>
    setEphemeralControls((prev) => [...prev.filter((c) => c.id !== control.id), control]);
  const [updateChecks, setUpdateChecks] = useState<Record<string, DockerUpdateCheckResult>>({});
  const { statusById: checkStatusById, show: showCheckStatus } = useTransientStatus(4000);
  const KILL_ARM_DISARM_MS = 6000; // matches ConfirmButton.tsx's own window
  const {
    armedIds: killArmedIds,
    arm: armKill,
    disarm: disarmKill,
  } = useArmedKill(KILL_ARM_DISARM_MS);
  // U5 — per-control "has the header been explicitly toggled since an
  // in-flight worktree-switch started" generation counter — see
  // `onWorktreeChange` below for the full mechanism.
  const toggleGenRef = useRef<Map<string, number>>(new Map());
  const bumpToggleGen = (controlId: string) => {
    toggleGenRef.current.set(controlId, (toggleGenRef.current.get(controlId) ?? 0) + 1);
  };
  // Per-monitor selected worktree path (by monitor config id) — not
  // persisted, same reasoning as before this extraction.
  const [worktreePaths, setWorktreePaths] = useState<Record<string, string>>({});

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

  // Polls so a discovered Docker service's container state/image tag stays
  // live without the user toggling anything — this component only renders
  // while the dock itself is expanded.
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
  // `useEffect` — for the same "adjust state during render" reason
  // `selectedKey`'s own reconciliation below is.
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

  const runningFor = (control: DockControl) => runningSessionFor(control, dockSessions);

  const optimisticEphemeralControls = ephemeralControls.filter((c) => runningFor(c));
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
  const { groups: dockerStackGroups, ungrouped: ungroupedDockerControls } = groupDockerControls(
    [...liveEphemeralControls, ...heldMerge.controls],
    heldMerge.heldIds,
  );
  const ephemeralIds = new Set(liveEphemeralControls.map((c) => c.id));

  const stackGroupRenderData = dockerStackGroups.map((group) => ({
    group,
    serviceControls: group.controls.filter((c) => !ephemeralIds.has(c.id)),
    ephemeralControlsInGroup: group.controls.filter((c) => ephemeralIds.has(c.id)),
  }));

  const controlsBeforeOrphans: DockControl[] = [
    ...configuredControls,
    ...ungroupedDockerControls,
    ...stackGroupRenderData.flatMap((g) => [...g.serviceControls, ...g.ephemeralControlsInGroup]),
  ];

  // Issue #1240 — a `docker-logs:<containerName>` session can outlive its
  // own control; this finds every one and synthesizes a standalone rail row
  // for it so it still has a stop affordance.
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
    };
  });

  const liveStackProjects = new Set(dockerStackGroups.map((g) => g.composeProject));
  const groupedOrphansByProject = new Map<string, DockControl[]>();
  const standaloneOrphanControls: DockControl[] = [];
  for (const orphan of orphanControls) {
    const containerName = orphan.id.slice("docker-logs:".length);
    const orphanProject = composeProjectFromContainerName(containerName);
    if (orphanProject !== null && liveStackProjects.has(orphanProject)) {
      const existing = groupedOrphansByProject.get(orphanProject);
      if (existing) existing.push(orphan);
      else groupedOrphansByProject.set(orphanProject, [orphan]);
    } else {
      standaloneOrphanControls.push(orphan);
    }
  }

  const allRenderedControls: DockControl[] = [...controlsBeforeOrphans, ...orphanControls];
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

  const AUTO_ATTACH_RETRY_MS = 60_000;
  const autoAttachStateRef = useRef<Map<string, { eligible: boolean; failedAt: number | null }>>(
    new Map(),
  );
  useEffect(() => {
    if (!sessionsLoaded) return;
    const autoAttachOn = settings.dock.autoAttachDockerLogs;
    const currentIdentities = new Set(
      discoveredControls
        .map((control) => dockerSessionIdentity(control))
        .filter((identity): identity is string => identity !== null),
    );
    for (const identity of autoAttachStateRef.current.keys()) {
      if (!currentIdentities.has(identity)) autoAttachStateRef.current.delete(identity);
    }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runningFor/discoveredControls are recomputed fresh from `controls`/`sessions` every render; depending on `controls` avoids re-running this effect on every unrelated re-render.
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
    } catch {
      console.warn("[dock] docker check-update failed", control.id);
      showCheckStatus(control.id, "Check failed", true);
    }
  };

  const handlePullAndRestart = async (control: DockControl, statusKey = control.id) => {
    try {
      const result = await api.updateDockerStack(projectId, control.id);
      if (result.reused) {
        showCheckStatus(statusKey, "Already running another stack action");
        return;
      }
      addEphemeralControl(result.control);
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
  // worktreePaths/toggleGenRef/allOptions/runningFor/etc.
  const renderMonitor = (control: DockControl) => {
    const running = runningFor(control);
    const controlShowSelector = showSelector && control.source !== "docker";
    const effectiveWorktreeRefresh =
      control.worktreeRefresh ?? settings.dock?.defaultWorktreeRefresh ?? false;

    const optionValues = new Set(allOptions.map((o) => o.value));
    const selectedValue = resolveSelectedValue({
      running,
      storedValue: worktreePaths[control.id],
      optionValues,
      mainCheckoutPath: mainCheckout?.path,
      controlCwd: control.cwd,
    });

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

    const updateAvailable = isUpdateStillAvailable(
      updateChecks[control.id],
      control.docker?.imageId,
    );
    const dockerStatus = control.docker ? dockerServiceStatus(control.docker.state) : null;

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
      bumpToggleGen(control.id);
      launchForValue(selectedValue).catch(() => {
        showCheckStatus(control.id, "Failed to start — try again", true);
        if (pendingSelectKeyRef.current?.key === rowKey) pendingSelectKeyRef.current = null;
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
    // running stream gets killed from, and it never touches selection OR
    // activation on that path, same as before this extraction.
    const toggleStream = () => {
      if (running) {
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

    const onWorktreeChange = (newValue: string) => {
      setWorktreePaths((prev) => ({ ...prev, [control.id]: newValue }));
      if (running) {
        disarmKill(control.id);
        bumpToggleGen(control.id);
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
        selected={isActive && selectedKey === rowKey}
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
        pinned={isPinOwner && pinnedRowKey === rowKey}
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
          {configuredControls.length === 0 &&
            dockerStackGroups.length === 0 &&
            ungroupedDockerControls.length === 0 &&
            orphanControls.length === 0 &&
            (project?.devServerUrl ? (
              <button
                className="dock-group-empty"
                onClick={() => onOpenBrowser(projectId)}
                title={`Open preview for ${project.devServerUrl}`}
                type="button"
              >
                <GlobeIcon size={11} />
                <span className="dock-monitor-url-text">{project.devServerUrl}</span>
              </button>
            ) : (
              <div className="dock-group-empty">No monitors configured</div>
            ))}
          {configuredControls.map(renderMonitor)}
          {ungroupedDockerControls.map(renderMonitor)}
          {standaloneOrphanControls.map(renderMonitor)}
          {stackGroupRenderData.map(({ group, serviceControls, ephemeralControlsInGroup }) => {
            const statusKey = `stack:${group.composeProject}`;
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
