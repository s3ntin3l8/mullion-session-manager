// Issue #29 — the per-AGENT quarantine.
//
// A task whose agent's provider is out of quota must not be claimed: it
// would take a concurrency slot it cannot use, and it would fail later
// for a reason the operator could not see.
//
// The quarantine is per AGENT, not per task, and that is the point: a
// provider's quota is a property of the PROVIDER, so every task bound to
// that agent is affected at once. A per-task record would quarantine one
// task and let the next one start into the same exhausted quota.
//
// It is ALSO additive to the existing per-task rate-limit grace
// (services/task-rate-limit-grace.ts), which is untouched: that mechanism
// answers "this turn hit a limit", and this one answers "this provider is
// out of quota". A task already claimed when the provider ran out keeps
// using the per-task grace; only CLAIMING is gated.
//
// Two rules that matter:
//
// - An agent with no mapping is NEVER quarantined. Absence of data must not
//   stop work.
// - A quarantine lifts itself when the quota window resets, so no operator
//   action is needed to recover.
import type { FastifyInstance } from "fastify";
import { getStoredSettings } from "./settings.js";
import {
  fetchRunwayLimits,
  isCardExhausted,
  isCardWindowReset,
  isRunwayConfigured,
  type RunwayLimits,
} from "./runway-client.js";

/** One agent's quarantine, and when it lifts. */
interface AgentQuarantine {
  /** Why it is quarantined, for the UI and the logs. */
  reason: string;
  /** When the provider's window resets — the quarantine lifts then. */
  resetAt: Date | null;
  /** When the quarantine was recorded. */
  since: Date;
  /**
   * When a reading last CONFIRMED this quarantine.
   *
   * Not the same as `since`: `since` is kept across polls so the UI can
   * show how long the agent has been out, while this one moves with every
   * successful reading that still reports the provider as exhausted. It is
   * what makes "the reading can no longer be refreshed" answerable — an
   * entry whose card reported no reset time has no release of its own, so
   * without this it could only ever be released by a reading that says
   * "fine", and a Runway that is down never says that.
   */
  confirmedAt: Date;
}

/**
 * The quarantined agents.
 *
 * Module-level rather than per-app, for the same reason the client's cache
 * is: the quota is a property of the PROVIDER, not of a Mullion app
 * instance.
 */
const quarantined = new Map<string, AgentQuarantine>();

/** When the last poll ran, so the operator's own interval is what paces the
 * refresh rather than the sweep tick. */
let lastPolledAt: number | null = null;

/**
 * How long a quarantine may stand on a reading that cannot be refreshed.
 *
 * Only entries whose card reported NO reset time are affected: an entry
 * with a known reset lifts on its own when the window closes, so it never
 * needs this ceiling. An entry without one has exactly two possible
 * releases — a later reading that says the provider is fine, or this
 * ceiling. Without it, a Runway that is unreachable (or a polling that is
 * switched off) would leave the agent quarantined for good, which is the
 * one outcome this feature must never produce.
 *
 * Half an hour is long enough for a genuinely exhausted provider to be
 * seen, and short enough that a stale reading cannot strand an agent's
 * tasks for the rest of the day.
 */
const MAX_STALE_QUARANTINE_MS = 30 * 60_000;

/** Test hook — forgets every quarantine. */
export function resetRunwayQuarantine(): void {
  quarantined.clear();
  lastPolledAt = null;
}

/**
 * The Mullion agent a Runway provider id maps to, or null when it maps to
 * none.
 */
export function agentForProvider(app: FastifyInstance, providerId: string): string | null {
  const settings = getStoredSettings(app.db);
  const agent = settings.runway?.providerMap?.[providerId];
  return typeof agent === "string" && agent.trim() !== "" ? agent.trim() : null;
}

/**
 * How long a quarantine may stand on a reading that can no longer be
 * refreshed.
 *
 * The ceiling is the LARGER of the fixed half hour and twice the operator's
 * poll interval. The interval matters: with a one-hour poll, a ceiling of
 * half an hour would release a healthy provider's quarantine in the gap
 * between two polls, and the next claim would go straight onto an exhausted
 * provider. Twice the interval means one missed poll is tolerated and two
 * in a row are not.
 */
function staleCeilingMs(app: FastifyInstance): number {
  const pollSeconds = getStoredSettings(app.db).runway?.pollSeconds ?? 0;
  return Math.max(MAX_STALE_QUARANTINE_MS, pollSeconds * 2 * 1000);
}

