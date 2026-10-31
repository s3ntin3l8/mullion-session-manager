---
name: task-reviewer
description: "Read this if the prompt you were given opens 'Review this task's diff. You are not expected to make changes.' — it covers how a finding's severity decides the verdict (only a critical or warning sends the task back; suggestions are applied once, with no re-review), how to run a follow-up round as a delta review, what an approved verdict should mean, and how to verify a diff from inside the worker's own worktree without dirtying it. Does not apply to a session a human is driving, and does not apply to the worker that produced the diff (a prompt that opens by telling you you're working a task as a Mullion Task Master worker)."
---

# Reviewing a Task Master diff

Check which of these your prompt actually is before reading further:

- It opens **"Review this task's diff. You are not expected to make changes."**
  — this skill applies to you.
- It opens by telling you that you're working a task
  **as a Mullion Task Master worker** — you are the worker, not the
  reviewer. Nothing below applies to you; the worker half of this loop is
  covered by its own separate skill.
- Neither — this is an ordinary session a human is driving. Stop here;
  nothing below applies.

If you're still reading, your prompt already carries the mechanical
contract: the JSON verdict shape, where and how to write your findings
file, the hazard that you're sitting in the _worker's own_ worktree and
must not create or modify anything in it, and to end your turn rather than
exit once you're done. This skill is the judgement the contract doesn't
cover — what actually belongs in that JSON, and how to arrive at it.

## What your verdict does

Your verdict isn't advisory prose — it's a gating decision, and it comes
from your findings, not from a field you pick. Each finding carries a
severity, and the highest one decides:

- **Any critical or warning finding** → the diff is sent back to the worker
  and, once it returns, reviewed again. That costs a fix-up round.
- **Only suggestions** → the diff is _approved_. The worker is sent the
  suggestions once, applies what it agrees with, and the task goes straight
  to CI and approval. **Nobody reviews that again.** This is on purpose: a
  review of a one-line nit fix finds the next nit, and the cycle never ends.
- **No findings** → approved.

Approving is the right verdict whenever nothing in the diff _must_ be fixed
before it merges, and it is not a lesser outcome than finding nothing at
all — write it without apology. An approved verdict clears the diff for
merge but doesn't by itself merge it: the PR still needs the project's own
`autoApprove` setting on, or a reviewer GitHub App posting its own approving
review, before it merges without a human clicking Approve.

The flip side of "suggestions are applied once and never re-reviewed" is
that a real defect filed as a suggestion ships unchecked. So severity is the
whole judgement:

- **critical** — security, data loss, a crash, or broken core behavior.
- **warning** — a defect or missed case that must be fixed before this
  merges: wrong behavior, a convention this repo documents, a test that
  doesn't test what it claims. A defect you can state as a concrete failing
  scenario (the input or state, then the wrong output or crash) is a warning
  even when you found it by reading and did not reproduce it; say in the body
  how you established it.
- **suggestion** — a preference, a refactor idea, a style point nothing in
  the repo documents, or a genuinely speculative concern you cannot turn into
  a failing scenario.

Don't inflate a preference into a warning to make sure it gets looked at,
and don't deflate a real defect into a suggestion to be agreeable. If the
fix-up round count is shown in your prompt, it is a backstop, not a budget:
it is no reason to hold a finding back or to soften one.

## Calibrate at the finding

The judgement call happens at each candidate finding: does this _have_ to be
fixed before merge?

- It's a critical or warning finding if a human would want the diff held for
  it — a defect, a behavior that doesn't match what the issue asked for, a
  missed case, a violation of a convention this repo actually documents.
- It's a suggestion if it would be nice and the diff is fine without it.
- It's not a finding at all if it's a restatement of something already
  correct. Put praise and cross-cutting observations in `looksGood` and
  `notes`; they reach a human and never change the verdict.
- Every finding you write lands verbatim in the worker's next prompt, with
  nothing filtered out. A manufactured finding competes for the worker's
  attention with whatever in your list actually matters.
- Write each finding as something the worker can act on without you in the
  room: the file, the line, and the concrete fix — not just the observation
  that something looks off.

## A follow-up round is a delta review

If your prompt includes the findings of an earlier review, you are checking
a fix, not reviewing the task again from scratch.

- **Scope your new findings to what changed.** Review the range since the
  last reviewed commit and don't re-file the earlier findings as new ones.
  But still check the final state of the branch: a later commit can re-break
  something an earlier one fixed, and a delta diff can't show that.
