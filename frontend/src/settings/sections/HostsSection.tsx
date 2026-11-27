import { useState } from "react";
import type { HostEditableRole, PlacementCapability } from "../../../../src/shared/constants.js";
import { useDashboardStore, LIVE_REFRESH_INTERVAL_MS } from "../../store/index.js";
import { api, ApiError, LOCAL_HOST_ID } from "../../api/index.js";
import { hasRemoteHosts } from "../../lib/hostBadge.js";
import type { Host, HostUpdateStatus } from "../../api/index.js";
import { CreateHostModal } from "../../CreateHostModal.js";
import { AgentInstallInstructions } from "../../AgentInstallInstructions.js";
import { HostConfigModal } from "../../HostConfigModal.js";
import {
  deriveHostStatus,
  legacyAgentLabels,
  legacyAgentTitle,
  type PingState,
} from "../../hostStatus.js";
import { formatCapacityAge, formatHostCapacityNow } from "../../hostCapacity.js";
import { formatRelativeUntil } from "../../relativeTime.js";
import { HOST_UPDATE_POLL_MS, useHostUpdateStatusPoll } from "../useHostUpdateStatusPoll.js";
import { KebabMenu } from "../../ui/KebabMenu.js";
import { useArmConfirm } from "../../hooks/useArmConfirm.js";
import { useCoarsePointer } from "../../lib/layoutTier.js";
import { usePolling } from "../../hooks/usePolling.js";
import { CloseIcon, GearIcon, HostsIcon, MoonIcon, PlusIcon, RenameIcon } from "../../ui/icons.js";
import {
  Dropdown,
  GroupHeading,
  ListRow,
  SecondaryButton,
  StyledList,
} from "../../ui/primitives.js";
import { ErrorText } from "../../ui/ErrorText.js";
import { BridgesSection } from "./BridgesSection.js";
import { HostPairingDialog, HostPairings } from "./HostPairings.js";
import { AutomationTokensSection } from "./AutomationTokensSection.js";
import { HostHeartbeatSetting, HostStaleAfterSetting } from "../RuntimeSettings.js";
import { Presence } from "../../ui/Presence.js";

// Mirrors the backend's IN_FLIGHT_PHASES (src/services/update-apply.ts) —
// used only to recognize "an update is already running on this host" from a
// freshly-fetched status (e.g. after a page reload mid-update), not to
// duplicate any backend logic.
const HOST_UPDATE_IN_FLIGHT_PHASES = new Set([
  "downloading",
  "installing",
  "verifying",
  "restarting",
]);

/**
 * How busy this host is, as one quiet line — issue #1726 / roadmap 8.12.
 *
 * "capacity unknown" is a real answer, not a missing one: a host that never
 * reported (an older agent build, or one that has not been polled yet) is
 * shown as unknown, NEVER as a zero — a zero load would read as "this
 * machine is idle", which is the one thing a missing reading must never
 * say. A reading that aged out keeps its numbers and says how old they are.
 */
function HostCapacityLine({ host }: { host: Host }) {
  const capacity = formatHostCapacityNow(host);
  if (!capacity.known) {
    return <span>{capacity.platform ? `${capacity.platform} · ` : ""}capacity unknown</span>;
  }
  const age = formatCapacityAge(capacity.ageMs);
  return (
    <span>
      {[
        capacity.platform,
        capacity.cores !== null ? `${capacity.cores} cores` : null,
        capacity.load !== null ? `load ${capacity.load}` : null,
        capacity.memory,
      ]
        .filter((part): part is string => part !== null)
        .join(" · ")}
      {capacity.stale && age ? ` (reading from ${age})` : ""}
    </span>
  );
}

const CAPABILITY_LABELS: Record<PlacementCapability, string> = {
  xcode: "Xcode",
  "android-emulator": "Android emulator",
};

/** Issue #2306 — null is "unknown" (an older agent), which is not "has none". */
function HostCapabilitiesLine({ host }: { host: Host }) {
  if (!host.capabilities) return <span>capabilities unknown</span>;
  if (host.capabilities.length === 0) return <span>no extra capabilities</span>;
  // The wire value is runtime data: a newer agent may report an id this build
  // does not know yet, which renders as its raw id rather than "undefined".
  const labels: Record<string, string | undefined> = CAPABILITY_LABELS;
  return <span>{host.capabilities.map((c) => labels[c] ?? c).join(" · ")}</span>;
}

/**
 * Issue #3156 — the environment a session on this host starts with: whether the
 * interactive-shell PATH recovery worked, the shell, and the PATH entries.
 * Collapsed by default; a fallback shows a warning chip naming the reason, and
 * null (an older agent) reads "not reported".
 */
