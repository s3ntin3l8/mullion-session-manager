# Task merge sweep, retry state and session cleanup

Read this when a diff touches `processMergeRequests`, `attemptMerge`, the
module-level retry Maps in the task reconciler, how a task's sessions are ended,
or the workflow-file push gate. Verified against `origin/main` baf16a1e; code is
cited by symbol, not line.

## 1. The merge sweep lands intent asynchronously; 405 and 409 are normal

**Invariant.** Approving only sets `mergeRequestedAt`, a durable intent that
bounds the candidate set. `processMergeRequests` performs the merge later over
REST, using repo and token resolved from the project, never from the worktree
(which is already cleaned up). In `attemptMerge`, `behind` updates the branch and
waits for the next tick; `blocked`, `dirty`, `unstable` and `computing` back off
and never give up. A 405 or 409 from `mergePullRequest` is an expected retryable
outcome; only 403 and 404 mean a scope problem. The merge is a squash pinned to
the PR head SHA.

**Breaks.** A synchronous merge fails on a just-pushed, behind branch; a give-up
cap strands tasks forever; a 409 is recorded as a permanent error.

**Check.** Read the disposition switch in `attemptMerge` and the error handling
in `mergePullRequest`. A new terminal "gave up" state for a retryable
mergeability is the red flag.

## 2. Backoff Map entries are spread, not overwritten

**Invariant.** `mergeRetryState` and the sibling Maps (`autoApproveRetryState`,
`draftPrRetryState`) hold long-lived fields such as `lastReassertedSha` next to
the backoff timers. The sweep's per-iteration update must spread the previous
entry before setting `lastAttemptedAt` and `attempts`. Re-asserting the reviewer
App's approval is allowed only when the decision is `REVIEW_REQUIRED`, the task
is `done`, and `lastReassertedSha` differs from the current head SHA; never after
`CHANGES_REQUESTED`.

**Breaks.** "Re-assert once per push" silently becomes "once per tick" and an
identical APPROVE is reposted on every backoff; re-asserting over
`CHANGES_REQUESTED` overrides an explicit rejection.

**Check.** `git grep -n "mergeRetryState.set\|autoApproveRetryState.set\|draftPrRetryState.set" -- src`
and confirm each write that can follow a callee-set field spreads. A new field in
such an entry needs a two-tick test.

## 3. Task sessions end through `killSession`

**Invariant.** Every point that supersedes a task's worker or review session
must end it with `killSession`, which marks the `sessions` row `killed` before
awaiting the host terminate. A bare backend `terminate()` leaves the row
`active`. The sanctioned exceptions are `task-reseed.ts` (it flips the row
itself and restores `active` if terminate fails, since it must confirm death
before spawning a second agent) and the `attemptAutoRebase` guards.
`cleanupTaskSessions(app, row)` only works if the transition's UPDATE did not
null the pointer columns on the row it was handed.

**Breaks.** Zombie "active" sessions clutter the sidebar and board, or a second
agent starts beside one not confirmed dead.

**Check.** `git grep -n "\.terminate(" -- src/services/task-*.ts src/routes/tasks.ts`;
each hit should be a sanctioned site. For a new transition, check whether its
`.returning()` or set nulls `sessionId`/`reviewSessionId` before cleanup reads them.

## 4. Workflow-file push gate: an unknown base is "unverified"

**Invariant.** A push touching `.github/workflows/` is held for operator
approval; `evaluateWorkflowGate` yields `clear`, `unverified`, `held` or
`approved`. It may say `clear` only when the host reports `baseResolved === true`
or `workflowFiles` is non-empty; a host that cannot resolve the base ref used to
return an empty diff, which read as clear. The elevated token goes only to the
push call (`pushToken ?? token`); every PR API call keeps the ordinary token,
with no fallback to a personal token.

**Breaks.** A workflow edit pushed under the ordinary token unchecked, or the
reverse, a fleet-wide push stop on hosts that predate the flag.

**Check.** Read `evaluateWorkflowGate` and its caller `preparePromotion`.
Changing `pushToken ?? token` back to `token` must fail a test, so a test should
assert the token argument passed to the push function.
