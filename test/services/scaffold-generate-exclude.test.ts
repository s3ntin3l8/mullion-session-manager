import { describe, it, expect } from "vitest";
import { generateScaffoldContent } from "../../src/services/scaffold-generate.js";
import { LOCAL_HOST_ID } from "../../src/services/host-registry.js";

const none = "<<<MULLION_CONFLICTS_START>>>\nnone\n<<<MULLION_CONFLICTS_END>>>\n";

describe("generateScaffoldContent — excludeSkillAndReviewer (issue #2473)", () => {
  it("asks only for the instructions item and needs no region paragraph", async () => {
    const seen: { prompt?: string } = {};
    const r = await generateScaffoldContent({
      app: { config: {} } as never,
      hostId: LOCAL_HOST_ID,
      cwd: process.cwd(),
      slug: "demo",
      agentCommand: "claude",
      seed: {},
      hasSkill: false,
      hasReviewer: false,
      hasScaffoldRegion: false,
      existingInstructions: "report",
      excludeSkillAndReviewer: true,
      spawn: async (o) => {
        seen.prompt = o.prompt;
        return none;
      },
    });
    expect(seen.prompt).not.toMatch(/SCAFFOLD_REGION|SKILL\.md|-reviewer\.md/);
    expect(seen.prompt).toContain("1. A conflicts report");
    expect(r.skill).toBeUndefined();
    expect(r.reviewer).toBeUndefined();
    expect(r.scaffoldRegion).toBe("");
  });
});
