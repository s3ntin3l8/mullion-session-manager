import { describe, it, expect, vi } from "vitest";
import {
  createProbeMemo,
  derivePrEvents,
  pruneClosedMeta,
  sessionIdsOnBranch,
  type ProjectSession,
} from "../../src/services/pr-session-events.js";
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
  // The review relay's two fields are part of the snapshot the production
  // code compares. This double has no relay run, so both are null — which
  // is what snapshotPr() produces for a PR without one.
  relayState: null,
  relayVerdict: null,
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

describe("session branch matching", () => {
  const sess = (id: string, liveBranch: string | null): ProjectSession => ({
    id,
    cwd: `/work/${id}`,
    liveBranch,
  });

  it("matches the hook branch without probing, and probes everything else", async () => {
    const probed: string[] = [];
    const branchOf = async (s: ProjectSession) => {
      probed.push(s.id);
      return s.id === "wt" ? "feat-x" : "main";
    };
    const ids = await sessionIdsOnBranch(
      [sess("hook", "feat-x"), sess("none", null), sess("wt", "main"), sess("other", "main")],
      "feat-x",
      branchOf,
    );
    // "wt" reported the main checkout's branch but lives in the PR's worktree.
    expect(ids.sort()).toEqual(["hook", "wt"]);
    expect(probed.sort()).toEqual(["none", "other", "wt"]);
  });

  it("probes each session once however many changes consult it (memo)", async () => {
    const probe = vi.fn(async () => "feat-x");
    const branchOf = createProbeMemo(probe);
    const sessions = [sess("a", null), sess("b", null)];
    await Promise.all([
      sessionIdsOnBranch(sessions, "feat-x", branchOf),
      sessionIdsOnBranch(sessions, "feat-x", branchOf),
      sessionIdsOnBranch(sessions, "other", branchOf),
    ]);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("prunes only closed PRs from the live metadata map", () => {
    const metas = new Map<number, unknown>([
      [7, {}],
      [8, {}],
    ]);
    const change = (number: number, kind: PrChange["kind"]): PrChange => ({
      number,
      kind,
      before: null,
      after: null,
    });
    pruneClosedMeta(metas, [change(7, "closed"), change(8, "updated")]);
    expect([...metas.keys()]).toEqual([8]);
    expect(() => pruneClosedMeta(undefined, [change(7, "closed")])).not.toThrow();
  });
});