/**
 * Whether an entry may no longer be trusted, because nothing can refresh
 * the reading it rests on.
 *
 * An entry WITH a reset time is never stale: the reset lifts it on its
 * own, so it stays exactly as long as the window says.
 */
function isStale(app: FastifyInstance, entry: AgentQuarantine, now: number): boolean {
  if (entry.resetAt !== null) return false;
  return now - entry.confirmedAt.getTime() >= staleCeilingMs(app);
}

/**
 * Whether an agent is currently quarantined.
 *
 * `agent` is the RESOLVED agent (the CLI command the task would run —
 * "claude", "codex", "opencode", "agy"), which is what the provider
 * map's values name.
 */
export function isAgentQuarantined(app: FastifyInstance, agent: string): boolean {
  const entry = quarantined.get(agent);
  if (entry === undefined) return false;
  const now = Date.now();
  // A window that has already reset lifts the quarantine without needing a
  // poll — the reset time is known, so waiting for the next poll to notice
  // would only strand the agent for longer than necessary.
  if (entry.resetAt !== null && entry.resetAt.getTime() <= now) {
    quarantined.delete(agent);
    return false;
  }
  // A reading that can no longer be refreshed lifts it too: the quarantine
  // rests on that reading, and a Runway that is unreachable (or a polling
  // that is switched off) will never contradict it. Holding it would
  // strand the agent's tasks for good.
  if (isStale(app, entry, now)) {
    quarantined.delete(agent);
    return false;
  }
  return true;
}

/**
 * The quarantine's details, for the UI.
 */
export function agentQuarantineInfo(
  app: FastifyInstance,
  agent: string,
): { quarantined: boolean; reason: string | null; resetAt: Date | null; since: Date | null } {
  if (!isAgentQuarantined(app, agent)) {
    return { quarantined: false, reason: null, resetAt: null, since: null };
  }
  const entry = quarantined.get(agent)!;
  return {
    quarantined: true,
    reason: entry.reason,
    resetAt: entry.resetAt,
    since: entry.since,
  };
}

/**
 * Applies a quota snapshot: quarantines the agents whose provider is out of
 * quota, and lifts the ones that are not.
 *
 * Lifting is deliberate and immediate — a provider that recovers must not
 * stay quarantined until the next poll, and an agent whose card simply
 * vanished (Runway stopped reporting it) must be released rather than
 * stranded.
 */
export function applyRunwaySnapshot(app: FastifyInstance, limits: RunwayLimits): void {
  const settings = getStoredSettings(app.db);
  const now = new Date();

  // Runway can report SEVERAL cards for one provider (they are per model
  // and per window — `model_id` / `variant` / `window_type` all split them).
  // A provider is out of quota when ANY of its cards is: Mullion cannot use
  // the provider at all, so a sibling card with room left does not help.
  // The agent is therefore quarantined if ANY of its provider's cards is
  // exhausted, and released only when NONE is.
  const exhaustedFor = new Map<string, { reason: string; resetAt: Date | null }>();

  for (const card of limits.cards) {
    const agent = agentForProvider(app, card.providerId);
    if (agent === null) continue;

    const exhausted = isCardExhausted(card) && !isCardWindowReset(card, now);
    if (!exhausted) continue;
    const existing = exhaustedFor.get(agent);
    // Keep the LATEST reset among the exhausted cards: the provider is
    // free again only when the LAST of its exhausted windows resets.
    // Keeping the earliest would lift the quarantine while a later window
    // is still exhausted — and auto-claim would then proceed onto a provider
    // with nothing left.
    //
    // A card with NO reset time means we cannot know when that window lifts,
    // so the quarantine does not lift on its own at all (`resetAt: null`).
    const resetAt =
      existing === undefined
        ? card.resetAt
        : existing.resetAt === null || card.resetAt === null
          ? null
          : new Date(Math.max(existing.resetAt.getTime(), card.resetAt.getTime()));
    exhaustedFor.set(agent, { reason: `${card.providerId} quota exhausted`, resetAt });
  }

  for (const [agent, info] of exhaustedFor) {
    const existing = quarantined.get(agent);
    // Keep the ORIGINAL "since" when the same agent stays quarantined, so
    // the UI shows how long it has been out rather than resetting the clock
    // on every poll.
    //
    // `confirmedAt`, though, MOVES with every reading: this snapshot is a
    // fresh confirmation that the provider is still exhausted, which is
    // what keeps the quarantine off the staleness ceiling while Runway
    // answers.
    quarantined.set(agent, {
      reason: info.reason,
      resetAt: info.resetAt,
      since: existing?.since ?? now,
      confirmedAt: limits.fetchedAt,
    });
  }

  // An agent this snapshot no longer reports as exhausted is released.
  for (const agent of [...quarantined.keys()]) {
    if (!exhaustedFor.has(agent)) quarantined.delete(agent);
  }

  // A provider map that changed under us must not leave a stale quarantine
  // behind for an agent that is no longer mapped.
  const mappedAgents = new Set(Object.values(settings.runway?.providerMap ?? {}));
  for (const agent of [...quarantined.keys()]) {
    if (!mappedAgents.has(agent)) quarantined.delete(agent);
  }
}

