import type { Host } from "./api.js";

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
    const dot = host.health === "online" ? "on" : host.health === "degraded" ? "warn" : "off";
    const color =
      host.health === "online" ? "var(--g)" : host.health === "degraded" ? "var(--y)" : "var(--r)";
    return { dot, label: host.health, color };
  }
  if (click.status === "unknown") return { dot: undefined, label: null, color: "var(--dim)" };
  return {
    dot: click.status === "online" ? "on" : "off",
    label: click.status,
    color: click.status === "online" ? "var(--g)" : "var(--r)",
  };
}
