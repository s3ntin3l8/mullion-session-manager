import { describe, expect, it } from "vitest";
import { PHASE_LABEL, phaseTone, sortPrsByAttention } from "./prPhase.js";

describe("phaseTone", () => {
  it("maps phases to tones", () => {
    expect(phaseTone("ci_failing")).toBe("bad");
    expect(phaseTone("changes_requested")).toBe("bad");
    expect(phaseTone("conflicts")).toBe("bad");
    expect(phaseTone("review_pending")).toBe("warn");
    expect(phaseTone("ci_pending")).toBe("warn");
    expect(phaseTone("ready_to_merge")).toBe("good");
    expect(phaseTone("draft")).toBe("dim");
    expect(phaseTone("unknown")).toBe("dim");
    expect(PHASE_LABEL.ready_to_merge).toBe("Ready to merge");
  });
});

describe("sortPrsByAttention", () => {
  it("puts failing CI, then changes requested, then conflicts first, then newest", () => {
    const prs = [
      { number: 1, prPhase: "ready_to_merge" as const, updatedAt: "2026-01-05T00:00:00Z" },
      { number: 2, prPhase: "conflicts" as const, updatedAt: "2026-01-01T00:00:00Z" },
      { number: 3, prPhase: "review_pending" as const, updatedAt: "2026-01-09T00:00:00Z" },
      { number: 4, prPhase: "changes_requested" as const, updatedAt: "2026-01-02T00:00:00Z" },
      { number: 5, prPhase: "ci_failing" as const, updatedAt: "2026-01-01T00:00:00Z" },
      { number: 6, updatedAt: null },
    ];
    expect(sortPrsByAttention(prs).map((p) => p.number)).toEqual([5, 4, 2, 3, 1, 6]);
    // Does not mutate its input.
    expect(prs[0].number).toBe(1);
  });
});
