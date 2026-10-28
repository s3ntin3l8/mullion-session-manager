import { describe, expect, it } from "vitest";
import { parseReviewRounds } from "./reviewRounds.js";

// Shaped like renderReviewFindingsMarkdown's output (src/services/task-prompt.ts).
const round1 = [
  "## Round 1",
  "",
  "**Verdict:** changes requested — two problems",
  "",
  "### Critical",
  "- **a.ts:1** — boom",
  "",
  "### Warnings",
  "- **b.ts:2** — hmm",
  "- **c.ts:3** — hmm again",
  "",
  "### Suggestions",
  "- None",
  "",
  "### Looks Good",
  "- None",
].join("\n");
const round2 = [
  "## Round 2",
  "",
  "**Verdict:** approved with suggestions — fine",
  "",
  "### Critical",
  "- None",
  "",
  "### Warnings",
  "- None",
  "",
  "### Suggestions",
  "- **d.ts:4** — nit",
  "",
  "### Looks Good",
  "- All good",
].join("\n");

describe("parseReviewRounds", () => {
  it("parses a single round", () => {
    const r = parseReviewRounds(round1);
    expect(r?.earlier).toEqual([]);
    expect(r?.latest).toMatchObject({
      round: 1,
      heading: "## Round 1",
      verdict: "changes requested — two problems",
      counts: { critical: 1, warnings: 2, suggestions: 0 },
    });
  });

  it("leads with the last of two rounds and keeps the first as earlier", () => {
    const r = parseReviewRounds(`${round1}\n\n${round2}`);
    expect(r?.earlier).toEqual([round1]);
    expect(r?.latest).toMatchObject({
      round: 2,
      verdict: "approved with suggestions — fine",
      counts: { critical: 0, warnings: 0, suggestions: 1 },
    });
    expect(r?.latest.text).toBe(round2);
  });

  it("keeps a re-review heading suffix in the heading", () => {
    const r = parseReviewRounds(
      "## Round 3 (re-review after suggestions)\n\n**Verdict:** approved",
    );
    expect(r?.latest.round).toBe(3);
    expect(r?.latest.heading).toBe("## Round 3 (re-review after suggestions)");
    expect(r?.latest.counts).toBeNull();
  });

  it("returns null counts and verdict for an inconclusive round", () => {
    const r = parseReviewRounds("## Round 1\n\nReview agent ended without writing a findings file");
    expect(r?.latest.verdict).toBeNull();
    expect(r?.latest.counts).toBeNull();
  });

  it("returns null without any round heading, or for empty input", () => {
    expect(parseReviewRounds("Just some free-form review text.")).toBeNull();
    expect(parseReviewRounds("")).toBeNull();
    expect(parseReviewRounds(null)).toBeNull();
  });
});
