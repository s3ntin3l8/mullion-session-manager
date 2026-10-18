import { describe, expect, it } from "vitest";
import { buildHandoffPrompt } from "../../src/services/pr-handoff.js";

const pr = {
  number: 9,
  title: "Add thing",
  htmlUrl: "https://github.com/o/r/pull/9",
  headBranch: "feat-thing",
  threads: [
    {
      isResolved: false,
      isOutdated: false,
      path: "src/a.ts",
      line: 12,
      comments: [{ author: "hermes", bodyHtml: "<p>Guard &lt;null&gt; here</p>", createdAt: "t" }],
    },
    {
      isResolved: true,
      isOutdated: false,
      path: "src/b.ts",
      line: 1,
      comments: [{ author: "x", bodyHtml: "done", createdAt: "t" }],
    },
    {
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
    expect(text).toContain("`feat-thing`");
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
});
