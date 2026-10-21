// `make review` falls back to an `@s3ntin3l8-hermes Review` comment when the
// relay is not there at all — but NOT when the relay REFUSED. A refusal
// answered with a comment dispatches another review, queued behind the one
// that is already running, which is how the reviews piled up.
//
// The guard is a list of phrases in the Makefile, and the refusals are prose
// in the relay's error messages. Nothing kept them in step, so this test
// does: every refusal the relay can answer with must be matched by the
// Makefile's guard, or `make review` would answer it with a comment.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The refusals `mullion review` can answer with, and what the CLI prints. */
const REFUSALS: Array<{ what: string; message: string }> = [
  {
    what: "the commit was requested recently (the cooldown)",
    message:
      "A review of this commit (abc1234) was requested recently — wait 60s before requesting another",
  },
  {
    what: "a review of the pull request is already in flight",
    message:
      "A review of this pull request is already in flight (run run_1) — wait for it, or stop it with stop_review",
  },
  {
    what: "a triage of the issue is already in flight",
    message:
      "A triage of this issue is already in flight (run run_1) — wait for it, or stop it with stop_review",
  },
  {
    what: "the commit was already reviewed",
    message:
      "A review of this commit already landed (at abc1234) — there is nothing new to review.",
  },
  {
    what: "Hermes already holds a run for the range",
    message:
      "A review of this commit was already requested (possibly by the repository's own workflow) — wait for it instead of requesting again",
  },
  {
    what: "the request was replayed (the range is already being reviewed)",
    message: "no new review started for acme/widgets#7: Hermes returned the earlier run run_1",
  },
  {
    what: "Hermes refused the request (its concurrent-run cap)",
    message: "Hermes API returned HTTP 429 — review not dispatched",
  },
  {
    what: "every attempt for the range failed",
    message: "The review could not be started — every attempt for this range failed",
  },
  {
    what: "every session for the pull request was refused",
    message: "The review could not be started — Hermes refused every session for this pull request",
  },
  {
    what: "the pull request's review session is stuck",
    message:
      "Hermes refused the turn for the review session of this pull request (hermes-review-acme-widgets-7-2) — that session is stuck and refuses every later round. The relay retries in a fresh session; asking again is not the way out of it.",
  },
];

function guardPatterns(): string {
  const makefile = fs.readFileSync(path.join(repoRoot, "Makefile"), "utf8");
  const match = makefile.match(/grep -qiE "([^"]+)"/);
  if (!match) throw new Error("the make review fallback guard no longer greps for phrases");
  return match[1];
}

describe("the make review fallback guard", () => {
  it("matches every refusal the relay can answer with", () => {
    const patterns = guardPatterns();
    for (const { what, message } of REFUSALS) {
      // The guard greps case-insensitively; -E is extended regex.
      const matched = execFileSync("grep", ["-qiE", patterns, "-"], {
        input: message,
        encoding: "utf8",
      });
      expect(matched, `the guard does not match: ${what}`).toBe("");
    }
  });

  it("still lets a genuine 'no relay here' failure fall back", () => {
    // The one failure that SHOULD fall back: the relay is not configured, so
    // the @mention comment is the only way to get a review at all.
    const patterns = guardPatterns();
    const notConfigured = "The Hermes review relay is not configured — choose Hermes in Settings";
    let matched = true;
    try {
      execFileSync("grep", ["-qiE", patterns, "-"], { input: notConfigured, encoding: "utf8" });
    } catch {
      matched = false;
    }
    expect(matched).toBe(false);
  });
});
