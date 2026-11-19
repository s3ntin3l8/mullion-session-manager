import type { Host } from "./api/index.js";
import { legacyAgentLabels, legacyAgentTitle } from "./hostStatus.js";
import { namedHostStatus, PARKED_WORD } from "./lib/hostStatusWords.js";

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
  const { display, parked } = namedHostStatus(host);
  const legacy = host.legacyAgent === true;
  if (!display?.label && !parked && !legacy) return null;
  return (
    <span className="host-derived-status">
      {display?.label && (
        <span
          className="host-derived-status-health"
          style={{ color: display.color }}
          title={display.title}
        >
          {display.dot && (
            <span className={`settings-status-dot ${display.dot}`} aria-hidden="true" />
          )}
          {display.label}
        </span>
      )}
      {legacy && (
        <span className="host-derived-status-legacy" title={legacyAgentTitle(host)}>
          {legacyAgentLabels(host).short}
        </span>
      )}
      {/* Not painted (a flex container), but keeps "unreachable parked" as
          two words in the text content an accessible name is matched to. */}
      {(display?.label || legacy) && parked && " "}
      {parked && (
        <span
          className="host-derived-status-parked"
          title="Parked: this host takes no new work. Nothing on it is stopped."
        >
          {PARKED_WORD}
        </span>
      )}
    </span>
  );
}