/**
 * The sweep's entry point: refresh the quarantine, on the operator's own
 * interval.
 *
 * Two things live here that used to live in the caller:
 *
 * - the POLL INTERVAL. `settings.runway.pollSeconds` is the operator's
 *   cadence, and `0` means "never poll" — so the refresh honours it instead
 *   of fetching on every sweep tick.
 * - the UNCONFIGURED case. An unconfigured integration (no URL, or the key
 *   deleted) RELEASES every quarantine: there is nothing left to refresh
 *   the reading with and nothing that could ever lift it, so holding it
 *   would strand every task on that agent until a restart. A configured but
 *   UNREACHABLE Runway is different — that is a transient outage, and the
 *   previous reading stands.
 */
export async function pollRunwayQuota(
  app: FastifyInstance,
): Promise<{ changed: boolean; quarantinedAgents: string[] }> {
  const settings = getStoredSettings(app.db);
  const pollSeconds = settings.runway?.pollSeconds ?? 0;

  if (!isRunwayConfigured(app)) {
    // Unconfigured: release everything.
    if (quarantined.size > 0) {
      quarantined.clear();
      return { changed: true, quarantinedAgents: [] };
    }
    return { changed: false, quarantinedAgents: [] };
  }

  if (pollSeconds <= 0) {
    // Configured but polling is OFF: keep the current reading, refresh
    // nothing.
    //
    // Nothing can refresh the reading from here on, so the entries that
    // rest on it are pruned: an entry with a KNOWN reset still lifts on its
    // own (the reset time is known, so `isAgentQuarantined` releases it
    // when the window closes), and an entry with NO reset goes on the
    // staleness ceiling — it has no other release, and holding it would
    // strand the agent's tasks indefinitely.
    let released = false;
    for (const agent of [...quarantined.keys()]) {
      // False means the entry was dropped (a passed reset, or staleness).
      if (!isAgentQuarantined(app, agent)) released = true;
    }
    return {
      changed: released,
      quarantinedAgents: [...quarantined.keys()],
    };
  }

  const now = Date.now();
  if (lastPolledAt !== null && now - lastPolledAt < pollSeconds * 1000) {
    return { changed: false, quarantinedAgents: [...quarantined.keys()] };
  }
  lastPolledAt = now;

  const before = new Set(quarantined.keys());

  let limits: RunwayLimits | null;
  try {
    limits = await fetchRunwayLimits(app, { force: true });
  } catch {
    // A Runway problem is NEVER fatal here: the previous reading stands and
    // the caller carries on. A sweep that throws would take the claim path
    // down with it — the exact coupling this feature exists to avoid.
    limits = null;
  }
  if (limits !== null) {
    try {
      applyRunwaySnapshot(app, limits);
    } catch {
      // Same posture: one malformed card must not take the sweep down.
    }
  }
  // Entries the reading could NOT refresh go on the staleness ceiling. With
  // a successful poll this prunes nothing — the snapshot just re-confirmed
  // the entries it still reports as exhausted — but when Runway is
  // unreachable for long enough, the entries it cannot confirm are
  // released rather than held for good.
  for (const agent of [...quarantined.keys()]) {
    isAgentQuarantined(app, agent);
  }
  const after = [...quarantined.keys()];
  const changed = before.size !== after.length || after.some((agent) => !before.has(agent));
  return { changed, quarantinedAgents: after };
}
