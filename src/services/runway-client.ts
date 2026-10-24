// Issue #29 — a client for Runway's quota API.
//
// Runway is a SEPARATE service (an "AI usage tracker") that already knows
// each provider's remaining quota. Mullion polls it and uses the answer to
// decide whether an agent may be claimed at all.
//
// THE CONTRACT, verified against the installed Runway
// (runway-ai-usage-tracker):
//
//   GET {apiUrl}/api/v1/usage/limits
//   X-Admin-Key: <the admin key>
//
// The path is `/api` (main.py) + `/v1` (routes.py) + `/usage` (routes.py)
// + `/limits` (endpoints/usage.py). The response is
// `{ "limits": [LimitCard, ...] }` — `LimitsResponse.model_dump(exclude_none=False)`,
// so absent fields come back as explicit nulls.
//
// THE FIELDS THAT MATTER, and the ones that do NOT:
//
// - `remaining` is a DISPLAY STRING ("—", "12", "45%") — not a number, and
//   not reliably parseable. It is never used for a decision.
// - `reset` is likewise a display string. `reset_at` is the machine-readable
//   one: an ISO 8601 timestamp.
// - `health` ("good" / "warning" / "critical" / "unknown" / "untried") and
//   `pace` are display states, not quota facts.
// - The decision inputs are the NUMERIC ones: `pct_used`, `used_value`,
//   `limit_value`, `is_unlimited`, plus `stale` and `reset_at`.
//
// THE FAILURE POSTURE, which is the most important thing here: a Runway
// outage, a timeout, a malformed body, an auth failure — NONE of them may
// mean "quota exhausted". Every one of them means "no quota information",
// and the caller must treat that as "carry on". A quarantine that cannot
// be lifted because the service that would lift it is down would strand
// every task on that agent forever.
import type { FastifyInstance } from "fastify";
import { getStoredSettings } from "./settings.js";
import { getRunwayKey } from "./runway-integration.js";

/** The request timeout. A quota poll must never hold anything up. */
const REQUEST_TIMEOUT_MS = 8_000;

/** The default poll interval, when the settings carry no `runway` group. */
const DEFAULT_POLL_SECONDS = 60;

/** One provider's quota, reduced to the fields a decision can use. */
export interface RunwayLimitCard {
  /** Runway's provider id ("anthropic", "opencode", …) — the map key. */
  providerId: string;
  /** "session" / "daily" / "weekly" / "monthly" / "rolling" / "unknown". */
  windowType: string;
  /** Percentage of the quota used, when Runway knows it. */
  pctUsed: number | null;
  /** The used amount, in the card's own unit. */
  usedValue: number | null;
  /** The quota, in the card's own unit. */
  limitValue: number | null;
  /** A plan with no quota (unlimited) is never exhausted. */
  isUnlimited: boolean;
  /** When the window resets — an ISO 8601 timestamp. */
  resetAt: Date | null;
  /** The card's data is older than Runway's staleness ceiling. */
  stale: boolean;
  /** Runway's own error classification for the card, if any. */
  errorType: string | null;
}

/** One poll's result. */
export interface RunwayLimits {
  fetchedAt: Date;
  cards: RunwayLimitCard[];
}

/**
 * A cached snapshot plus the moment it expires AND the apiUrl it came from.
 *
 * Module-level rather than per-app: the quota is a property of the
 * PROVIDER, not of a Mullion app instance, and a test that creates several
 * apps must not see another's cached answer.
 *
 * The apiUrl is part of the key because the snapshot is the SERVER's answer:
 * pointing Mullion at a different Runway must not keep serving the old
 * server's answer until the TTL runs out.
 */
let cached: { snapshot: RunwayLimits; expiresAt: number; apiUrl: string } | null = null;

/** Test hook — drops the cached snapshot. */
export function resetRunwayCache(): void {
  cached = null;
}

/**
 * Whether the integration is CONFIGURED — a URL and a key.
 *
 * Distinct from "the last fetch succeeded": a configured-but-unreachable
 * Runway must leave the previous reading standing, while an UNCONFIGURED
 * one must release it (the operator turned the feature off, or deleted the
 * key; keeping a quarantine with no way to refresh or lift it would strand
 * every task on that agent).
 */
