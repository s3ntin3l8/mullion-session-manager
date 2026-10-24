// Types for codex-rollout.mjs, which stays plain ESM (the forwarder is
// spawned by codex as a hook command and cannot import TypeScript). Declared
// here so the TypeScript side — src/services/codex-rate-limit.ts — and the
// plain-ESM side — src/hooks/forwarder-core.mjs — can share the one reader
// instead of each keeping a copy of codex's error taxonomy.
export const DEFAULT_TAIL_BYTES: number;

export interface CodexRateLimitSignalOptions {
  /** How many bytes of the rollout's tail to read. */
  tailBytes?: number;
}

export class CodexRateLimitSignal {
  constructor(init: {
    turnId: string | null;
    rateLimited: boolean;
    status: number | null;
    variant: string | null;
    message: string | null;
  });
  /** The turn the signal belongs to, so a caller can report it once. */
  turnId: string | null;
  /** True only for a quota-shaped provider refusal. */
  rateLimited: boolean;
  /** The provider's HTTP status, when codex recorded one. */
  status: number | null;
  /** The `codex_error_info` variant name, for diagnostics. */
  variant: string | null;
  /** codex's own human-readable error message. */
  message: string | null;
}

export function readCodexRateLimitSignal(
  rolloutPath: string,
  options?: CodexRateLimitSignalOptions,
): CodexRateLimitSignal | null;

export function parseCodexRateLimitSignal(tailText: string): CodexRateLimitSignal | null;
