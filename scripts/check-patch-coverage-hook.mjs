#!/usr/bin/env node
// Pre-push hook wrapper around scripts/check-patch-coverage.mjs.
//
// The patch-coverage rule itself (>=75% of changed executable lines in
// src/ and frontend/src/ covered) lives in check-patch-coverage.mjs and is
// reused here unchanged — this wrapper deliberately does NOT reimplement the
// diff, the istanbul statement mapping or the threshold, so the local gate
// and `make test-patch-coverage` can never drift apart.
//
// What the wrapper adds is the one behaviour a git hook needs and the script
// does not: SKIP instead of FAIL when there is no base ref to diff against.
// The script is also what CI's Codecov patch status compares against, so the
// two read the same coverage/coverage-final.json the pre-push test hooks
// produce (they run `test:coverage`, not `test`, for exactly that reason).
//
// Exit codes: 0 = covered (or skipped), 1 = below the threshold.

import { resolveBaseRef, runPatchCoverageCheck } from "./check-patch-coverage.mjs";

export const THRESHOLD = 75;

/**
 * Run the patch-coverage check and return the process exit code.
 *
 * `baseRef` and `check` are injectable so the skip and fail paths can be
 * tested without a repository in a particular state.
 */
export function runHook({ baseRef = resolveBaseRef(), check = runPatchCoverageCheck } = {}) {
  if (!baseRef) {
    console.log(
      "No base ref (origin/main, main, HEAD~1) available — skipping the patch-coverage check.",
    );
    return 0;
  }

  const result = check({ threshold: THRESHOLD, baseRef });
  if (!result.ok) {
    console.error(
      `ERROR: patch coverage ${result.overallPercent.toFixed(1)}% is below the required ${THRESHOLD}% threshold.`,
    );
    return 1;
  }
  return 0;
}

// Direct execution — imported by the test suite, so only run when invoked
// directly (same guard as scripts/check-patch-coverage.mjs's own `cli`).
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  process.exit(runHook());
}
