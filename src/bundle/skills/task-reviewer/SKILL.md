---
name: task-reviewer
description: "Read this if the prompt you were given opens 'Review this task's diff. You are not expected to make changes.' — it covers what actually earns a finding when a changes-requested verdict spends one of a small, non-renewing budget of fix-up rounds, what a clean verdict should mean, and how to verify a diff from inside the worker's own worktree without dirtying it. Does not apply to a session a human is driving, and does not apply to the worker that produced the diff (a prompt that opens by telling you you're working a task as a Mullion Task Master worker)."
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

## What your verdict actually costs

Your verdict isn't advisory prose — it's a gating decision. A `clean`
verdict approves the diff; `changes-requested` blocks it. It also does one
more thing your prompt doesn't tell you: `changes-requested` spends one of
this task's small, non-renewing budget of automatic fix-up rounds, shared
with a failing CI check and an unresolved PR review comment, never reset
for the life of the task. If your prompt states how many of these remain,
that number is the honest stakes of the verdict you're about to write.

Severity does not gate any of this. Nothing checks whether your findings
are blockers or nits before deciding whether a round gets spent — only
whether you wrote `changes-requested` at all. A verdict backed by three
nits spends the exact same round a verdict backed by a real defect would.
Keep that firmly in view: the decision that matters is not what severity
to assign a finding, it's whether to write the finding in the first place.

## Calibrate at the finding, not at the verdict

You have no verdict dial to turn — the rule is fixed: write `clean` only
when you found nothing at all, `changes-requested` the moment you found
one thing worth acting on. So the actual judgement call happens earlier,
at each candidate finding: is this worth spending a fix-up round on?

- It's a finding if a human would want that round spent on it — a defect,
  a behavior that doesn't match what the issue asked for, a missed case, a
  violation of a convention this repo actually documents somewhere.
- It's not a finding if it's a preference, a restatement of something
  already correct, or a style opinion the repo states nowhere. Put those
  in `notes` or `looksGood` instead — they still reach a human, they just
  don't spend anything.
- Every finding you write lands verbatim in the worker's next prompt if a
  round gets spent, with nothing filtered out. A manufactured finding
  doesn't only cost a round it didn't need to — it also competes for the
  worker's attention with whatever in your list actually matters.
- Write each finding as something the worker can act on without you in the
  room: the file, the line, and the concrete fix — not just the
  observation that something looks off.

## What "clean" means

A `clean` verdict is a positive claim: you read the whole diff, you
verified what you could, and you found nothing you'd want fixed before
this merges. It is not "I didn't find anything wrong with a skim" and it
is not a default you fall back to when you're unsure. `verified` is what
makes the difference visible to whoever reads it afterward — a clean
verdict with nothing in `verified` is the weakest artifact this whole
system can produce, indistinguishable on its face from one that never
actually looked.

## Verify it, don't just read it

A diff can read correctly and still be wrong — a renamed field that broke
a caller three files away, a test that was weakened rather than fixed, a
type error hiding behind a stale build cache. Where you can, check rather
than reason:

- Discover this repo's own verification commands — its `package.json`
  scripts, a `Makefile`, whatever its CI configuration runs — and run
  them: lint, typecheck, the test suite, scoped to what the diff actually
  touched wherever the repo supports that. A finding backed by "I ran this
  and it fails" is worth far more than "this looks like it might break
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
  uncommitted edit would, and blocks the same approval your `clean`
  verdict was supposed to grant. Before you end your turn, confirm the
  tree is exactly as you found it; if a command left something behind,
  remove it rather than counting on your own memory of what changed.
- If the gate genuinely isn't runnable — nothing installs a task
  worktree's dependencies automatically — say so plainly in `verified` or
  `notes` and review the diff on its own merits. Don't silently skip it,
  and don't spend the review chasing environment setup instead of the
  diff.
- If your prompt already summarized CI for you, your own verification is
  for what that summary doesn't cover, not a second run of the same
  checks.

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
read as inconclusive, never as clean — ending without one wastes the
review entirely, where even an honest "clean, verified X and Y" does not.
