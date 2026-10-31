# Auto-rebase, mergeability and worktree reclaim

Read this when a diff touches `attemptAutoRebase`, the rebase hold
(`rebaseStartedAt`), anything that reads GitHub's `mergeable`, or the code that
clears and recreates a task's worktree. Verified against `origin/main` baf16a1e;
code is cited by symbol, not line.

## 1. Never put a second agent into a worktree an agent still holds

**Invariant.** `processPendingReviewSpawns` selects tasks that are `reviewing`
with no `reviewSessionId` and no `reviewRunId`, and it must exclude a task whose
rebase attempt is in flight (`rebaseStartedAt` younger than
`REBASE_ATTEMPT_STALE_MS`). Any path that nulls `reviewSessionId` or
`reviewSpawnClaimedAt`, or gives the task a new worker `sessionId`, while it
stays `reviewing`, re-arms that pass. `rebaseStartedAt` is not cleared the moment
`mergeable` turns true: `clearRebaseHoldIfWorkerFinished` clears it once the
worker signals done, or it ages out. The stale window is an abandon timeout, not
proof the session exited.

**Breaks.** Two agent PTYs write one git tree: corrupt index, clobbered commits,
duplicate pushes.

**Check.** For any change touching `rebaseStartedAt`, a `reviewSessionId: null`
write, or a widened CAS status set, re-read the WHERE in
`processPendingReviewSpawns` and confirm it still excludes the in-flight attempt.

## 2. `attemptAutoRebase` terminates or bails, and every bail clears the handle

**Invariant.** Before the worktree is force-removed and recreated, the active
worker session and the active review session or run (`stopHermesRunQuietly` plus
terminate) must be ended; if termination fails, the function bails with a
`mergeError`. Because the review session dies before the final CAS, every early
return after that point (worktree not recreated, spawn failed, CAS lost) must
null `reviewSessionId` and spread `CLEARED_REVIEW_RUN`. The `rebaseAttempts`
increment and `rebaseStartedAt` live inside that same CAS'd UPDATE.

**Breaks.** A live reviewer loses its directory, or the task keeps a dead review
session id forever (the spawn pass only refills a null one), or a CAS loser
burns the rebase budget.

**Check.** Read `attemptAutoRebase` top to bottom: guards, terminates,
`removeWorktree`, `resumeTaskWorktree`, `createSessionRecord`, final CAS. For
each `return` after the review terminate, confirm the handle is cleared. A new
entry path must also hit the terminate.

## 3. `mergeable` is tri-state

**Invariant.** `mergeable: null` (or state `unknown`) means GitHub is still
computing: wait and retry, neither clean nor dirty. `attemptAutoApprove`
requires `mergeable === true` before approving or dropping rebase markers. The
conflict (rebase) arm runs only after `hasIngestedCurrentReview` and an
approving verdict, so a conflict cannot hijack a live reviewer.
`classifyMergeReadiness` maps unknown to `computing`, and `unstable` is never
merged.

**Breaks.** An `!== false` or truthiness test approves or merges an unverified
PR just after a push, or clears a rebase hold while the rebase worker still runs.

**Check.** `git grep -nE "mergeable (!==|===|==) " -- src`; any `!== false` or
bare truthiness in task logic is the red flag.

## 4. Worktree reclaim clears the directory and the branch

**Invariant.** `git worktree add -b` creates the branch ref before it fails on
an existing non-empty directory, and `git worktree remove` never deletes the
branch. `clearOrphanedTaskWorktree` therefore removes the directory (including
when `removeWorktreeIfClean` reports `not-a-repo` but the path exists, with a
containment check under `.mullion-worktrees`), then force-deletes the branch. It
refuses with a "resolve manually" error when a stale branch exists but no
directory does. `deriveWorktreePath` must keep predicting the path
`createWorktree` creates.

**Breaks.** A claim retry loop (claim, worktree failure, retry) that recreates
the branch each time, or deletion of a branch holding recoverable work.

**Check.** For any change to claim, retry or promote cleanup, ask whether both
halves are cleared, and whether a test asserts the branch is gone and a real
same-name retry succeeds, not only that the directory no longer exists.
