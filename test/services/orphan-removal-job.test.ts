import { describe, expect, it } from "vitest";
import { createOrphanRemovalJob } from "../../src/services/orphan-removal-job.js";
import type { RemoveOrphanResult } from "../../src/services/dev-worktrees.js";

describe("orphan removal job", () => {
  it("keeps one job running and retains its result for later readers", async () => {
    const runner = createOrphanRemovalJob();
    let finish!: (result: RemoveOrphanResult) => void;
    const result = new Promise<RemoveOrphanResult>((resolve) => {
      finish = resolve;
    });
    const job = runner.start(1, "/project/.wt/a", () => result);
    expect(job).toMatchObject({ state: "running", projectId: 1, path: "/project/.wt/a" });
    expect(
      runner.start(1, "/project/.wt/b", async () => ({ removed: true, reclaimedBytes: 1 })),
    ).toBeNull();
    finish({ removed: true, reclaimedBytes: 42 });
    await viWaitForDone(runner);
    expect(runner.status()).toMatchObject({
      state: "done",
      result: { removed: true, reclaimedBytes: 42 },
    });
  });
  it("reports unexpected failures as unavailable", async () => {
    const runner = createOrphanRemovalJob();
    runner.start(1, "/project/.wt/a", async () => {
      throw new Error("failed");
    });
    await viWaitForDone(runner);
    expect(runner.status()).toMatchObject({
      state: "done",
      result: { removed: false, reason: "unavailable" },
    });
  });
});
async function viWaitForDone(runner: ReturnType<typeof createOrphanRemovalJob>) {
  for (let i = 0; i < 5 && runner.status().state === "running"; i++) await Promise.resolve();
  expect(runner.status().state).toBe("done");
}
