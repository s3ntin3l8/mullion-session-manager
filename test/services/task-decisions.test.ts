import { describe, it, expect } from "vitest";
import {
  MAX_DECISION_LINES,
  MAX_DECISION_LINE_LENGTH,
  applyWorkerDecisionsSection,
  extractDeclaredDecisions,
  neutraliseDecisionLine,
  renderWorkerDecisionsSection,
} from "../../src/services/task-decisions.js";

describe("extractDeclaredDecisions", () => {
  it("keeps only body lines that start with a declared prefix", () => {
    const out = extractDeclaredDecisions([
      [
        "feat: x",
        "",
        "Some prose about the change.",
        "Decision: kept the old API",
        "Skipped: the migration",
        "  Deferred: the docs",
        "- Not run locally: e2e",
        "We made a Decision: not at line start",
        "decision: lower case is not a declaration",
      ].join("\n"),
    ]);
    expect(out).toEqual([
      "Decision: kept the old API",
      "Skipped: the migration",
      "Deferred: the docs",
      "Not run locally: e2e",
    ]);
  });

  it("ignores a subject line that happens to start with a prefix", () => {
    expect(extractDeclaredDecisions(["Decision: subject only"])).toEqual([]);
  });

  it("caps the line count and the line length", () => {
    const many = ["feat: x", ...Array.from({ length: 30 }, (_, i) => `Decision: d${i}`)].join("\n");
    expect(extractDeclaredDecisions([many])).toHaveLength(MAX_DECISION_LINES);

    const long = `feat: x\n\nDecision: ${"a".repeat(1000)}`;
    const [line] = extractDeclaredDecisions([long]);
    expect(line).toHaveLength(MAX_DECISION_LINE_LENGTH);
    expect(line.endsWith("…")).toBe(true);
  });

  it("redacts secrets, including one that would straddle the length cut", () => {
    const token = "sk-ant-" + "x".repeat(40);
    const [plain] = extractDeclaredDecisions([`feat: x\n\nDecision: used ${token} to test`]);
    expect(plain).toContain("[redacted]");
    expect(plain).not.toContain(token);

    const padded = `Decision: ${"a".repeat(MAX_DECISION_LINE_LENGTH - 15)} ${token}`;
    const [cut] = extractDeclaredDecisions([`feat: x\n\n${padded}`]);
    expect(cut).not.toContain("sk-ant");
  });
});

