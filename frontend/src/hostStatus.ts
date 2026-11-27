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
 * Issue #3573 — the two wordings for a flagged agent, in one place: the short
 * chip beside a host name ("outdated agent") and the Settings row's longer
 * one, which adds the suffix that says what to do ("— upgrade").
 *
 * The suffix is applied by legacyChip, so the Settings row gets its longer
 * wording FROM the shared function instead of building a second copy of it.
 *
 * The longer wording only reaches a host with NO deprecation kind: the server
 * gives every host it flags `legacyAgent` a kind too (a legacy agent either
 * has a static token of its own — "manual-token" — or none, which leaves it
 * "legacy-agent"), so such a host reads the qualified chip on every surface.
 * See LegacyChipOptions.long.
 */
const LEGACY_AGENT_LABEL = {
  upgrade: { short: "outdated agent", suffix: "upgrade" },
  register: { short: "not registered", suffix: "set primary URL" },
} as const;

/** The longer wording: the chip, capitalized, plus the suffix that says what to do. */
function legacyAgentLongText(short: string, suffix: string): string {
  return `${short.charAt(0).toUpperCase()}${short.slice(1)} — ${suffix}`;
}

/**
 * The words shown for a flagged agent, from the same decision as the hover so
 * the two cannot disagree. `short` is the chip beside a host name; `long` is
 * the Settings row's label — and, like legacyChip's `long` option, it only
 * reaches a host with no deprecation kind (one the API cannot return).
 */
