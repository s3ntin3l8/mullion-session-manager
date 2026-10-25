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
import { GIT_NO_AUTO_GC, gitEnv } from "./git-env.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

/** A bad command line — distinct from a merge that did not happen. */
class UsageError extends Error {}

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
const PR_FIELDS = [
  "number",
  "headRefName",
  "mergeable",
  "mergeStateStatus",
  "statusCheckRollup",
  // Why the PR is blocked is not always a check: GitHub uses the same
  // BLOCKED state for an unmet review requirement, for UNRESOLVED
  // REQUIRED CONVERSATIONS, and for a required check that never got
  // scheduled. reviewDecision names the first of those.
  "reviewDecision",
  // The PR's own URL carries the owner and repository name, which the
  // GraphQL query below needs. Deriving them from the PR beats hardcoding
  // them: a fork, a renamed repo, or a second checkout would otherwise
  // query the wrong repository and read the wrong conversation state.
  "url",
];

export function readPr(prNumber) {
  const args = ["pr", "view", prNumber, "--json", PR_FIELDS.join(",")];
  const pr = JSON.parse(gh(args));
  // `gh pr view` cannot see whether review conversations are resolved, and
  // this repo's `required_conversation_resolution` blocks the merge on an
  // unresolved one — so the count comes from GraphQL.
  pr.unresolvedConversations = unresolvedConversationCount(prNumber, repoSlug(pr.url));
  return pr;
}

/**
 * The owner and repository name, taken from a PR's URL.
 *
 * Returns null when the URL does not have the expected shape, so a caller
 * can decide what to do instead of querying a repository guessed wrong.
 */
export function repoSlug(prUrl) {
  const match = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/\d+/.exec(prUrl ?? "");
  if (!match) return null;
  return { owner: match[1], name: match[2] };
}

/**
 * How many review conversations on the PR are still unresolved.
 *
 * Only GraphQL knows: `gh pr view --json` has no thread resolution, and a
 * legacy commit status has no equivalent field. An unresolved conversation
 * blocks the merge until a human resolves it, so a wait will never clear it
 * — the caller has to know that, not discover it after the timeout.
 */
