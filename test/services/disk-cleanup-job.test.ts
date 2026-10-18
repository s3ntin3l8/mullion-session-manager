import { describe, expect, it, vi } from "vitest";
import {
  CLEANUP_IN_PROGRESS,
  createCleanupRunner,
  type CleanupJob,
  type CleanupStepPlan,
} from "../../src/services/disk-cleanup-job.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

const plan = (
  source: CleanupStepPlan["source"],
  run: CleanupStepPlan["run"],
  skip: string | null = null,
): CleanupStepPlan => ({ source, label: source, skip, run });

const finished = (runner: ReturnType<typeof createCleanupRunner>) =>
  vi.waitFor(() => {
    expect(runner.status().state).toBe("done");
    return runner.status() as CleanupJob;
  });

describe("createCleanupRunner", () => {
  it("is idle before any job", () => {
    expect(createCleanupRunner().status()).toEqual({ state: "idle" });
  });

  it("returns a running job at once and runs the steps in order", async () => {
    const order: string[] = [];
    const gate = deferred<{ reclaimedBytes: number }>();
    const runner = createCleanupRunner({ newId: () => "job-1" });
    const job = runner.start("aggressive", [
      plan("docker", async () => {
        order.push("docker");
        return gate.promise;
      }),
      plan("temp", async () => {
        order.push("temp");
        return { reclaimedBytes: 4 };
      }),
    ]);
    expect(job).toMatchObject({ id: "job-1", mode: "aggressive", state: "running" });
    // The first step has already begun by the time the snapshot is taken.
    expect(job.steps.map((s) => s.state)).toEqual(["running", "pending"]);
    expect(order).toEqual(["docker"]);
    gate.resolve({ reclaimedBytes: 10 });
    const done = await finished(runner);
    expect(order).toEqual(["docker", "temp"]);
    expect(done.steps.map((s) => [s.state, s.reclaimedBytes])).toEqual([
      ["done", 10],
      ["done", 4],
    ]);
  });

  it("refuses a second start while running and accepts one afterwards", async () => {
    const gate = deferred<{ reclaimedBytes: number }>();
    const runner = createCleanupRunner();
    runner.start("safe", [plan("docker", () => gate.promise)]);
    expect(() => runner.start("safe", [])).toThrow(CLEANUP_IN_PROGRESS);
    gate.resolve({ reclaimedBytes: 0 });
    await finished(runner);
    expect(() => runner.start("safe", [])).not.toThrow();
  });

  it("skips a step with its reason, without running it", async () => {
    const run = vi.fn(async () => ({ reclaimedBytes: 1 }));
    const runner = createCleanupRunner();
    runner.start("safe", [plan("docker", run, "Docker unavailable")]);
    const done = await finished(runner);
    expect(run).not.toHaveBeenCalled();
    expect(done.steps[0]).toMatchObject({ state: "skipped", note: "Docker unavailable" });
  });

  it("shows a step that chose not to act as skipped, with its reason", async () => {
    const runner = createCleanupRunner();
    runner.start("safe", [
      plan("opencode", async () => ({ reclaimedBytes: 0, skipped: "opencode is running" })),
      plan("temp", async () => ({ reclaimedBytes: 2 })),
    ]);
    const done = await finished(runner);
    expect(done.steps[0]).toMatchObject({
      state: "skipped",
      note: "opencode is running",
      reclaimedBytes: 0,
    });
    expect(done.steps[1]?.state).toBe("done");
  });

  it("records a throwing step and carries on", async () => {
    const runner = createCleanupRunner();
    runner.start("safe", [
      plan("docker", async () => {
        throw new Error("boom");
      }),
      plan("temp", async () => {
        throw "not an error";
      }),
      plan("caches", async () => ({ reclaimedBytes: 3 })),
    ]);
    const done = await finished(runner);
    expect(done.steps.map((s) => s.state)).toEqual(["error", "error", "done"]);
    expect(done.steps[0]?.note).toBe("boom");
    expect(done.steps[1]?.note).toBe("Cleanup failed");
  });

  it("distinguishes a step that stopped early with figures from one that freed nothing", async () => {
    const runner = createCleanupRunner();
    runner.start("safe", [
      plan("docker", async () => ({ reclaimedBytes: 5, error: "stopped" })),
      plan("temp", async () => ({ reclaimedBytes: 0, error: "nothing worked" })),
    ]);
    const done = await finished(runner);
    expect(done.steps[0]).toMatchObject({ state: "done", reclaimedBytes: 5, note: "stopped" });
    expect(done.steps[1]).toMatchObject({ state: "error", note: "nothing worked" });
  });

  it("reports the finish time and tells the observer, even if the observer throws", async () => {
    const onFinished = vi.fn(() => {
      throw new Error("observer bug");
    });
    const runner = createCleanupRunner({
      onFinished,
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    runner.start("safe", [plan("docker", async () => ({ reclaimedBytes: 1 }))]);
    const done = await finished(runner);
    expect(done.finishedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(onFinished).toHaveBeenCalledOnce();
  });

  it("hands out copies, so callers can't change a running job", async () => {
    const runner = createCleanupRunner();
    const job = runner.start("safe", [plan("docker", async () => ({ reclaimedBytes: 1 }))]);
    job.steps[0]!.state = "error";
    const done = await finished(runner);
    expect(done.steps[0]?.state).toBe("done");
  });
});
