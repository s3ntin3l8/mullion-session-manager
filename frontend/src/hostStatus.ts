import { CHANNEL_SATURATED_REASON } from "../../src/shared/constants.js";
import type { Host } from "./api/index.js";

// Per-row connection-test state (Settings -> Hosts' "Test connection"
// button) — deliberately not part of the store's `hosts` state: it's
// ephemeral UI feedback from POST /api/hosts/:id/ping, not data about the
// host itself, same reasoning as LaunchersSection's local `copied` flag.
// lastCheckedAtSnapshot (Hermes review, PR #524, 2nd pass) is the host's
// server-issued lastCheckedAt captured when the click began — compared for
// *equality* against the current host.lastCheckedAt in deriveHostStatus,
// never against a client Date.now(). An earlier version compared the
// click's own browser-clock completion time against the server's
// lastCheckedAt, which silently breaks under clock skew between the
// user's machine and the primary (Hermes review, PR #524, 1st pass fix).
// Comparing two server-issued opaque tokens for equality has no clock to
// skew. Lives in its own module (not inline in Settings.tsx) so it can be
// unit-tested without pulling in the whole Settings component graph —
// Hermes review, PR #524, 2nd pass: this precedence logic had no direct
// test coverage.
export interface PingState {
  status: "unknown" | "checking" | "online" | "offline";
  lastCheckedAtSnapshot: string | null;
}

export interface HostStatusDisplay {
  dot: "on" | "off" | "warn" | undefined;
  label: string | null;
  color: string;
  /** Hover text that explains the label, when the label alone does not. */
  title?: string;
}

// The server sends a short reason code with a degraded host (host-heartbeat.ts's
// CHANNEL_SATURATED_REASON); this is what it means to the person reading it.
const HEALTH_REASON_TITLES: Record<string, string> = {
  [CHANNEL_SATURATED_REASON]:
    "The host's connection is up and answering, but every request slot has been busy for several checks in a row (large transfers or previews in flight). It is not marked unreachable.",
};

// The first release whose agent registers with a machine identity and opens the
// outbound channel (#2568, #2628).
const CHANNEL_MIN_VERSION = [0, 3, 59] as const;

function supportsChannel(version: string | null | undefined): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(version ?? "");
  if (!match) return false;
  const parts = match.slice(1, 4).map(Number);
  for (let i = 0; i < 3; i++) {
    if (parts[i]! !== CHANNEL_MIN_VERSION[i]) return parts[i]! > CHANNEL_MIN_VERSION[i]!;
  }
  // Exactly the floor: a pre-release of it (0.3.59-rc.1) predates the release.
  return match[4] === "";
}

/**
 * Issue #2969 — which of the two fixes a flagged agent needs. An agent that
 * predates the channel needs upgrading; one that already supports it and is
 * flagged anyway has never registered (no `MULLION_PRIMARY_URL`, or its state
 * was lost), and upgrading would change nothing.
 */
export function legacyAgentFix(host: Host): "upgrade" | "register" {
  return supportsChannel(host.mullionVersion) ? "register" : "upgrade";
}

/**
 * The words shown for a flagged agent, from the same decision as the hover so
 * the two cannot disagree. `short` is the chip beside a host name; `long` is
 * the Settings row's label.
 */
export function legacyAgentLabels(host: Host): { short: string; long: string } {
  return legacyAgentFix(host) === "register"
    ? { short: "not registered", long: "Agent not registered — set MULLION_PRIMARY_URL" }
    : { short: "outdated agent", long: "Outdated agent — upgrade" };
}

/**
 * Issue #2969 — why an agent without a machine identity goes dark off the
 * primary's network, and what fixes it. `primaryVersion` is optional: only
 * Settings has the host list that carries the primary's own version, so the
 * sidebar, pane-tab and session-row hovers omit "this server runs vX".
 */
