import { describe, it, expect } from "vitest";
import {
  MAX_FOCUS_ITEMS,
  MAX_FOCUS_ITEM_LENGTH,
  normalizeFocus,
  parseReviewFocus,
} from "../../src/services/task-review-focus.js";
import {
  buildReviewPrompt,
  deriveVerdict,
  parseReviewFindings,
  renderReviewFindingsMarkdown,
  type TaskPromptTask,
} from "../../src/services/task-prompt.js";

const bodyWith = (focus: string) =>
  `## Context\n\nx\n\n## Review focus\n\n${focus}\n\n## Scope\n\n- [ ] a`;

describe("parseReviewFocus (#2600)", () => {
  it("is empty when the section is absent, null or has no bullets", () => {
    expect(parseReviewFocus("## Scope\n\n- [ ] a")).toEqual([]);
    expect(parseReviewFocus(null)).toEqual([]);
    expect(parseReviewFocus(bodyWith("just prose"))).toEqual([]);
    expect(parseReviewFocus("## Review focus\n")).toEqual([]);
  });

  it("reads bullets up to the next ## heading and ignores the commented template", () => {
    expect(parseReviewFocus(bodyWith("- one\n* two\n1. three\n### sub\n- four"))).toEqual([
      "one",
      "two",
      "three",
      "four",
    ]);
    expect(parseReviewFocus("## Review focus\n\n<!-- - example -->\n\n## Scope\n- x")).toEqual([]);
    // Nested/spliced and unterminated comments do not leave a live `<!--` behind.
    expect(parseReviewFocus("## Review focus\n<!<!-- a -->-- - hidden -->\n- real")).toEqual([
      "real",
    ]);
    expect(parseReviewFocus("## Review focus\n- kept\n<!-- - unterminated\n- gone")).toEqual([
      "kept",
    ]);
    expect(parseReviewFocus("## Review focus\n- a\n## Scope\n- b")).toEqual(["a"]);
  });

  it("keeps code spans and cuts over-long and surplus bullets", () => {
    expect(parseReviewFocus(bodyWith("- compare with `timingSafeEqual(a, b)` only"))).toEqual([
      "compare with `timingSafeEqual(a, b)` only",
    ]);
    const long = parseReviewFocus(bodyWith(`- ${"x".repeat(500)}`));
    expect(long[0]).toHaveLength(MAX_FOCUS_ITEM_LENGTH);
    expect(long[0]!.endsWith("…")).toBe(true);
    const many = Array.from({ length: 20 }, (_, i) => `- item ${i}`).join("\n");
    expect(parseReviewFocus(bodyWith(many))).toHaveLength(MAX_FOCUS_ITEMS);
  });

  it("does not read a heading inside a code fence", () => {
    expect(parseReviewFocus("```\n## Review focus\n- a\n```")).toEqual([]);
  });
});

describe("review focus in the review prompt and findings", () => {
  const task = (body: string): TaskPromptTask => ({ id: 1, issueNumber: 2, title: "t", body });
  const prompt = (body: string, extra = {}) =>
    buildReviewPrompt({ task: task(body), worktreePath: "/w", findingsPath: "/f", ...extra });
  const parse = (o: Record<string, unknown>) =>
    parseReviewFindings(JSON.stringify({ verdict: "approved", summary: "s", ...o }));

  it("renders the bullets and asks for a report on each, only when present", () => {
    const out = prompt(bodyWith("- supersede races\n- fail-open gates"));
    expect(out).toContain("The issue author asks you to specifically examine:");
    expect(out).toContain("- supersede races");
    expect(out).toContain("- fail-open gates");
    expect(out).toContain("Report each one in `focus`");
    expect(out).toContain('"focus": [');
    expect(prompt("## Scope\n- [ ] a")).not.toContain("specifically examine");
  });

  it("follow-up rounds re-check only finding / not-checked items", () => {
    const out = prompt("## Scope\n- [ ] a", {
      priorRound: { reviewedSha: "abc1234", findings: "- x" },
    });
    expect(out).toContain("only the `focus` items the earlier review reported as `finding`");
  });

  it("normalizes focus tolerantly", () => {
    expect(
      normalizeFocus([
        { item: "a", status: "clear", evidence: "e" },
        { item: "b", status: "not-checked" },
        { item: "c", status: "bogus" },
        { status: "clear" },
        null,
        "x",
      ]),
    ).toEqual([
      { item: "a", status: "clear", evidence: "e" },
      { item: "b", status: "not-checked", evidence: "" },
    ]);
    expect(normalizeFocus("nope")).toEqual([]);
    expect(parse({}).focus).toEqual([]);
  });

  it("a not-checked entry is a prominent note and leaves the verdict alone", () => {
    const parsed = parse({
      focus: [{ item: "races", status: "not-checked", evidence: "no time" }],
    });
    expect(parsed.verdict).toBe("approved");
    expect(parsed.notes[0]).toContain("NOT CHECKED");
    expect(parsed.notes[0]).toContain("races");
    expect(deriveVerdict({ findings: [], previous: [], claimed: "approved" })).toBe("approved");
  });

  it("keeps focus notes raw for the worker prompt and neutralises them in comments", () => {
    const parsed = parse({
      verdict: "changes-requested",
      findings: [{ path: "a.ts", line: 1, severity: "warning", body: "bug" }],
      focus: [{ item: "rows[0] & <script> @someone", status: "not-checked", evidence: "no time" }],
    });
    const worker = renderReviewFindingsMarkdown(parsed, "worker-prompt");
    expect(worker).toContain("rows[0] & <script> @someone");
    const comment = renderReviewFindingsMarkdown(parsed, "comment");
    expect(comment).toContain("rows\\[0\\] &amp; &lt;script&gt; @\u200Bsomeone");
    expect(comment).not.toContain("<script>");
  });

  it("flags a finding-status entry that has no finding behind it, without changing the verdict", () => {
    const orphan = parse({ focus: [{ item: "races", status: "finding", evidence: "x" }] });
    expect(orphan.verdict).toBe("approved");
    expect(orphan.notes.join("\n")).toContain("no finding was filed");
    const backed = parse({
      verdict: "changes-requested",
      findings: [{ path: "a.ts", line: 1, severity: "warning", body: "race" }],
      focus: [{ item: "races", status: "finding", evidence: "a.ts:1" }],
    });
    expect(backed.verdict).toBe("changes-requested");
    expect(backed.notes.join("\n")).not.toContain("no finding was filed");
  });

  it("renders a Review focus section", () => {
    const md = renderReviewFindingsMarkdown(
      parse({ focus: [{ item: "races", status: "clear", evidence: "checked a.ts" }] }),
    );
    expect(md).toContain("### Review focus");
    expect(md).toContain("- **clear** — races: checked a.ts");
  });
});

describe("renderFocusSection neutralisation", () => {
  it("defuses mentions and HTML in focus items and evidence", async () => {
    const { renderFocusSection } = await import("../../src/services/task-review-focus.js");
    const out = renderFocusSection([
      { item: "ping @someone <b>x</b>", status: "ok", evidence: "see [a](http://x)" },
    ] as never).join("\n");
    expect(out).not.toContain("@someone");
    expect(out).not.toContain("<b>");
    expect(out).toContain("\\[a\\]");
  });
});
