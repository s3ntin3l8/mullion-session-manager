import { describe, expect, it } from "vitest";
import { buildHandoffPrompt } from "../../src/services/pr-handoff.js";

const pr = {
  number: 9,
  title: "Add thing",
  htmlUrl: "https://github.com/o/r/pull/9",
  headBranch: "feat-thing",
  threads: [
    {
      id: "T1",
      isResolved: false,
      isOutdated: false,
      path: "src/a.ts",
      line: 12,
      comments: [{ author: "hermes", bodyHtml: "<p>Guard &lt;null&gt; here</p>", createdAt: "t" }],
    },
    {
      id: "T2",
      isResolved: true,
      isOutdated: false,
      path: "src/b.ts",
      line: 1,
      comments: [{ author: "x", bodyHtml: "done", createdAt: "t" }],
    },
    {
      id: "T3",
      isResolved: false,
      isOutdated: true,
      path: "src/c.ts",
      line: 3,
      comments: [{ author: "x", bodyHtml: "stale", createdAt: "t" }],
    },
  ],
  reviews: [
    {
      author: "hermes",
      state: "CHANGES_REQUESTED",
      bodyHtml: "<p>Fix the <b>race</b></p>",
      createdAt: "t",
    },
  ],
};

describe("buildHandoffPrompt", () => {
  it("lists only open, current threads with plain text, plus requested changes and red checks", () => {
    const text = buildHandoffPrompt(pr, ["CI", "CodeQL"]);
    expect(text).toContain("PR #9: Add thing");
    expect(text).toContain("Unresolved review threads (1):");
    expect(text).toContain("src/a.ts:12 — hermes: Guard <null> here");
    expect(text).not.toContain("src/b.ts");
    expect(text).not.toContain("src/c.ts");
    expect(text).toContain("Changes requested by hermes: Fix the race");
    expect(text).toContain("Failing checks: CI, CodeQL");
    expect(text).toContain("not required for merging still counts");
    expect(text).toContain("`feat-thing`");
  });

  it("includes COMMENTED review bodies, each reviewer's latest only, but not approvals", () => {
    const review = (author: string, state: string, bodyHtml: string) => ({
      author,
      state,
      bodyHtml,
      createdAt: "t",
    });
    const text = buildHandoffPrompt(
      {
        ...pr,
        threads: [],
        reviews: [
          review("hermes", "COMMENTED", "<p>first pass</p>"),
          review("hermes", "COMMENTED", "<p>second pass</p>"),
          review("bob", "CHANGES_REQUESTED", "<p>nope</p>"),
          review("bob", "APPROVED", "<p>fine now</p>"),
          review("eve", "COMMENTED", "  "),
        ],
      },
      [],
    );
    expect(text).toContain("Review comments from hermes: second pass");
    expect(text).not.toContain("first pass");
    expect(text).not.toContain("nope");
    expect(text).not.toContain("fine now");
    expect(text).not.toContain("nothing outstanding");
  });

  it("an inline-only latest review does not hide the author's earlier text", () => {
    const review = (state: string, bodyHtml: string) => ({
      author: "hermes",
      state,
      bodyHtml,
      createdAt: "t",
    });
    const text = buildHandoffPrompt(
      {
        ...pr,
        threads: [],
        reviews: [review("CHANGES_REQUESTED", "<p>fix the race</p>"), review("COMMENTED", "")],
      },
      [],
    );
    expect(text).toContain("Changes requested by hermes: fix the race");
  });

  it("drops a reviewer's request once their latest review is DISMISSED", () => {
    const text = buildHandoffPrompt(
      {
        ...pr,
        threads: [],
        reviews: [
          { author: "bob", state: "CHANGES_REQUESTED", bodyHtml: "<p>nope</p>", createdAt: "t" },
          { author: "bob", state: "DISMISSED", bodyHtml: "", createdAt: "t" },
        ],
      },
      [],
    );
    expect(text).not.toContain("nope");
  });

  it("strips nested/spliced tags and script blocks completely", () => {
    const text = buildHandoffPrompt(
      {
        ...pr,
        reviews: [],
        threads: [
          {
            id: "T0",
            isResolved: false,
            isOutdated: false,
            path: "a.ts",
            line: 1,
            comments: [
              {
                author: "x",
                bodyHtml: "<scr<script>x</script>ipt>alert(1)</scr<script></script>ipt><b>ok</b>",
                createdAt: "t",
              },
            ],
          },
        ],
      },
      [],
    );
    expect(text).not.toMatch(/<\/?script/i);
    expect(text).toContain("ok");
  });

  it("says so when nothing is outstanding and clips very long comments", () => {
    const empty = buildHandoffPrompt({ ...pr, threads: [], reviews: [] }, []);
    expect(empty).toContain("nothing outstanding");
    const long = buildHandoffPrompt(
      {
        ...pr,
        reviews: [],
        threads: [
          {
            id: "T1",
            isResolved: false,
            isOutdated: false,
            path: null,
            line: null,
            comments: [{ author: null, bodyHtml: "x".repeat(2000), createdAt: "t" }],
          },
        ],
      },
      [],
    );
    expect(long).toContain("(general) — reviewer: ");
    expect(long).toContain("…");
    expect(long.length).toBeLessThan(1200);
  });

  describe("a merge conflict with the base branch", () => {
    const clean = { ...pr, threads: [], reviews: [] };

    it("tells the session to resolve it, instead of saying nothing is outstanding", () => {
      const text = buildHandoffPrompt(
        { ...clean, baseBranch: "main", mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" },
        [],
      );
      expect(text).toContain("merge conflict with `main`");
      expect(text).toContain("`origin/main`");
      expect(text).toContain("--force-with-lease");
      expect(text).not.toContain("nothing outstanding");
    });

    it("explains the missing CI when there are no failing checks, since GitHub skips workflows on a conflict", () => {
      const text = buildHandoffPrompt(
        { ...clean, baseBranch: "main", mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" },
        [],
      );
      expect(text).toContain("does not run a PR's workflows while it conflicts");
    });

    it("does not add the missing-CI note when checks did fail", () => {
      const text = buildHandoffPrompt(
        { ...clean, baseBranch: "main", mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" },
        ["CI"],
      );
      expect(text).toContain("Failing checks: CI");
      expect(text).not.toContain("does not run a PR's workflows");
    });

    it("recognises either signal alone", () => {
      expect(
        buildHandoffPrompt({ ...clean, baseBranch: "main", mergeable: "CONFLICTING" }, []),
      ).toContain("merge conflict");
      expect(
        buildHandoffPrompt({ ...clean, baseBranch: "main", mergeStateStatus: "DIRTY" }, []),
      ).toContain("merge conflict");
    });

    it("names the base generically when it is not known", () => {
      const text = buildHandoffPrompt({ ...clean, mergeable: "CONFLICTING" }, []);
      expect(text).toContain("merge conflict with its base branch");
      expect(text).toContain("Bring the base branch into the branch");
    });

    it("does not claim a conflict while GitHub is still computing, or when the PR is mergeable", () => {
      for (const mergeable of ["UNKNOWN", null, "MERGEABLE"] as const) {
        const text = buildHandoffPrompt(
          { ...clean, baseBranch: "main", mergeable, mergeStateStatus: "CLEAN" },
          [],
        );
        expect(text).not.toContain("merge conflict");
        expect(text).toContain("nothing outstanding");
      }
    });

    it("lists the conflict alongside review feedback and failing checks", () => {
      const text = buildHandoffPrompt(
        { ...pr, baseBranch: "main", mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" },
        ["CI"],
      );
      expect(text).toContain("Unresolved review threads (1):");
      expect(text).toContain("merge conflict with `main`");
      expect(text).toContain("Failing checks: CI");
    });
  });
});
