import type { FastifyInstance } from "fastify";
import { KNOWN_AGENTS } from "./agent-detect.js";
import { adapterHasInitialPromptArgs } from "./hook-adapters/index.js";
import { getStoredSettings } from "./settings.js";

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
 * 1. The issue body's own `Agent: <name>` line.
 * 2. The project's `defaultAgent` column (6.9/#233).
 * 3. The install-wide `settings.launchers.defaultAgent`.
 *
 * An unrecognized name at step 1 or 2 is logged and falls through to the
 * next tier rather than failing the claim — a typo in an issue body
 * shouldn't block autonomous pickup any more than a stale project setting
 * should.
 */
export function resolveAgentCommand(
  app: FastifyInstance,
  opts: { issueBody: string | null; projectDefaultAgent: string | null },
): string {
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

  return getStoredSettings(app.db).launchers.defaultAgent;
}

/**
 * Review-agent resolution (6.2/#215) — same shape as the worker-agent
 * precedence above, but with no global-settings fallback tier: a review
 * agent is opt-in per project/task, not a new install-wide default, since
 * it's an additive advisory feature (see the Review agent design decision)
 * rather than a required part of the loop. Returns null when nothing
 * configures one — "no review agent, human reviews directly," today's
 * behavior, unchanged.
 */
export function resolveReviewAgentCommand(
  app: FastifyInstance,
  opts: { issueBody: string | null; projectDefaultReviewAgent: string | null },
): string | null {
  const fromIssue = parseDirectiveLine(opts.issueBody, REVIEW_AGENT_LINE_RE);
  if (fromIssue !== null) {
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

  return null;
}

/**
 * Initial-prompt capability check (Hermes/independent review posture carried
 * into 6.2; mechanism updated when the delivery itself moved off
 * `stashSeed`'s SessionStart `additionalContext` — see task-claim.ts's own
 * doc comment for why that mechanism never actually started a turn). A task
 * prompt is delivered as argv via the matched hook adapter's
 * `initialPromptArgs` (Claude Code, Codex, and agy today; OpenCode has no
 * such argv form, and neither does any `KNOWN_AGENTS` entry with no adapter
 * at all — currently `aider`, `gemini`, `pi` — see each adapter's own
 * `initialPromptArgs`, hook-adapters/index.ts's
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
