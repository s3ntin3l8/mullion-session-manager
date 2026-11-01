import { describe, it, expect } from "vitest";
import { buildGenerationPrompt } from "../../src/services/scaffold-generate.js";

// Pins the restructure/report brief's scope and context-budget wording.
describe("buildGenerationPrompt — instruction-file scope and context budget", () => {
  const baseOpts = {
    slug: "demo",
    seed: {},
    hasSkill: false,
    hasReviewer: false,
    hasScaffoldRegion: false,
  };

  it("widens the scope to every instruction file and names the leftover classes generally", () => {
    for (const mode of ["report", "restructure"] as const) {
      const p = buildGenerationPrompt({ ...baseOpts, existingInstructions: mode });
      expect(p).toContain("every file that tells agents or contributors how to work");
      expect(p).toContain("any docs they point to for workflow");
      expect(p).toContain("in any wording or by any mechanism");
      expect(p).toContain("renamed or removed");
      expect(p).toContain("anything else the rewrite makes inconsistent");
      expect(p).toContain("Mullion owns those");
      expect(p).not.toContain("@mention special");
    }
  });

  it("restructure carries the context-budget clause", () => {
    const p = buildGenerationPrompt({ ...baseOpts, existingInstructions: "restructure" });
    expect(p).toContain("every line costs every session");
    expect(p).toContain("cannot get from the repo itself");
    expect(p).toContain("command lists a help target prints");
    expect(p).toContain("Anything needed on every change stays in AGENTS.md");
    expect(p).toContain("one-line pointer left in AGENTS.md saying when to read it");
    expect(p).toContain("never append a duplicate");
  });
});
