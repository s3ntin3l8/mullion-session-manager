import { describe, expect, it } from "vitest";
import { DROP_DISPOSITIONS, type DropDisposition } from "../../src/shared/constants.js";
import { computeScaffold } from "../../src/services/mullion-scaffold.js";

// Issue #2934. Kept out of mullion-scaffold.test.ts, which sits under the
// 1200-line ceiling with no room for another case.
const body = "# P\n\nIntro.\n\n<<<MULLION_REGION>>>\n\n## Repo specifics\n- make install\n";
const longClaude =
  "# My Project\n\n" +
  Array.from({ length: 200 }, (_, i) => `Rule number ${i}: do the thing.`).join("\n") +
  "\n";

function claude(generated: {
  conflicts?: { file: string; disposition?: DropDisposition }[];
  possiblyLossy?: boolean;
}) {
  const entries = computeScaffold(
    { "CLAUDE.md": longClaude },
    { slug: "demo", generated: { agentsMdBody: body, ...generated } },
  );
  return (entries.find((e) => e.path === "CLAUDE.md") as { contents: string }).contents;
}

describe("CLAUDE.md reduction and deliberate drops (issue #2934)", () => {
  it("reduces when the uncovered passage was dropped on purpose", () => {
    for (const disposition of DROP_DISPOSITIONS) {
      expect(
        claude({
          conflicts: [{ file: "CLAUDE.md", disposition }],
        }),
      ).not.toContain("Rule number");
    }
  });

  it("keeps the body for an unknown disposition and for a lossy rewrite", () => {
    expect(
      claude({ conflicts: [{ file: "CLAUDE.md", disposition: "shrug" as "dropped-obsolete" }] }),
    ).toContain("Rule number 199");
    expect(
      claude({
        possiblyLossy: true,
        conflicts: [{ file: "CLAUDE.md", disposition: "dropped-obsolete" }],
      }),
    ).toContain("Rule number 199");
  });
});