export function unresolvedConversationCount(prNumber, slug) {
  // Without a slug the query would target a guessed repository; report "none
  // known" rather than an authoritative-looking zero.
  if (!slug) return 0;
  const query = `query($owner:String!,$name:String!,$num:Int!){
    repository(owner:$owner,name:$name){
      pullRequest(number:$num){
        reviewThreads(first:100){ nodes{ isResolved } }
      }
    }
  }`;
  const out = gh([
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    "-F",
    `owner=${slug.owner}`,
    "-F",
    `name=${slug.name}`,
    "-F",
    `num=${prNumber}`,
  ]);
  const data = JSON.parse(out);
  const nodes = data?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  return nodes.filter((n) => !n.isResolved).length;
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

  // A rollup entry is one of two shapes. A CheckRun (an Actions run)
  // carries `status` and `conclusion`; a StatusContext (a legacy commit
  // status) carries `state` and no conclusion. GitHub emits "CheckRun" and
  // "StatusContext" — there is no "StatusCheck" in that union.
  //
  // So branch on the LEGACY shape and treat everything else as a check: an
  // unknown typename must never be read as "no conclusion", or a queued
  // check reads as failed and the script stops on a bogus failure report
  // instead of waiting.
  const isLegacyStatus = (c) => c.__typename === "StatusContext";

  // A legacy status still in flight is PENDING; a check still in flight is
  // anything but COMPLETED. Both are "wait", never "stop".
  const running = rollup.filter((c) =>
    isLegacyStatus(c) ? c.state === "PENDING" : c.status !== "COMPLETED",
  );
  if (running.length > 0) {
    return {
      action: "wait",
      reason: `${running.length} check(s) still running: ${running
        .map((c) => c.name ?? c.context)
        .join(", ")}`,
    };
  }

  const failed = rollup.filter((c) => {
    if (isLegacyStatus(c)) {
      // A legacy commit status: SUCCESS, FAILURE, ERROR, PENDING. Anything
      // but success (PENDING is already counted as running) is a failure.
      return c.state !== "SUCCESS" && c.state !== "PENDING";
    }
    return !["SUCCESS", "SKIPPED", "NEUTRAL"].includes(c.conclusion ?? "");
  });
  if (failed.length > 0) {
    return {
      action: "stop",
      reason: `${failed.length} check(s) failed: ${failed
        .map((c) => `${c.name ?? c.context} (${c.conclusion ?? c.state})`)
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

  if (pr.mergeStateStatus === "BLOCKED") {
    // BLOCKED with no failed check in the rollup means a REQUIRED check has
    // not reported on THIS head yet. Right after a push the rollup can
    // still hold the PREVIOUS head's green checks while the new ones
    // register — and GitHub calls the state BLOCKED throughout. That is
    // "not ready yet", not "not ready ever": a genuinely failed check was
    // already caught above, by the rollup itself.
    // A review decision that needs a HUMAN is not a wait — the script
    // cannot fix a CHANGES_REQUESTED or satisfy a REVIEW_REQUIRED, and
    // burning the whole timeout on it helps nobody.
    const decision = pr.reviewDecision || "none";
    // An unresolved review conversation blocks the merge until a human
    // resolves it. Waiting will not clear it, so say so instead of sitting
    // out the timeout on a state that cannot change.
    if ((pr.unresolvedConversations ?? 0) > 0) {
      return {
        action: "stop",
        reason:
          `${pr.unresolvedConversations} unresolved review conversation(s) — ` +
          `a human has to resolve them`,
      };
    }
    if (decision === "CHANGES_REQUESTED" || decision === "REVIEW_REQUIRED") {
      return {
        action: "stop",
        reason: `the review decision is ${decision} — that needs a human, not a wait`,
      };
    }
    return {
      action: "wait",
      reason:
        `blocked, and no check has failed — review decision is ` +
        `"${decision}". This state also covers ` +
        `unresolved required conversations and a required check that never ` +
        `got scheduled, so a wait here is not necessarily a check that has ` +
        `not reported.`,
    };
  }

  if (pr.mergeStateStatus === "DRAFT") {
    return { action: "stop", reason: "merge state is DRAFT" };
  }

  if (pr.mergeable !== "MERGEABLE") {
    return { action: "stop", reason: `mergeable is ${pr.mergeable}` };
  }

  return { action: "merge", reason: "checks are green and the head contains the base" };
}

export function waitForReady(
  prNumber,
  { timeoutMs = 30 * 60_000, intervalMs = 30_000, log, deadline = null } = {},
) {
  // An explicit `deadline` wins over `timeoutMs`, so a second wait after a
  // rebase can share ONE budget instead of arming a fresh full one (which
  // would make the documented worst case double).
  const until = deadline ?? Date.now() + timeoutMs;
  for (;;) {
    const pr = readPr(prNumber);
    const readiness = mergeReadiness(pr);
    if (readiness.action !== "wait") return { pr, readiness };
    if (Date.now() >= until) {
      return {
        pr,
        readiness: { action: "stop", reason: `timed out waiting: ${readiness.reason}` },
      };
    }
    log?.(`waiting: ${readiness.reason}`);
    // A blocking sleep without a POSIX binary: Atomics.wait parks this
    // thread for exactly the interval, with no external program to depend
    // on. It never sleeps PAST the deadline — otherwise a 1s timeout would
    // still take a full 30s interval to give up.
    const remaining = until - Date.now();
    Atomics.wait(
      new Int32Array(new SharedArrayBuffer(4)),
      0,
      0,
      Math.max(0, Math.min(intervalMs, remaining)),
    );
  }
}

export function mergePr(prNumber) {
  gh(["pr", "merge", prNumber, "--squash"]);
}

/**
 * Rebase the PR's branch onto the latest origin/main and push it.
 *
 * Every git child process scrubs the ambient git environment (gitEnv()).
 * That is not a nicety here: a GIT_DIR leaked from an outer hook
 * retargets `git fetch` / `git rebase` / `git push` at a DIFFERENT
 * checkout — and for a script whose whole job is to force-push a rebase,
 * that is the worst possible call site to get it wrong. The repo enforces
 * it for every git spawn under src/, test/ and scripts/ (issue #1602,
 * extended to scripts/ by #1649 — see test/git-env-guard.test.ts).
 */
export function rebaseAndPush(branch) {
  execFileSync("git", [...GIT_NO_AUTO_GC, "fetch", "origin"], { stdio: "inherit", env: gitEnv() });
  // Name the branch explicitly, for BOTH the rebase and the push — the
  // script may be run from outside the branch's worktree, and pushing
  // "whatever HEAD happens to be" is not the same thing.
  execFileSync("git", [...GIT_NO_AUTO_GC, "rebase", "origin/main", branch], {
    stdio: "inherit",
    env: gitEnv(),
  });
  execFileSync("git", [...GIT_NO_AUTO_GC, "push", "--force-with-lease", "origin", branch], {
    stdio: "inherit",
    env: gitEnv(),
  });
}

function currentPrNumber() {
  const out = gh(["pr", "view", "--json", "number", "-q", ".number"]).trim();
  if (!out) throw new Error("No PR found for the current branch — pass a PR number explicitly.");
  return out;
}

/**
 * Parses the CLI arguments.
 *
 * The positional PR number has to be found by SKIPPING the flag values —
 * a plain `argv.find(a => /^\d+$/.test(a))` picks up the number after
 * `--timeout` and then waits on, and squash-merges, the wrong PR.
 */
export function parseArgs(argv) {
  const positionals = [];
  let allowRebase = true;
  let timeoutSeconds;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--no-rebase") {
      allowRebase = false;
    } else if (arg === "--timeout") {
      const raw = argv[i + 1];
      const seconds = Number(raw);
      // A missing or non-numeric value would make the deadline NaN, and
      // `Date.now() >= NaN` is never true — so the wait would never time
      // out. Refuse the flag instead.
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new UsageError(
          `--timeout needs a positive number of seconds, got ${raw ?? "(nothing)"}`,
        );
      }
      timeoutSeconds = seconds;
      i++;
    } else if (arg.startsWith("--timeout=")) {
      const raw = arg.slice("--timeout=".length);
      const seconds = Number(raw);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new UsageError(`--timeout needs a positive number of seconds, got ${raw}`);
      }
      timeoutSeconds = seconds;
    } else if (/^\d+$/.test(arg)) {
      positionals.push(arg);
    } else {
      throw new UsageError(`unknown argument: ${arg}`);
    }
  }

  // Exactly one PR number, or none (meaning "the current branch's PR").
  // Silently ignoring a second one would merge a different PR than the
  // caller named.
  if (positionals.length > 1) {
    throw new UsageError(
      `expected at most one PR number, got ${positionals.length} (${positionals.join(", ")})`,
    );
  }

  return {
    prNumber: positionals[0],
    allowRebase,
    timeoutMs: (timeoutSeconds ?? 30 * 60) * 1000,
  };
}

export function cli(argv = process.argv.slice(2)) {
  const { prNumber: parsed, allowRebase, timeoutMs } = parseArgs(argv);
  const prNumber = parsed ?? currentPrNumber();
  const log = (msg) => console.log(`merge-pr: ${msg}`);

  // ONE budget across both waits: a rebase re-runs the whole gate (the
  // pre-push hook), so the second wait is part of the same job, not a new
  // one. Re-arming a full timeout would make the documented worst case 60
  // minutes rather than 30.
  const deadline = Date.now() + timeoutMs;
  let { readiness } = waitForReady(prNumber, { timeoutMs, deadline, log });
  if (readiness.action === "rebase" && allowRebase) {
    log(`${readiness.reason} — rebasing onto origin/main and pushing`);
    rebaseAndPush(readiness.branch);
    log("pushed; waiting for the checks to settle again");
    ({ readiness } = waitForReady(prNumber, { timeoutMs, deadline, log }));
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
    // A bad flag is a usage error, not a failure of the merge — exit 2 so
    // the two are distinguishable.
    process.exit(err instanceof UsageError ? 2 : 1);
  }
}
