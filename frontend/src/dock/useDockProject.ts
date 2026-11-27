import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, ApiError, LOCAL_HOST_ID } from "../api/index.js";
import type {
  DockControl,
  DockerUpdateCheckResult,
  GitBranchesResult,
  Session,
} from "../api/index.js";
import { useDashboardStore } from "../store/index.js";
import { CheckoutPrepareError } from "../store/slices/sessions.js";
import { useShallow } from "zustand/react/shallow";
import type { DockerStatusPresentation } from "../dockerServiceStatus.js";
import { dockerServiceStatus, isUpdateStillAvailable } from "../dockerServiceStatus.js";
import type { CustomSelectOption } from "../ui/CustomSelect.js";
import {
  composeProjectForControl,
  composeProjectFromContainerName,
  cwdForOtherHost,
  lastOutputLines,
  dockerSessionIdentity,
  groupDockerControls,
  holdVanishedDockerControls,
  isDockPreviewPath,
  resolveRememberedValueFromRunning,
  REMOTE_CHECKOUT_VALUE_PREFIX,
  remoteSelectorDisplay,
  resolveSelectedValue,
  runningSessionFor,
  runsDevServer,
} from "./dockHelpers.js";
import type { DockerStackGroup } from "./dockHelpers.js";
import { DOCKER_STACK_SESSION_NAME_PREFIX } from "../../../src/shared/constants.js";
import { KILL_ARM_DISARM_MS, useArmedKill } from "./useArmedKill.js";
import { useTransientStatus } from "./useTransientStatus.js";
import {
  buildHostTargetOptions,
  AUTO_VALUE,
  OWN_HOST_VALUE,
} from "../command-palette/hostTarget.js";
import { DOCKER_POLL_INTERVAL_MS, useSharedDockControls } from "./dockProjectShared.js";
import { useDetectedDockPorts } from "./dockDetectedPorts.js";
import {
  isBottomDockMounted,
  registerBottomDock,
  sharedAutoAttachState,
  useBottomDockMounted,
} from "./dockAutoAttach.js";

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
// `surface` says which layout this copy serves, and decides (here, and
// nowhere else) which one runs the "Auto-attach Docker logs" effect (#3031):
// exactly one per project. The bottom Dock runs it whenever it is mounted
// for the project; the right sidebar's Dock view runs it only when the
// bottom Dock is not (a coarse pointer, the phone tier, a collapsed Dock,
// Tasks mode). With a fine pointer between 700 and 1099px both can be
// mounted for one project, and two copies of the effect would each start a
// log session for the same container.

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

// #3557 — a session that ends this soon after its start is reported (toast +
// its last output in the log pane): a dev server that dies on startup (a
// missing .env in a remote checkout) otherwise just flips the row back to
// off. Generous because the row only reads "exited" once the server's
// reconciler has noticed, which can take tens of seconds for a remote host.
const EARLY_EXIT_WINDOW_MS = 2 * 60_000;
const EARLY_EXIT_LINES = 40;

/** #3557 — a control's run that ended right after it started: what the log
 * pane shows in place of the stream that is gone. */
export interface DockEndedReport {
  sessionId: number;
  title: string;
  hostLabel: string;
  exitCode: number | null;
  lines: string[];
}

