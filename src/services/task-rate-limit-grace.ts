/**
 * Decides whether to grace a task that landed in `errorState === "api_error"`
 * (the value `stop_failure` sets) after a rate-limit-class error — skip this
 * reconciler tick rather than fail. Returns `true` ONLY when every condition
 * holds; on `false`, the caller falls through to its normal fail path.
 *
 * Conditions, all required: `errorState === "api_error"`, `graceMinutes > 0`,
 * `hasCommitsPastBase === false` (if the task made progress, don't delay —
 * let the normal path succeed), `errorAt !== null`, `errorDetail` exactly
 * `"rate_limit"` (the short classification label `stop_failure` sets via the
 * wire-level `errorType` field, populated onto `SessionInfo.errorDetail` in
 * `hook-handlers.ts`; `null` means no classification, free-text detail carries
 * no signal — fail fast rather than grace an unknown error that could be a
 * permanent failure like auth), and the window itself
 * (`Date.now() - errorAt < graceMinutes * 60_000`).
 */
export function isRateLimitGraceActive(
  info: {
    errorState: string | null;
    errorAt: number | null;
    errorDetail: string | null;
  },
  opts: {
    graceMinutes: number;
    hasCommitsPastBase: boolean;
  },
): boolean {
  if (info.errorState !== "api_error") return false;
  if (opts.graceMinutes <= 0) return false;
  if (opts.hasCommitsPastBase) return false;
  if (info.errorAt === null) return false;
  if (info.errorDetail !== "rate_limit") return false;

  const graceMs = opts.graceMinutes * 60_000;
  return Date.now() - info.errorAt < graceMs;
}