export function legacyAgentLabels(host: Host): { short: string; long: string } {
  const { short, suffix } = LEGACY_AGENT_LABEL[legacyAgentFix(host)];
  return { short, long: legacyAgentLongText(short, suffix) };
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

/**
 * Issue #3476 — the word that marks a host as being on a legacy path. One
 * literal, so the chip text, the hover title and the accessible name cannot
 * drift apart.
 */
export const DEPRECATED_WORD = "deprecated";

/**
 * Issue #3476 — the chip text for a host that is still on a legacy path, or
 * null when it is on the current one.
 *
 * The chip keeps BOTH facts when a host has both:
 *
 * - a legacy agent reads as the EXISTING chip plus the qualifier ("outdated
 *   agent (deprecated)"), so the chip still says what is wrong with the agent
 *   itself;
 * - a manual-token host gets a chip of its own ("manual token (deprecated)") —
 *   the static token is what has to change, and saying "outdated agent" there
 *   would point at the wrong fix;
 * - a manual-token host the primary also dials by address is BOTH (it has no
 *   machine identity AND its own static token), so the chip carries the agent
 *   words AND the kind: nothing that was visible before the deprecation
 *   qualifier disappears.
 */
export function deprecatedKindLabel(host: Host): string | null {
  switch (host.deprecatedKind) {
    case "legacy-agent":
      return host.legacyAgent === true
        ? `${legacyAgentLabels(host).short} (${DEPRECATED_WORD})`
        : `legacy agent (${DEPRECATED_WORD})`;
    case "manual-token":
      return host.legacyAgent === true
        ? `${legacyAgentLabels(host).short} · manual token (${DEPRECATED_WORD})`
        : `manual token (${DEPRECATED_WORD})`;
    default:
      return null;
  }
}

/**
 * Issue #3476 — the hover text for a host that is still on a legacy path, or
 * null when it is on the current one.
 *
 * It says what is deprecated and what REPLACES it, and every path it names
 * exists today:
 *
 * - a legacy agent is fixed agent-side — upgrade it and point it at the
 *   primary (MULLION_PRIMARY_URL) so it registers with a machine identity —
 *   or replaced by a host paired from a one-time pairing code;
 * - a manual-token host is fixed by pairing: a one-time pairing code BOUND to
 *   that host replaces the static token with a machine identity. An unbound
 *   code (the _Generate pairing link_ button) creates a NEW host row and
 *   leaves the deprecated row behind, so the hover names the bound one.
 *
 * The row menu's _Re-pair_ entry is deliberately NOT named here: it only
 * appears once a host holds a machine identity (or had one revoked), and a
 * host that is still fully on a legacy path has no such entry — the Settings
 * row is where the pairing code is minted.
 */
export function deprecatedKindTitle(host: Host): string | null {
  switch (host.deprecatedKind) {
    case "legacy-agent":
      return (
        "Deprecated: this agent has no machine identity, so the primary has to reach it at " +
        "the address it stored — which only works from the primary's own network. Upgrade it " +
        "to v0.3.59 or later and set MULLION_PRIMARY_URL so it registers with a machine " +
        "identity, or replace the host with one paired from a one-time pairing code " +
        "(Settings → Hosts)."
      );
    case "manual-token":
      return (
        "Deprecated: this host's agent still authenticates with the row's own static token " +
        "(MULLION_AGENT_TOKEN), which never expires. Mint a one-time pairing code BOUND to " +
        'this host (POST /api/host-pairings with {"hostId": "<id>"}) and redeem it on the ' +
        "agent, so the agent holds a machine identity instead of that token. An unbound code " +
        "creates a NEW host row and leaves this one deprecated."
      );
    default:
      return null;
  }
}

/**
 * Issue #3573 — the chip a host on a legacy path gets, and the hover that
 * goes with it: the text and the title, in one place.
 */
export interface LegacyChip {
  /** The chip's visible text. */
  text: string;
  /** The chip's hover text. */
  title: string;
}

export interface LegacyChipOptions {
  /**
   * The primary's own version. Only Settings has the host list that carries
   * it, so the sidebar, pane-tab and session-row hovers omit "this server
   * runs vX" (same reason legacyAgentTitle takes it as an argument).
   */
  primaryVersion?: string | null;
  /**
   * The Settings row's longer wording ("Outdated agent — upgrade"). The
   * suffix is applied HERE, by the shared function, so the row is not a
   * second copy of the label logic.
   *
   * It only reaches a host with NO `deprecatedKind`. The server derives the
   * two flags from the same row, and a host it flags `legacyAgent` always
   * carries a kind as well: a legacy agent either has a static token of its
   * own ("manual-token") or none, which leaves it "legacy-agent". So
   * `GET /api/hosts` cannot produce a legacy agent without a kind, and every
   * real host takes the deprecation branch below and reads the qualified chip
   * on EVERY surface — the Settings row included. The option is kept for the
   * shape a caller can build but the API cannot return, so no caller expects
   * a suffix that never appears.
   */
  long?: boolean;
}

/**
 * Issue #3573 — the chip for a host that is on a legacy path, or null when it
 * is on the current one.
 *
 * ONE producer for every surface that shows the chip. The Settings → Hosts
 * row used to build its own from the legacy-agent words, so a host on a
 * deprecated path read "Outdated agent — upgrade" there — no "(deprecated)",
 * no mention of the static token — while the places that name a host read
 * the qualified chip. The row now gets its chip from here, like every other
 * surface, and the two cannot drift apart again.
 *
 * The deprecation qualifier wins when the host has one: the kind is what has
 * to change (a static token), and the hover says what replaces it. Such a
 * host reads the SAME chip on every surface — the qualifier IS the chip, so
 * no surface adds the legacy suffix to it (the hover still says what to do).
 * A host that is on no legacy path at all gets no chip.
 */
export function legacyChip(host: Host, options: LegacyChipOptions = {}): LegacyChip | null {
  const deprecatedLabel = deprecatedKindLabel(host);
  const deprecatedNote = deprecatedKindTitle(host);
  if (deprecatedLabel) {
    // A host that is BOTH a legacy agent and a manual-token host keeps the
    // agent words AND the kind in the chip; the hover adds the agent's own
    // explanation next to the deprecation note.
    const legacyNote =
      host.legacyAgent === true ? legacyAgentTitle(host, options.primaryVersion) : null;
    return {
      text: deprecatedLabel,
      title: [legacyNote, deprecatedNote].filter(Boolean).join(" "),
    };
  }
  if (host.legacyAgent !== true) return null;
  const labels = legacyAgentLabels(host);
  // The Settings row keeps its longer wording ("Outdated agent — upgrade"):
  // the suffix is added HERE, by the shared function, out of the same words
  // the short chip is built from — so the row is not a second copy of the
  // label logic. Only a host with NO deprecation kind reaches this branch
  // (see LegacyChipOptions.long): the API flags every legacy agent with a
  // kind, so a real host reads the qualified chip above.
  const { suffix } = LEGACY_AGENT_LABEL[legacyAgentFix(host)];
  return {
    text: options.long ? legacyAgentLongText(labels.short, suffix) : labels.short,
    title: legacyAgentTitle(host, options.primaryVersion),
  };
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
  if (host.machineIdentityRevoked === true) {
    return {
      dot: "off",
      label: "Identity revoked",
      color: "var(--dim)",
      title: "The agent can no longer connect. Re-pair this host to let it connect again.",
    };
  }
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
