import { describe, expect, it, vi } from "vitest";
import {
  PHASE_LABEL,
  attentionSummary,
  phaseChip,
  checkCounts,
  checksStatus,
  mergeStatus,
  pendingLabel,
  phaseTone,
  prStatuses,
  prTriadItems,
  reviewerRows,
  reviewStatus,
  runIdFromUrl,
  sortPrsByAttention,
  type PrStatusInput,
} from "./prPhase.js";

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

describe("phaseChip", () => {
  it("maps attention and ready phases to a glyph", () => {
    expect(phaseChip("ci_failing", 0)).toEqual({ glyph: "✗", text: "CI" });
    expect(phaseChip("changes_requested", 3)).toEqual({ glyph: "✎", text: "changes 💬3" });
    expect(phaseChip("conflicts", null)).toEqual({ glyph: "⚠", text: "conflicts" });
    expect(phaseChip("ready_to_merge", undefined)).toEqual({ glyph: "✓", text: "ready" });
    expect(phaseChip("draft", 0)).toEqual({ glyph: "", text: "draft" });
  });
  it("shows only unresolved threads for quiet phases, nothing otherwise", () => {
    expect(phaseChip("review_pending", 1)).toEqual({ glyph: "", text: "💬1" });
    expect(phaseChip("review_pending", 0)).toBeNull();
    expect(phaseChip(undefined, undefined)).toBeNull();
  });
});

describe("attentionSummary", () => {
  it("counts only needs-attention phases, by phase", () => {
    expect(
      attentionSummary([
        { prPhase: "ci_failing" },
        { prPhase: "ci_failing" },
        { prPhase: "conflicts" },
        { prPhase: "ready_to_merge" },
        {},
      ]),
    ).toEqual({ total: 3, byPhase: { ci_failing: 2, conflicts: 1 } });
  });
});

const run = (conclusion: string | null, status = "completed", n = 1) => ({
  name: `w${n}`,
  status,
  conclusion,
  htmlUrl: `https://github.com/a/b/actions/runs/${n}`,
  headSha: "abc",
});
const base = (over: Partial<PrStatusInput> = {}): PrStatusInput => ({
  actionsRuns: [],
  ciStatus: null,
  prPhase: "review_pending",
  ...over,
});

describe("runIdFromUrl", () => {
  it("reads the run id, or null for a URL without one", () => {
    expect(runIdFromUrl("https://github.com/a/b/actions/runs/99")).toBe(99);
    expect(runIdFromUrl("https://example.com/x")).toBeNull();
  });
});

describe("checksStatus", () => {
  it("is unknown without data, none once the poller answered with no runs", () => {
    expect(checksStatus(base())).toMatchObject({
      text: "Checks unknown",
      label: "CI unknown",
      short: "—",
    });
    expect(checksStatus(base({ ciKnown: true }))).toMatchObject({
      text: "No checks reported",
      label: "No CI",
    });
    expect(checksStatus(base({ ciFetched: true })).text).toBe("No checks reported");
  });

  it("counts failures first, then running, then passed", () => {
    const failing = checksStatus(
      base({
        actionsRuns: [
          run("failure", "completed", 1),
          run(null, "in_progress", 2),
          run("success", "completed", 3),
        ],
      }),
    );
    expect(failing).toMatchObject({
      tone: "danger",
      label: "✗1 ⋯1 ✓1",
      short: "✗1",
      text: "1 failing, 1 in progress",
    });
    const running = checksStatus(
      base({ actionsRuns: [run(null, "in_progress", 1), run("success", "completed", 2)] }),
    );
    expect(running).toMatchObject({ tone: "warn", short: "1/2", text: "1 in progress" });
    expect(checksStatus(base({ actionsRuns: [run("success")] }))).toMatchObject({
      tone: "success",
      label: "✓1",
      text: "All checks have passed",
    });
  });

  it("counts other checks, and switches to job level once every run's jobs are loaded", () => {
    const input = base({
      actionsRuns: [run("success", "completed", 1)],
      otherChecks: [
        { name: "a", state: "failure", url: null, source: "status" },
        { name: "b", state: "pending", url: null, source: "status" },
        { name: "c", state: "neutral", url: null, source: "status" },
        { name: "d", state: "success", url: null, source: "check_run" },
      ],
    });
    expect(checkCounts(input)).toEqual({ failed: 1, pending: 1, passed: 2, skipped: 1 });
    const job = (id: number, conclusion: string) => ({
      id,
      name: `j${id}`,
      status: "completed",
      conclusion,
      startedAt: null,
      completedAt: null,
      htmlUrl: "",
      steps: [],
    });
    expect(
      checkCounts(input, { 1: [job(1, "success"), job(2, "success"), job(3, "skipped")] }),
    ).toEqual({
      failed: 1,
      pending: 1,
      passed: 3,
      skipped: 2,
    });
    // Jobs that came back empty say nothing: the run itself still counts.
    expect(checkCounts(input, { 1: [] }).passed).toBe(2);
    // A run whose jobs are not in yet keeps the run-level counts.
    expect(checkCounts(input, { 1: undefined }).passed).toBe(2);
  });
});