export function isRunwayConfigured(app: FastifyInstance): boolean {
  const settings = getStoredSettings(app.db);
  if ((settings.runway?.apiUrl ?? "").trim() === "") return false;
  try {
    // A rotated app key makes the decrypt throw; that is "not configured"
    // as far as the caller is concerned, not a crash.
    return getRunwayKey(app) !== null;
  } catch {
    return false;
  }
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isoDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Reduces one raw card from Runway to the fields Mullion can decide on.
 *
 * Returns null for a card with no provider id: without one there is
 * nothing to map it to, and an unmapped card must never quarantine
 * anything.
 */
export function toRunwayLimitCard(raw: unknown): RunwayLimitCard | null {
  if (!raw || typeof raw !== "object") return null;
  const card = raw as Record<string, unknown>;
  const providerId = typeof card.provider_id === "string" ? card.provider_id.trim() : "";
  if (providerId === "") return null;
  return {
    providerId,
    windowType: typeof card.window_type === "string" ? card.window_type : "unknown",
    pctUsed: num(card.pct_used),
    usedValue: num(card.used_value),
    limitValue: num(card.limit_value),
    isUnlimited: card.is_unlimited === true,
    resetAt: isoDate(card.reset_at),
    stale: card.stale === true,
    errorType: typeof card.error_type === "string" ? card.error_type : null,
  };
}

/**
 * Fetches the quota snapshot from Runway.
 *
 * Returns null whenever the answer is not trustworthy — the feature is off,
 * no key is configured, the request failed, timed out, or the body is not
 * the expected shape. `null` means "no quota information", NEVER "quota
 * exhausted".
 */
export async function fetchRunwayLimits(
  app: FastifyInstance,
  opts: { force?: boolean } = {},
): Promise<RunwayLimits | null> {
  const settings = getStoredSettings(app.db);
  // Defensive about the group: `runway` was added to the settings shape
  // late, and a settings blob (or a partial one) from before that must not
  // crash the caller — an absent group reads as "not configured".
  const apiUrl = (settings.runway?.apiUrl ?? "").trim();
  if (apiUrl === "") return null;

  const now = Date.now();
  if (!opts.force && cached !== null && cached.expiresAt > now && cached.apiUrl === apiUrl) {
    return cached.snapshot;
  }

  let body: unknown;
  try {
    // The key read (and its decrypt) is INSIDE the try: a rotated app key
    // makes `getRunwayKey` throw a DecryptionError, and that must degrade to
    // "no quota information" like every other failure — not escape and 500
    // the caller's request.
    const key = getRunwayKey(app);
    if (key === null) return null;
    const response = await fetch(`${apiUrl.replace(/\/+$/, "")}/api/v1/usage/limits`, {
      method: "GET",
      headers: { "X-Admin-Key": key, accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    body = await response.json();
  } catch {
    // A Runway outage is NOT "quota exhausted" — it is "no information".
    return null;
  }

  const rawCards = (body as { limits?: unknown } | null)?.limits;
  if (!Array.isArray(rawCards)) return null;

  const cards: RunwayLimitCard[] = [];
  for (const raw of rawCards) {
    const card = toRunwayLimitCard(raw);
    if (card !== null) cards.push(card);
  }

  const snapshot: RunwayLimits = { fetchedAt: new Date(), cards };
  const ttl = Math.max(1, settings.runway?.pollSeconds ?? DEFAULT_POLL_SECONDS) * 1000;
  cached = { snapshot, expiresAt: now + ttl, apiUrl };
  return snapshot;
}

/**
 * Whether one card says its provider is out of quota.
 *
 * Only the NUMERIC fields decide this, and a STALE card never does: Runway
 * sets `stale` when its collection is failing, and the card's data is then
 * real but old. Quarantining on stale data would stop work for a provider
 * that may well have quota again.
 */
export function isCardExhausted(card: RunwayLimitCard): boolean {
  if (card.stale) return false;
  if (card.isUnlimited) return false;
  if (card.pctUsed !== null) return card.pctUsed >= 100;
  if (card.limitValue !== null && card.limitValue > 0 && card.usedValue !== null) {
    return card.usedValue >= card.limitValue;
  }
  // No usable numbers: the card cannot say anything, so it says nothing.
  return false;
}

/**
 * Whether the card's window has already reset, which lifts a quarantine.
 *
 * A card with no `reset_at` never lifts on its own — it is refreshed by
 * the next poll instead.
 */
export function isCardWindowReset(card: RunwayLimitCard, now: Date = new Date()): boolean {
  return card.resetAt !== null && card.resetAt.getTime() <= now.getTime();
}
