import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  GENERATED_PREVIEW_TTL_MS,
  PREVIEW_TTL_MS,
  isPreviewExpired,
  startGenerateJob,
  cancelGenerateJob,
  getGenerateJob,
  getActiveGenerateJob,
  getInFlightGenerateJob,
  sweepExpiredGenerateJobs,
  deleteGenerateJobByPreviewId,
  clearGenerateJobsForTests,
  isGenerateJobRunning,
  modeLogLabel,
  type GenerateJobOutcome,
  type GenerateJobRunnerControls,
  type ScaffoldGenerateResponse,
} from "../../src/services/scaffold-generate-jobs.js";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function sampleResponse(previewId = "preview-1"): ScaffoldGenerateResponse {
  return {
    previewId,
    diff: "diff --git a/AGENTS.md b/AGENTS.md",
    files: ["AGENTS.md", "CLAUDE.md"],
    agent: "claude",
    sandboxed: true,
    hasAgentsOverride: false,
  };
}

describe("scaffold-generate-jobs registry", () => {
  beforeEach(() => {
    clearGenerateJobsForTests();
  });

  it("tracks lifecycle phases from preparing -> agent -> composing -> done", async () => {
    const agentGate = createDeferred<void>();
    const composeGate = createDeferred<void>();
    let capturedControls: GenerateJobRunnerControls | undefined;
    let currentNow = 1000;

    const { job, attached } = startGenerateJob({
      projectId: 1,
      slug: "demo",
      agent: "claude",
      mode: "keep",
      now: () => currentNow,
      run: async (controls) => {
        capturedControls = controls;
        controls.setPhase("agent");
        await agentGate.promise;
        controls.setPhase("composing");
        await composeGate.promise;
        return { ok: true, response: sampleResponse("p-done") };
      },
    });

    expect(attached).toBe(false);
    expect(job.phase).toBe("preparing");
    expect(job.startedAt).toBe(1000);
    expect(job.finishedAt).toBeUndefined();
    expect(isGenerateJobRunning(job)).toBe(true);
    expect(getGenerateJob(job.id, currentNow)?.phase).toBe("preparing");
    expect(getActiveGenerateJob(1, currentNow)?.id).toBe(job.id);
    expect(getInFlightGenerateJob(1, currentNow)?.id).toBe(job.id);

    // Let the microtask run so `run` enters the `agent` phase.
    await Promise.resolve();
    expect(job.phase).toBe("agent");

    agentGate.resolve();
    await Promise.resolve();
    expect(job.phase).toBe("composing");

    currentNow = 4500;
    composeGate.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(job.phase).toBe("done");
    expect(job.finishedAt).toBe(4500);
    expect(job.result).toEqual(sampleResponse("p-done"));
    expect(job.error).toBeUndefined();
    expect(isGenerateJobRunning(job)).toBe(false);
    expect(getInFlightGenerateJob(1, currentNow)).toBeNull();
    expect(getActiveGenerateJob(1, currentNow)?.phase).toBe("done");

    // Calling setPhase after completion is a no-op.
    capturedControls?.setPhase("agent");
    expect(job.phase).toBe("done");
  });

  it("enforces one in-flight job per project (second start attaches) and replaces a finished job", async () => {
    const gate = createDeferred<GenerateJobOutcome>();
    const runFirst = vi.fn(() => gate.promise);
    const runSecond = vi.fn(async (): Promise<GenerateJobOutcome> => ({
      ok: true,
      response: sampleResponse("p-second"),
    }));

    const first = startGenerateJob({
      projectId: 10,
      slug: "demo",
      agent: "claude",
      mode: "keep",
      run: runFirst,
    });
    expect(first.attached).toBe(false);

    const second = startGenerateJob({
      projectId: 10,
      slug: "demo",
      agent: "claude",
      mode: "report",
      run: runSecond,
    });
    expect(second.attached).toBe(true);
    expect(second.job.id).toBe(first.job.id);
    expect(runSecond).not.toHaveBeenCalled();

    // Another project can still start its own independent job concurrently.
    const otherProject = startGenerateJob({
      projectId: 20,
      slug: "other",
      agent: "codex",
      mode: "keep",
      run: async () => ({ ok: true, response: sampleResponse("p-other") }),
    });
    expect(otherProject.attached).toBe(false);
    expect(otherProject.job.id).not.toBe(first.job.id);

    gate.resolve({ ok: true, response: sampleResponse("p-first") });
    await Promise.resolve();
    await Promise.resolve();
    expect(first.job.phase).toBe("done");

    // Once the first job has finished, starting again creates a new job and drops the old one.
    const third = startGenerateJob({
      projectId: 10,
      slug: "demo",
      agent: "claude",
      mode: "restructure",
      run: runSecond,
    });
    expect(third.attached).toBe(false);
    expect(third.job.id).not.toBe(first.job.id);
    expect(getGenerateJob(first.job.id)).toBeNull();
    expect(getActiveGenerateJob(10)?.id).toBe(third.job.id);
  });

  it("records a failed job with the route's HTTP status and message (and 500 on unexpected throw)", async () => {
    let now = 2000;
    const { job } = startGenerateJob({
      projectId: 1,
      slug: "demo",
      agent: "claude",
      mode: "keep",
      now: () => now,
      run: async () => {
        now = 2500;
        return {
          ok: false,
          status: 502,
          message: '"claude" generation turn failed: exit code 1',
        };
      },
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(job.phase).toBe("failed");
    expect(job.finishedAt).toBe(2500);
    expect(job.error).toEqual({
      status: 502,
      message: '"claude" generation turn failed: exit code 1',
    });
    expect(job.result).toBeUndefined();

    // Unexpected rejection maps to status 500.
    const thrown = startGenerateJob({
      projectId: 2,
      slug: "demo",
      agent: "codex",
      mode: "report",
      now: () => now,
      run: async () => {
        throw new Error("unexpected boom");
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(thrown.job.phase).toBe("failed");
    expect(thrown.job.error).toEqual({ status: 500, message: "unexpected boom" });
  });

  it("expires finished jobs after GENERATED_PREVIEW_TTL_MS and deletes jobs when their previewId is evicted", async () => {
    let now = 10_000;
    const { job } = startGenerateJob({
      projectId: 1,
      slug: "demo",
      agent: "claude",
      mode: "keep",
      now: () => now,
      run: async () => {
        now = 12_000;
        return { ok: true, response: sampleResponse("p-ttl") };
      },
    });

    // Running job does not expire even if time advances past PREVIEW_TTL_MS before it finishes.
    sweepExpiredGenerateJobs(10_000 + PREVIEW_TTL_MS + 5000);
    expect(getGenerateJob(job.id, 10_000 + PREVIEW_TTL_MS + 5000)).not.toBeNull();

    await Promise.resolve();
    await Promise.resolve();
    expect(job.phase).toBe("done");
    expect(job.finishedAt).toBe(12_000);

    // A finished agent result outlives the template preview TTL.
    expect(getGenerateJob(job.id, 12_000 + PREVIEW_TTL_MS + 1)).not.toBeNull();

    // Still live at finishedAt + GENERATED_PREVIEW_TTL_MS (and well past the template TTL).
    expect(getGenerateJob(job.id, 12_000 + GENERATED_PREVIEW_TTL_MS)).not.toBeNull();
    expect(getActiveGenerateJob(1, 12_000 + GENERATED_PREVIEW_TTL_MS)).not.toBeNull();

    // Expired 1 ms past GENERATED_PREVIEW_TTL_MS.
    expect(getGenerateJob(job.id, 12_000 + GENERATED_PREVIEW_TTL_MS + 1)).toBeNull();
    expect(getActiveGenerateJob(1, 12_000 + GENERATED_PREVIEW_TTL_MS + 1)).toBeNull();

    // A job whose previewId is explicitly deleted (apply or preview eviction) is removed immediately.
    const second = startGenerateJob({
      projectId: 2,
      slug: "demo2",
      agent: "claude",
      mode: "keep",
      now: () => now,
      run: async () => ({ ok: true, response: sampleResponse("p-evict") }),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(getActiveGenerateJob(2, now)?.id).toBe(second.job.id);
    deleteGenerateJobByPreviewId("p-evict");
    expect(getGenerateJob(second.job.id, now)).toBeNull();
    expect(getActiveGenerateJob(2, now)).toBeNull();
  });

  it("logs one structured line with fixed labels when a job ends", async () => {
    const info = vi.fn();
    let now = 5000;

    startGenerateJob({
      projectId: 1,
      slug: "demo",
      agent: "codex",
      mode: "restructure",
      log: { info } as never,
      now: () => now,
      run: async () => {
        now = 6234;
        return { ok: true, response: { ...sampleResponse("p-log"), sandboxed: false } };
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      {
        mode: "restructure",
        agent: "codex",
        sandboxed: false,
        durationMs: 1234,
        outcome: "done",
      },
      "[scaffold-generate] generation job finished",
    );

    expect(modeLogLabel("keep")).toBe("keep");
    expect(modeLogLabel("report")).toBe("report");
    expect(modeLogLabel("restructure")).toBe("restructure");
    expect(modeLogLabel("evil\ninjected")).toBe("keep");

    // If the logger's `info` throws after the runner's `try/catch`, the terminal
    // `.catch()` handler logs the crash via `log.error` instead of letting an
    // unhandled rejection escape.
    const error = vi.fn();
    startGenerateJob({
      projectId: 9,
      slug: "demo",
      agent: "claude",
      mode: "keep",
      log: {
        info: () => {
          throw new Error("logger sink broke");
        },
        error,
      },
      now: () => now,
      run: async () => ({ ok: true, response: sampleResponse("p-log-err") }),
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[1]).toBe("[scaffold-generate] generation job runner crashed");
  });

  it("cancelGenerateJob aborts the runner's signal and keeps the job cancelled, not failed", async () => {
    let controls: GenerateJobRunnerControls | undefined;
    const { job } = startGenerateJob({
      projectId: 7,
      slug: "demo",
      agent: "claude",
      mode: "keep",
      run: (c) => {
        controls = c;
        return new Promise((_res, rej) =>
          c.signal.addEventListener("abort", () => rej(new Error("aborted"))),
        );
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(cancelGenerateJob(job.id, 8)).toBeNull();
    expect(cancelGenerateJob(job.id, 7)?.phase).toBe("cancelled");
    expect(controls?.signal.aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(getGenerateJob(job.id)).toMatchObject({ phase: "cancelled" });
    expect(getGenerateJob(job.id)?.error).toBeUndefined();
    expect(getInFlightGenerateJob(7)).toBeNull();
    expect(cancelGenerateJob(job.id, 7)).toBeNull();
  });

  it("keeps a failed job only PREVIEW_TTL_MS: it holds no result worth keeping", async () => {
    let now = 10_000;
    const { job } = startGenerateJob({
      projectId: 3,
      slug: "demo3",
      agent: "claude",
      mode: "keep",
      now: () => now,
      run: async () => {
        now = 11_000;
        return { ok: false, status: 502, message: "boom" };
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(job.phase).toBe("failed");
    expect(getGenerateJob(job.id, 11_000 + PREVIEW_TTL_MS)).not.toBeNull();
    expect(getGenerateJob(job.id, 11_000 + PREVIEW_TTL_MS + 1)).toBeNull();
  });
});

describe("isPreviewExpired", () => {
  it("expires a template preview after 15 minutes and a generated one after 24 hours", () => {
    const createdAt = 1_000;
    expect(isPreviewExpired({ createdAt, generated: false }, createdAt + PREVIEW_TTL_MS)).toBe(
      false,
    );
    expect(isPreviewExpired({ createdAt, generated: false }, createdAt + PREVIEW_TTL_MS + 1)).toBe(
      true,
    );
    expect(isPreviewExpired({ createdAt, generated: true }, createdAt + PREVIEW_TTL_MS + 1)).toBe(
      false,
    );
    expect(
      isPreviewExpired({ createdAt, generated: true }, createdAt + GENERATED_PREVIEW_TTL_MS + 1),
    ).toBe(true);
  });
});
