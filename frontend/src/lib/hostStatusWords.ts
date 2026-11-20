import type { Host } from "../api/index.js";
import { deriveHostStatus, type HostStatusDisplay, type PingState } from "../hostStatus.js";

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

/** The word for a drained host — Settings calls it "parked". One literal, so
 * HostStatusLabel and the row's accessible name cannot drift apart. */
export const PARKED_WORD = "parked";

/** What HostStatusLabel shows for a host: the heartbeat's display, and whether it is parked. */
export function namedHostStatus(host: Host): {
  display: HostStatusDisplay | null;
  parked: boolean;
} {
  return {
    display: KNOWN_HEALTH.has(host.health) ? deriveHostStatus(host, IDLE_PING) : null,
    parked: host.drained === true,
  };
}

/**
 * The words HostStatusLabel shows, as one plain string ("unreachable",
 * "unreachable parked"), or null when it shows nothing. For an accessible
 * name that has to say what the label says (SessionRow's aria-label, #3286).
 */
export function hostStatusWords(host: Host): string | null {
  const { display, parked } = namedHostStatus(host);
  const words = [display?.label, parked ? PARKED_WORD : null].filter(Boolean);
  return words.length > 0 ? words.join(" ") : null;
}