describe("checksStatus — runs awaiting approval", () => {
  it("shows runs held at action_required as pending, not failing", () => {
    const held = checksStatus(
      base({
        actionsRuns: [
          run("action_required", "completed", 1),
          run("action_required", "completed", 2),
          run("action_required", "completed", 3),
        ],
      }),
    );
    expect(held).toMatchObject({ tone: "warn", label: "⋯3", text: "3 awaiting approval" });
  });

  it("splits awaiting approval from running", () => {
    const mixed = checksStatus(
      base({ actionsRuns: [run("action_required", "completed", 1), run(null, "in_progress", 2)] }),
    );
    expect(mixed.text).toBe("1 awaiting approval, 1 in progress");
  });

  it("still reports a genuine failure next to a held run", () => {
    const failing = checksStatus(
      base({
        actionsRuns: [run("action_required", "completed", 1), run("failure", "completed", 2)],
      }),
    );
    expect(failing).toMatchObject({ tone: "danger", short: "✗1" });
  });
});

describe("reviewStatus", () => {
  const sum = (over: Record<string, unknown>) => ({
    decision: null,
    approved: [],
    changesRequested: [],
    commented: [],
    requested: [],
    relay: null,
    unresolvedThreads: null,
    latest: [],
    ...over,
  });
  it("reads each state from the summary, bots included", () => {
    const of = (over: Record<string, unknown>, relay = null as never) =>
      reviewStatus(base({ reviewSummary: sum(over) as never }), relay);
    expect(of({ changesRequested: ["bob"], unresolvedThreads: 2 })).toMatchObject({
      tone: "danger",
      label: "Changes requested",
      short: "Changes",
      text: "Changes requested by bob · 2 open",
    });
    expect(of({ decision: "APPROVED", approved: ["a", "b"] })).toMatchObject({
      tone: "success",
      label: "Approved",
      text: "Approved by a and b",
    });
    expect(of({ commented: ["hermes[bot]"] })).toMatchObject({
      tone: "info",
      label: "Commented",
      short: "💬",
    });
    expect(of({ requested: ["x", "y"] })).toMatchObject({
      label: "Review requested",
      text: "Awaiting review from x, y",
    });
    expect(of({ decision: "REVIEW_REQUIRED" })).toMatchObject({ label: "Review required" });
    expect(of({})).toMatchObject({ tone: "neutral", label: "No reviews", text: "No reviews yet" });
  });

  it("names a running relay, but not one that failed or could not be confirmed", () => {
    const running = reviewStatus(base(), { state: "requested", status: "running" });
    expect(running).toMatchObject({
      label: "Relay running",
      text: "Review requested — waiting for the review bot",
    });
    const failed = reviewStatus(base(), { state: "requested", status: "failed" });
    expect(failed.label).toBe("Review requested");
    expect(failed.text).toContain("the review did not finish");
    const unconfirmed = reviewStatus(base(), {
      state: "requested",
      status: "running",
      landedChecked: false,
    });
    expect(unconfirmed.label).toBe("Review requested");
    const withComment = reviewStatus(base({ reviewSummary: sum({ commented: ["b"] }) as never }), {
      state: "requested",
      status: "queued",
    });
    expect(withComment.label).toBe("Commented · relay running");
    const awaiting = reviewStatus(base({ reviewSummary: sum({ requested: ["b"] }) as never }), {
      state: "requested",
      status: "running",
    });
    expect(awaiting.label).toBe("Relay running");
  });

  it("falls back to the lean reviewer fields when the server sent no summary", () => {
    const st = reviewStatus(
      base({
        reviewers: [
          { login: "a", state: "APPROVED" },
          { login: "b", state: "CHANGES_REQUESTED" },
          { login: "c", state: "COMMENTED" },
        ],
        reviewDecision: "CHANGES_REQUESTED",
        requestedReviewers: ["d"],
      }),
      null,
    );
    expect(st.label).toBe("Changes requested");
  });

  it("takes the relay from the summary when no live read is given", () => {
    const st = reviewStatus(
      base({
        reviewSummary: sum({ relay: { state: "landed", reviewer: "h", url: null } }) as never,
      }),
      null,
    );
    expect(st.relay).toEqual({ state: "landed", reviewer: "h", url: null });
  });
});

