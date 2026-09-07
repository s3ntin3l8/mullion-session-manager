// Issue #1130 — a real, live end-to-end check that agy's generation turn
// (scaffold-generate.ts's buildInvocation "agy" case) actually completes
// and actually reads the repo, not just that it stops erroring. The two
// bugs this closes were both invisible to a mocked-spawn unit test: (1) a
// pre-existing argument-parsing bug meant agy silently dropped the real
// prompt and used an unrelated one instead (fixed by attaching the prompt
// to `-p` with `=`, not a separate arg); (2) even with the prompt fixed,
// agy denies every tool call in headless/print mode without
// `--dangerously-skip-permissions` — a turn can complete (exit 0,
// non-empty stdout, even satisfying parseGeneratedOutput's cross-file
// check) while never having actually read anything. A mocked `spawn`
// can't catch either: it never touches the real agy binary or its real
// argument parser/permission gate. This test does, by asserting the
// output actually reflects a specific, contrived invariant seeded into a
// throwaway fixture repo that agy could not have produced without reading
// it.
//
// Same "probe binary presence only, skip cleanly otherwise" idiom as
// test/e2e/opencode-permission-merge.e2e.test.ts's `describeIfOpencode` —
// deliberately NOT scaffold-generate.test.ts's own `describeIfBwrap` gate,
// which runs its probe synchronously at module load. That's free for a
// trivial `/bin/true` bwrap smoke test but would be a real, paid model
// call here if this test's own gate did the same — so this only checks
// that the `agy` binary is on PATH (`agy --version`), never invokes it at
// gate time. Lives in test/e2e/ (opt-in `make test-e2e`, its own CI job),
// not the default `make test` — the real model call this test makes has
// latency and API cost the default fast suite must never pay, and CI's
// own test-e2e job (.github/workflows/ci-cd.yml) does not install/
// authenticate agy, so this test skips cleanly there too, exactly like a
// developer's own machine without agy installed.
//
// This test's own live run (2026-09-07, this repo's own dev box, whose
// `~/.gemini/antigravity-cli/settings.json` carried `agentMode: "plan"` at
// the time) is also the evidence behind `buildInvocation`'s own comment on
// why agy's argv here does NOT add `--mode accept-edits`: reads succeeded
// under `agentMode: "plan"` with just `--dangerously-skip-permissions`,
// so the write-refusal `launch-plan.ts`'s SKIP_PERMISSION_FLAGS.agy entry
// documents (a different, write-capable spawn path) does not reach this
// module's read-only turn.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import type { FastifyInstance } from "fastify";
import { gitEnv } from "../../src/services/git-env.js";
import { LOCAL_HOST_ID } from "../../src/services/host-registry.js";
import { generateScaffoldContent } from "../../src/services/scaffold-generate.js";

function agyAvailable(): boolean {
  try {
    execFileSync("agy", ["--version"], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

const describeIfAgy = agyAvailable() ? describe : describe.skip;

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
}

// A contrived, single-purpose invariant with an unusual, made-up term
// ("Zorb epoch") that would never appear in generated content by chance —
// the ONLY way agy's output could plausibly reference it is by having
// actually read this file, which is exactly what buildGenerationPrompt
// asks for ("this repo's own non-obvious correctness invariants... the
// kind of mistake that looks reasonable in isolation but breaks an
// assumption another part of the codebase depends on") and exactly what
// the pre-fix argument-parsing bug and the pre-fix missing
// --dangerously-skip-permissions flag each independently prevented.
//
// The slug, the fixture's own filename, and the README below deliberately
// share NO vocabulary with "zorb"/"Zorb" — buildGenerationPrompt embeds the
// slug-derived skill/reviewer PATHS (and asks the agent to echo them back
// in frontmatter) directly into the prompt text sent to the agent, so a
// slug like "zorb-demo" would leak the assertion's own target string into
// the model's context before it ever reads a file, letting pure boilerplate
// (e.g. `name: zorb-demo` frontmatter from a blind turn) satisfy the
// assertion below for the wrong reason. Keeping the two vocabularies
// disjoint means "computezorblatency" can only appear in the output by
// having actually read `src/marker.ts`.
const FIXTURE_SOURCE = `// INVARIANT: computeZorbLatency() takes a "Zorb epoch" timestamp
// (milliseconds since 2026-01-01T00:00:00Z), never a Unix-epoch
// timestamp. Passing a Unix-epoch value silently produces a huge
// positive number that a naive caller's own Math.max(0, ...) clamp
// does NOT catch (it is already positive), masking the bug instead of
// surfacing it.
const ZORB_EPOCH_OFFSET_MS = 1767225600000;

export function computeZorbLatency(zorbEpochMs: number): number {
  return Math.max(0, Date.now() - ZORB_EPOCH_OFFSET_MS - zorbEpochMs);
}
`;

function initFixtureRepo(cwd: string) {
  fs.mkdirSync(cwd, { recursive: true });
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "test@example.com"]);
  git(cwd, ["config", "user.name", "Test"]);
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src", "marker.ts"), FIXTURE_SOURCE);
  fs.writeFileSync(
    path.join(cwd, "README.md"),
    "# fixture repo\n\nA throwaway repo whose only real content is src/marker.ts.\n",
  );
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-m", "initial commit", "--no-verify"]);
}

describeIfAgy("agy generation turn actually reads the repo (issue #1130)", () => {
  let repoDir: string;
  const fakeApp = {} as FastifyInstance; // never touched on the LOCAL_HOST_ID path

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "scaffold-generate-agy-e2e-"));
    initFixtureRepo(repoDir);
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it(
    "completes a real turn and reports genuinely repo-specific content, not blind boilerplate",
    async () => {
      const result = await generateScaffoldContent({
        app: fakeApp,
        hostId: LOCAL_HOST_ID,
        cwd: repoDir,
        slug: "widget-demo",
        agentCommand: "agy",
        seed: {},
        hasSkill: false,
        hasReviewer: false,
        hasBriefingRegion: false,
        timeoutMs: 4 * 60 * 1000,
      });

      // The unique compound identifier from src/marker.ts — content only
      // producible by having actually read that file, and never leaked
      // into the agent's context any other way (see FIXTURE_SOURCE's own
      // comment on why the slug shares no vocabulary with it).
      expect(result.skill.toLowerCase()).toContain("computezorblatency");
      // parseGeneratedOutput's own cross-file invariant (the reviewer
      // must name the skill's real path) already held, or
      // generateScaffoldContent would have thrown GenerationOutputError
      // before returning at all — asserted again here so a future
      // change to that check's strictness shows up as a failure in
      // this test too, not just the unit suite.
      expect(result.reviewer).toContain(".claude/skills/widget-demo/SKILL.md");
    },
    5 * 60 * 1000,
  );
});