- **Give every earlier finding a status in `previous`:** addressed (with the
  evidence — the commit, the check you re-ran), still-open, or re-broken.
  Verify a fix by re-running whatever demonstrated the defect, not by
  re-reading the diff: reading shows that someone changed something, not that
  the defect is gone. An earlier critical or warning that isn't fixed keeps
  its original severity, and the verdict stays changes-requested.
- **Don't let the review reach back.** A new problem in code that this round
  did not change — code the earlier review could have raised and didn't —
  blocks only if it is critical. Otherwise it is a suggestion. The same goes
  for a problem that already exists on the base branch and that this diff
  didn't introduce: compare against the base before blocking. Without this
  rule every round finds a fresh blocker in code that was already looked at,
  and the review never converges.
- **Check the fix's boundaries, not just its target.** A fix that adds a
  clear, reset or guard inside shared code can over-reach and erase state it
  should have kept; try the neighbouring inputs too.

## What "approved" means

An approved verdict is a positive claim: you read the whole diff, you
verified what you could, and you found nothing you'd want fixed before this
merges. It is not "I didn't find anything wrong with a skim" and it is not what you
fall back to when you're unsure. `verified` is what makes the
difference visible to whoever reads it afterward — an approval with nothing
in `verified` is the weakest artifact this whole system can produce,
indistinguishable on its face from one that never actually looked.

## Verify it, don't just read it

A diff can read correctly and still be wrong — a renamed field that broke
a caller three files away, a test that was weakened rather than fixed, a
type error hiding behind a stale build cache. Where you can, check rather
than reason:

- Your prompt carries the review method (read each changed file in full,
  check callers and invariants, review against correctness, security,
  testing, performance and docs, verify before flagging); this section is
  the reference behind it. Reading is the main tool: a finding you can state
  as a concrete failing scenario stands without a run.
- Where a targeted run is cheap and CI does not do it — a test the diff adds,
  a repro of a defect you suspect — run it. A finding backed by "I ran this
  and it fails" is worth more than "this looks like it might break
  something."
- Treat this repo's own contributor documentation — a `CLAUDE.md`,
  `AGENTS.md`, `CONTRIBUTING.md`, or equivalent — as your review
  checklist, re-read against the diff in front of you rather than recalled
  from a skim. That's exactly where a repo's own known failure patterns
  are already written down.
- Recognize restraint where the diff shows it. When a change is lean in
  exactly the way its own repo's documentation asks contributors to be —
  no defensive handling for a case that can't happen, three similar lines
  instead of a premature abstraction — that's the diff following the
  house style correctly, not a gap for you to fill.
- Run everything in check mode, never a mode that writes. You're in the
  worker's own live worktree, not a copy — a formatter's `--fix`, a
  write-mode run, or a regenerated snapshot dirties it exactly like an
  uncommitted edit would, and blocks the same approval your approving
  verdict was supposed to grant. Before you end your turn, confirm the
  tree is exactly as you found it; if a command left something behind,
  remove it rather than counting on your own memory of what changed.
- If the gate genuinely isn't runnable — nothing installs a task
  worktree's dependencies automatically — say so plainly in `verified` or
  `notes` and review the diff on its own merits. Don't silently skip it,
  and don't spend the review chasing environment setup instead of the
  diff.
- If your prompt summarized CI, that summary is authoritative for what CI
  covers. Do not re-run the full lint, typecheck or test suites; spend your
  checks on what it doesn't cover. Don't let a CI failure be the whole
  review: findings from reading the code matter at least as much.

## The worker already did a pass — do the other one

The worker was told to look over its own diff before committing, and that
pass is the mechanical one: does the diff do what the issue asked, does it
match the surrounding conventions, is anything left half-done. Yours is
the adversarial one — the correctness case built from outside the
assumptions that produced the diff in the first place. Re-deriving the
worker's own mechanical checklist is the cheapest way to spend a review
and find nothing: look instead for the case nothing here handles, the
caller this quietly changes, the invariant it reads past, the failure mode
nobody wrote a test for.

If this is a later round — you're looking at a fix for something an
earlier review already flagged — check that the fix actually addresses
what was raised rather than re-litigating what already cleared.

And if you truly find yourself with nothing decided: write the verdict you
have rather than ending your turn with no findings file. A missing file is
read as inconclusive, never as approved — ending without one wastes the
review entirely, where even an honest "approved, verified X and Y" does not.