describe("pendingLabel", () => {
  it("covers every run status", () => {
    expect(pendingLabel("stopping", undefined)).toContain("being stopped");
    expect(pendingLabel("not_found", undefined)).toContain("no longer known");
    expect(pendingLabel("completed", false)).toContain("could not be confirmed");
    expect(pendingLabel("completed", true)).toContain("finished without posting");
  });
});

describe("mergeStatus", () => {
  it("names open conversations as the block", () => {
    expect(mergeStatus(base({ prPhase: "threads_unresolved" }))).toMatchObject({
      tone: "warn",
      text: "Blocked: unresolved conversations",
      label: "Blocked: Unresolved conversations",
    });
    expect(phaseChip("threads_unresolved", 2)).toEqual({ glyph: "", text: "threads 💬2" });
  });

  it("says Ready, Conflicts, Draft, Blocked: reason, and Waiting", () => {
    expect(mergeStatus(base({ prPhase: "ready_to_merge" }))).toMatchObject({
      tone: "success",
      label: "Ready",
    });
    expect(mergeStatus(base({ prPhase: "conflicts" }))).toMatchObject({
      tone: "danger",
      label: "Conflicts",
    });
    expect(mergeStatus(base({ prPhase: "draft" }))).toMatchObject({
      tone: "neutral",
      label: "Draft",
    });
    expect(mergeStatus(base({ isDraft: true, prPhase: "ci_failing" })).label).toBe("Draft");
    expect(mergeStatus(base({ prPhase: "ci_failing" }))).toMatchObject({
      label: "Blocked: CI failing",
      short: "Blocked",
      text: "Blocked: ci failing",
    });
    expect(mergeStatus(base({ prPhase: "changes_requested" })).label).toBe(
      "Blocked: Changes requested",
    );
    expect(mergeStatus(base({ prPhase: "review_pending" }))).toMatchObject({
      label: "Waiting",
      short: "Wait",
    });
    expect(mergeStatus(base({ prPhase: undefined })).label).toBe("Waiting");
    expect(mergeStatus(base({ state: "MERGED" })).tone).toBe("merged");
    expect(mergeStatus(base({ state: "CLOSED" })).label).toBe("Closed");
  });
});

describe("prTriadItems", () => {
  it("builds the CI, Review and Merge chips, each toggling its own drilldown", () => {
    const onToggle = vi.fn();
    const items = prTriadItems(prStatuses(base({ actionsRuns: [run("success")] }), null), onToggle);
    expect(items.map((i) => i.key)).toEqual(["ci", "review", "merge"]);
    expect(items[0].title).toBe("CI: All checks have passed");
    items[1].onClick?.();
    expect(onToggle).toHaveBeenCalledWith("review");
  });
});

describe("checks edge cases (review feedback)", () => {
  it("does not call all-skipped or cancelled runs a pass", () => {
    for (const conclusion of ["skipped", "cancelled"]) {
      const st = checksStatus(
        base({ actionsRuns: [run(conclusion, "completed", 1), run(conclusion, "completed", 2)] }),
      );
      expect(st).toMatchObject({
        tone: "neutral",
        text: "No checks ran",
        label: "–2",
        short: "–2",
      });
    }
    const jobs = [1, 2].map((id) => ({
      id,
      name: "j",
      status: "completed",
      conclusion: "skipped",
      startedAt: null,
      completedAt: null,
      htmlUrl: "",
      steps: [],
    }));
    expect(
      checksStatus(base({ actionsRuns: [run("success", "completed", 1)] }), { 1: jobs }).text,
    ).toBe("No checks ran");
  });

  it("counts a run with no jobs at run level next to a run that has jobs", () => {
    const job = {
      id: 9,
      name: "j",
      status: "completed",
      conclusion: "success",
      startedAt: null,
      completedAt: null,
      htmlUrl: "",
      steps: [],
    };
    const input = base({
      actionsRuns: [run("failure", "completed", 1), run("success", "completed", 2)],
    });
    expect(checkCounts(input, { 1: [], 2: [job] })).toEqual({
      failed: 1,
      pending: 0,
      passed: 1,
      skipped: 0,
    });
  });
});

describe("reviewerRows", () => {
  it("reads the summary (COMMENTED included), else the lean reviewer list", () => {
    const sum = {
      decision: null,
      approved: ["a"],
      changesRequested: ["b"],
      commented: ["hermes-bot"],
      requested: [],
      relay: null,
      unresolvedThreads: null,
      latest: [],
    };
    expect(reviewerRows({ reviewSummary: sum, reviewers: [] }).map((r) => r.state)).toEqual([
      "APPROVED",
      "CHANGES_REQUESTED",
      "COMMENTED",
    ]);
    expect(reviewerRows({ reviewers: [{ login: "x", state: "APPROVED" }] })).toHaveLength(1);
    expect(reviewerRows({})).toEqual([]);
  });
});
