#!/usr/bin/env node
// Merges a pull request the way this repo's branch protection actually
// demands, instead of the way that races it.
//
// The race this exists for: right after a force-push, `gh pr view
// --json statusCheckRollup` can report an EMPTY rollup — the new head's
// checks have not registered yet — and `mergeable` can still be
// "UNKNOWN" while GitHub recomputes it. A script that reads "0 pending
// checks" as "ready" then asks to merge, and GitHub refuses with
// "Pull Request is not mergeable (mergePullRequest)". That refusal is not
// wrong, and retrying it is not the fix: the state was simply read too
// early.
//
// So this waits for the state to be MEANINGFUL — a non-empty rollup with
// every check reported, and a mergeability GitHub has finished computing —
// and only then merges. If the PR is behind the base (this repo's
// protection is `required_status_checks.strict: true`, so the head must
// contain the base), it rebases onto the latest `origin/main` and pushes
// again — the pre-push hook re-runs the gate, so the wait after that is
// the hook's, not this script's.
//
// Usage:
//   node scripts/merge-pr.mjs [<pr-number>]
//
// Flags:
//   --no-rebase    do not rebase when the PR is behind the base; report it
//   --timeout <s>  how long to wait for the checks to settle (default 30m)
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

// Every gh call goes through here so a bad PR number, an unauthenticated
// `gh`, or a missing PR surfaces as a short readable message instead of a
// raw Node stack trace.
function gh(args) {
  try {
    return execFileSync("gh", args, { encoding: "utf8" });
  } catch (err) {
    const stderr = err.stderr?.toString().trim();
    throw new Error(stderr || err.message, { cause: err });
  }
}

/** The PR fields this script reads. */
const PR_FIELDS = ["number", "headRefName", "mergeable", "mergeStateStatus", "statusCheckRollup"];

export function readPr(prNumber) {
  const args = ["pr", "view", prNumber, "--json", PR_FIELDS.join(",")];
  return JSON.parse(gh(args));
}

/**
 * What to do about a PR, given the state `gh pr view` reports.
 *
 * The distinction that matters is between "not ready YET" and "not ready
 * EVER": an empty rollup or an UNKNOWN mergeability means GitHub has not
 * finished computing, and waiting is right; a failed check or a conflict
 * means waiting is pointless, and the caller should be told.
 *
 * Returns `{ action, reason }` where action is one of:
 *   "merge"  — everything is green and the head contains the base
 *   "wait"   — GitHub has not finished; poll again
 *   "rebase" — the head does not contain the base
 *   "stop"   — a check failed, or the PR conflicts; do not retry
 */
export function mergeReadiness(pr) {
  const rollup = pr.statusCheckRollup ?? [];

  // The race: an empty rollup means the new head's checks have not
  // registered yet, NOT that everything passed.
  if (rollup.length === 0) {
    return { action: "wait", reason: "no status checks have reported yet" };
  }

  const running = rollup.filter((c) => c.status !== "COMPLETED");
  if (running.length > 0) {
    return {
      action: "wait",
      reason: `${running.length} check(s) still running: ${running.map((c) => c.name).join(", ")}`,
    };
  }

  const failed = rollup.filter(
    (c) => !["SUCCESS", "SKIPPED", "NEUTRAL"].includes(c.conclusion ?? ""),
  );
  if (failed.length > 0) {
    return {
      action: "stop",
      reason: `${failed.length} check(s) failed: ${failed
        .map((c) => `${c.name} (${c.conclusion})`)
        .join(", ")}`,
    };
  }

  if (pr.mergeable === "CONFLICTING") {
    return { action: "stop", reason: "the PR conflicts with the base" };
  }

  // GitHub is still working out whether this can merge. `mergeable` is
  // "UNKNOWN" while it computes.
  if (pr.mergeable === "UNKNOWN" || pr.mergeStateStatus === "UNKNOWN") {
    return { action: "wait", reason: "GitHub has not finished computing mergeability" };
  }

  // `strict: true` on this repo's required status checks means the head must
  // CONTAIN the base — a behind head is refused even with green checks.
  if (pr.mergeStateStatus === "BEHIND") {
    return {
      action: "rebase",
      reason: "the head does not contain the base",
      branch: pr.headRefName,
    };
  }

  if (pr.mergeStateStatus === "BLOCKED" || pr.mergeStateStatus === "DRAFT") {
    return { action: "stop", reason: `merge state is ${pr.mergeStateStatus}` };
  }

  if (pr.mergeable !== "MERGEABLE") {
    return { action: "stop", reason: `mergeable is ${pr.mergeable}` };
  }

  return { action: "merge", reason: "checks are green and the head contains the base" };
}

export function waitForReady(prNumber, { timeoutMs = 30 * 60_000, intervalMs = 30_000, log } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pr = readPr(prNumber);
    const readiness = mergeReadiness(pr);
    if (readiness.action !== "wait") return { pr, readiness };
    if (Date.now() >= deadline) {
      return {
        pr,
        readiness: { action: "stop", reason: `timed out waiting: ${readiness.reason}` },
      };
    }
    log?.(`waiting: ${readiness.reason}`);
    execFileSync("sleep", [String(Math.ceil(intervalMs / 1000))]);
  }
}

export function mergePr(prNumber) {
  gh(["pr", "merge", prNumber, "--squash"]);
}

/** Rebase the PR's branch onto the latest origin/main and push it. */
export function rebaseAndPush(branch) {
  execFileSync("git", ["fetch", "origin"], { stdio: "inherit" });
  // Rebase the named branch explicitly rather than whatever HEAD happens to
  // be — the script may be run from outside the branch's worktree.
  execFileSync("git", ["rebase", "origin/main", branch], { stdio: "inherit" });
  execFileSync("git", ["push", "--force-with-lease"], { stdio: "inherit" });
}

function currentPrNumber() {
  const out = gh(["pr", "view", "--json", "number", "-q", ".number"]).trim();
  if (!out) throw new Error("No PR found for the current branch — pass a PR number explicitly.");
  return out;
}

export function cli(argv = process.argv.slice(2)) {
  const allowRebase = !argv.includes("--no-rebase");
  const timeoutArg = argv.indexOf("--timeout");
  const timeoutMs = timeoutArg >= 0 ? Number(argv[timeoutArg + 1]) * 1000 : 30 * 60_000;

  const prNumber = argv.find((a) => /^\d+$/.test(a)) ?? currentPrNumber();
  const log = (msg) => console.log(`merge-pr: ${msg}`);

  let { readiness } = waitForReady(prNumber, { timeoutMs, log });
  if (readiness.action === "rebase" && allowRebase) {
    log(`${readiness.reason} — rebasing onto origin/main and pushing`);
    rebaseAndPush(readiness.branch);
    log("pushed; waiting for the checks to settle again");
    ({ readiness } = waitForReady(prNumber, { timeoutMs, log }));
  }

  if (readiness.action !== "merge") {
    console.error(`ERROR: ${readiness.reason}`);
    return 1;
  }
  log(readiness.reason);
  mergePr(prNumber);
  console.log(`merge-pr: merged #${prNumber} (squash)`);
  return 0;
}

if (isMain) {
  try {
    process.exit(cli());
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
}
