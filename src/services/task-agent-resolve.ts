import type { FastifyInstance } from "fastify";
import { KNOWN_AGENTS } from "./agent-detect.js";
import { adapterHasInitialPromptArgs } from "./hook-adapters/index.js";
import { getStoredSettings } from "./settings.js";
import { LOCAL_HOST_ID } from "./host-registry.js";

// Phase 6 Task Master (6.2/#215) — an issue body can override the worker
// agent for its own task with an `Agent: <name>` line, mirroring the
// existing `Manual: true` convention (task-watcher.ts). Matched
// case-insensitively, on its own line, same "whole-line, not substring"
// shape as MANUAL_LINE_RE — a spec that merely *mentions* "Agent: claude"
// in prose shouldn't be silently picked up. `<name>` is captured, not
// validated, here; validation against KNOWN_AGENTS happens in
// resolveAgentCommand so an invalid name falls through cleanly instead of
// this regex needing to encode the allow-list itself.
const AGENT_LINE_RE = /^\s*Agent:\s*(\S+)\s*$/im;
const REVIEW_AGENT_LINE_RE = /^\s*ReviewAgent:\s*(\S+)\s*$/im;

function parseDirectiveLine(body: string | null, re: RegExp): string | null {
  if (body === null) return null;
  const match = re.exec(body);
  return match ? match[1] : null;
}

/**
 * Resolution precedence for the worker agent, most specific wins:
 * 1. The task's own `agent` column (manual per-task override).
 * 2. The issue body's own `Agent: <name>` line.
 * 3. The project's `defaultAgent` column (6.9/#233).
 * 4. The install-wide `settings.taskMaster.defaultAgent` (#741).
 *
 * An unrecognized name at step 1, 2 or 3 is logged and falls through to the
 * next tier rather than failing the claim — a typo in an issue body
 * shouldn't block autonomous pickup any more than a stale project setting
 * should.
 */
export function resolveAgentCommand(
  app: FastifyInstance,
  opts: {
    taskAgent?: string | null;
    issueBody: string | null;
    projectDefaultAgent: string | null;
  },
): string {
  if (opts.taskAgent) {
    if ((KNOWN_AGENTS as readonly string[]).includes(opts.taskAgent)) {
      return opts.taskAgent;
    }
    app.log.warn(
      { name: opts.taskAgent },
      "[task-agent-resolve] task's agent names an unrecognized agent, falling through",
    );
  }

  const fromIssue = parseDirectiveLine(opts.issueBody, AGENT_LINE_RE);
  if (fromIssue !== null) {
    if ((KNOWN_AGENTS as readonly string[]).includes(fromIssue)) return fromIssue;
    app.log.warn(
      { name: fromIssue },
      "[task-agent-resolve] issue body's Agent: line names an unrecognized agent, falling through",
    );
  }

  if (opts.projectDefaultAgent !== null) {
    if ((KNOWN_AGENTS as readonly string[]).includes(opts.projectDefaultAgent)) {
      return opts.projectDefaultAgent;
    }
    app.log.warn(
      { name: opts.projectDefaultAgent },
      "[task-agent-resolve] project's defaultAgent names an unrecognized agent, falling through",
    );
  }

  return getStoredSettings(app.db).taskMaster.defaultAgent;
}

/**
 * Review-agent resolution (6.2/#215) — same shape as the worker-agent
 * precedence above, now with a global-settings fallback tier (#741): the
 * install-wide `settings.taskMaster.defaultReviewAgent` fills in when
 * nothing per task/project/issue configures one. "none"/empty at any tier
 * (including the global one) means "no review agent, human reviews
 * directly" — today's behavior, unchanged; a review agent is still an
 * additive advisory feature, it's just no longer required to be configured
 * per project to engage install-wide. Returns null when nothing configures
 * one or when explicitly set to "none".
 */
