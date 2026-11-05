import { describe, it, expect } from "vitest";
import {
  MAX_DECISION_LINES,
  MAX_DECISION_LINE_LENGTH,
  applyWorkerDecisionsSection,
  extractDeclaredDecisions,
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
});