function HostSessionEnvDetail({ host }: { host: Host }) {
  const env = host.sessionEnv;
  if (env === undefined) return null;
  return (
    <details data-testid={`host-session-env-${host.id}`} style={{ marginTop: 2 }}>
      <summary style={{ cursor: "pointer" }}>
        Session environment
        {env === null && " — not reported"}
        {env?.interactiveResolve === "fallback" && (
          <span
            data-testid={`host-session-env-warning-${host.id}`}
            style={{ color: "var(--y)", marginLeft: 6 }}
            title={
              env.retryAt
                ? "The interactive shell's PATH could not be recovered yet, so sessions on this host get only the service PATH until the agent's automatic retry succeeds."
                : "The interactive shell's PATH could not be recovered, so sessions on this host get only the service PATH."
            }
          >
            ⚠ PATH recovery fell back{env.reason ? `: ${env.reason}` : ""}
            {env.retryAt ? ` — will retry ${formatRelativeUntil(env.retryAt)}` : ""}
          </span>
        )}
      </summary>
      {env && (
        <div>
          <div>
            Interactive resolve:{" "}
            {env.interactiveResolve === "not-applicable"
              ? "not applicable (Windows)"
              : env.interactiveResolve}
            {env.reason ? ` (${env.reason})` : ""} · shell: {env.shell ?? "none"}
          </div>
          <div>PATH:</div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {env.path.map((entry, i) => (
              <li key={`${i}:${entry}`}>
                <code>{entry}</code>
              </li>
            ))}
          </ul>
          {env.recoveredKeys.length > 0 && <div>Recovered: {env.recoveredKeys.join(", ")}</div>}
        </div>
      )}
    </details>
  );
}

/**
 * Issue #2248 — protocol version, incompatibility and missing operations. The
 * remedy for both is the row's existing Update action. Null renders nothing
 * (not negotiated yet).
 */
function HostProtocolLine({ host }: { host: Host }) {
  const protocol = host.protocol;
  if (!protocol) return null;
  const parts: string[] = [
    protocol.legacy ? "protocol: legacy" : `protocol v${protocol.protocolVersion}`,
  ];
  if (protocol.incompatible) parts.push("incompatible — update this host");
  else if (protocol.missingOperations.length > 0) {
    parts.push(`missing: ${protocol.missingOperations.join(", ")} — update this host`);
  }
  // Issue #2569 — launches needing one of these are refused until it is updated.
  if (!protocol.incompatible && protocol.missingLaunchOptions.length > 0) {
    parts.push(`launch options: ${protocol.missingLaunchOptions.join(", ")} unavailable`);
  }
  return (
    <span data-testid={`host-protocol-${host.id}`}>
      {" · "}
      {parts.join(" · ")}
    </span>
  );
}

function formatIdentityReplacementAge(iso: string, nowMs: number): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "recently";
  const seconds = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// Issue #3091 — a host that connects out needs no stored address, so it may be
// cleared; one without a live machine identity (none, revoked or expired) is
// reached only by it. The server enforces the same rule.
function canClearAddress(host: Host): boolean {
  return host.hasLiveMachineIdentity === true;
}

