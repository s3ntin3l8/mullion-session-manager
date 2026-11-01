// Issue #2535 — a live-agent regression net for scaffold generation.
//
// The bugs that cost the most (#2430: empty credential seeding; #2472: codex's
// own sandbox failing inside Mullion's) passed every unit test, because the unit
// tests mock the agent process, and showed up as a "successful" preview written
// without reading the repository. Only a real agent can catch that class.
//
// Two layers: `runGenerationTurnInScratchWorktree` already fails any turn that
// does not echo its canary file (scaffold-canary.ts), so a green run here means
// the agent really read the repo through Mullion's sandbox; the assertions below
// then check the content is repo-specific and that report/restructure surface
// the planted contradiction.
//
// Skipped unless MULLION_LIVE_AGENT_E2E=1 AND the agent binary exists: these are
// paid model calls and need the operator's own credentials, so neither CI nor a
// plain `make test-e2e` runs them. Run one with:
//   MULLION_LIVE_AGENT_E2E=1 npx vitest run -c vitest.e2e.config.ts scaffold-generate-live
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import type { FastifyInstance } from "fastify";
import { gitEnv } from "../../src/services/git-env.js";
import { LOCAL_HOST_ID } from "../../src/services/host-registry.js";
import { generateScaffoldContent } from "../../src/services/scaffold-generate.js";

function agentAvailable(bin: string): boolean {
  if (process.env.MULLION_LIVE_AGENT_E2E !== "1") return false;
  try {
    execFileSync(bin, ["--version"], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
}

// The slug, file names and README share no vocabulary with "zorb": the prompt
// embeds the slug-derived paths, so a slug like "zorb-demo" would let blind
// boilerplate satisfy the assertion (see scaffold-generate-agy.e2e.test.ts).
const FIXTURE_SOURCE = `// INVARIANT: computeZorbLatency() takes a "Zorb epoch" timestamp
// (milliseconds since 2026-01-01T00:00:00Z), never a Unix-epoch timestamp.
const ZORB_EPOCH_OFFSET_MS = 1767225600000;
export function computeZorbLatency(zorbEpochMs: number): number {
  return Math.max(0, Date.now() - ZORB_EPOCH_OFFSET_MS - zorbEpochMs);
}
`;

const CONVENTIONS = [
  "Never commit directly to the default branch. Always branch and open a PR.",
  "Request a review through the review relay (`request_review`). Never re-trigger a review by mentioning the review bot.",
].join("\n\n");

function initFixtureRepo(cwd: string) {
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  git(cwd, ["init", "-b", "main"]);
  fs.writeFileSync(path.join(cwd, "src", "marker.ts"), FIXTURE_SOURCE);
  fs.writeFileSync(path.join(cwd, "README.md"), "# fixture repo\n\nOnly src/marker.ts matters.\n");
  fs.writeFileSync(
    path.join(cwd, "AGENTS.md"),
    "# AGENTS.md\n\nRun `npm test` before pushing. See src/marker.ts for the timestamp rule.\n",
  );
  // The planted contradiction with CONVENTIONS, outside AGENTS.md.
  fs.writeFileSync(
    path.join(cwd, "CONTRIBUTING.md"),
    "# Contributing\n\nTo get a review, comment `@review-bot please review` on your pull request.\n",
  );
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-m", "initial commit", "--no-verify"]);
}

for (const agent of ["claude", "codex"]) {
  const describeIfAgent = agentAvailable(agent) ? describe : describe.skip;

  describeIfAgent(
    `${agent} generation turn reads the repo through the sandbox (issue #2535)`,
    () => {
      let repoDir: string;
      const app = {} as FastifyInstance; // never touched on the LOCAL_HOST_ID path

      beforeEach(() => {
        repoDir = fs.mkdtempSync(path.join(os.tmpdir(), `scaffold-live-${agent}-`));
        initFixtureRepo(repoDir);
      });
      afterEach(() => fs.rmSync(repoDir, { recursive: true, force: true }));

      const generate = (existingInstructions: "keep" | "report" | "restructure") =>
        generateScaffoldContent({
          app,
          hostId: LOCAL_HOST_ID,
          cwd: repoDir,
          slug: "widget-demo",
          agentCommand: agent,
          seed: {},
          hasSkill: false,
          hasReviewer: false,
          hasScaffoldRegion: false,
          existingInstructions,
          conventionsText: CONVENTIONS,
          originalAgentsMd: fs.readFileSync(path.join(repoDir, "AGENTS.md"), "utf8"),
          timeoutMs: 6 * 60 * 1000,
        });

      it(
        "keep: writes content that reflects the repository",
        async () => {
          const result = await generate("keep");
          expect(result.skill!.toLowerCase()).toContain("computezorblatency");
        },
        7 * 60 * 1000,
      );

      it(
        "report: names the contradicting CONTRIBUTING.md passage",
        async () => {
          const result = await generate("report");
          expect(result.conflicts?.some((c) => /CONTRIBUTING/i.test(c.file))).toBe(true);
        },
        7 * 60 * 1000,
      );

      it(
        "restructure: rewrites AGENTS.md and still reports the passage it left alone",
        async () => {
          const result = await generate("restructure");
          expect(result.agentsMdBody).toBeTruthy();
          expect(result.conflicts?.some((c) => /CONTRIBUTING/i.test(c.file))).toBe(true);
        },
        7 * 60 * 1000,
      );
    },
  );
}
