import type { Host } from "./api/index.js";
import { deriveHostStatus, type PingState } from "./hostStatus.js";

// Surfaces that name a host have no "Test connection" button, so there is
// no click to report. deriveHostStatus treats "unknown" as "the user has
// not tested this" and then trusts the heartbeat. Anything else would
// override that heartbeat — do not invent a click.
const IDLE_PING: PingState = { status: "unknown", lastCheckedAtSnapshot: null };

// A host object that has not carried a health value yet (a test double, or
// a row still arriving) must not fall through deriveHostStatus's final
// branch and be called "unreachable". The real Host type always has one of
// these four.
const KNOWN_HEALTH = new Set<Host["health"]>(["pending", "online", "degraded", "offline"]);

/**
 * Issue #1892 — the words Settings → Hosts already shows, next to a host
 * the app was already naming.
 *
 * deriveHostStatus has no "drained" value. Its heartbeat labels are
 * "online", "missed a ping" (degraded), and "unreachable". `host.drained`
 * is a separate flag — Settings calls it "parked" (the host is up, or not,
 * and it is taking no new work). Both words are shown when both are true,
 * so "unreachable" and "parked" are not the same sentence.
 */
export function HostStatusLabel({ host }: { host: Host }) {
  const display = KNOWN_HEALTH.has(host.health) ? deriveHostStatus(host, IDLE_PING) : null;
  const parked = host.drained === true;
  if (!display?.label && !parked) return null;
  return (
    <span className="host-derived-status">
      {display?.label && (
        <span className="host-derived-status-health" style={{ color: display.color }}>
          {display.dot && (
            <span className={`settings-status-dot ${display.dot}`} aria-hidden="true" />
          )}
          {display.label}
        </span>
      )}
      {parked && (
        <span
          className="host-derived-status-parked"
          title="Parked: this host takes no new work. Nothing on it is stopped."
        >
          parked
        </span>
      )}
    </span>
  );
}