export function resolveReviewAgentCommand(
  app: FastifyInstance,
  opts: {
    taskReviewAgent?: string | null;
    issueBody: string | null;
    projectDefaultReviewAgent: string | null;
  },
): string | null {
  if (opts.taskReviewAgent !== undefined && opts.taskReviewAgent !== null) {
    if (opts.taskReviewAgent === "none" || opts.taskReviewAgent === "") {
      return null;
    }
    if ((KNOWN_AGENTS as readonly string[]).includes(opts.taskReviewAgent)) {
      return opts.taskReviewAgent;
    }
    app.log.warn(
      { name: opts.taskReviewAgent },
      "[task-agent-resolve] task's reviewAgent names an unrecognized agent, falling through",
    );
  }

  const fromIssue = parseDirectiveLine(opts.issueBody, REVIEW_AGENT_LINE_RE);
  if (fromIssue !== null) {
    if (fromIssue === "none" || fromIssue === "false") {
      return null;
    }
    if ((KNOWN_AGENTS as readonly string[]).includes(fromIssue)) return fromIssue;
    app.log.warn(
      { name: fromIssue },
      "[task-agent-resolve] issue body's ReviewAgent: line names an unrecognized agent, falling through",
    );
  }

  if (opts.projectDefaultReviewAgent !== null) {
    if ((KNOWN_AGENTS as readonly string[]).includes(opts.projectDefaultReviewAgent)) {
      return opts.projectDefaultReviewAgent;
    }
    app.log.warn(
      { name: opts.projectDefaultReviewAgent },
      "[task-agent-resolve] project's defaultReviewAgent names an unrecognized agent, falling through",
    );
  }

  const globalDefaultReviewAgent = getStoredSettings(app.db).taskMaster.defaultReviewAgent;
  if (globalDefaultReviewAgent && globalDefaultReviewAgent !== "none") {
    if ((KNOWN_AGENTS as readonly string[]).includes(globalDefaultReviewAgent)) {
      return globalDefaultReviewAgent;
    }
    app.log.warn(
      { name: globalDefaultReviewAgent },
      "[task-agent-resolve] install-wide defaultReviewAgent names an unrecognized agent, resolving to no review agent",
    );
  }
  return null;
}

/**
 * Initial-prompt capability check (Hermes/independent review posture carried
 * into 6.2; mechanism updated when the delivery itself moved off
 * `stashSeed`'s SessionStart `additionalContext` — see task-claim.ts's own
 * doc comment for why that mechanism never actually started a turn). A task
 * prompt is delivered as argv via the matched hook adapter's
 * `initialPromptArgs` (Claude Code, Codex, agy, and — as of the promote
 * first-turn fix — opencode too, via `--prompt`, verified to actually
 * submit a turn; see opencode.ts's own comment). No `KNOWN_AGENTS` entry
 * with no adapter at all has this — currently `aider`, `gemini`, `pi` — see
 * each adapter's own `initialPromptArgs`, hook-adapters/index.ts's
 * `adapterHasInitialPromptArgs`). Spawning an autonomous claim with a
 * command that can't receive an initial prompt this way means the agent
 * starts with NO instructions at all — silent for a manual human claim (the
 * human can paste the prompt in), a correctness bug for an unattended one.
 * "Seed" in this function's name and its callers' `seedDelivered`/
 * `reviewSeedDelivered` fields now means "the initial prompt, however
 * delivered" rather than literally `stashSeed` — kept rather than renamed to
 * avoid a schema migration for what's still the same signal (see
 * task-claim.ts's own doc comment).
 */
export function commandSupportsSeed(command: string): boolean {
  return adapterHasInitialPromptArgs(command);
}

/**
 * Hermes review, PR #538 — the final, trustworthy `seedDelivered` value for
 * a claim/retry/review spawn. `seedCapable` alone (this call's own local
 * prediction of whether an initial prompt WOULD be sent) is sufficient for
 * a local-hosted spawn, since the primary and the spawning process are the
 * same build. It is NOT sufficient for a remote-hosted one: an agent build
 * too old to know about `initialPrompt` silently strips it from the spawn
 * body (Fastify's default `removeAdditional` behavior, verified empirically
 * — see routes/internal.ts's POST /internal/sessions doc comment), so the
 * session spawns promptless and idle — the exact bug this delivery
 * mechanism exists to fix — while a naive `seedDelivered: seedCapable`
 * would still claim success. `initialPromptApplied` is that remote agent's
 * own echo of what it actually did; its ABSENCE (`undefined`, not `false`)
 * is the version-skew signal, since an old build's route handler has no
 * idea the field exists and never includes it in its response.
 */
export function resolveSeedDelivered(
  seedCapable: boolean,
  hostId: string,
  initialPromptApplied: boolean | undefined,
): boolean {
  if (!seedCapable) return false;
  if (hostId === LOCAL_HOST_ID) return true;
  return initialPromptApplied === true;
}
