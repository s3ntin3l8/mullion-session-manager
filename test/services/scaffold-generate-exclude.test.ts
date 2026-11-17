import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { gitEnv } from "../../src/services/git-env.js";
import { generateScaffoldContent } from "../../src/services/scaffold-generate.js";
import { LOCAL_HOST_ID } from "../../src/services/host-registry.js";

const none = "<<<MULLION_CONFLICTS_START>>>\nnone\n<<<MULLION_CONFLICTS_END>>>\n";

describe("generateScaffoldContent — excludeSkillAndReviewer (issue #2473)", () => {
  // A one-file repo, not process.cwd(): generation checks out a scratch
  // worktree of `cwd`, and checking out this whole repo (~2800 files) can
  // outlast git-worktree's 15s git timeout on a loaded host, which made this
  // test flake in the pre-push gate.
  let repoDir: string;
  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "scaffold-exclude-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repoDir, stdio: "pipe", env: gitEnv() });
    git("init", "-b", "main");
    fs.writeFileSync(path.join(repoDir, "README.md"), "# test repo\n");
    git("add", "-A");
    git("commit", "-m", "initial commit", "--no-verify");
  });
  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it("asks only for the instructions item and needs no region paragraph", async () => {
    const seen: { prompt?: string } = {};
    const r = await generateScaffoldContent({
      app: { config: {} } as never,
      hostId: LOCAL_HOST_ID,
      cwd: repoDir,
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
