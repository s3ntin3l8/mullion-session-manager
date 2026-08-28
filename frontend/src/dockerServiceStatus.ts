// Issue #73 — presentation table for a discovered Docker Compose service's
// container state (control.docker.state), mirroring sessionStatus.ts's own
// "one presentation table every rendering surface looks up into" pattern —
// small enough today to have just one consumer (Dock.tsx's monitor header
// dot), but kept as its own testable module rather than inlined so that
// stays true if a second surface needs it later.
//
// A label is always shown alongside the dot in Dock.tsx (sessionStatus.ts's
// same accessibility rule) — this table only supplies color, never implies
// color-alone is sufficient on its own.

export interface DockerStatusPresentation {
  label: string;
  /** CSS custom property name (styles.css) driving the dot's background. */
  colorToken: "--g" | "--o" | "--r" | "--dim";
}

// Docker's own fixed container-state vocabulary (`docker ps`'s State
// column) — anything outside this set (a future Docker version, or a
// mocked/fixture value in tests) falls through to the "unknown" default
// below rather than throwing.
const KNOWN_STATES: Record<string, DockerStatusPresentation> = {
  running: { label: "running", colorToken: "--g" },
  restarting: { label: "restarting", colorToken: "--o" },
  created: { label: "created", colorToken: "--dim" },
  paused: { label: "paused", colorToken: "--dim" },
  exited: { label: "exited", colorToken: "--dim" },
  dead: { label: "dead", colorToken: "--r" },
  removing: { label: "removing", colorToken: "--dim" },
};

export function dockerServiceStatus(state: string): DockerStatusPresentation {
  return KNOWN_STATES[state] ?? { label: state, colorToken: "--dim" };
}

// Hermes review (PR #857) — `docker compose start` only succeeds from these
// three states; offering it for `paused` (needs `unpause`, not `start`) or
// `restarting` (already mid-transition) surfaces a button that reliably
// errors.
const STARTABLE_STATES = new Set(["created", "exited", "dead"]);

export function isStartable(state: string): boolean {
  return STARTABLE_STATES.has(state);
}

/**
 * Whether a "Check for update" result should still show as an update
 * available, given the CURRENT image id the control's own latest dock poll
 * reports. Dock.tsx's `updateChecks` map is only ever written (a check
 * result is never proactively invalidated) — deriving this instead of
 * trusting `check.updateAvailable` on its own is what lets the badge clear
 * itself once a later poll shows the new image is already running,
 * whether that happened via this Dock's own "Pull & restart stack" or a
 * restart triggered some other way entirely (a plain terminal, `docker`
 * run by hand, …).
 */
export function isUpdateStillAvailable(
  check: { updateAvailable: boolean; latestImageId?: string } | undefined,
  currentImageId: string | undefined,
): boolean {
  if (!check || check.updateAvailable !== true || check.latestImageId === undefined) return false;
  if (currentImageId === undefined) return false;
  return check.latestImageId !== currentImageId;
}
