// #3234 — agy states a quota reset as a relative duration inside the Stop
// hook's `error` text ("... Resets in 102h16m12s."), not as a date. Pure:
// `base` is the instant the message was produced, injectable for tests.

const RESETS_IN = /\bResets in\s+(?:(\d+)h)?(?:\s*(\d+)m)?(?:\s*(\d+)s)?(?![\w])/i;

/**
 * The instant a "Resets in 102h16m12s" style message says the quota
 * returns, or null. Any of the h/m/s parts may be absent; at least one is
 * required and the total must be positive.
 */
export function parseRelativeResetDuration(
  message: string | null | undefined,
  base: Date = new Date(),
): Date | null {
  if (typeof message !== "string") return null;
  const match = message.match(RESETS_IN);
  if (!match) return null;
  const [, h, m, s] = match;
  if (h === undefined && m === undefined && s === undefined) return null;
  const totalSeconds = Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0);
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return null;
  return new Date(base.getTime() + totalSeconds * 1000);
}
