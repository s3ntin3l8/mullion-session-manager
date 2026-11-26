import type {
  PlacementCapability,
  HostRole,
  PlacementMode,
} from "../../../src/shared/constants.js";
import type { HostProtocolStatus } from "../../../src/shared/agent-protocol.js";
import type {
  HostHealthStatus,
  HostRecentIdentityReplacement,
  HostCapacityReport,
  HostChannelStatus,
  DeprecatedHostKind,
} from "../../../src/shared/types.js";
export type {
  HostHealthStatus,
  HostRecentIdentityReplacement,
  HostCapacityReport,
  HostChannelStatus,
  DeprecatedHostKind,
} from "../../../src/shared/types.js";

export interface HostSessionEnv {
  shell: string | null;
  /** `not-applicable`: a Windows host, which never resolves (by design). */
  interactiveResolve: "ok" | "fallback" | "not-applicable";
  reason: string | null;
  /** ms-epoch of the agent's next automatic retry after a transient failure
   * (issue #3524); null or absent (an older agent) when none is scheduled. */
  retryAt?: number | null;
  path: string[];
  recoveredKeys: string[];
}

export interface Host {
  id: string;
  name: string;
  baseUrl: string | null;
  isLocal: boolean;
  hasToken: boolean;
  createdAt: string;
  // "enrolled" = created by an agent registering with the fleet secret;
  // "manual" = added in Settings (including every pre-#245 row).
  origin?: "manual" | "enrolled";
  // Issue #2568 — the agent has a persistent machine identity / an operator
  // revoked it. Never the credential. Absent from an older primary.
  hasMachineIdentity?: boolean;
  // Issue #3091 — that identity is also unrevoked and unexpired, so the agent connects
  // out and the host's address may be cleared. Absent from an older primary.
  hasLiveMachineIdentity?: boolean;
  machineIdentityRevoked?: boolean;
  // Issue #2969 — an address-dialled agent with no machine identity: it cannot
  // open the outbound channel, so it is unreachable off the primary's network.
  // Absent from an older primary.
  legacyAgent?: boolean;
  // Issue #3476 — which legacy path this host is still on: "legacy-agent" (an
  // agent without a machine identity that the primary dials by address) or
  // "manual-token" (an agent that still authenticates with the row's own
  // static token). Null/absent on a host that is on the current path.
  // Absent from an older primary.
  deprecatedKind?: DeprecatedHostKind | null;
  // Issue #2449 — created by redeeming a one-time pairing code. Absent from an
  // older primary.
  paired?: boolean;
  // Issue #2582 — ids of older, offline, session-free enrolled rows this host
  // probably replaced. Absent from an older primary.
  possibleDuplicateOf?: string[];
  // Issue #2641 — browsers left running on this host after the primary gave up
  // closing them. Absent from an older primary.
  leakedBrowsers?: number;
  // Issue #3435 — newest unacknowledged `replaced` identity event within 30
  // days, else null. Absent from an older primary.
  recentIdentityReplacement?: HostRecentIdentityReplacement | null;
  health: HostHealthStatus;
  // Why the host is degraded when the primary knows ("channel saturated"). Absent from an older primary.
  healthReason?: string | null;
  // Offline beyond the configured threshold, with no active session.
  // Absent from an older primary.
  stale?: boolean;
  // Last successful contact, preserved across primary restarts.
  lastSeenAt: string | null;
  // Distinct from lastSeenAt (last successful contact): advances on every
  // sweep result, success or failure. Settings.tsx uses this to tell "a
  // sweep has run since my Test click completed" apart from "the host was
  // last reachable at this time" (Hermes review, PR #524).
  lastCheckedAt: string | null;
  // Issue #1721 / roadmap 8.7 — the host's own reported platform
  // ("darwin" | "linux" | "win32" | …), free-form and informational. Null
  // for a host that never reported one (a manually-added host, or an agent
  // build that predates the field). Not rendered anywhere yet — the Fleet
  // UI is #1726; this is the same deliberate forward-plumbing as
  // lastSeenAt above.
  platform?: string | null;
  // Issue #2240 — the agent CLIs (claude, codex, …) the host has, null while
  // unknown (an old agent, or not read yet), and the Mullion version it runs.
  agents?: string[] | null;
  // Issue #2306 — "xcode" / "android-emulator"; null while unknown (an old agent).
  capabilities?: PlacementCapability[] | null;
  // Issue #3156 — the environment this host gives its sessions. Null = not
  // reported (an older agent); absent from an older primary.
  sessionEnv?: HostSessionEnv | null;
  mullionVersion?: string | null;
  // Issue #2248 — the negotiated agent protocol; null while not read yet.
  protocol?: HostProtocolStatus | null;
  // Issue #2450/#2622 — outbound agent channel state.
  channel?: HostChannelStatus | null;
  // The host's CAPACITY — how busy it is, in numbers comparable across
  // hosts. Null when the host does not report capacity (an agent build
  // without the route) or has not been polled yet. `sampledAt` is when the
  // numbers were measured, so a stale reading can be shown as stale — the
  // UI work is #1726.
  capacity?: HostCapacityReport | null;
  // Issue #1725 / roadmap 8.11 — whether this host is PARKED: it takes no
  // new work (the placement policy stops choosing it), but nothing about
  // it is torn down and it stays usable for manual placement.
  //
  // NOT optional: the column is notNull with a default, so every host
  // carries it. Required here too — `drained?: boolean` would make
  // `undefined` a THIRD state, and every reader (`!host.drained`)
  // would silently read it as "not parked".
  drained: boolean;
  // Issue #2239 — what the host is for. "main" is the primary (`local`
  // only); "burst" hosts stay out of automatic placement. Required for the
  // same reason as `drained`: the column is notNull with a default.
  role: HostRole;
}

// Issue #1726 / roadmap 8.12 — the placement PREVIEW: "where would a new
// session land right now, and why?".
//
// Mirrors src/services/placement.ts's PlacementDecision 1:1 (plus the mode
// the preview was asked about), which is what the server's
// /api/projects/:id/placement-preview and /api/projects/placement-preview
// routes return.
export interface PlacementPreview {
  /** The mode the preview was asked about ("pinned" | "auto"). */
  placement: PlacementMode;
  /** The host a new session would be placed on. */
  hostId: string;
  /** Why — human-readable, for the UI to show verbatim. */
  reason: string;
  /**
   * The eligible hosts and the numbers the policy compared, so a UI can
   * show the comparison rather than just the winner. Empty for a pinned
   * project (nothing is scored).
   */
  considered: {
    hostId: string;
    loadAverage1m: number;
    logicalCores: number;
    loadPerCore: number;
    chosen: boolean;
  }[];
  /** The hosts that were not eligible, each with the first rule it failed. */
  excluded: { hostId: string; reason: string }[];
  /** True when the fallback was used (no eligible host at all). */
  fellBack: boolean;
  /**
   * Issue #2241 — set when the project's platform flag leaves no host: Auto
   * would refuse the launch (409) rather than use `hostId`.
   */
  refusal?: { detail: string; transient: boolean; unreadable?: boolean };
}