export function HostsSection() {
  const {
    hosts,
    refreshHosts,
    updateHost,
    deleteHost,
    pingHost,
    rotateHostToken,
    revokeHost,
    unbindHost,
    acknowledgeHostIdentityReplacement,
  } = useDashboardStore();

  // Issue #1725 / roadmap 8.11 — park a host, or un-park it.
  //
  // Parking is a FLAG, not an action: the host keeps running, keeps its
  // sessions, and stays usable for manual placement. What it changes is
  // that the placement policy stops CHOOSING it for new work.
  const toggleDrain = (host: Host) => {
    setDrainError(null);
    // The failure is SURFACED: the KebabMenu just calls onClick() with no
    // error handling of its own, so a park that does not reach the server
    // would otherwise leave the row unchanged with nothing said — the user
    // would think the switch worked.
    void updateHost(host.id, { drained: !host.drained }).catch((err: unknown) => {
      setDrainError(err instanceof Error ? err.message : String(err));
    });
  };
  // Issue #2239 — worker | burst. Surfaced on failure like toggleDrain.
  const changeRole = (host: Host, role: HostEditableRole) => {
    setDrainError(null);
    void updateHost(host.id, { role }).catch((err: unknown) => {
      setDrainError(err instanceof Error ? err.message : String(err));
    });
  };
  // Issue #2582 — the server flags a newer enrolled row as a probable
  // duplicate of older offline, session-free ones. The older rows are the
  // ones offered for removal; nothing is ever removed automatically.
  const duplicateHostIds = new Set(hosts.flatMap((h) => h.possibleDuplicateOf ?? []));
  const staleHosts = hosts.filter((host) => host.id !== LOCAL_HOST_ID && host.stale);
  const [now, setNow] = useState(Date.now);
  const [selectedStaleIds, setSelectedStaleIds] = useState<string[]>([]);
  const [removingStale, setRemovingStale] = useState(false);
  const [remainingStale, setRemainingStale] = useState<Host[]>([]);
  const hostNameById = new Map(hosts.map((h) => [h.id, h.name]));
  // The primary's own version, reported on its "local" row (Issue #2969).
  const primaryVersion = hosts.find((h) => h.id === LOCAL_HOST_ID)?.mullionVersion ?? null;
  const [pairing, setPairing] = useState<{ host?: Host } | null>(null);
  const [editing, setEditing] = useState<Host | null>(null);
  // A freshly rotated token, shown once (the DB only keeps it encrypted).
  const [rotated, setRotated] = useState<{
    name: string;
    token: string;
  } | null>(null);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [viewingConfig, setViewingConfig] = useState<{ id: string; name: string } | null>(null);
  const [pingStatus, setPingStatus] = useState<Record<string, PingState>>({});
  // A host that 409s on delete (still owns projects) — offers a cascade
  // retry inline instead of a second confirm dialog, since the backend's
  // own error message already names the project count.
  const [cascadePrompt, setCascadePrompt] = useState<{ id: string; message: string } | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Issue #1725 — a failed park/unpark says so, rather than leaving the
  // row unchanged with nothing said.
  const [drainError, setDrainError] = useState<string | null>(null);
  const [acknowledging, setAcknowledging] = useState<Record<string, boolean>>({});
  const [ackError, setAckError] = useState<string | null>(null);
  const [approving, setApproving] = useState<Record<string, boolean>>({});
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const coarse = useCoarsePointer();
  const {
    armedKey: armedRejectHostId,
    arm: armReject,
    disarm: disarmReject,
    confirm: confirmReject,
  } = useArmConfirm();

  // Issue #647 / roadmap 7.8 — per-host update state, keyed like pingStatus
  // above (one global updater's worth of state, per host, not a single flat
  // useState the way ServerInfoSection's UpdatesSubsection gets away with
  // for the primary).
  const [updateInfo, setUpdateInfo] = useState<Record<string, HostUpdateStatus>>({});
  const [applyingUpdate, setApplyingUpdate] = useState<Record<string, boolean>>({});
  const [applyError, setApplyError] = useState<Record<string, string>>({});
  const [updateForcePrompt, setUpdateForcePrompt] = useState<{
    hostId: string;
    hostName: string;
    message: string;
    tasks: Array<{
      id: number;
      issueNumber: number | null;
      projectName: string;
      status: string;
    }>;
  } | null>(null);

  // The local host is a row in the `hosts` table too (migration 0008 seeds
  // it), so it is filtered out of the REMOTE list below — but its row is
  // where this machine's own capacity reading comes from, and "how busy am
  // I" is the first question a user has about their own box.
  const localHost = hosts.find((h) => h.id === LOCAL_HOST_ID);

  // Issue #3574 — the update-status poll is its own hook, with a cadence
  // that follows what each host can answer: a host awaiting approval (409)
  // or with no connected agent (503) is not asked at all, or is asked with
  // a backoff, instead of every couple of seconds forever. The server's
  // answers are unchanged.
  useHostUpdateStatusPoll({
    hosts,
    applying: applyingUpdate,
    onStatus: (hostId, status) => {
      setUpdateInfo((prev) => ({ ...prev, [hostId]: status }));
      // Recognizes an update already in flight on this host (e.g. this
      // tab reloaded mid-update, or a different tab started it) so the
      // in-flight poll below picks it up instead of the row looking idle.
      if (HOST_UPDATE_IN_FLIGHT_PHASES.has(status.status.phase)) {
        setApplyingUpdate((prev) => (prev[hostId] ? prev : { ...prev, [hostId]: true }));
      }
    },
  });

  // Polls only the hosts with an update actually running — same
  // poll-until-terminal-state shape as ServerInfoSection's own update-apply
  // poll, just fanned out per host. A transient poll failure (expected
  // during the agent's own restart step — see self-update.sh's last step)
  // is swallowed on purpose: the row keeps showing its last known phase
  // ("restarting…") rather than flashing an error for a connectivity gap
  // that's part of a normal update.
  const applyingHostIds = Object.keys(applyingUpdate).filter((id) => applyingUpdate[id]);
  usePolling(
    () => {
      for (const id of applyingHostIds) {
        api
          .getHostUpdateStatus(id)
          .then((info) => {
            setUpdateInfo((prev) => ({ ...prev, [id]: info }));
            if (info.status.phase === "done" || info.status.phase === "failed") {
              setApplyingUpdate((prev) => ({ ...prev, [id]: false }));
            }
          })
          .catch(() => {
            // See comment above — a mid-restart connectivity gap is
            // expected, not a failure.
          });
      }
    },
    HOST_UPDATE_POLL_MS,
    { enabled: applyingHostIds.length > 0, immediate: false },
  );

  const applyHostUpdate = (hostId: string, force = false) => {
    setApplyError((prev) => {
      if (!(hostId in prev)) return prev;
      const next = { ...prev };
      delete next[hostId];
      return next;
    });
    setUpdateForcePrompt((prev) => (prev?.hostId === hostId ? null : prev));
    setApplyingUpdate((prev) => ({ ...prev, [hostId]: true }));
    api
      .applyHostUpdate(hostId, force ? { force: true } : undefined)
      .then((status) => {
        setUpdateInfo((prev) =>
          prev[hostId] ? { ...prev, [hostId]: { ...prev[hostId], status } } : prev,
        );
      })
      .catch((err: unknown) => {
        setApplyingUpdate((prev) => ({ ...prev, [hostId]: false }));
        if (
          !force &&
          err instanceof ApiError &&
          err.statusCode === 409 &&
          Array.isArray(err.body?.tasks)
        ) {
          const blockedTasks = err.body.tasks.filter(
            (
              t,
            ): t is {
              id: number;
              issueNumber: number | null;
              projectName: string;
              status: string;
            } =>
              typeof t === "object" &&
              t !== null &&
              typeof (t as Record<string, unknown>).id === "number" &&
              typeof (t as Record<string, unknown>).projectName === "string" &&
              typeof (t as Record<string, unknown>).status === "string",
          );
          if (blockedTasks.length > 0) {
            const hostName = hosts.find((h) => h.id === hostId)?.name ?? hostId;
            const message = typeof err.body.error === "string" ? err.body.error : err.message;
            setUpdateForcePrompt({
              hostId,
              hostName,
              message,
              tasks: blockedTasks,
            });
            return;
          }
        }
        setApplyError((prev) => ({
          ...prev,
          [hostId]: err instanceof ApiError ? err.message : "Could not start the update",
        }));
      });
  };

  // Sidebar.tsx's own mount effect already fetches `hosts` in practice
  // (it's always mounted alongside Settings), but relying on that as a
  // hidden cross-file invariant is fragile — a lone Settings render (or a
  // future change to when Sidebar mounts) would otherwise show a stale
  // list until the next mutation. This fetch is cheap; the duplication is
  // an acceptable cost for not coupling this section's correctness to
  // another file's mount order (Hermes review, PR #35).
  //
  // Also polls on LIVE_REFRESH_INTERVAL_MS (same interval Source Control's own
  // live-status effect uses) so the heartbeat-driven health dot (issue
  // #246) actually updates while this section stays open, instead of only
  // on mount/after a host mutation — matching #246's "continuously-updated
  // indicator" ask, not just a one-shot fetch.
  usePolling(
    () => {
      setNow(Date.now());
      void refreshHosts();
    },
    LIVE_REFRESH_INTERVAL_MS,
    { pauseWhenHidden: true, deps: [refreshHosts] },
  );

  // Snapshotting host.lastCheckedAt when the click *begins* (not when it
  // resolves) is what deriveHostStatus compares against later — see its
  // own doc comment for why this must be a server-issued value, never
  // Date.now().
  const testConnection = (host: Host) => {
    const lastCheckedAtSnapshot = host.lastCheckedAt;
    setPingStatus((prev) => ({
      ...prev,
      [host.id]: { status: "checking", lastCheckedAtSnapshot },
    }));
    void pingHost(host.id)
      .then((online) =>
        setPingStatus((prev) => ({
          ...prev,
          [host.id]: { status: online ? "online" : "offline", lastCheckedAtSnapshot },
        })),
      )
      .catch(() =>
        setPingStatus((prev) => ({
          ...prev,
          [host.id]: { status: "offline", lastCheckedAtSnapshot },
        })),
      );
  };

  const handleDelete = async (host: Host): Promise<"deleted" | "conflict" | "error"> => {
    setDeleteError(null);
    try {
      await deleteHost(host.id);
      return "deleted";
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // 409 is src/routes/hosts.ts's HostHasProjectsError (still owns
      // projects) — branching on the status code rather than matching the
      // message text ("...pass ?cascade=true") keeps this from silently
      // breaking if that wording ever changes; anything else (unreachable,
      // 404) surfaces as a plain inline error instead.
      if (err instanceof ApiError && err.statusCode === 409) {
        setCascadePrompt({ id: host.id, message });
        return "conflict";
      } else {
        setDeleteError(message);
      }
      return "error";
    }
  };

  // Stop at a conflict so every project-owning host gets the existing prompt.
  const removeStaleHosts = async (queue: Host[]) => {
    setRemovingStale(true);
    for (const [index, host] of queue.entries()) {
      const result = await handleDelete(host);
      if (result !== "deleted") {
        setRemainingStale(result === "conflict" ? queue.slice(index + 1) : []);
        setRemovingStale(false);
        return;
      }
      setSelectedStaleIds((ids) => ids.filter((id) => id !== host.id));
    }
    setRemainingStale([]);
    setRemovingStale(false);
  };

  const handleRevoke = (host: Host) => {
    setRotateError(null);
    revokeHost(host.id).catch((err: unknown) =>
      setRotateError(err instanceof Error ? err.message : "Could not revoke the identity."),
    );
  };

  const handleUnbind = (host: Host) => {
    setDeleteError(null);
    unbindHost(host.id).catch((err: unknown) =>
      setDeleteError(err instanceof Error ? err.message : "Could not unbind the channel."),
    );
  };

  const handleRotate = (host: Host) => {
    setRotateError(null);
    rotateHostToken(host.id)
      .then((token) => setRotated({ name: host.name, token }))
      .catch((err: unknown) =>
        setRotateError(err instanceof Error ? err.message : "Could not rotate the token."),
      );
  };

  const handleAcknowledgeReplacement = (host: Host) => {
    setAckError(null);
    setAcknowledging((prev) => ({ ...prev, [host.id]: true }));
    void acknowledgeHostIdentityReplacement(host.id)
      .catch((err: unknown) =>
        setAckError(
          err instanceof Error ? err.message : "Could not acknowledge identity replacement.",
        ),
      )
      .finally(() => {
        setAcknowledging((prev) => ({ ...prev, [host.id]: false }));
      });
  };

  const handleApprove = (host: Host) => {
    setApprovalError(null);
    setApproving((prev) => ({ ...prev, [host.id]: true }));
    void api
      .approveHost(host.id)
      .then(() => refreshHosts())
      .catch((err: unknown) =>
        setApprovalError(err instanceof Error ? err.message : "Could not approve host."),
      )
      .finally(() => {
        setApproving((prev) => ({ ...prev, [host.id]: false }));
      });
  };

  const handleReject = (host: Host) => {
    setApprovalError(null);
    setApproving((prev) => ({ ...prev, [host.id]: true }));
    void deleteHost(host.id)
      .catch((err: unknown) =>
        setApprovalError(err instanceof Error ? err.message : "Could not reject host."),
      )
      .finally(() => {
        setApproving((prev) => ({ ...prev, [host.id]: false }));
      });
  };

  const confirmCascadeDelete = () => {
    if (!cascadePrompt) return;
    const { id } = cascadePrompt;
    setCascadePrompt(null);
    setRemovingStale(true);
    void deleteHost(id, { cascade: true })
      .then(() => {
        setSelectedStaleIds((ids) => ids.filter((selected) => selected !== id));
        return removeStaleHosts(remainingStale);
      })
      .catch((err: unknown) => {
        setDeleteError(err instanceof Error ? err.message : String(err));
        setRemainingStale([]);
        setRemovingStale(false);
      });
  };

  return (
    <>
      <GroupHeading
        title="Registered hosts"
        desc="Other machines running Mullion that this dashboard can run sessions on."
      />
      <StyledList>
        <ListRow
          icon={<HostsIcon size={15} />}
          dot="on"
          title="This machine"
          subtitle={
            localHost ? (
              <>
                local · <HostCapacityLine host={localHost} />
              </>
            ) : (
              "local"
            )
          }
          trailing={
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: "0.65625rem", color: "var(--dim)" }}>always online</span>
              {/* Issue #2239 — the primary's role is fixed. */}
              <span
                style={{ fontSize: "0.65625rem", color: "var(--dim)" }}
                title="The primary is always the main host."
              >
                main
              </span>
              {/* Issue #1725 — the primary can be parked too: parking it is
                  how you drain it. The local host takes no other edits, but
                  this one is a placement decision rather than an edit of
                  the host's identity. */}
              {localHost?.drained && (
                <span
                  style={{ fontSize: "0.65625rem", color: "var(--y)" }}
                  title="Parked: this machine takes no new work. Nothing on it is stopped."
                >
                  parked
                </span>
              )}
              <SecondaryButton
                onClick={() => localHost && toggleDrain(localHost)}
                disabled={!localHost}
              >
                {localHost?.drained ? "Unpark" : "Park"}
              </SecondaryButton>
              <SecondaryButton
                onClick={() => setViewingConfig({ id: LOCAL_HOST_ID, name: "This machine" })}
              >
                Config
              </SecondaryButton>
            </div>
          }
        />
        {hosts
          .filter((h) => h.id !== LOCAL_HOST_ID)
          .map((host) => {
            const click = pingStatus[host.id] ?? { status: "unknown", lastCheckedAtSnapshot: null };
            const display = deriveHostStatus(host, click);
            return (
              <ListRow
                key={host.id}
                testId={`host-row-${host.id}`}
                stacked={Boolean(host.recentIdentityReplacement)}
                icon={<HostsIcon size={15} />}
                dot={display.dot}
                title={host.name}
                subtitle={
                  <>
                    {host.stale && host.lastSeenAt && (
                      <>
                        <span style={{ color: "var(--y)" }}>
                          Not seen for{" "}
                          {Math.max(
                            0,
                            Math.floor((now - Date.parse(host.lastSeenAt)) / 86_400_000),
                          )}{" "}
                          days
                        </span>
                        {" · "}
                      </>
                    )}
                    {host.baseUrl ??
                      (host.machineIdentityRevoked === true
                        ? "Re-pair to reconnect the agent"
                        : host.health === "online"
                          ? "connected over the outbound channel"
                          : host.paired
                            ? "paired — waiting for the agent to connect"
                            : host.hasMachineIdentity
                              ? "outbound only — waiting for the agent to connect"
                              : "waiting for the agent to register")}
                    {host.legacyAgent && (
                      <>
                        {" · "}
                        <span
                          style={{ color: "var(--y)" }}
                          title={legacyAgentTitle(host, primaryVersion)}
                        >
                          {legacyAgentLabels(host).long}
                        </span>
                      </>
                    )}
                    {host.unclaimed && (
                      <>
                        {" · "}
                        <span
                          style={{ color: "var(--y)" }}
                          title="The pairing code was redeemed but the agent never renewed its credential or connected. Revoke the identity or remove the host."
                        >
                          Paired, never connected
                        </span>
                      </>
                    )}
                    {host.channel?.bound && !host.channel?.ready && (
                      <>
                        {" · "}
                        <span
                          style={{ color: "var(--y)" }}
                          title="Bound to the outbound channel, but no connection is currently open."
                        >
                          bound to the outbound channel, not connected
                        </span>
                      </>
                    )}
                    {" · "}
                    <HostCapacityLine host={host} />
                    {" · "}
                    <HostCapabilitiesLine host={host} />
                    <HostProtocolLine host={host} />
                    <HostSessionEnvDetail host={host} />
                    {(host.leakedBrowsers ?? 0) > 0 && (
                      <>
                        {" · "}
                        <span
                          style={{ color: "var(--y)" }}
                          title="Mullion could not close these browsers when their session or worktree ended and stopped retrying. They stay running until this host's Mullion restarts."
                        >
                          {host.leakedBrowsers} leaked browser{host.leakedBrowsers === 1 ? "" : "s"}
                        </span>
                      </>
                    )}
                    {(host.possibleDuplicateOf?.length ?? 0) > 0 && (
                      <>
                        {" · "}
                        <span
                          style={{ color: "var(--y)" }}
                          title="An older offline host with no sessions reports the same URL or hostname — likely this agent's previous registration, left behind when its state file was lost."
                        >
                          Possible duplicate of{" "}
                          {host
                            .possibleDuplicateOf!.map((id) => hostNameById.get(id) ?? id)
                            .join(", ")}
                        </span>
                      </>
                    )}
                    {host.approvalPending && (
                      <>
                        {" · "}
                        <span
                          data-testid={`host-approval-pending-${host.id}`}
                          style={{ color: "var(--y)" }}
                          title="This host was enrolled without an operator present and receives no work until approved."
                        >
                          Awaiting approval
                        </span>
                        <span
                          data-testid={`host-approval-detail-${host.id}`}
                          style={{ display: "block", marginTop: 2 }}
                        >
                          Enrolled from peer <code>{host.enrollmentPeer ?? "unknown"}</code>
                          {" · "}
                          <SecondaryButton
                            onClick={() => handleApprove(host)}
                            disabled={approving[host.id] === true}
                          >
                            Approve
                          </SecondaryButton>{" "}
                          <SecondaryButton
                            className={armedRejectHostId === host.id ? "danger armed" : undefined}
                            onClick={(e) => {
                              if (armedRejectHostId === host.id) {
                                if (!confirmReject(host.id, e)) return;
                                handleReject(host);
                              } else {
                                armReject(host.id);
                              }
                            }}
                            onBlur={() => {
                              if (armedRejectHostId === host.id) disarmReject();
                            }}
                            disabled={approving[host.id] === true}
                          >
                            {armedRejectHostId === host.id
                              ? coarse
                                ? "Tap again to reject"
                                : "Click again to reject"
                              : "Reject"}
                          </SecondaryButton>
                        </span>
                      </>
                    )}
                    {host.recentIdentityReplacement && (
                      <>
                        {" · "}
                        <span
                          data-testid={`host-identity-replaced-${host.id}`}
                          style={{ color: "var(--y)" }}
                          title="This host's machine identity was replaced in place. Re-pairing is the operator's way to replace an agent; if unexpected, revoke the identity."
                        >
                          Identity replaced{" "}
                          {formatIdentityReplacementAge(host.recentIdentityReplacement.at, now)}
                        </span>
                        <span
                          data-testid={`host-identity-replaced-detail-${host.id}`}
                          style={{ display: "block", marginTop: 2 }}
                        >
                          Identity replaced from peer{" "}
                          <code>{host.recentIdentityReplacement.peer ?? "unknown"}</code>
                          {" · "}
                          <SecondaryButton
                            onClick={() => handleAcknowledgeReplacement(host)}
                            disabled={acknowledging[host.id] === true}
                          >
                            Acknowledge
                          </SecondaryButton>
                        </span>
                      </>
                    )}
                  </>
                }
                trailing={
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {display.label && (
                      <span
                        style={{ fontSize: "0.65625rem", color: display.color }}
                        title={display.title}
                      >
                        {display.label}
                      </span>
                    )}
                    {/* Issue #2239 — a burst host (a laptop that sleeps) stays out
                        of automatic placement; an explicit target still reaches it. */}
                    <span title="Worker: eligible for automatic placement. Burst: only used when a session or task names this host.">
                      <Dropdown<HostEditableRole>
                        small
                        ariaLabel={`Role of ${host.name}`}
                        value={host.role as HostEditableRole}
                        onChange={(r) => changeRole(host, r)}
                        options={[
                          { value: "worker", label: "worker" },
                          { value: "burst", label: "burst" },
                        ]}
                      />
                    </span>
                    {/* Issue #1725 — the parked state, visible next to the
                        health: the host is up, it is just taking no new
                        work. */}
                    {host.drained && (
                      <span
                        style={{ fontSize: "0.65625rem", color: "var(--y)" }}
                        title="Parked: this host takes no new work. Nothing on it is stopped."
                      >
                        parked
                      </span>
                    )}
                    {(() => {
                      const info = updateInfo[host.id];
                      if (!info) return null;
                      const applying = applyingUpdate[host.id] ?? false;
                      if (info.upToDate) {
                        return (
                          <span style={{ fontSize: "0.65625rem", color: "var(--dim)" }}>
                            v{info.hostVersion} · up to date
                          </span>
                        );
                      }
                      return (
                        <>
                          <span style={{ fontSize: "0.65625rem", color: "var(--y)" }}>
                            v{info.hostVersion} → v{info.primaryVersion}
                          </span>
                          {info.updatable ? (
                            <SecondaryButton
                              onClick={() => applyHostUpdate(host.id)}
                              disabled={applying}
                            >
                              {applying ? `${info.status.phase}…` : "Update"}
                            </SecondaryButton>
                          ) : (
                            info.unavailableReason && (
                              <span
                                style={{ fontSize: "0.65625rem", color: "var(--dim)" }}
                                title={info.unavailableReason}
                              >
                                update unavailable
                              </span>
                            )
                          )}
                        </>
                      );
                    })()}
                    <SecondaryButton
                      onClick={() => testConnection(host)}
                      disabled={host.machineIdentityRevoked === true || click.status === "checking"}
                    >
                      Test
                    </SecondaryButton>
                    {host.channel?.bound && !host.channel?.ready && (
                      <SecondaryButton
                        onClick={() => handleUnbind(host)}
                        data-testid={`unbind-host-${host.id}`}
                      >
                        Unbind
                      </SecondaryButton>
                    )}
                    <KebabMenu
                      title="More…"
                      items={[
                        {
                          key: "config",
                          label: "View config",
                          icon: <GearIcon size={14} style={{ color: "var(--muted)" }} />,
                          onClick: () => setViewingConfig({ id: host.id, name: host.name }),
                          // Opens the host-config modal, which traps focus
                          // itself.
                          opensOverlay: true,
                        },
                        {
                          key: "edit",
                          label: "Edit",
                          icon: <RenameIcon size={14} style={{ color: "var(--muted)" }} />,
                          onClick: () => setEditing(host),
                        },
                        {
                          // Issue #1725 — park / un-park. The label says what
                          // it DOES, not what it looks like: the host keeps
                          // running and keeps its sessions.
                          key: "drain",
                          label: host.drained ? "Unpark host" : "Park host (take no new work)",
                          icon: <MoonIcon size={14} style={{ color: "var(--muted)" }} />,
                          onClick: () => toggleDrain(host),
                        },
                        ...(host.channel?.bound && !host.channel?.ready
                          ? [
                              {
                                key: "unbind",
                                label: "Unbind channel",
                                icon: <CloseIcon size={14} style={{ color: "var(--muted)" }} />,
                                onClick: () => handleUnbind(host),
                              },
                            ]
                          : []),
                        ...(host.hasToken &&
                        !host.hasLiveMachineIdentity &&
                        host.origin !== "enrolled"
                          ? [
                              {
                                key: "rotate",
                                label: "Rotate token",
                                armLabel: "Click again to rotate",
                                icon: <GearIcon size={14} style={{ color: "var(--muted)" }} />,
                                confirm: true,
                                onClick: () => handleRotate(host),
                              },
                            ]
                          : []),
                        {
                          key: "re-pair",
                          label: "Re-pair",
                          icon: <HostsIcon size={14} style={{ color: "var(--muted)" }} />,
                          onClick: () => setPairing({ host }),
                          opensOverlay: true,
                        },
                        ...(host.machineIdentityRevoked === true
                          ? []
                          : [
                              {
                                key: "revoke",
                                label: "Revoke identity",
                                armLabel: "Click again to revoke",
                                icon: <CloseIcon size={14} style={{ color: "var(--muted)" }} />,
                                confirm: true,
                                onClick: () => handleRevoke(host),
                              },
                            ]),
                        {
                          key: "delete",
                          label:
                            host.stale || duplicateHostIds.has(host.id)
                              ? "Remove stale host"
                              : "Delete host",
                          armLabel: "Click again to delete",
                          icon: <CloseIcon size={14} />,
                          danger: true,
                          confirm: true,
                          onClick: () => handleDelete(host),
                        },
                      ]}
                    />
                  </div>
                }
              />
            );
          })}
      </StyledList>

      {ackError && <ErrorText>{ackError}</ErrorText>}
      {approvalError && <ErrorText>{approvalError}</ErrorText>}

      {staleHosts.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <GroupHeading
            title="Remove stale hosts"
            desc="These hosts have been offline for a long time and have no active sessions. Select the hosts you want to remove."
          />
          {staleHosts.map((host) => (
            <label key={host.id} style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              <input
                type="checkbox"
                checked={selectedStaleIds.includes(host.id)}
                disabled={removingStale || !!cascadePrompt}
                onChange={(event) =>
                  setSelectedStaleIds((ids) =>
                    event.target.checked ? [...ids, host.id] : ids.filter((id) => id !== host.id),
                  )
                }
              />
              {host.name}
            </label>
          ))}
          <SecondaryButton
            disabled={
              removingStale ||
              !!cascadePrompt ||
              !staleHosts.some((host) => selectedStaleIds.includes(host.id))
            }
            onClick={() =>
              void removeStaleHosts(staleHosts.filter((host) => selectedStaleIds.includes(host.id)))
            }
          >
            {removingStale ? "Removing…" : "Remove selected hosts"}
          </SecondaryButton>
        </div>
      )}

      {cascadePrompt && (
        <div className="settings-cascade-warning">
          <span>{cascadePrompt.message}</span>
          <div style={{ display: "flex", gap: 8 }}>
            <SecondaryButton onClick={confirmCascadeDelete}>
              Delete host and its projects
            </SecondaryButton>
            <SecondaryButton
              onClick={() => {
                setCascadePrompt(null);
                setRemainingStale([]);
              }}
            >
              Cancel
            </SecondaryButton>
          </div>
        </div>
      )}
      {updateForcePrompt && (
        <div className="settings-cascade-warning" data-testid="update-force-prompt">
          <span>
            {updateForcePrompt.hostName}: {updateForcePrompt.message}
          </span>
          <ul style={{ margin: "4px 0", paddingLeft: 18 }}>
            {updateForcePrompt.tasks.map((t) => (
              <li key={t.id}>
                {t.issueNumber !== null ? `#${t.issueNumber}` : `Task ${t.id}`} · {t.projectName} (
                {t.status})
              </li>
            ))}
          </ul>
          <div style={{ display: "flex", gap: 8 }}>
            <SecondaryButton onClick={() => applyHostUpdate(updateForcePrompt.hostId, true)}>
              Update anyway
            </SecondaryButton>
            <SecondaryButton onClick={() => setUpdateForcePrompt(null)}>Cancel</SecondaryButton>
          </div>
        </div>
      )}
      {drainError && <ErrorText style={{ marginTop: 8 }}>{drainError}</ErrorText>}
      {rotateError && <ErrorText style={{ marginTop: 8 }}>{rotateError}</ErrorText>}
      {deleteError && !cascadePrompt && (
        <ErrorText style={{ marginTop: 8 }}>{deleteError}</ErrorText>
      )}

      {Object.entries(applyError).map(([hostId, message]) => (
        <ErrorText key={hostId} style={{ marginTop: 8 }}>
          {hosts.find((h) => h.id === hostId)?.name ?? hostId}: {message}
        </ErrorText>
      ))}

      <div style={{ marginTop: 10 }}>
        <button className="settings-add-btn" onClick={() => setPairing({})}>
          <PlusIcon size={13} />
          Add host
        </button>
      </div>

      {!hasRemoteHosts(hosts) && (
        <div style={{ fontSize: "0.71875rem", color: "var(--dim)", marginTop: 10 }}>
          No remote hosts yet. Every project runs on this machine until you add one.
        </div>
      )}

      <HostPairings />

      <Presence when={pairing !== null}>
        {pairing && <HostPairingDialog host={pairing.host} onClose={() => setPairing(null)} />}
      </Presence>
      <Presence when={editing !== null}>
        {editing && (
          <CreateHostModal
            initialName={editing.name}
            initialBaseUrl={editing.baseUrl ?? ""}
            hasToken={editing.hasToken}
            canClearBaseUrl={canClearAddress(editing)}
            onClose={() => setEditing(null)}
            onSave={(name, baseUrl, token) =>
              updateHost(editing.id, {
                name,
                // An emptied address on a host with an identity is a clear (#3091).
                ...(baseUrl
                  ? { baseUrl }
                  : editing.baseUrl && canClearAddress(editing)
                    ? { baseUrl: null }
                    : {}),
                ...(token ? { token } : {}),
              })
            }
          />
        )}
      </Presence>
      <Presence when={Boolean(rotated)}>
        {rotated && (
          <AgentInstallInstructions
            kind="rotate"
            token={rotated.token}
            hostName={rotated.name}
            primaryUrl={window.location.origin}
            onClose={() => setRotated(null)}
          />
        )}
      </Presence>
      <Presence when={viewingConfig !== null}>
        {viewingConfig && (
          <HostConfigModal
            hostId={viewingConfig.id}
            hostName={viewingConfig.name}
            onClose={() => setViewingConfig(null)}
          />
        )}
      </Presence>

      <div style={{ marginTop: 16 }}>
        <HostHeartbeatSetting />
        <HostStaleAfterSetting />
      </div>

      <div style={{ marginTop: 28 }}>
        <AutomationTokensSection />
      </div>

      <div style={{ marginTop: 28 }}>
        <BridgesSection />
      </div>
    </>
  );
}
