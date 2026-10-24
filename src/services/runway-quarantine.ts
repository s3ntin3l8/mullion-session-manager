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
}

/**
 * The quarantined agents.
 *
 * Module-level rather than per-app, for the same reason the client's cache
 * is: the quota is a property of the PROVIDER, not of a Mullion app
 * instance.
 */
const quarantined = new Map<string, AgentQuarantine>();

/** Test hook — forgets every quarantine. */
export function resetRunwayQuarantine(): void {
  quarantined.clear();
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
 * Whether an agent is currently quarantined.
 *
 * `agent` is the RESOLVED agent (the CLI command the task would run —
 * "claude", "codex", "opencode", "agy"), which is what the provider
 * map's values name.
 */
export function isAgentQuarantined(app: FastifyInstance, agent: string): boolean {
  const entry = quarantined.get(agent);
  if (entry === undefined) return false;
  // A window that has already reset lifts the quarantine without needing a
  // poll — the reset time is known, so waiting for the next poll to notice
  // would only strand the agent for longer than necessary.
  if (entry.resetAt !== null && entry.resetAt.getTime() <= Date.now()) {
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
    // Keep the EARLIEST reset among the exhausted cards: the provider is
    // free again only when the last of its exhausted windows resets.
    const resetAt =
      existing?.resetAt === null || existing?.resetAt === undefined
        ? card.resetAt
        : existing.resetAt === null
          ? null
          : card.resetAt === null
            ? null
            : new Date(Math.min(existing.resetAt.getTime(), card.resetAt.getTime()));
    exhaustedFor.set(agent, { reason: `${card.providerId} quota exhausted`, resetAt });
  }

  for (const [agent, info] of exhaustedFor) {
    const existing = quarantined.get(agent);
    // Keep the ORIGINAL "since" when the same agent stays quarantined, so
    // the UI shows how long it has been out rather than resetting the clock
    // on every poll.
    quarantined.set(agent, {
      reason: info.reason,
      resetAt: info.resetAt,
      since: existing?.since ?? now,
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
 * Refreshes the quarantine from Runway and returns whether anything
 * changed — the caller uses that to log.
 */
export async function refreshRunwayQuarantine(
  app: FastifyInstance,
): Promise<{ changed: boolean; quarantinedAgents: string[] }> {
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
  const after = [...quarantined.keys()];
  const changed = before.size !== after.length || after.some((agent) => !before.has(agent));
  return { changed, quarantinedAgents: after };
}
