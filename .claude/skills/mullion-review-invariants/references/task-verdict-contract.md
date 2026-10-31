# Task review verdict contract

Read this when a diff touches how a review verdict is parsed, stored, mapped to
a GitHub review, or acted on. Verified against `origin/main` 6af59eac; code is
cited by symbol, not line.

## 1. "Is this review an approval?" has one predicate

**Invariant.** The verdicts are `approved`, `approved-with-suggestions`,
`changes-requested` (plus `inconclusive` as a stored state; the legacy `clean`
only appears in old rows and is aliased to `approved` inside
`parseReviewFindings`). Every approval decision (auto-approve gate, merge sweep,
own-thread resolver, the GitHub APPROVE mapping, carry-approval) goes through
`isApprovingVerdict()` in `task-prompt.ts`.

**Breaks.** A bare `=== "approved"` treats a suggestions-only review as a
rejection, so the task never merges; treating `inconclusive` as approved
auto-merges unreviewed code.

**Check.** `git grep -nE '(===|!==|==) "(clean|approved|changes-requested)"' -- src`
and every new read of `lastReviewVerdict` or `parsed.verdict`.

## 2. Unparseable reviewer output must keep a human in the loop

**Invariant.** `parseReviewFindings` is tolerant: anything that is not the
expected JSON becomes `changes-requested` with the raw text as the summary and
`structured: false`; it has no "unknown" result. `inconclusive` is a
reconciler-level fact (no usable output), never a parser return. When findings
exist, `deriveVerdict` computes the verdict from finding severities and
previous-round dispositions, not from the agent's own `verdict` field. The
external-reviewer path (`processHermesRuns`) additionally refuses an
unstructured reply and records `inconclusive`: freeform text from outside is
not a verdict.

**Breaks.** A reviewer that ignores the format reads as clean and the task
auto-merges, or a stray prose reply spends an auto-return round.

**Check.** Any new early return in `parseReviewFindings`/`deriveVerdict` that
yields an approving verdict for malformed input; a `deriveVerdict` change needs
a test where the claimed verdict disagrees with the findings.

## 3. Gating reviews come only from the reviewer App identity

**Invariant.** GitHub 422s APPROVE/REQUEST_CHANGES from a PR's own author, so a
gating event is posted only with a token from `resolveReviewerToken` (a
separate reviewer App, no PAT fallback, `null` when unconfigured or minting
fails, which means a COMMENT from the primary identity). The reviewer token is
resolved only when a gating event is wanted. In `postReviewFindingsComment` a
422 retries once from the primary identity with no event; a 403 scope error does
not retry. The same local `verdict` feeds the stored column and the post.

**Breaks.** Lost review rounds when an anchorless APPROVE 422s, a PAT-authored
"approval" GitHub rejects, drift between the stored verdict and the posted
state.

**Check.** Read `postReviewFindingsComment` for where the event is derived, the
token chosen and the retry predicate. A new caller that passes a `verdict` is a
gating call site; notice-only callers (round caps) intentionally pass none.

## 4. Own-comment and own-thread filtering uses both Mullion identities

**Invariant.** Mullion posts as two identities (primary token and the reviewer
App). "Is this comment or thread ours?" must use `resolveMullionReviewLogins`
(a set, with the viewer login's `[bot]` suffix stripped by `stripBotSuffix`),
never a single `viewerLogin`. Threads are auto-resolved only on a fresh
approving verdict and only when every comment in the thread is Mullion's; a
truncated thread fetch fails closed.

**Breaks.** Mullion ingests its own review comments as new human feedback (a
spent round the tick a clean verdict landed), never resolves its threads (merge
blocked under required conversation resolution), or resolves a thread a human
pushed back on.

**Check.** `git grep -n viewerLogin -- src`; flag any single-login comparison
and any pair of logins normalized differently.
