// Cleanup can take minutes (the temp tier re-scans /tmp before it deletes
// anything), so it runs as a job the page polls, never inside one HTTP request:
// a reload, a second tab or a proxy timeout can't lose it, and each source's
// progress is visible while it works. One job at a time per server.

export type CleanupMode = "safe" | "aggressive";
export type CleanupSource = "docker" | "temp" | "caches" | "opencode" | "worktrees";

export interface CleanupStepResult {
  reclaimedBytes: number;
  output?: string;
  /** The step freed what it could and stopped early; shown next to the figure. */
  error?: string;
  /** The step chose not to act (e.g. the tool it works on is running), and why. */
  skipped?: string;
}

/** One source's part of a cleanup, as decided by the caller. */
export interface CleanupStepPlan {
  source: CleanupSource;
  label: string;
  /** Why this source won't run (shown in its row); null to run it. */
  skip: string | null;
  run: () => Promise<CleanupStepResult>;
}

export interface CleanupStepState {
  source: CleanupSource;
  label: string;
  state: "pending" | "running" | "done" | "skipped" | "error";
  reclaimedBytes: number;
  /** Why it was skipped, or what went wrong. */
  note?: string;
}

export interface CleanupJob {
  id: string;
  mode: CleanupMode;
  state: "running" | "done";
  startedAt: string;
  finishedAt?: string;
  steps: CleanupStepState[];
}

export type CleanupStatus = CleanupJob | { state: "idle" };

export const CLEANUP_IN_PROGRESS = "CLEANUP_IN_PROGRESS";

export interface CleanupRunnerOptions {
  now?: () => Date;
  newId?: () => string;
  /** Called when the whole job has finished, whether or not every step succeeded. */
  onFinished?: (job: CleanupJob) => void;
}

const clone = (job: CleanupJob): CleanupJob => ({
  ...job,
  steps: job.steps.map((step) => ({ ...step })),
});

export function createCleanupRunner(options: CleanupRunnerOptions = {}) {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => crypto.randomUUID());
  let job: CleanupJob | null = null;

  async function execute(current: CleanupJob, plans: readonly CleanupStepPlan[]) {
    for (const [index, plan] of plans.entries()) {
      const step = current.steps[index] as CleanupStepState;
      if (plan.skip !== null) {
        step.state = "skipped";
        step.note = plan.skip;
        continue;
      }
      step.state = "running";
      try {
        const result = await plan.run();
        if (result.skipped) {
          step.state = "skipped";
          step.note = result.skipped;
          continue;
        }
        step.reclaimedBytes = result.reclaimedBytes;
        // A step that freed something and then hit a problem is still "done":
        // the figure is real, and the note says what stopped it.
        step.state = result.error && result.reclaimedBytes === 0 ? "error" : "done";
        if (result.error) step.note = result.error;
      } catch (error) {
        // One source failing never stops the next: they are independent.
        step.state = "error";
        step.note = error instanceof Error ? error.message : "Cleanup failed";
      }
    }
    current.state = "done";
    current.finishedAt = now().toISOString();
    try {
      options.onFinished?.(clone(current));
    } catch {
      // A failing observer must not leave the job looking unfinished.
    }
  }

  return {
    status(): CleanupStatus {
      return job ? clone(job) : { state: "idle" };
    },
    /** Starts the job and returns at once; poll `status()` for progress. */
    start(mode: CleanupMode, plans: readonly CleanupStepPlan[]): CleanupJob {
      // Check-and-set with no await between them, so two requests can't both pass.
      if (job?.state === "running") throw new Error(CLEANUP_IN_PROGRESS);
      const current: CleanupJob = {
        id: newId(),
        mode,
        state: "running",
        startedAt: now().toISOString(),
        steps: plans.map((plan) => ({
          source: plan.source,
          label: plan.label,
          state: "pending",
          reclaimedBytes: 0,
        })),
      };
      job = current;
      void execute(current, plans);
      return clone(current);
    },
  };
}