export function legacyAgentTitle(host: Host, primaryVersion?: string | null): string {
  const reported = host.mullionVersion
    ? `This agent reports v${host.mullionVersion}`
    : "This agent's version is unknown";
  const primary = primaryVersion ? `; this server runs v${primaryVersion}` : "";
  const why =
    `${reported}${primary}. It has no machine identity, so it cannot open the outbound ` +
    `channel and the primary has to reach ${host.baseUrl ?? "its address"} directly. That ` +
    "fails whenever the host is off the primary's network. ";
  return legacyAgentFix(host) === "register"
    ? why +
        "This version supports the channel, so the agent has not registered: set " +
        "MULLION_PRIMARY_URL in its .env to an address it can reach from anywhere and restart it."
    : why +
        "Upgrade the agent to a release with the outbound channel (v0.3.59 or later) and it " +
        "connects out from anywhere.";
}

// Issue #246 — the primary's background heartbeat sweep (host.health) is
// the preferred source of truth once it has swept a host at least once;
// the click-driven "Test" button (click) is the fallback for a host the
// poller hasn't reported on yet (health === "pending" — right after boot,
// HOST_HEARTBEAT_INTERVAL_SECONDS=0, or a #245 enrollment-created row with
// no baseUrl yet), always wins outright while a click is in flight, and
// stays authoritative after completing until a *newer* sweep has landed
// (host.lastCheckedAt no longer equals the snapshot taken when the click
// began) — otherwise a user testing a host the poller currently reports
// stale-offline-for would see their fresh result discarded immediately
// (Hermes review, PR #524).
//
// Known tradeoff (Hermes review, PR #524, 3rd pass): if a real sweep lands
// *while* the click is still in flight, host.lastCheckedAt has already
// moved past the snapshot by the time the click resolves — so the click's
// own (newer) result is immediately treated as stale and the (older)
// sweep's verdict wins instead, with no UI indication that happened.
// Self-corrects on the next sweep; not fixed here since doing so would
// need a queue/version-vector for a narrow race window.
export function deriveHostStatus(host: Host, click: PingState): HostStatusDisplay {
  if (click.status === "checking") {
    return { dot: undefined, label: "testing…", color: "var(--dim)" };
  }
  const clickIsFresh =
    click.status !== "unknown" && host.lastCheckedAt === click.lastCheckedAtSnapshot;

  if (host.health !== "pending" && !clickIsFresh) {
    // Issue #1727 / roadmap 8.13 — the wording, and the unreachable dot.
    //
    // The backend CANNOT tell a sleeping host from an unreachable one (it
    // only knows that the host did not answer), so the UI must not say
    // "offline" — which reads as "something broke". "Unreachable" says what
    // is actually knowable, and the hollow dim dot says "not there right
    // now" rather than "failed". A fleet of laptops should not look like a
    // fleet of broken machines.
    if (host.health === "online") return { dot: "on", label: "online", color: "var(--g)" };
    if (host.health === "degraded") {
      // A degraded host whose channel answered but is full says why (#2702).
      const label = host.healthReason ? host.healthReason : "missed a ping";
      const title = host.healthReason ? HEALTH_REASON_TITLES[host.healthReason] : undefined;
      return { dot: "warn", label, color: "var(--y)", ...(title ? { title } : {}) };
    }
    // The "off" dot IS the hollow dim ring (.settings-status-dot.off) —
    // the same shape an idle dot uses, so no new dot value is needed.
    return {
      dot: "off",
      label: "unreachable",
      color: "var(--dim)",
      // An outdated agent is the one cause of "unreachable" the primary can name.
      ...(host.legacyAgent ? { title: `Unreachable. ${legacyAgentTitle(host)}` } : {}),
    };
  }
  if (click.status === "unknown") return { dot: undefined, label: null, color: "var(--dim)" };
  return {
    dot: click.status === "online" ? "on" : "off",
    label: click.status,
    color: click.status === "online" ? "var(--g)" : "var(--r)",
  };
}
