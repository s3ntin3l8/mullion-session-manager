import type { BrowserTarget } from "./browser-manager.js";

// Issue #2639 — the browser target the primary resolved for a session running
// on THIS agent host. An agent has no database to resolve one with, so the
// primary sends it with the spawn and it is kept here, in memory, for as long
// as the session lives. Like the session's GitHub credential it is not
// persisted: a session reattached after an agent restart has no target until
// the primary launches it again, and its browser is refused rather than guessed.
const targets = new Map<string, BrowserTarget>();

/** Records (or, for a spawn that carries none, clears) the target of session
 * `id`, and drops entries of sessions that no longer exist so the map cannot
 * grow for the lifetime of the agent. */
export function rememberSessionBrowserTarget(
  pty: { get(id: string): unknown },
  id: string,
  target: BrowserTarget | undefined,
): void {
  for (const known of targets.keys()) {
    if (known !== id && pty.get(known) === undefined) targets.delete(known);
  }
  if (target) targets.set(id, target);
  else targets.delete(id);
}

/** The target the primary sent for session `id`, or null when it sent none. */
export function sessionBrowserTarget(id: string): BrowserTarget | null {
  return targets.get(id) ?? null;
}
