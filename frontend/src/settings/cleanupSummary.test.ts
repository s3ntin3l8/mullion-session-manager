import { describe, expect, it } from "vitest";
import type { CleanupJob, CleanupStepState } from "../api/index.js";
import { summarizeCleanup } from "./cleanupSummary.js";

const GIB = 1024 ** 3;
const step = (
  source: CleanupStepState["source"],
  over: Partial<CleanupStepState> = {},
): CleanupStepState => ({ source, label: source, state: "done", reclaimedBytes: 0, ...over });
const job = (...steps: CleanupStepState[]): CleanupJob => ({
  id: "j",
  mode: "safe",
  state: "done",
  startedAt: "",
  steps,
});

describe("summarizeCleanup", () => {
  it("names only the total when one source took part", () => {
    expect(summarizeCleanup(job(step("docker", { reclaimedBytes: GIB })))).toBe("Freed 1.0 GiB.");
  });

  it("breaks the total down per source when several took part", () => {
    expect(
      summarizeCleanup(
        job(
          step("docker", { reclaimedBytes: GIB }),
          step("temp", { reclaimedBytes: GIB / 2 }),
          step("caches", { reclaimedBytes: 2 }),
          step("opencode", { reclaimedBytes: 3 }),
        ),
      ),
    ).toBe(
      "Freed 1.5 GiB (Docker 1.0 GiB, temp files 512 MiB, caches 2 B, opencode database 3 B).",
    );
  });

  it("says what stopped a cleanup that still freed something", () => {
    expect(summarizeCleanup(job(step("temp", { reclaimedBytes: 2, note: "boom" })))).toBe(
      "Freed 2 B, then stopped: boom",
    );
  });

  it("gives just the reasons when nothing was freed, joined across sources", () => {
    expect(
      summarizeCleanup(
        job(
          step("docker", { state: "error", note: "no daemon" }),
          step("temp", { state: "error", note: "no /tmp" }),
        ),
      ),
    ).toBe("no daemon; no /tmp");
  });

  it("leaves skipped sources out of the sentence, and their reasons out of the errors", () => {
    expect(
      summarizeCleanup(
        job(
          step("docker", { state: "skipped", note: "Docker unavailable" }),
          step("temp", { reclaimedBytes: 5 }),
        ),
      ),
    ).toBe("Freed 5 B.");
  });

  it("mentions developer worktrees only when they freed or reported something", () => {
    expect(summarizeCleanup(job(step("docker", { reclaimedBytes: 7 }), step("worktrees")))).toBe(
      "Freed 7 B.",
    );
    expect(
      summarizeCleanup(
        job(step("docker", { reclaimedBytes: 7 }), step("worktrees", { reclaimedBytes: GIB })),
      ),
    ).toBe("Freed 1.0 GiB (Docker 7 B, developer worktrees 1.0 GiB).");
    expect(
      summarizeCleanup(
        job(
          step("docker", { reclaimedBytes: 7 }),
          step("worktrees", { state: "error", note: "x" }),
        ),
      ),
    ).toBe("Freed 7 B (Docker 7 B, developer worktrees 0 B), then stopped: x");
  });

  it("says it freed nothing when no source took part", () => {
    expect(summarizeCleanup(job())).toBe("Freed 0 B.");
  });
});
