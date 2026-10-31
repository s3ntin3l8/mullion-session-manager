import type { FastifyInstance } from "fastify";
import {
  checkHealth,
  getRun,
  isGone,
  isTerminal,
  postRun,
  resolveHermesConfig,
  stopRun,
} from "./hermes-client.js";
import type { HermesRun, PostRunResult } from "./hermes-client.js";
import { buildRelayTargetLines } from "./hermes-review.js";

/**
 * A Task Master review run on Hermes. Unlike the GitHub relay
 * (`hermes-review.ts`), the reviewer posts nothing: it replies with the
 * findings JSON, and Mullion ingests and posts it through the usual path. The
 * run is addressed by its id alone, so it can be polled or stopped after a
 * Mullion restart.
 */

export interface TaskReviewTarget {
  owner: string;
  repo: string;
  prNumber: number;
  /** The exact commit to review. */
  headSha: string;
  /** The commit the previous round reviewed up to; set on a follow-up round. */
  baseSha?: string;
}

export interface TaskReviewRound {
  taskId: number;
  /** The review round of this task. */
  round: number;
  /** How many times this round was re-armed; keeps a re-armed round's key fresh. */
  rearms: number;
}

/**
 * The dispatch message: where to look, what to read, and the output contract.
 * `prompt` is the Task Master review prompt (`buildReviewPrompt` with
 * `output: "reply"`, `workspace: "clone"`). The Target and commit/range lines
 * are the relay's, but not its "post as your GitHub App" paragraph.
 */
export function buildTaskReviewMessage(target: TaskReviewTarget, prompt: string): string {
  const lines = buildRelayTargetLines("pull_request", target.owner, target.repo, target.prNumber, {
    headSha: target.headSha,
    baseSha: target.baseSha,
    // Each round runs in its own session (taskReviewSessionId).
    freshSession: true,
  });
  return (
    lines +
    "\nOutput contract: reply with ONLY the findings JSON object described below. This review " +
    "is read-only: post nothing to GitHub (no review, no comment, no check run), push nothing " +
    "and change nothing. Mullion reads your reply and posts the review itself.\n\n" +
    prompt
  );
}

/**
 * Distinct from `reviewIdempotencyKey`'s `hermes-review:` prefix, so it can
 * never replay a GitHub-workflow review of the same range.
 */
export function taskReviewIdempotencyKey(target: TaskReviewTarget, r: TaskReviewRound): string {
  return (
    `mullion-task-review:${target.owner.toLowerCase()}/${target.repo.toLowerCase()}#${target.prNumber}` +
    `:t${r.taskId}:r${r.round}:x${r.rearms}@${target.baseSha ?? ""}..${target.headSha}`
  );
}

/** Not the per-PR `hermes-review-...` session of the relay. */
export function taskReviewSessionId(r: Pick<TaskReviewRound, "taskId" | "round">): string {
  return `mullion-task-${r.taskId}-r${r.round}`;
}

export interface TaskReviewDispatch extends PostRunResult {
  idempotencyKey: string;
  sessionId: string;
}

/** Starts a Task Master review run. Needs a Hermes URL and key, not the relay provider. */
export async function dispatchTaskReview(
  app: FastifyInstance,
  r: TaskReviewRound & {
    target: TaskReviewTarget;
    prompt: string;
    model?: string;
    provider?: string;
  },
): Promise<TaskReviewDispatch> {
  const config = resolveHermesConfig(app, { requireProvider: false });
  await checkHealth(config.root);
  const idempotencyKey = taskReviewIdempotencyKey(r.target, r);
  const sessionId = taskReviewSessionId(r);
  const run = await postRun(config, {
    input: buildTaskReviewMessage(r.target, r.prompt),
    sessionId,
    idempotencyKey,
    model: r.model,
    provider: r.provider,
  });
  return { ...run, idempotencyKey, sessionId };
}

export interface TaskReviewPoll extends HermesRun {
  /** Hermes finished the run (it says nothing about whether the reply parses). */
  terminal: boolean;
  /** Hermes no longer knows the run. */
  gone: boolean;
}

/** Reads a Task Master review run by id; `output` is the whole reply. */
export async function pollTaskReview(app: FastifyInstance, runId: string): Promise<TaskReviewPoll> {
  const run = await getRun(resolveHermesConfig(app, { requireProvider: false }), runId);
  return { ...run, terminal: isTerminal(run.status), gone: isGone(run.status) };
}

function parsesAsObject(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

/** The end of the string starting at `start` (a quote), or -1 when unterminated. */
function stringEnd(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === '"') return i;
  }
  return -1;
}

/** The balanced `{...}` starting at `start`, ignoring braces inside strings. */
function balancedObject(text: string, start: number): string | null {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      const end = stringEnd(text, i);
      if (end < 0) return null;
      i = end;
    } else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/**
 * The findings JSON object inside a reviewer's reply, for `parseReviewFindings`
 * (which only takes the bare JSON): the raw reply, else a fenced code block,
 * else the first balanced `{...}` object that parses. Null when there is none.
 */
export function extractFindingsJson(text: string): string | null {
  const raw = text.trim();
  if (raw === "") return null;
  if (parsesAsObject(raw)) return raw;
  for (const match of raw.matchAll(/```[ \t]*(?:json)?[ \t]*\r?\n([\s\S]*?)```/gi)) {
    const body = match[1].trim();
    if (parsesAsObject(body)) return body;
  }
  for (let i = raw.indexOf("{"); i >= 0; i = raw.indexOf("{", i + 1)) {
    const candidate = balancedObject(raw, i);
    if (candidate !== null && parsesAsObject(candidate)) return candidate;
  }
  return null;
}

const UNSENT_RUN_PREFIX = "unsent:";

/**
 * The stand-in run id for a round whose dispatch never got through (Hermes
 * unreachable past the give-up window). It is stored in `reviewRunId` so the
 * round can be ingested as inconclusive and re-armed once; there is no run
 * behind it, so nothing may poll or stop it.
 */
export function unsentRunId(r: TaskReviewRound): string {
  return `${UNSENT_RUN_PREFIX}${r.taskId}:r${r.round}:x${r.rearms}`;
}

export function isUnsentRunId(runId: string): boolean {
  return runId.startsWith(UNSENT_RUN_PREFIX);
}

/**
 * Stops a review run that nothing points at any more, fire-and-forget like
 * `killSession`: the caller has already cleared the task's handle, so a
 * failure here only leaves a Hermes run to finish on its own. Null and
 * synthetic ids are ignored.
 */
export function stopHermesRunQuietly(app: FastifyInstance, runId: string | null | undefined): void {
  if (typeof runId !== "string" || isUnsentRunId(runId)) return;
  void (async () => {
    try {
      await stopRun(resolveHermesConfig(app, { requireProvider: false }), runId);
    } catch (err) {
      app.log.warn({ err, runId }, "task reconcile: failed to stop the Hermes review run");
    }
  })();
}
