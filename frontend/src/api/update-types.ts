// Self-update shapes, split out of types.ts (re-exported from there).

// Mirrors src/services/update-checker.ts's UpdateCheckResult.
export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  assetUrl: string | null;
  checksumUrl: string | null;
  // Whether POST /api/updates/apply would even work — false on a dev
  // checkout (MULLION_HOME unset), true on a versioned-release install.
  applyAvailable: boolean;
  // Epoch ms of when GitHub was actually last queried for this result —
  // unchanged across a backend cache hit, so it reflects real staleness
  // rather than "when this response happened to arrive" (issue #123).
  checkedAt: number;
}

// Phases self-update.sh writes to $MULLION_HOME/.update-status.json as it
// runs (see src/routes/updates.ts) — "unavailable" is server-side-only
// (MULLION_HOME unset), "idle" means MULLION_HOME is set but no update has
// run yet.
export type UpdatePhase =
  | "unavailable"
  | "idle"
  | "downloading"
  | "installing"
  | "verifying"
  | "restarting"
  | "done"
  | "failed";

export interface UpdateStatus {
  phase: UpdatePhase;
  version?: string;
  updatedAt?: number;
  error?: string;
}