describe("worker decisions PR section", () => {
  it("renders nothing for no decisions", () => {
    expect(renderWorkerDecisionsSection([])).toBe("");
  });

  it("inserts above the Task Master footer, then replaces in place", () => {
    const body = "Issue text\n\nCloses #1\n\n---\nOpened by Mullion Task Master.";
    const once = applyWorkerDecisionsSection(body, ["Decision: a"]);
    expect(once).toContain("### Worker decisions\n\n- Decision: a");
    expect(once.indexOf("Worker decisions")).toBeLessThan(once.indexOf("Opened by Mullion"));
    const twice = applyWorkerDecisionsSection(once, ["Decision: b"]);
    expect(twice).toContain("- Decision: b");
    expect(twice).not.toContain("Decision: a");
    expect(twice.match(/Worker decisions/g)).toHaveLength(1);
  });

  it("removes the section when nothing is declared any more, and leaves other bodies alone", () => {
    const withSection = applyWorkerDecisionsSection("Text\n\n---\nfooter", ["Decision: a"]);
    expect(applyWorkerDecisionsSection(withSection, [])).toBe("Text\n\n---\nfooter");
    expect(applyWorkerDecisionsSection("Plain body", [])).toBe("Plain body");
    expect(applyWorkerDecisionsSection("Plain body", ["Skipped: x"])).toContain("Plain body");
  });

  it("neutralises mentions, comment markers, HTML tags and markdown links/images", () => {
    const raw =
      "Decision: ping @someone and @org/team, handle <!-- /mullion:worker-decisions -->, escape <script>alert(1)</script> and [link](https://example.com) and ![img](https://example.com/p.png)";
    const safe = neutraliseDecisionLine(raw);
    expect(safe).not.toContain("@someone");
    expect(safe).toContain("@\u200Bsomeone");
    expect(safe).toContain("@\u200Borg/team");
    expect(safe).not.toContain("<!--");
    expect(safe).not.toContain("-->");
    expect(safe).toContain("&lt;!-- /mullion:worker-decisions --&gt;");
    expect(safe).not.toContain("<script>");
    expect(safe).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(safe).toContain("\\[link\\](https://example.com)");
    expect(safe).toContain("!\\[img\\](https://example.com/p.png)");
  });

  it("renders harmless lines with mentions, markers, HTML and markdown links, and refresh replaces only the section", () => {
    const body = "Initial issue body\n\nCloses #42\n\n---\nOpened by Mullion Task Master.";
    const decisions = [
      "Decision: pinged @someone for feedback",
      "Skipped: <!-- /mullion:worker-decisions --> close attempt",
      "Deferred: <div class='alert'>HTML content</div> and [docs](https://example.com/guide)",
    ];
    const rendered = applyWorkerDecisionsSection(body, decisions);

    // Each renders harmlessly
    expect(rendered).not.toContain("@someone");
    expect(rendered).toContain("@\u200Bsomeone");
    expect(rendered).toContain("&lt;!-- /mullion:worker-decisions --&gt;");
    // Ensure the section only has exactly one SECTION_START and one SECTION_END
    expect(rendered.match(/<!-- mullion:worker-decisions -->/g)).toHaveLength(1);
    expect(rendered.match(/<!-- \/mullion:worker-decisions -->/g)).toHaveLength(1);
    expect(rendered).not.toContain("<div");
    expect(rendered).toContain("&lt;div class='alert'&gt;HTML content&lt;/div&gt;");
    expect(rendered).toContain("\\[docs\\](https://example.com/guide)");

    // Refresh replaces only the section
    const refreshed = applyWorkerDecisionsSection(rendered, ["Decision: fresh decision only"]);
    expect(refreshed).toContain("- Decision: fresh decision only");
    expect(refreshed).not.toContain("@someone");
    expect(refreshed).not.toContain("&lt;!-- /mullion:worker-decisions --&gt;");
    expect(refreshed).not.toContain("HTML content");
    expect(refreshed.match(/Worker decisions/g)).toHaveLength(1);
    expect(refreshed).toContain("Initial issue body\n\nCloses #42");
    expect(refreshed).toContain("---\nOpened by Mullion Task Master.");
  });

  it("still replaces exactly the section it wrote after a body that contains lookalike markers", () => {
    const bodyWithLookalikes = [
      "Issue discussing <!-- /mullion:worker-decisions --> closing issues",
      "and also mentioning <!-- mullion:worker-decisions --> unclosed markers.",
      "",
      "Closes #99",
      "",
      "---",
      "Opened by Mullion Task Master.",
    ].join("\n");

    const withSection = applyWorkerDecisionsSection(bodyWithLookalikes, [
      "Decision: initial decision",
    ]);
    expect(withSection).toContain("Issue discussing <!-- /mullion:worker-decisions -->");
    expect(withSection).toContain("<!-- mullion:worker-decisions --> unclosed markers.");
    expect(withSection).toContain("- Decision: initial decision");

    const updated = applyWorkerDecisionsSection(withSection, ["Decision: updated decision"]);
    expect(updated).toContain("- Decision: updated decision");
    expect(updated).not.toContain("Decision: initial decision");
    expect(updated).toContain("Issue discussing <!-- /mullion:worker-decisions -->");
    expect(updated).toContain("<!-- mullion:worker-decisions --> unclosed markers.");
    expect(updated.match(/Worker decisions/g)).toHaveLength(1);

    const cleared = applyWorkerDecisionsSection(updated, []);
    expect(cleared).not.toContain("Worker decisions");
    expect(cleared).toContain("Issue discussing <!-- /mullion:worker-decisions -->");
    expect(cleared).toContain("<!-- mullion:worker-decisions --> unclosed markers.");
  });

  it("leaves a line-start marker pair quoted in the issue body intact", () => {
    const issue = [
      "<!-- mullion:worker-decisions -->",
      "ISSUE-TEXT-THAT-MUST-SURVIVE",
      "<!-- /mullion:worker-decisions -->",
      "more issue prose",
    ].join("\n");
    const body = `${issue}\n\nCloses #99\n\n---\nOpened by Mullion Task Master.`;
    const withSection = applyWorkerDecisionsSection(body, ["Decision: x"]);
    expect(withSection).toContain("ISSUE-TEXT-THAT-MUST-SURVIVE");
    expect(withSection).toContain("more issue prose");
    expect(withSection).toContain("- Decision: x");
    // Heading deleted: still our block, replaced in place, issue text kept.
    const noHeading = withSection.replace("### Worker decisions\n", "");
    const updated = applyWorkerDecisionsSection(noHeading, ["Decision: y"]);
    expect(updated).toContain("ISSUE-TEXT-THAT-MUST-SURVIVE");
    expect(updated).toContain("- Decision: y");
    expect(updated).not.toContain("Decision: x");
    const cleared = applyWorkerDecisionsSection(updated, []);
    expect(cleared).toContain("ISSUE-TEXT-THAT-MUST-SURVIVE");
    expect(cleared).not.toContain("Decision: y");
    // No section written yet: only the issue's pair exists, and it is not touched.
    expect(applyWorkerDecisionsSection(body, [])).toBe(body);
  });

  it("still replaces or removes a section whose heading was edited", () => {
    const first = applyWorkerDecisionsSection("Issue body\n\n---\nfooter", ["Decision: a"]);
    const renamed = first.replace("### Worker decisions", "### Decisions the worker made");
    const updated = applyWorkerDecisionsSection(renamed, ["Decision: b"]);
    expect(updated).toContain("- Decision: b");
    expect(updated).not.toContain("Decision: a");
    expect(updated.match(/<!-- mullion:worker-decisions -->/g)).toHaveLength(1);
    expect(updated).toContain("\n\n---\nfooter");
    const cleared = applyWorkerDecisionsSection(renamed, []);
    expect(cleared).not.toContain("mullion:worker-decisions");
    expect(cleared).toContain("Issue body");
    expect(cleared).toContain("\n\n---\nfooter");
  });

  it.each([
    ["bold text", (b: string) => b.replace("### Worker decisions", "**Worker decisions**")],
    ["a deleted heading line", (b: string) => b.replace("### Worker decisions\n\n", "")],
    ["a blank line before the heading", (b: string) => b.replace("### Worker", "\n### Worker")],
  ])("replaces or removes a section whose heading became %s", (_name, edit) => {
    const first = applyWorkerDecisionsSection("Issue body\n\nCloses #7\n\n---\nfooter", [
      "Decision: a",
    ]);
    const edited = edit(first);
    const updated = applyWorkerDecisionsSection(edited, ["Decision: b"]);
    expect(updated).toContain("- Decision: b");
    expect(updated).not.toContain("Decision: a");
    expect(updated.match(/<!-- mullion:worker-decisions -->/g)).toHaveLength(1);
    expect(updated).toContain("\n\n---\nfooter");
    const cleared = applyWorkerDecisionsSection(edited, []);
    expect(cleared).not.toContain("mullion:worker-decisions");
    expect(cleared).toContain("Closes #7");
    expect(cleared).toContain("\n\n---\nfooter");
  });
});
