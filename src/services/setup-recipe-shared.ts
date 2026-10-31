// Issue #2245 — constants and types shared by setup-recipe.ts and
// remote-host-client.ts (kept apart so the two do not import each other).

/** Cap on the recipe text (a shell command line, not a script). */
export const SETUP_RECIPE_MAX_LENGTH = 4096;
/** Default budget for one recipe run. */
export const DEFAULT_SETUP_TIMEOUT_MS = 15 * 60 * 1000;
/** How much of a log `readSetupLog` returns (the tail — failures are at the end). */
export const SETUP_LOG_TAIL_BYTES = 256 * 1024;

export type SetupStatus = "running" | "ok" | "failed" | "timeout";

/**
 * What a run reports. A typed envelope returned with HTTP 200 (like
 * `/internal/run-generation-turn`): `busy` means a run was already in flight in
 * that directory and nothing was started.
 */
export interface SetupRunResult {
  outcome: "ok" | "failed" | "timeout" | "busy";
  exitCode: number | null;
  /** Absolute path of the log on the machine that ran the recipe. */
  logPath: string;
  detail?: string;
}
