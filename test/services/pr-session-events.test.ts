import { describe, it, expect } from "vitest";
import { derivePrEvents } from "../../src/services/pr-session-events.js";
import type { PrChange, PrSnapshot } from "../../src/services/github-pr-phase.js";

const snap = (over: Partial<PrSnapshot> = {}): PrSnapshot => ({
  number: 7,
  headSha: "abc",
  isDraft: false,
  ciStatus: "in_progress",
  reviewDecision: null,
  mergeable: "MERGEABLE",
  unresolvedThreads: 0,
  commentCount: 0,
  prPhase: "ci_pending",
  ...over,
});
const meta = { number: 7, title: "Add x", url: "https://example.test/pull/7" };
const updated = (before: Partial<PrSnapshot>, after: Partial<PrSnapshot>): PrChange => ({
  number: 7,
  kind: "updated",
  before: snap(before),
  after: snap(after),
});
const kinds = (c: PrChange, merged = false) => derivePrEvents(c, meta, merged).map((e) => e.kind);

describe("derivePrEvents", () => {
  it("reports CI turning red or green, but not first-time CI knowledge", () => {
    expect(kinds(updated({}, { ciStatus: "failure" }))).toEqual(["pr_ci_failed"]);
    expect(kinds(updated({ ciStatus: "failure" }, { ciStatus: "success" }))).toEqual([
      "pr_ci_passed",
    ]);
    expect(kinds(updated({ ciStatus: "in_progress" }, { ciStatus: "success" }))).toEqual([
      "pr_ci_passed",
    ]);
    expect(kinds(updated({ ciStatus: null }, { ciStatus: "success" }))).toEqual([]);
    expect(
      kinds(updated({ ciStatus: "failure" }, { ciStatus: "failure", headSha: "def" })),
    ).toEqual([]);
  });

  it("reports new conflicts once", () => {
    expect(kinds(updated({ mergeable: null }, { mergeable: "CONFLICTING" }))).toEqual([
      "pr_conflicts",
    ]);
    expect(
      kinds(updated({ mergeable: "CONFLICTING" }, { mergeable: "CONFLICTING", headSha: "d" })),
    ).toEqual([]);
  });

  it("reports approvals and change requests with the decision", () => {
    const [ev] = derivePrEvents(updated({}, { reviewDecision: "CHANGES_REQUESTED" }), meta, false);
    expect(ev).toEqual({
      kind: "pr_review_submitted",
      payload: { ...meta, decision: "CHANGES_REQUESTED" },
    });
    expect(kinds(updated({ reviewDecision: "APPROVED" }, { reviewDecision: null }))).toEqual([]);
  });

  it("reports added comments and new unresolved threads", () => {
    const [ev] = derivePrEvents(
      updated({}, { commentCount: 2, unresolvedThreads: 1 }),
      meta,
      false,
    );
    expect(ev.kind).toBe("pr_new_comments");
    expect(ev.payload).toMatchObject({ added: 2, unresolvedThreads: 1 });
  });

  it("ignores review signals while review state is unfetched (null counts)", () => {
    expect(
      kinds(
        updated(
          { commentCount: null, unresolvedThreads: null },
          { reviewDecision: "APPROVED", commentCount: 3, unresolvedThreads: 0 },
        ),
      ),
    ).toEqual([]);
  });

  it("maps a vanished PR to pr_merged only when it was merged", () => {
    const closed: PrChange = { number: 7, kind: "closed", before: snap(), after: null };
    expect(kinds(closed, true)).toEqual(["pr_merged"]);
    expect(kinds(closed, false)).toEqual([]);
  });

  it("emits nothing for an opened PR", () => {
    expect(kinds({ number: 7, kind: "opened", before: null, after: snap() })).toEqual([]);
  });
});
