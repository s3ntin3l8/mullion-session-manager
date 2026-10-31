# The task reconcile loop: sweep order, auto-return, approval carry

Read this when a diff touches `reconcileTasks`, a sweep it calls, or what happens
when a review sends a task back to its worker. Verified against `origin/main`
6af59eac; code is cited by symbol, not line.

## 1. The sweep order is load-bearing

**Invariant.** `reconcileTasks` runs `processHermesRuns`, `processReviewingTasks`
(verdict ingest), `processAutoApprovals`, `processReviewingPrState`,
`notifyApprovalsAwaitingHuman`, `retryStrandedDraftPRs`, `processMergeRequests`
and so on; `processPendingReviewSpawns` and `processHermesDispatch` run after
the claimed/in_progress pass. Several sweeps (ingest, spawns, merge) must run on a
tick where nothing is claimed or in progress, so they sit before that pass's
`rows.length` early return. A sweep that turns state into a user-visible nudge
must run after the sweeps that can close or take the task.

**Breaks.** Announcing or acting on a task auto-approve just took; a sweep behind
an early `return` stops running on idle ticks and strands reviewing tasks.

**Check.** Read the call list at the top of `reconcileTasks`. A new sweep needs a
placement reason; a new early `return` before the spawn passes is a red flag.

## 2. Auto-return spends a bounded round and is rolled back on a failed re-seed

**Invariant.** `autoReturnTask` moves `reviewing` to `in_progress` by CAS, bumps
`autoReturnRounds` only for reasons that spend a round (`suggestions` does not:
it sets `approvalCarriedAt` instead), then force re-seeds the worker. If the
re-seed fails it rolls back status, rounds, the carry marker, the cap-announce
markers and `claimedAt` (itself CAS'd). `autoReturnCapAnnouncedAt` and
`needsHumanReason` are written in the same durable write as the verdict and
cleared at every site that resumes work (auto-return, reject, retry, entering
reviewing). The cap is announced on `capReached` alone, not only for
`changes-requested`.

**Breaks.** Burning limited rounds when nothing was delivered; a capped task
showing "review in flight" forever; a resumed task keeping a stale "needs a
human" banner.

**Check.** A new auto-return reason: does it set `spendsRound` correctly and
survive a failed re-seed? `git grep -n autoReturnCapAnnouncedAt -- src` and confirm
a clear at each work-resuming write.

## 3. An approval carried through a suggestions round needs a current approval

**Invariant.** An `approved-with-suggestions` review returns the task to the
worker without spending a round and without a new review: the `in_progress` to
`reviewing` transition keeps the review handle so the auto-approve gate reads the
already-ingested verdict. `hasCurrentApproval` (an approving verdict AND ingested
for the current review handle) gates any carry. A human reject clears
`approvalCarriedAt`; a fresh ingest overwrites it. A re-review asked for through
the escape hatch spends a round, which is its only bound. An approval is not
head-bound by design: do not flag that as new.

**Breaks.** Carrying an approval from a non-approving verdict merges unreviewed
work; an unbounded suggestions loop; a carried approval surviving a rejection.

**Check.** For any new head-moving auto-return path (CI fix, PR-comment return)
read how it sets `carryApproval`, whether it requires `hasCurrentApproval`, and
whether its prompt names the re-review request path.

## 4. A `return` inside a per-host loop ends that host's pass

**Invariant.** The in_progress to reviewing transition and similar loops run
inside `Promise.all` over per-host groups. A `return` inside the per-row `for`
aborts every remaining task on that host for the tick; use `continue`.
Unreachable-host handling (`HostUnreachableError`) is the case that bit this.

**Breaks.** One task's transient host error starves every other task on that host.

**Check.** Find `return` statements inside `for (const row of hostRows)` in any
diff to the reconcile loops and confirm they are meant to end the host's pass.
