import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { ExistingInstructionsMode } from "../shared/constants.js";
import { agentLogLabel, type ScaffoldConflict } from "./scaffold-generate.js";

// Issue #2429 — in-memory registry for background scaffold-generation jobs.
// Like `previews` in `routes/project-setup.ts`, this state is ephemeral and
// lost on a Mullion restart: a restart also kills the spawned agent child, so
// persisting job records to SQLite would buy nothing.

export const PREVIEW_TTL_MS = 15 * 60 * 1000;

export const GENERATE_JOB_PHASES = ["preparing", "agent", "composing", "done", "failed"] as const;
export type GenerateJobPhase = (typeof GENERATE_JOB_PHASES)[number];
export type RunningGenerateJobPhase = "preparing" | "agent" | "composing";

/** AGENTS.md before/after a restructure, in bytes. */
export interface AgentsMdSize {
  before: number;
  after: number;
}

export interface ScaffoldGenerateResponse {
  previewId: string;
  diff: string;
  files: string[];
  // The agent whose turn produced this content (the server resolved it).
  agent: string;
  sandboxed: boolean;
  // Issue #2554 — false when a remote agent ran the turn without the read canary.
  canary?: boolean;
  hasAgentsOverride: boolean;
  possiblyGeneric?: boolean;
  missingCitedPaths?: { missing: number; cited: number };
  conflicts?: ScaffoldConflict[];
  droppedConflictLines?: number;
  possiblyLossy?: boolean;
  /** `restructure` only. */
  agentsMdSize?: AgentsMdSize;
}

export interface GenerateJobError {
  status: number;
  message: string;
}

export interface GenerateJob {
  id: string;
  projectId: number;
  slug: string;
  agent: string;
  mode: ExistingInstructionsMode;
  phase: GenerateJobPhase;
  startedAt: number;
  finishedAt?: number;
  result?: ScaffoldGenerateResponse;
  error?: GenerateJobError;
}

export type GenerateJobOutcome =
  { ok: true; response: ScaffoldGenerateResponse } | { ok: false; status: number; message: string };

export interface GenerateJobRunnerControls {
  setPhase: (phase: RunningGenerateJobPhase) => void;
}

export type GenerateJobLogger = Pick<FastifyBaseLogger, "info"> &
  Partial<Pick<FastifyBaseLogger, "error">>;

const jobsById = new Map<string, GenerateJob>();
const jobIdByProject = new Map<number, string>();

export function isGenerateJobRunning(job: GenerateJob): boolean {
  return job.phase === "preparing" || job.phase === "agent" || job.phase === "composing";
}

/** Fixed label for `mode` in log lines (CodeQL `js/log-injection` requires
 * literal branches rather than passing a caller-derived string or regex-stripped
 * copy into the logger). */
export function modeLogLabel(mode: string): ExistingInstructionsMode {
  switch (mode) {
    case "report":
      return "report";
    case "restructure":
      return "restructure";
    default:
      return "keep";
  }
}

function logJobFinished(
  log: GenerateJobLogger | undefined,
  job: GenerateJob,
  finishedAt: number,
  outcome: GenerateJobOutcome,
): void {
  if (!log) return;
  const mode = modeLogLabel(job.mode);
  const agent = agentLogLabel(job.agent);
  const sandboxed = outcome.ok ? Boolean(outcome.response.sandboxed) : false;
  const durationMs = Math.max(0, finishedAt - job.startedAt);
  const outcomeLabel = outcome.ok ? "done" : "failed";
  log.info(
    {
      mode,
      agent,
      sandboxed,
      durationMs,
      outcome: outcomeLabel,
    },
    "[scaffold-generate] generation job finished",
  );
}

function removeJob(job: GenerateJob): void {
  jobsById.delete(job.id);
  if (jobIdByProject.get(job.projectId) === job.id) {
    jobIdByProject.delete(job.projectId);
  }
}

/** Sweeps finished jobs whose `finishedAt` is older than `PREVIEW_TTL_MS`.
 * Running jobs do not have `finishedAt` and are bounded by the agent turn's
 * timeout instead. */
