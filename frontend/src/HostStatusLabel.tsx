import type { Host } from "./api/index.js";
import { legacyChip } from "./hostStatus.js";
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
  // Issue #3476 / #3573 — the deprecation qualifier and the legacy-agent
  // words come from ONE shared function (legacyChip), so this label and the
  // Settings → Hosts row cannot drift apart. One chip, never two: the
  // deprecation label carries the legacy-agent words itself when the host IS
  // a legacy agent (so a host that is both a manual-token host and a legacy
  // agent keeps both facts visible), and it stands alone when the host is
  // not one. The hover gains the sentence that says what is deprecated and
  // what replaces it.
  const chip = legacyChip(host);
  if (!display?.label && !parked && !chip) return null;
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
      {chip && (
        <span className="host-derived-status-legacy" title={chip.title}>
          {chip.text}
        </span>
      )}
      {/* Not painted (a flex container), but keeps "unreachable parked" as
          two words in the text content an accessible name is matched to. */}
      {(display?.label || chip?.text) && parked && " "}
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
