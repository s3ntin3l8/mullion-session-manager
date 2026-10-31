# The review relay: ids, keys, markers and external-reviewer runs

Read this when a diff touches `src/services/hermes-review.ts`,
`src/services/hermes-task-review.ts`, `src/routes/review-relay.ts`, the marker
sweep, or an external-reviewer run path in the task reconciler. Verified against
`origin/main` baf16a1e; code is cited by symbol, not line.

## 1. Session ids and idempotency keys match the shared workflow byte for byte

**Invariant.** `reviewSessionId` and `reviewIdempotencyKey` lower-case owner and
repo and fold the result to `[A-Za-z0-9_-]`. The shared reusable workflow in the
`s3ntin3l8/.github` repo computes the same strings. Hermes fingerprints the whole
request body against the key, so the same key with a different body is a 409
conflict, not a replay. A retry that moves the session id must move the key too.

**Breaks.** Two entry points dispatch two reviews of the same PR or range
(duplicate bot comments, wasted runs), or a 409 is mistaken for an outage.

**Check.** Any change to case-folding, the delta-base rule or bot-review
filtering must be compared against the workflow file, which lives outside this
repo (`gh api repos/s3ntin3l8/.github/contents/.github/workflows/hermes-review.yml`,
compare the `SESSION_ID=` and `IDEMPOTENCY_KEY=` lines). That half cannot be
verified from the diff alone, so say so in the review note.

## 2. Keys carry the target kind; cooldown is per commit; liveness is "not terminal"

**Invariant.** A PR and an issue share GitHub's number space, so the run index
key, cooldown key and idempotency scope all include the kind (`targetKey`,
shaped `kind:owner/repo#n`). The PR cooldown is keyed per head commit
(`cooldownKeyFor`) and an empty head SHA throws, so a PR-wide cooldown does not
come back. Whether a run is live is decided with `isTerminal(status)`, so queued,
running, stopping and waiting-for-approval all count as live; there is no
allowlist of running statuses. Stopping a review is scoped to the calling
session (`callerSessionId`).

**Breaks.** Triaging issue 5 displaces the review of PR 5; a new head commit is
refused for the cooldown window; a review parked on tool approval is treated as
finished and a second one starts; an agent stops another session's run.

**Check.** Read `targetKey` and `cooldownKeyFor`, and any new comparison against
Hermes run statuses. A hard-coded list of status strings is the red flag.

## 3. The in-flight marker check run must always be closeable

**Invariant.** The "Hermes review" marker check run is what makes the shared
workflow defer to an in-flight review, so an unclosed marker blocks every later
review of that PR. It is closed by the status route's lazy close and by
`sweepOpenReviewMarkers`, both through `markerConclusionForRunStatus`. A marker
older than `MARKER_MAX_AGE_MS` closes `neutral`, including when the Hermes status
read throws: the age check must live in the inner catch, not only on a
successful read. A refused PATCH or an unmintable token is retried next pass and
never thrown.

**Breaks.** A marker pinned `in_progress` for as long as Hermes is unhealthy.

**Check.** Read the sweep's per-marker `try` and confirm the max-age fallback is
reachable when the status read throws. Moving the conclusion computation back
after an uncaught awaited run fetch reintroduces the pin.

## 4. External-reviewer runs share the ingest and the give-up clock

**Invariant.** A task review can be an HTTP run (`reviewRunId`,
`reviewRunDispatchedAt`) dispatched by `processHermesDispatch` and finished by
`processHermesRuns`; both feed the same `ingestReviewOutcome` as session
reviews. Any give-up or stall clock for such a task must anchor on a column that
dispatch attempts do not re-stamp (`reviewingAt`, falling back to `claimedAt`
then `createdAt`), not on `reviewSpawnClaimedAt`. `attemptAutoRebase` stops an
in-flight run with `stopHermesRunQuietly` before displacing the worktree.

**Breaks.** A review never gives up because its clock keeps resetting, or a run
keeps reviewing a worktree being rebuilt.

**Check.** For any new timeout in `processHermesDispatch` or `processHermesRuns`,
read which columns it compares and whether a retry rewrites them.
