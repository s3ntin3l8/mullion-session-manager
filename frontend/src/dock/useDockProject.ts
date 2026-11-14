import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api/index.js";
import type {
  DockControl,
  DockerUpdateCheckResult,
  GitBranchesResult,
  Session,
} from "../api/index.js";
import { useDashboardStore } from "../store/index.js";
import { useShallow } from "zustand/react/shallow";
import type { DockerStatusPresentation } from "../dockerServiceStatus.js";
import { dockerServiceStatus, isUpdateStillAvailable } from "../dockerServiceStatus.js";
import { usePolling } from "../hooks/usePolling.js";
import type { CustomSelectOption } from "../ui/CustomSelect.js";
import {
  composeProjectForControl,
  composeProjectFromContainerName,
  dockerSessionIdentity,
  groupDockerControls,
  holdVanishedDockerControls,
  isDockPreviewPath,
  resolveSelectedValue,
  runningSessionFor,
} from "./dockHelpers.js";
import type { DockerStackGroup } from "./dockHelpers.js";
import { DOCKER_STACK_SESSION_NAME_PREFIX } from "../../../src/shared/constants.js";
import { useArmedKill } from "./useArmedKill.js";
import { useTransientStatus } from "./useTransientStatus.js";

// One project's Dock data and actions (#3012): its controls (dock.json and
// the Docker Compose discovery), how they group, which are running, and every
// start, stop, restart, worktree, service and stack action. Extracted from
// DockProjectGroup, which still owns everything about how the bottom Dock
// lays a project out (row selection and its reconciliation, the pin, the
// collapse, the GitHub row, the log-pane portals), so that the right
// sidebar's Dock view (right-sidebar/DockSidebarView.tsx) runs the same data
// and the same actions instead of a fork of them. The code below moved here
// verbatim; only its packaging changed.
//
// `autoAttach` gates the "Auto-attach Docker logs" effect. Only the bottom
// Dock runs it: the view and the Dock can both be mounted for one project (a
// fine pointer between 700 and 1099px), and two copies of the effect would
// each start a log session for the same container.

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

// A control's state and actions, bound to it. What DockMonitor renders and
// what the Dock view's action buttons call.
export interface DockControlView {
  control: DockControl;
  running: Session | undefined;
  showSelector: boolean;
  selectedValue: string;
  worktreeOptions: CustomSelectOption[];
  updateAvailable: boolean;
  dockerStatus: DockerStatusPresentation | null;
  held: boolean;
  checkStatus: { message: string; isError: boolean } | undefined;
  portConflict: { port: number; holderSessionId?: number; message: string } | undefined;
  armed: boolean;
  confirmBeforeKill: boolean;
  /** Starts the control (from the selected worktree or branch). Resolves
   * false when the start failed; the failure is already on the row. */
  start: () => Promise<boolean>;
  /** Ends the running session, behind the arm-then-confirm step when
   * "Confirm before kill" is on (the first call only arms). */
  stop: () => void;
  /** Ends the running session and starts it again from the same checkout;
   * starts it when it is not running. */
  restart: () => void;
  changeWorktree: (value: string) => void;
  /** Present only when the caller can open a session. */
  openHolder?: () => void;
  stopHolderAndStart: () => void;
  checkUpdate: () => void;
  serviceRestart: () => void;
  serviceStop: () => void;
  serviceStart: () => void;
}

// A Compose stack's own actions, from its representative services (see
// docs/dock.md's stack header section for how they are picked).
export interface DockStackActions {
  statusKey: string;
  status: { message: string; isError: boolean } | undefined;
  hasActions: boolean;
  canPull: boolean;
  canRebuild: boolean;
  restart: () => void;
  apply: () => void;
  pullAndRestart: () => void;
  rebuildAndRestart: () => void;
  stop: () => void;
}

