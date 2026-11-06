import { describe, it, expect } from "vitest";
import {
  REVIEW_STATUS_NOTE,
  hasNoReviewRun,
  reviewStatusLines,
} from "../../src/cli/review-protocol.mjs";
import { TOOLS } from "../../src/mcp/tools.mjs";

// #2634 — what an agent is told about a review that is not the relay's own run,
// and about a stuck one. `mullion review status` and the MCP `review_status`
// tool share this text, so the two cannot disagree about what to do.
describe("reviewStatusLines", () => {
  const base = { runId: "run_wf", repo: "acme/widgets", prNumber: 42 };

  it("prints the run, and says when it was started outside this Mullion", () => {
    expect(reviewStatusLines({ ...base, status: "running" })).toEqual([
      "review run run_wf for acme/widgets#42: running",
    ]);
    const [line] = reviewStatusLines({ ...base, status: "running", source: "ledger" });
    expect(line).toContain(
      "review run run_wf for acme/widgets#42: running (started outside this Mullion",
    );
  });

  it("tells the agent to report a stuck review, and never to @mention the bot", () => {
    const lines = reviewStatusLines({
      ...base,
      status: "failed",
      source: "ledger",
      stuck: true,
      stuckReason: "dead_run",
    });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("stuck (dead_run)");
    expect(lines[1]).toContain("tell the human");
    expect(lines[1]).toContain("do not @mention the review bot");
  });

  it("keeps a ledger answer whose run Hermes lost, with the lost_run advice", () => {
    // Hermes' own status is `not_found`, but there IS a run: the marker names it.
    const lines = reviewStatusLines({
      ...base,
      status: "not_found",
      source: "ledger",
      stuck: true,
      stuckReason: "lost_run",
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("review run run_wf for acme/widgets#42: not_found");
    expect(lines[0]).toContain("started outside this Mullion");
    expect(lines[0]).not.toContain("no review run known");
    expect(lines[1]).toContain("stuck (lost_run)");
    expect(lines[1]).toContain("do not @mention the review bot");
  });

  it("does not say nothing is working on an overdue run Hermes still calls running", () => {
    const [, advice] = reviewStatusLines({
      ...base,
      status: "running",
      stuck: true,
      stuckReason: "overdue",
    });
    expect(advice).toContain("stuck (overdue)");
    expect(advice).toContain("still reports it running");
    expect(advice).not.toContain("nothing is working");
    expect(advice).toContain("mullion review stop run_wf");
    expect(advice).toContain("do not @mention the review bot");
  });

  it("explains a not_found that has a run id: Hermes no longer knows that run", () => {
    // A relay run whose status window elapsed: a run, not an absence.
    const lines = reviewStatusLines({ ...base, status: "not_found" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("review run run_wf for acme/widgets#42: not_found");
    expect(lines[0]).toContain("Hermes no longer knows this run");
    expect(hasNoReviewRun({ ...base, status: "not_found" })).toBe(false);
    expect(hasNoReviewRun({ status: "not_found" })).toBe(true);
    expect(hasNoReviewRun({ ...base, status: "running" })).toBe(false);
  });

  it("is a single line for not_found, naming the missing review check", () => {
    const lines = reviewStatusLines({ status: "not_found", repo: "acme/widgets", prNumber: 42 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("no review run known for acme/widgets#42");
    expect(lines[0]).toContain('no "Hermes review" check');
  });
});

describe("the review_status tool description", () => {
  it("carries the shared note about ledger-found and stuck reviews", () => {
    const tool = TOOLS.find((t) => t.name === "review_status");
    expect(tool?.description).toContain(REVIEW_STATUS_NOTE);
    expect(REVIEW_STATUS_NOTE).toContain("do NOT @mention the review bot");
  });
});