export function sweepExpiredGenerateJobs(now = Date.now()): void {
  for (const job of jobsById.values()) {
    if (job.finishedAt !== undefined && now - job.finishedAt > PREVIEW_TTL_MS) {
      removeJob(job);
    }
  }
}

/** Removes any finished job pointing at `previewId` (when the preview expires,
 * is invalidated by a fresh worktree reset, or is consumed by `/setup/apply`)
 * so a job result never outlives the preview record it points at. */
export function deleteGenerateJobByPreviewId(previewId: string): void {
  for (const job of jobsById.values()) {
    if (job.result?.previewId === previewId) {
      removeJob(job);
    }
  }
}

export function getGenerateJob(jobId: string, now = Date.now()): GenerateJob | null {
  sweepExpiredGenerateJobs(now);
  return jobsById.get(jobId) ?? null;
}

export function getActiveGenerateJob(projectId: number, now = Date.now()): GenerateJob | null {
  sweepExpiredGenerateJobs(now);
  const jobId = jobIdByProject.get(projectId);
  if (!jobId) return null;
  const job = jobsById.get(jobId);
  if (!job) {
    jobIdByProject.delete(projectId);
    return null;
  }
  return job;
}

export function getInFlightGenerateJob(projectId: number, now = Date.now()): GenerateJob | null {
  const job = getActiveGenerateJob(projectId, now);
  return job && isGenerateJobRunning(job) ? job : null;
}

export function clearGenerateJobsForTests(): void {
  jobsById.clear();
  jobIdByProject.clear();
}

async function runGenerateJob(
  job: GenerateJob,
  run: (controls: GenerateJobRunnerControls) => Promise<GenerateJobOutcome>,
  log: GenerateJobLogger | undefined,
  now: () => number,
): Promise<void> {
  const controls: GenerateJobRunnerControls = {
    setPhase(phase) {
      if (isGenerateJobRunning(job)) {
        job.phase = phase;
      }
    },
  };
  // Yield a microtask so callers inspecting the job immediately after start
  // observe the initial `preparing` phase before `run` transitions to `agent`.
  await Promise.resolve();
  let outcome: GenerateJobOutcome;
  try {
    outcome = await run(controls);
  } catch (err) {
    outcome = {
      ok: false,
      status: 500,
      message: err instanceof Error ? err.message : String(err),
    };
  }
  const finishedAt = now();
  job.finishedAt = finishedAt;
  if (outcome.ok) {
    job.phase = "done";
    job.result = outcome.response;
  } else {
    job.phase = "failed";
    job.error = { status: outcome.status, message: outcome.message };
  }
  logJobFinished(log, job, finishedAt, outcome);
}

/** Starts a background generate job for `projectId`, or attaches to the
 * existing in-flight job if one is already running for that project. Replacing
 * a previously finished (`done` / `failed`) job for `projectId` drops the old
 * finished job from the registry. */
export function startGenerateJob(opts: {
  projectId: number;
  slug: string;
  agent: string;
  mode: ExistingInstructionsMode;
  run: (controls: GenerateJobRunnerControls) => Promise<GenerateJobOutcome>;
  log?: GenerateJobLogger;
  now?: () => number;
}): { job: GenerateJob; attached: boolean } {
  const now = opts.now ?? Date.now;
  sweepExpiredGenerateJobs(now());

  const existing = getActiveGenerateJob(opts.projectId, now());
  if (existing && isGenerateJobRunning(existing)) {
    return { job: existing, attached: true };
  }
  if (existing) {
    removeJob(existing);
  }

  const job: GenerateJob = {
    id: randomUUID(),
    projectId: opts.projectId,
    slug: opts.slug,
    agent: opts.agent,
    mode: opts.mode,
    phase: "preparing",
    startedAt: now(),
  };
  jobsById.set(job.id, job);
  jobIdByProject.set(opts.projectId, job.id);

  void runGenerateJob(job, opts.run, opts.log, now).catch((err) => {
    opts.log?.error?.({ err }, "[scaffold-generate] generation job runner crashed");
  });
  return { job, attached: false };
}