export function useDockProject(
  projectId: number,
  {
    autoAttach,
    onOpenSession,
  }: {
    autoAttach: boolean;
    // Issue #2069 — "Open holder" on a port-in-use row.
    onOpenSession?: (session: Session) => void;
  },
) {
  // P1 perf fix — run once PER PROJECT in the dock, so a
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
  } = useDashboardStore(
    useShallow((s) => ({
      projects: s.projects,
      sessions: s.sessions,
      sessionsLoaded: s.sessionsLoaded,
      gitBranchesByProject: s.gitBranchesByProject,
      settings: s.settings,
      dockConfigRefreshTrigger: s.dockConfigRefreshTrigger,
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
  // Issue #2069 — a start the backend refused with 409 `port_in_use`. Kept
  // until the next start attempt (not a transient tag) because it carries
  // actions: the holder may need opening or stopping, not just reading about.
  const [portConflicts, setPortConflicts] = useState<
    Record<string, { port: number; holderSessionId?: number; message: string }>
  >({});
  const setPortConflict = (
    controlId: string,
    conflict: { port: number; holderSessionId?: number; message: string } | null,
  ) =>
    setPortConflicts((prev) => {
      if (conflict === null) {
        if (!(controlId in prev)) return prev;
        const { [controlId]: _gone, ...rest } = prev;
        return rest;
      }
      return { ...prev, [controlId]: conflict };
    });
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

  const AUTO_ATTACH_RETRY_MS = 60_000;
  const autoAttachStateRef = useRef<Map<string, { eligible: boolean; failedAt: number | null }>>(
    new Map(),
  );
  useEffect(() => {
    if (!autoAttach || !sessionsLoaded) return;
    const autoAttachOn = settings.dock.autoAttachDockerLogs;
    const currentIdentities = new Set(
      discoveredControls
        .map((control) => dockerSessionIdentity(control))
        .filter((identity): identity is string => identity !== null),
    );
    for (const identity of autoAttachStateRef.current.keys()) {
      if (!currentIdentities.has(identity)) autoAttachStateRef.current.delete(identity);
    }
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
  }, [autoAttach, controls, sessionsLoaded, settings.dock.autoAttachDockerLogs, projectId]);

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

  const controlView = (control: DockControl): DockControlView => {
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

    const portConflict = portConflicts[control.id];
    const start = async (): Promise<boolean> => {
      bumpToggleGen(control.id);
      setPortConflict(control.id, null);
      try {
        await launchForValue(selectedValue);
        return true;
      } catch (err: unknown) {
        if (err instanceof ApiError && err.code === "port_in_use") {
          const port = Number(err.body?.port);
          const holder = Number(err.body?.holderSessionId);
          setPortConflict(control.id, {
            port,
            ...(Number.isInteger(holder) ? { holderSessionId: holder } : {}),
            message: err.message,
          });
        } else {
          showCheckStatus(control.id, "Failed to start — try again", true);
        }
        return false;
      }
    };
    const openHolder = () => {
      const holder = useDashboardStore
        .getState()
        .sessions.find((s) => s.id === portConflict?.holderSessionId);
      if (holder) onOpenSession?.(holder);
    };
    const stopHolderAndStart = () => {
      const holderId = portConflict?.holderSessionId;
      if (holderId === undefined) return;
      setPortConflict(control.id, null);
      void useDashboardStore
        .getState()
        .deleteSession(holderId)
        .then(() => launchForValue(selectedValue))
        .catch(() => showCheckStatus(control.id, "Failed to start — try again", true));
    };
    // The ONLY place a running stream gets killed from, and it never touches
    // selection OR activation, same as before this extraction.
    const stop = () => {
      if (!running) return;
      if (!confirmBeforeKill || killArmedIds.has(control.id)) {
        disarmKill(control.id);
        bumpToggleGen(control.id);
        // The failure is reported on the row, the same way its two
        // siblings in this file report theirs — "Failed to start — try
        // again" and "Failed to switch — try again". This one used to
        // reject unhandled, so a kill that failed was completely silent
        // and the row just sat there looking alive (audit finding 10).
        void useDashboardStore
          .getState()
          .deleteSession(running.id)
          .catch(() => {
            showCheckStatus(control.id, "Failed to kill — try again", true);
          });
      } else {
        armKill(control.id);
      }
    };

    // Kill-then-relaunch on `value`, guarded by the toggle generation so an
    // explicit stop or start in between wins over the relaunch.
    const relaunch = (value: string) => {
      if (!running) return;
      disarmKill(control.id);
      bumpToggleGen(control.id);
      const shouldRestart = Boolean(running);
      const genAtStart = toggleGenRef.current.get(control.id) ?? 0;
      void (async () => {
        try {
          await useDashboardStore.getState().deleteSession(running.id);
          const genUnchanged = (toggleGenRef.current.get(control.id) ?? 0) === genAtStart;
          if (shouldRestart && genUnchanged) {
            await launchForValue(value);
          }
        } catch {
          showCheckStatus(control.id, "Failed to switch — try again", true);
        }
      })();
    };
    const changeWorktree = (newValue: string) => {
      setWorktreePaths((prev) => ({ ...prev, [control.id]: newValue }));
      relaunch(newValue);
    };
    const restart = () => {
      if (running) relaunch(selectedValue);
      else void start();
    };

    return {
      control,
      running,
      showSelector: controlShowSelector,
      selectedValue,
      worktreeOptions: allOptions,
      updateAvailable,
      dockerStatus,
      held: heldMerge.heldIds.has(control.id),
      checkStatus: checkStatusById[control.id],
      portConflict,
      armed: killArmedIds.has(control.id),
      confirmBeforeKill,
      start,
      stop,
      restart,
      changeWorktree,
      ...(onOpenSession ? { openHolder } : {}),
      stopHolderAndStart,
      checkUpdate: () => void handleCheckUpdate(control),
      serviceRestart: () =>
        void handleServiceAction(control, api.restartDockerService, "Restart failed"),
      serviceStop: () => void handleServiceAction(control, api.stopDockerService, "Stop failed"),
      serviceStart: () => void handleServiceAction(control, api.startDockerService, "Start failed"),
    };
  };

  const stackActions = (group: DockerStackGroup): DockStackActions => {
    const statusKey = `stack:${group.composeProject}`;
    const rep = group.anyRep;
    return {
      statusKey,
      status: checkStatusById[statusKey],
      hasActions: rep !== null,
      canPull: group.pullRep !== null,
      canRebuild: group.rebuildRep !== null,
      restart: () => {
        if (rep)
          void handleStackAction(rep, api.restartDockerStack, "Failed to start restart", statusKey);
      },
      apply: () => {
        if (rep)
          void handleStackAction(rep, api.applyDockerStack, "Failed to apply config", statusKey);
      },
      pullAndRestart: () => {
        if (group.pullRep) void handlePullAndRestart(group.pullRep, statusKey);
      },
      rebuildAndRestart: () => {
        if (group.rebuildRep) void handleRebuildAndRestart(group.rebuildRep, statusKey);
      },
      stop: () => {
        if (rep)
          void handleStackAction(rep, api.stopDockerStack, "Failed to start stop", statusKey);
      },
    };
  };

  return {
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
  };
}