// A control's state and actions, bound to it. What DockMonitor renders and
// what the Dock view's action buttons call.
export interface DockControlCardView {
  control: DockControl;
  running: Session | undefined;
  /** #3556 — the host the running session is on ("this server" or the host's
   * name), or null when it is not running or the project has one host. */
  runHostLabel: string | null;
  showSelector: boolean;
  selectedValue: string;
  worktreeOptions: CustomSelectOption[];
  /** #3589 — opens the built-in browser on this row's server: the Preview
   * menu's "Dev server" when the row's port is the dev server's (it follows
   * the row to its host), else the port detected in the run's output (the
   * Browser quick pick's entry for it). Null when it is not running or has
   * no known port. */
  openInBrowser: (() => void) | null;
  updateAvailable: boolean;
  dockerStatus: DockerStatusPresentation | null;
  held: boolean;
  checkStatus: { message: string; isError: boolean } | undefined;
  portConflict: { port: number; holderSessionId?: number; message: string } | undefined;
  armed: boolean;
  confirmBeforeKill: boolean;
  /** #3557 — set when the control's last run ended right after it started. */
  ended: DockEndedReport | undefined;
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

export type DockSurface = "bottom-dock" | "sidebar-view";

/** The Dock's host choice ("Next start on") for a project that reaches more than one host. */
export interface DockHostPicker {
  projectId: number;
  value: string;
  options: { value: string; label: string; disabled: boolean }[];
  onChange: (value: string) => void;
  /** #3556 — the titles of the running controls that pin the selector to the
   * host they run on; empty when nothing runs and it picks the next start's. */
  lockedBy: string[];
}

export function useDockProject(
  projectId: number,
  {
    surface,
    onOpenSession,
    onOpenBrowser,
    onOpenBrowserUrl,
  }: {
    surface: DockSurface;
    // Issue #2069 — "Open holder" on a port-in-use row.
    onOpenSession?: (session: Session) => void;
    // #3589 — what the Preview menu's "Dev server" item does; a running row
    // whose port is the dev server's offers it as "Open in browser".
    onOpenBrowser?: () => void;
    // #3589 — opens an address in the browser pane: a detected port's own
    // address when previews are off (PREVIEW_BASE_HOST unset), as the
    // Browser quick pick does.
    onOpenBrowserUrl?: (url: string, label: string) => void;
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
    gitRefsLoaded,
    settings,
    dockConfigRefreshTrigger,
    dockControlWorktrees,
    hosts,
  } = useDashboardStore(
    useShallow((s) => ({
      projects: s.projects,
      sessions: s.sessions,
      sessionsLoaded: s.sessionsLoaded,
      gitBranchesByProject: s.gitBranchesByProject,
      gitRefsLoaded: Boolean(s.gitRefsLoadedIds?.[projectId]),
      settings: s.settings,
      dockConfigRefreshTrigger: s.dockConfigRefreshTrigger,
      dockControlWorktrees: s.dockControlWorktrees?.[String(projectId)],
      hosts: s.hosts,
    })),
  );
  // U8 — Settings -> Session management's "Confirm before kill" toggle.
  const confirmBeforeKill = settings.sessions.confirmBeforeKill;
  // The project's controls come from ONE poll shared by every mounted copy
  // of this hook for the project (#3036, dockProjectShared.ts): the bottom
  // Dock and the Dock view see the same list and make one request per
  // interval between them.
  const {
    controls,
    known: controlsKnown,
    refreshNow: refreshControlsNow,
  } = useSharedDockControls(projectId, dockConfigRefreshTrigger);
  // Issue #73 — a "Pull & restart stack" session's synthesized control
  // (POST .../docker/update's response), never returned by GET .../dock.
  // Kept separately from `controls` so the shared 15s poll can freely
  // overwrite `controls` without wiping an in-flight update's own row.
  const [ephemeralControls, setEphemeralControls] = useState<DockControl[]>([]);
  const addEphemeralControl = (control: DockControl) =>
    setEphemeralControls((prev) => [...prev.filter((c) => c.id !== control.id), control]);
  const [updateChecks, setUpdateChecks] = useState<Record<string, DockerUpdateCheckResult>>({});
  const { statusById: checkStatusById, show: showCheckStatus } = useTransientStatus(4000);
  // #3557 — each control's latest launch, watched for an early exit, and the
  // report of one that did end early.
  const launchWatchRef = useRef(
    new Map<string, { sessionId: number; at: number; title: string; hostLabel: string }>(),
  );
  // Each control's latest launched session, so a report still in flight for
  // an older run is dropped once a newer one has started.
  const latestLaunchRef = useRef(new Map<string, number>());
  const [endedById, setEndedById] = useState<Record<string, DockEndedReport>>({});
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
  // Tracks which running session id + resolved value was already synced to
  // `dockControlWorktrees` per control so an in-flight manual switch in
  // `changeWorktree` is never overwritten by the outgoing session before
  // `deleteSession` completes.
  const syncedSessionByControlRef = useRef<Map<string, { sessionId: number; value: string }>>(
    new Map(),
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
  // #3425 — where a Start runs. Per launch and per mount: nothing is stored.
  // Until the user picks, it follows where the project's dock already runs
  // (a control running on the Mac is not offered "this server" by default),
  // else the project's own placement.
  const [hostChoice, setHostChoice] = useState<string | null>(null);
  // Own host first, then each host the project has a checkout on. Auto is not
  // offered: a dock control is somewhere on purpose.
  const hostOptions = project
    ? buildHostTargetOptions(project, hosts).filter((o) => o.value !== AUTO_VALUE)
    : [];
  const multiHost = project !== null && hostOptions.length > 1;
  // #3556 — the name a host goes by in the Dock, by buildHostTargetOptions's
  // rule: "this server" for the project's own host when that is the local one,
  // else the host's name. No id means the project's own host (#3557).
  const hostLabel = (hostId: string | undefined): string => {
    const id = hostId ?? project?.hostId ?? LOCAL_HOST_ID;
    if (id === LOCAL_HOST_ID && (!project || id === project.hostId)) return "this server";
    return hosts.find((h) => h.id === id)?.name ?? id;
  };
  // The option value that stands for a host: the project's own host is the
  // OWN sentinel, any other host its id.
  const hostValue = (hostId: string): string =>
    project && hostId === project.hostId ? OWN_HOST_VALUE : hostId;
  // #3556 — the project's configured controls that are running now (a Compose
  // service's log stream is not a dev server the selector would move). While
  // any runs, the selector shows where and is locked: a choice that differs
  // from where the control runs would contradict the log pane beside it.
  const runningConfigured = multiHost
    ? controls
        .filter((c) => c.source !== "docker")
        .flatMap((c) => {
          const s = runningSessionFor(c, dockSessions);
          return s ? [{ control: c, session: s }] : [];
        })
        .sort((a, b) => b.session.id - a.session.id)
    : [];
  // With controls on two hosts (only `mullion dock start --host` gets there),
  // the newest one on another host wins, as it did before the lock.
  const lockingRun =
    runningConfigured.find((r) => project && r.session.resolvedHostId !== project.hostId) ??
    runningConfigured[0];
  const lockedHostValue = lockingRun ? hostValue(lockingRun.session.resolvedHostId) : undefined;
  const runningElsewhere = multiHost
    ? [...dockSessions]
        .sort((a, b) => b.id - a.id)
        .map((s) => s.resolvedHostId)
        .find((h) => h && h !== project?.hostId && hostOptions.some((o) => o.value === h))
    : undefined;
  const effectiveHostChoice = lockedHostValue ?? hostChoice ?? runningElsewhere ?? OWN_HOST_VALUE;
  // A locked host is used even when it has left the options (removed, or no
  // longer in `hostCwds`): Start must go where the selector says, and the
  // server refuses a host it cannot use rather than the Dock silently picking
  // another (#3556).
  const targetHostId =
    project &&
    effectiveHostChoice !== OWN_HOST_VALUE &&
    (effectiveHostChoice === lockedHostValue ||
      hostOptions.some((o) => o.value === effectiveHostChoice))
      ? effectiveHostChoice
      : undefined;
  const lockedBy = runningConfigured.map((r) => r.control.title);
  // A locked value must be one of the options; a host that left the list
  // (removed, or no longer in `hostCwds`) is shown as itself, disabled.
  const pickerOptions =
    lockedHostValue !== undefined &&
    lockingRun &&
    !hostOptions.some((o) => o.value === lockedHostValue)
      ? [
          ...hostOptions,
          {
            value: lockedHostValue,
            label: hostLabel(lockingRun.session.resolvedHostId),
            disabled: true,
          },
        ]
      : hostOptions;
  const hostPicker: DockHostPicker | null = multiHost
    ? {
        projectId,
        value: lockedHostValue ?? targetHostId ?? OWN_HOST_VALUE,
        options: pickerOptions,
        onChange: (value: string) => {
          if (lockedBy.length === 0) setHostChoice(value);
        },
        lockedBy,
      }
    : null;

  // #3557 — a watched launch whose session has ended is reported once: a
  // toast naming the host and exit code, and its last output kept for the log
  // pane (the stream itself can no longer be attached).
  useEffect(() => {
    const watches = launchWatchRef.current;
    if (watches.size === 0) return;
    const now = Date.now();
    for (const [controlId, watch] of watches) {
      if (now - watch.at > EARLY_EXIT_WINDOW_MS) {
        watches.delete(controlId);
        continue;
      }
      const session = sessions.find((s) => s.id === watch.sessionId);
      if (!session) continue;
      // The row's own status, not the live `sessionStatus`: a killed row (Stop,
      // Restart) also derives "exited" there, and that is not an early exit.
      if (session.status === "active") continue;
      watches.delete(controlId);
      // A deliberate stop, or a one-shot command that finished cleanly.
      if (session.status !== "exited" || session.exitCode === 0) continue;
      void (async () => {
        let lines: string[] = [];
        try {
          const { text } = await api.getRenderedScrollback(session.id);
          lines = lastOutputLines(text, EARLY_EXIT_LINES);
        } catch {
          // The host no longer answers for it: the report says so.
        }
        if (latestLaunchRef.current.get(controlId) !== session.id) return;
        const exitCode = typeof session.exitCode === "number" ? session.exitCode : null;
        setEndedById((prev) => ({
          ...prev,
          [controlId]: {
            sessionId: session.id,
            title: watch.title,
            hostLabel: watch.hostLabel,
            exitCode,
            lines,
          },
        }));
        useDashboardStore
          .getState()
          .reportError(
            `${watch.title} exited right after starting on ${watch.hostLabel}${
              exitCode !== null ? ` (exit code ${exitCode})` : ""
            }.`,
            lines.length > 0
              ? `Last output: ${lines[lines.length - 1]}`
              : "It left no output to show.",
          );
      })();
    }
  }, [sessions]);

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

  // #3589 — the ports detected in this project's running commands' output
  // (dockDetectedPorts.ts), for a row's "Open in browser"; polled only where
  // a surface can open a browser and a command runs on this server.
  const localRunningIds = configuredControls
    .map((c) => runningFor(c))
    .filter((s): s is Session => s !== undefined && s.resolvedHostId === LOCAL_HOST_ID)
    .map((s) => s.id);
  const detectedDestinations = useDetectedDockPorts(
    projectId,
    localRunningIds.join(","),
    onOpenBrowser !== undefined && localRunningIds.length > 0,
  );
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

  // Which surface runs auto-attach (see the header comment). The bottom Dock
  // registers in a layout effect, so a view mounting in the same commit
  // already sees it when its own (passive) auto-attach effect runs; the
  // effect also re-checks the registry rather than trusting this render's
  // value alone.
  useLayoutEffect(
    () => (surface === "bottom-dock" ? registerBottomDock(projectId) : undefined),
    [surface, projectId],
  );
  const bottomDockMounted = useBottomDockMounted(projectId);
  const autoAttach = surface === "bottom-dock" || !bottomDockMounted;

  const AUTO_ATTACH_RETRY_MS = 60_000;
  // The bookkeeping is the project's, not this mount's (dockAutoAttach.ts):
  // when the effect moves from one surface to the other, or a surface
  // remounts, the owner knows which containers were already attached, or
  // are being attached right now, and does not start a second log session
  // for them, nor bring back a stream the user ended.
  useEffect(() => {
    // Only on a successful answer: the empty list shown before the first one,
    // or after a failed fetch, would prune every identity the project's
    // bookkeeping holds, and the next good poll would re-attach them.
    if (!autoAttach || !sessionsLoaded || !controlsKnown) return;
    if (surface !== "bottom-dock" && isBottomDockMounted(projectId)) return;
    const autoAttachState = sharedAutoAttachState(projectId);
    const autoAttachOn = settings.dock.autoAttachDockerLogs;
    const currentIdentities = new Set(
      discoveredControls
        .map((control) => dockerSessionIdentity(control))
        .filter((identity): identity is string => identity !== null),
    );
    for (const identity of autoAttachState.keys()) {
      if (!currentIdentities.has(identity)) autoAttachState.delete(identity);
    }
    const nowMs = Date.now();
    for (const control of discoveredControls) {
      const identity = dockerSessionIdentity(control);
      if (identity === null) continue;
      const eligible = autoAttachOn && control.docker?.state === "running";
      const entry = autoAttachState.get(identity);
      const wasEligible = entry?.eligible ?? false;
      const failedAt = entry?.failedAt ?? null;
      const dueForRetry = failedAt !== null && nowMs - failedAt >= AUTO_ATTACH_RETRY_MS;
      if (eligible && (!wasEligible || dueForRetry) && !runningFor(control)) {
        autoAttachState.set(identity, { eligible: true, failedAt });
        useDashboardStore
          .getState()
          .createSession(projectId, control.command, {
            kind: "dock",
            name: identity,
            nameLocked: true,
            ...(control.env ? { env: control.env } : {}),
          })
          .then(() => {
            autoAttachState.set(identity, { eligible: true, failedAt: null });
          })
          .catch(() => {
            console.warn("[dock] auto-attach docker logs failed", control.id);
            showCheckStatus(control.id, "Auto-attach failed", true);
            autoAttachState.set(identity, { eligible: true, failedAt: Date.now() });
          });
        continue;
      }
      autoAttachState.set(identity, { eligible, failedAt });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runningFor/discoveredControls are recomputed fresh from `controls`/`sessions` every render; depending on `controls` avoids re-running this effect on every unrelated re-render.
  }, [
    autoAttach,
    surface,
    controls,
    controlsKnown,
    sessionsLoaded,
    settings.dock.autoAttachDockerLogs,
    projectId,
  ]);

  // Issue #3230 — remember the branch/worktree a running monitor resolved to
  // in the persisted store so stopping it (even after a reload, remount, or
  // external start) keeps that selection instead of resetting to main. Runs
  // in every mounted copy of this hook: it only writes on a change, so the
  // bottom Dock and the Dock view agree after the first of them writes.
  useEffect(() => {
    const setWorktree = useDashboardStore.getState().setDockControlWorktree;
    if (!setWorktree) return;
    const opts = new Set(allOptions.map((o) => o.value));
    for (const control of configuredControls) {
      const running = runningFor(control);
      if (!running) {
        syncedSessionByControlRef.current.delete(control.id);
        continue;
      }
      const remembered = resolveRememberedValueFromRunning(running, opts);
      if (!remembered) continue;
      const prevSynced = syncedSessionByControlRef.current.get(control.id);
      if (prevSynced?.sessionId === running.id && prevSynced.value === remembered) continue;
      syncedSessionByControlRef.current.set(control.id, {
        sessionId: running.id,
        value: remembered,
      });
      setWorktree(projectId, control.id, remembered);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- controls/sessions/gitRefs are the stable state inputs from which configuredControls/runningFor/allOptions are derived; dockControlWorktrees is omitted because this effect only writes to it and need not re-run on manual picks (syncedSessionByControlRef is what prevents clobbering an in-flight pick).
  }, [projectId, controls, sessions, gitRefs]);

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

  const controlView = (control: DockControl): DockControlCardView => {
    const running = runningFor(control);
    const controlShowSelector = showSelector && control.source !== "docker";
    const effectiveWorktreeRefresh =
      control.worktreeRefresh ?? settings.dock?.defaultWorktreeRefresh ?? false;

    const optionValues = new Set(allOptions.map((o) => o.value));
    const selectedValue = resolveSelectedValue({
      running,
      storedValue: dockControlWorktrees?.[control.id],
      optionValues,
      refsLoaded: gitRefs !== undefined || gitRefsLoaded,
      mainCheckoutPath: mainCheckout?.path,
      controlCwd: control.cwd,
    });

    // Where this row launches. Start (nothing running) uses the group's choice.
    // Restart keeps the control on the host its OWN session runs on: with
    // `dev` on the Mac and `logs` at home, Restart on `logs` must not move it
    // to the Mac (#3425), and the selector is locked while it runs, so a
    // choice made before the start cannot move it either (#3556).
    // A host that has left the options is kept too, as Start does for a
    // locked host: the server refuses it rather than the row moving home.
    const rowHostId =
      running && project && running.resolvedHostId !== project.hostId
        ? running.resolvedHostId
        : undefined;
    const launchHostId = running ? rowHostId : targetHostId;
    // #3556 — where it runs, from the session, never from the selector. Only
    // where the project reaches more than one host, or the session landed off
    // the project's own host: a single-host Dock has nothing to tell apart.
    const runHostLabel =
      running && project && (multiHost || running.resolvedHostId !== project.hostId)
        ? hostLabel(running.resolvedHostId)
        : null;

    // #3589 — the selector's options are the project's own host's checkouts.
    // A row running elsewhere shows where it runs instead: the branch it
    // was started on, or that host's path, never this host's.
    const display = remoteSelectorDisplay({
      selectedValue,
      options: allOptions,
      running,
      remoteHostRoot: rowHostId !== undefined ? project?.hostCwds?.[rowHostId] : undefined,
      remote: rowHostId !== undefined,
    });

    const dockIdentity = dockerSessionIdentity(control);
    const identityOpts = dockIdentity ? { name: dockIdentity, nameLocked: true } : {};
    // #3557 — the selector's paths are on the project's own host; another host
    // gets the same directory under its own checkout, or a refusal to show.
    const cwdOnLaunchHost = (
      value: string,
    ): { ok: true; cwd: string | undefined } | { ok: false; message: string } => {
      const effectiveCwd = value.length > 0 ? value : control.cwd;
      if (!project || launchHostId === undefined || launchHostId === project.hostId) {
        return { ok: true, cwd: effectiveCwd };
      }
      if (effectiveCwd?.startsWith("branch:")) return { ok: true, cwd: effectiveCwd };
      const mapped =
        effectiveCwd !== undefined && effectiveCwd === mainCheckout?.path
          ? { ok: true as const, cwd: undefined }
          : cwdForOtherHost({
              cwd: effectiveCwd,
              projectRoot: project.cwd,
              hostRoot: project.hostCwds?.[launchHostId],
              isLinkedWorktree:
                effectiveCwd !== undefined &&
                worktrees.some((w) => w.path === effectiveCwd && !w.isMain),
            });
      if (mapped.ok) return mapped;
      return {
        ok: false,
        message:
          project.hostCwds?.[launchHostId] === undefined
            ? `${hostLabel(launchHostId)} has no checkout of this project.`
            : `${effectiveCwd} is a checkout on ${hostLabel(project.hostId)} only. Run the main checkout or a branch preview on ${hostLabel(launchHostId)}.`,
      };
    };
    const reportStartFailure = (err: unknown) => {
      const host = hostLabel(launchHostId);
      let reason = err instanceof Error ? err.message : String(err);
      // The server already names a remote host in front of its reason.
      if (reason.startsWith(`${host}: `)) reason = reason.slice(host.length + 2);
      useDashboardStore
        .getState()
        .reportError(`Couldn't start ${control.title} on ${host}:`, reason);
    };
    const launchOnHost = (value: string) => {
      const resolved = cwdOnLaunchHost(value);
      if (!resolved.ok) return Promise.reject(new Error(resolved.message));
      const effectiveCwd = resolved.cwd;
      if (effectiveCwd && effectiveCwd.startsWith("branch:")) {
        const branchName = effectiveCwd.slice("branch:".length);
        return useDashboardStore.getState().createSession(projectId, control.command, {
          kind: "dock",
          dockControlId: control.id,
          worktree: { branch: branchName },
          worktreeRefresh: effectiveWorktreeRefresh,
          ...(launchHostId !== undefined ? { targetHostId: launchHostId } : {}),
          ...identityOpts,
          ...(control.env ? { env: control.env } : {}),
        });
      }
      return useDashboardStore.getState().createSession(projectId, control.command, {
        ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
        kind: "dock",
        dockControlId: control.id,
        ...(launchHostId !== undefined ? { targetHostId: launchHostId } : {}),
        ...identityOpts,
        ...(control.env ? { env: control.env } : {}),
      });
    };

    // Every launch of this row clears its last early-exit report and watches
    // the new session for one (#3557).
    const launchForValue = async (value: string) => {
      setEndedById((prev) => {
        if (!(control.id in prev)) return prev;
        const next = { ...prev };
        delete next[control.id];
        return next;
      });
      const session = await launchOnHost(value);
      latestLaunchRef.current.set(control.id, session.id);
      launchWatchRef.current.set(control.id, {
        sessionId: session.id,
        at: Date.now(),
        title: control.title,
        hostLabel: hostLabel(launchHostId),
      });
      return session;
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
        } else if (
          (err instanceof ApiError && err.statusCode >= 400 && err.statusCode < 500) ||
          err instanceof CheckoutPrepareError
        ) {
          // #3556 — the server refused this start (e.g. a locked host with no
          // checkout any more: POST /api/sessions answers 409 with no `code`).
          // Retrying cannot help; its reason says what to do.
          showCheckStatus(control.id, err.message, true);
        } else {
          // #3557 — the reason, not just "try again": a remote host's own
          // refusal (a missing directory there) or the server's message.
          showCheckStatus(control.id, "Failed to start", true);
          reportStartFailure(err);
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
        .catch((err: unknown) => {
          showCheckStatus(control.id, "Failed to start", true);
          reportStartFailure(err);
        });
    };
    // The ONLY place a running stream gets killed from, and it never touches
    // selection OR activation, same as before this extraction.
    const stop = () => {
      if (!running) return;
      if (!confirmBeforeKill || killArmedIds.has(control.id)) {
        disarmKill(control.id);
        bumpToggleGen(control.id);
        // The failure is reported on the row, the same way its two
        // siblings in this file report theirs — "Failed to start" and
        // "Failed to switch" (plus a toast with the reason). This one used to
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
      // Refused before anything stops: a checkout that cannot run on the
      // chosen host must not cost the user the run they have (#3557).
      const resolved = cwdOnLaunchHost(value);
      if (!resolved.ok) {
        showCheckStatus(control.id, "Failed to switch", true);
        reportStartFailure(new Error(resolved.message));
        return;
      }
      disarmKill(control.id);
      bumpToggleGen(control.id);
      const shouldRestart = Boolean(running);
      const genAtStart = toggleGenRef.current.get(control.id) ?? 0;
      void (async () => {
        try {
          await useDashboardStore.getState().deleteSession(running.id);
          const genUnchanged = (toggleGenRef.current.get(control.id) ?? 0) === genAtStart;
          if (shouldRestart && genUnchanged) {
            await launchForValue(value).catch((err: unknown) => {
              reportStartFailure(err);
              throw err;
            });
          }
        } catch {
          showCheckStatus(control.id, "Failed to switch", true);
        }
      })();
    };
    // #3589 — the dev server (the Preview menu's own "Dev server", which
    // follows the control to its host), or else the port detected in this
    // run's output, opened as the quick pick opens it.
    const detected = running ? detectedDestinations.get(running.id) : undefined;
    const openInBrowser: (() => void) | null =
      !running || !onOpenBrowser
        ? null
        : runsDevServer(control, project, configuredControls.length === 1)
          ? onOpenBrowser
          : detected !== undefined
            ? () =>
                void api
                  .openDestinationPreview(projectId, detected.key)
                  .then((preview) =>
                    useDashboardStore.getState().requestOpenPreview({
                      projectId,
                      slug: preview.slug,
                      branch: null,
                      targetName: control.title,
                    }),
                  )
                  .catch((err: unknown) => {
                    // Previews are off (409 without PREVIEW_BASE_HOST): open
                    // the address itself, as the quick pick does then.
                    if (
                      err instanceof ApiError &&
                      err.statusCode === 409 &&
                      detected.address !== null &&
                      onOpenBrowserUrl
                    ) {
                      onOpenBrowserUrl(detected.address, control.title);
                      return;
                    }
                    useDashboardStore
                      .getState()
                      .reportError(
                        "Could not open preview",
                        err instanceof Error ? err.message : String(err),
                      );
                  })
            : null;
    const changeWorktree = (newValue: string) => {
      // Picking the remote checkout the row already runs from (#3589) is not
      // a switch: there is nothing to relaunch.
      if (newValue.startsWith(REMOTE_CHECKOUT_VALUE_PREFIX)) return;
      useDashboardStore.getState().setDockControlWorktree?.(projectId, control.id, newValue);
      relaunch(newValue);
    };
    const restart = () => {
      if (running) relaunch(selectedValue);
      else void start();
    };

    return {
      control,
      running,
      runHostLabel,
      showSelector: controlShowSelector,
      selectedValue: display.value,
      worktreeOptions: display.options,
      openInBrowser,
      updateAvailable,
      dockerStatus,
      held: heldMerge.heldIds.has(control.id),
      checkStatus: checkStatusById[control.id],
      portConflict,
      armed: killArmedIds.has(control.id),
      confirmBeforeKill,
      ended: endedById[control.id],
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
    hostPicker,
    configuredControls,
    ungroupedDockerControls,
    standaloneOrphanControls,
    stackGroupRenderData,
    groupedOrphansByProject,
    orphanControls,
    dockerStackGroups,
    allRenderedControls,
    runningFor,
    endedFor: (control: DockControl) => endedById[control.id],
    controlView,
    stackActions,
  };
}
