import { describe, it, expect } from "vitest";
import {
  buildGenerationPrompt,
  parseGeneratedOutput,
} from "../../src/services/scaffold-generate.js";
import { MULLION_REGION_PLACEHOLDER } from "../../src/services/mullion-scaffold.js";

// Issue #2531 — restructure also reports the passages it did not change.
describe("restructure report of unchanged passages", () => {
  const body = `# P\n\n${MULLION_REGION_PLACEHOLDER}\n\n## Repo specifics\n- x\n`;
  const opts = { mode: "restructure" as const, originalAgentsMd: "# P\n\n## A\nx\n" };
  const raw = (extra = "") =>
    `<<<MULLION_AGENTS_MD_START>>>\n${body}<<<MULLION_AGENTS_MD_END>>>\n${extra}`;
  const parse = (extra = "") =>
    parseGeneratedOutput(raw(extra), "demo", { ...opts, noPointer: true });

  it("reads the report, keeps an unknown kind and counts a malformed line", () => {
    const r = parse(
      "<<<MULLION_CONFLICTS_START>>>\n" +
        '{"file":"CONTRIBUTING.md","excerpt":"ask @bot","kind":"contradicts","note":"n"}\n' +
        '{"file":"docs/a.md","excerpt":"see ## Old","kind":"made-up-kind","note":"n"}\n' +
        "not json\n" +
        "<<<MULLION_CONFLICTS_END>>>\n",
    );
    expect(r.conflicts?.map((c) => c.kind)).toEqual(["contradicts", "made-up-kind"]);
    expect(r.droppedConflictLines).toBe(1);
  });

  it("treats an absent or 'none' section as nothing to report", () => {
    expect(parse()).toMatchObject({ conflicts: [], droppedConflictLines: 0 });
    expect(
      parse("<<<MULLION_CONFLICTS_START>>>\nnone\n<<<MULLION_CONFLICTS_END>>>\n").conflicts,
    ).toEqual([]);
  });

  it("asks for the report in the restructure prompt", () => {
    const p = buildGenerationPrompt({
      slug: "demo",
      seed: {},
      hasSkill: false,
      hasReviewer: false,
      hasScaffoldRegion: false,
      existingInstructions: "restructure",
    });
    expect(p).toContain("<<<MULLION_CONFLICTS_START>>>");
    expect(p).toContain("did not change");
  });
});
