import type {
  PlacementCapability,
  HostRole,
  PlacementMode,
} from "../../../src/shared/constants.js";
import type { HostProtocolStatus } from "../../../src/shared/agent-protocol.js";

// #246) — health/lastSeenAt are never persisted, just the primary's
// in-memory view of "is it actually up right now" as of the last sweep.
// Never carries a token, just whether one is set (hasToken), same
// "no secrets over the API" rule AppSettings/ServerInfo above already follow.
export type HostHealthStatus = "pending" | "online" | "degraded" | "offline";

export interface HostChannelStatus {
  ready: boolean;
  bound: boolean;
  status: "connected" | "bound to the outbound channel, not connected" | "not connected";
  connectedAt: string | null;
  carriedOperations: string[];
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
  machineIdentityRevoked?: boolean;
  // Issue #2449 — created by redeeming a one-time pairing code. Absent from an
  // older primary.
  paired?: boolean;
  // Issue #2582 — ids of older, offline, session-free enrolled rows this host
  // probably replaced. Absent from an older primary.
  possibleDuplicateOf?: string[];
  // Issue #2641 — browsers left running on this host after the primary gave up
  // closing them. Absent from an older primary.
  leakedBrowsers?: number;
  health: HostHealthStatus;
  // Not currently rendered anywhere — kept for a future "last seen Nm ago"
  // affordance (would make a "degraded" host more actionable than a bare
  // color). Deliberate forward-plumbing, not dead code: it's the one field
  // in this merge the backend computes but the UI doesn't consume yet.
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
  capacity?: HostCapacity | null;
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

// Mirrors src/services/host-capacity.ts's HostCapacity 1:1 — issue #1721,
// roadmap 8.7.
export interface HostCapacity {
  platform: string;
  logicalCores: number;
  loadAverage1m: number;
  memory: { totalBytes: number; freeBytes: number };
  sessions: { tracked: number; alive: number };
  /** When the numbers were measured, ISO-8601. */
  sampledAt: string;
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
