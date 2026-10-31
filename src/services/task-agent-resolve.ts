import type { FastifyInstance } from "fastify";
import { KNOWN_AGENTS } from "./agent-detect.js";
import { adapterHasInitialPromptArgs } from "./hook-adapters/index.js";
import { getStoredSettings } from "./settings.js";
import { hermesTaskReviewerUsable } from "./hermes-integration.js";
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

/** True when the task's own `agent` column names a known agent — i.e. the
 * worker is pinned and neither the issue body, the project nor the install
 * default can move it (issue #2491's family-drift guard keys off it).
 *
 * Only the `agent` COLUMN counts: it is written by the PATCH handler and the
 * claim route's enqueue path (both run `resolveTaskModelPatch`, which also
 * pins the agent into the column whenever it stores a worker model) and by
 * `POST /api/tasks`, which is safe only because `createTaskSchema` has no
 * `model`/`smallModel` fields — add them there and this invariant breaks. The
 * issue body's `Agent:` line is re-synced by the watcher and editable by a
 * plain body PATCH without any model revalidation, so it must not count. */
export function workerAgentPinned(taskAgent: string | null): boolean {
  return !!taskAgent && (KNOWN_AGENTS as readonly string[]).includes(taskAgent);
}

/**
 * The issue body's usable `Agent:` / `ReviewAgent:` directives, for display
 * (the task detail dropdowns). Applies the same validity checks the resolvers
 * use, so a value that would fall through there is `null` here: an unknown
 * agent (falls through). `ReviewAgent: none`/`false` is reported as "none", and
 * so is `hermes` while Hermes isn't usable, since the resolver yields no
 * reviewer for it rather than falling through.
 */
export function issueDirectiveAgents(
  app: FastifyInstance,
  issueBody: string | null,
): { issueAgent: string | null; issueReviewAgent: string | null } {
  const agent = parseDirectiveLine(issueBody, AGENT_LINE_RE);
  const review = parseDirectiveLine(issueBody, REVIEW_AGENT_LINE_RE);
  const issueAgent =
    agent !== null && (KNOWN_AGENTS as readonly string[]).includes(agent) ? agent : null;
  let issueReviewAgent: string | null = null;
  if (review === "none" || review === "false") issueReviewAgent = "none";
  else if (review !== null) {
    if ((KNOWN_AGENTS as readonly string[]).includes(review)) issueReviewAgent = review;
    else if (review === HERMES_REVIEW_AGENT) {
      // An unusable hermes does NOT fall through (resolveReviewer): it
      // resolves to no reviewer, so report that, not the project default.
      issueReviewAgent = hermesTaskReviewerUsable(app) ? review : "none";
    }
  }
  return { issueAgent, issueReviewAgent };
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

/** The name that picks Hermes (the external reviewer, #2369) as a review
 * agent, wherever a review agent is named. It is not a CLI, so it is never in
 * `KNOWN_AGENTS` — that list drives CLI detection and host placement. */
export const HERMES_REVIEW_AGENT = "hermes";

/** Who reviews a task: a CLI session Mullion spawns, or Hermes over HTTP. */
export type ResolvedReviewer = { kind: "cli"; command: string } | { kind: "hermes" } | null;

/**
 * The reviewer a recognised name stands for, `null` for Hermes when it cannot
 * be used right now, and `undefined` for a name nobody recognises (the caller
 * falls through to the next tier, as for any unknown name).
 *
 * Hermes is recognised BEFORE the `KNOWN_AGENTS` check on purpose: an unusable
 * `hermes` resolves to no reviewer rather than falling through, where it would
 * quietly pick a different CLI reviewer than the one asked for. The flag and
 * the key can change after a task or project named it, so this is asked at
 * resolve time, not only when the name is written.
 */
function reviewerForName(
  app: FastifyInstance,
  name: string,
  source: string,
): ResolvedReviewer | undefined {
  if (name === HERMES_REVIEW_AGENT) {
    if (hermesTaskReviewerUsable(app)) return { kind: "hermes" };
    app.log.warn(
      { source },
      "[task-agent-resolve] a review agent names hermes but Hermes isn't usable as a Task Master reviewer (setting off, or no API URL or key), resolving to no review agent",
    );
    return null;
  }
  if ((KNOWN_AGENTS as readonly string[]).includes(name)) return { kind: "cli", command: name };
  return undefined;
}

/**
 * Why a write that names `hermes` as a review agent should be refused, or null
 * when it may go ahead (any other name, or Hermes while it is usable). Routes
 * use it to answer 400 at write time; `resolveReviewer` stays the authority
 * since the setting can change afterwards.
 */
export function hermesReviewAgentRefusal(
  app: FastifyInstance,
  name: string | null | undefined,
): string | null {
  if (name !== HERMES_REVIEW_AGENT || hermesTaskReviewerUsable(app)) return null;
  return "Hermes isn't set up as a Task Master reviewer — turn on 'Task Master reviews' and set the API URL and key in Settings → Review relay first";
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
 *
 * Any tier may name `hermes` (#2369): the reviewer is then Hermes when it is
 * usable (`hermesTaskReviewerUsable`) and nothing when it isn't — see
 * `reviewerForName`.
 */
export function resolveReviewer(
  app: FastifyInstance,
  opts: {
    taskReviewAgent?: string | null;
    issueBody: string | null;
    projectDefaultReviewAgent: string | null;
  },
): ResolvedReviewer {
  if (opts.taskReviewAgent !== undefined && opts.taskReviewAgent !== null) {
    if (opts.taskReviewAgent === "none" || opts.taskReviewAgent === "") {
      return null;
    }
    const reviewer = reviewerForName(app, opts.taskReviewAgent, "task");
    if (reviewer !== undefined) return reviewer;
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
    const reviewer = reviewerForName(app, fromIssue, "issue");
    if (reviewer !== undefined) return reviewer;
    app.log.warn(
      { name: fromIssue },
      "[task-agent-resolve] issue body's ReviewAgent: line names an unrecognized agent, falling through",
    );
  }

  if (opts.projectDefaultReviewAgent !== null) {
    const reviewer = reviewerForName(app, opts.projectDefaultReviewAgent, "project");
    if (reviewer !== undefined) return reviewer;
    app.log.warn(
      { name: opts.projectDefaultReviewAgent },
      "[task-agent-resolve] project's defaultReviewAgent names an unrecognized agent, falling through",
    );
  }

  const globalDefaultReviewAgent = getStoredSettings(app.db).taskMaster.defaultReviewAgent;
  if (globalDefaultReviewAgent && globalDefaultReviewAgent !== "none") {
    const reviewer = reviewerForName(app, globalDefaultReviewAgent, "install-wide");
    if (reviewer !== undefined) return reviewer;
    app.log.warn(
      { name: globalDefaultReviewAgent },
      "[task-agent-resolve] install-wide defaultReviewAgent names an unrecognized agent, resolving to no review agent",
    );
  }
  return null;
}

/**
 * The CLI review agent to spawn, or null when there is none — which includes
 * a task whose reviewer is Hermes: Hermes is not launched as a session, so
 * every caller that spawns or places a CLI (the review spawn pass, host
 * placement) correctly sees "no CLI reviewer". Use `resolveReviewer` where
 * Hermes needs to be told apart from "no reviewer".
 */
export function resolveReviewAgentCommand(
  app: FastifyInstance,
  opts: {
    taskReviewAgent?: string | null;
    issueBody: string | null;
    projectDefaultReviewAgent: string | null;
  },
): string | null {
  const reviewer = resolveReviewer(app, opts);
  return reviewer?.kind === "cli" ? reviewer.command : null;
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
 * with no adapter at all has this — currently `gemini`, `pi` — see
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
