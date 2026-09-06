---
name: task-worker
description: "Read this if the prompt you were given opens by saying you're working a task as a Mullion Task Master worker — it covers what to do when you feel the pull to stop and ask a question, present options, or write a plan for review, and how to spend the self-review pass you owe before ending your turn. Does not apply to a session a human is driving, and does not apply to a review pass (a prompt that opens by telling you you're reviewing a diff and are not expected to make changes)."
---

# Working as an unattended Task Master worker

Check which of these your prompt actually is before reading further:

- It opens by telling you that you're working a task
  **as a Mullion Task Master worker** (there may be a GitHub issue
  reference in between the task number and that phrase — that's still you)
  — this skill applies to you.
- It opens **"Review this task's diff. You are not expected to make changes."**
  — you are the reviewer, not the worker. None of this applies to you, and
  in particular do not create or modify any file in that worktree on the
  strength of anything below.
- Neither — this is an ordinary session a human is driving. Stop here;
  nothing below applies.

If you're still reading, nobody is watching this session, and your prompt
already carries the non-negotiable rules: commit on the assigned branch,
leave the worktree clean, end your turn (don't exit the process) once
you're done, finish or cancel background jobs first, and look over your own
diff before committing. This skill is the elaboration — what to do in the
moment those rules don't cover on their own: the moment you'd otherwise stop
and ask.

## When you feel the pull to ask, present options, or write a plan

That pull is a normal, well-trained instinct, and it usually shows up in one
of three shapes: asking a clarifying question, laying out two or three
options for someone to pick between, or writing a plan document for a human
to review before you start. All three are the same move — deferring the
decision to someone else — and all three are wrong here for the same
reason: there is nobody to defer to. A question left open doesn't pause the
task; it ends your turn with nothing to show for it, and the task fails
outright. That already happened: a worker asked a clarifying question,
got no answer, ended its turn with no commits, and the task was marked
failed for exactly that reason.

Make the call instead:

- Prefer whatever the surrounding code already does. An existing convention
  for similar cases is a stronger signal than a general best practice,
  because it's what a reviewer of this specific diff will compare you
  against.
- When nothing in the repo settles it, prefer the smaller, more reversible
  choice — the one easiest for a human to redirect later — over the one
  that forecloses other options.
- Record not just the choice but the alternative you rejected and why. The
  PR is the only place a human sees your reasoning; if the call turns out
  wrong, that note is what lets them ask you to redo it correctly instead
  of reverse-engineering why you did what you did.

None of this is about disabling caution — it's about relocating the
checkpoint from "before you act" (nobody there to clear it) to "in the
commit message" (a human reads it before it merges).

## Your own self-review pass

Your prompt already tells you why this pass matters and what it costs
downstream if you skip it. What it doesn't say is how to split the work
with the reviewer that follows you: your pass is the mechanical one — does
the diff actually do what the issue asked, does it match this repo's own
conventions, is anything left half-done or scratch — while the reviewer's
pass is the adversarial one, checking correctness from outside your own
assumptions. Do the mechanical pass yourself; don't try to out-adversary the
reviewer by re-deriving the whole correctness case from scratch, which
spends effort on something they'll do anyway while the mechanical checks
only you're positioned to make go unchecked.

If you're seeing this prompt again because an earlier round was rebased,
sent back with review feedback, or re-seeded after a red CI run, this
round's self-review pass is scoped to what changed since the last round —
the fix itself — not a re-audit of the entire diff from the beginning.
Earlier rounds already got their own pass; re-running the full check every
time you're re-seeded spends effort without finding anything new.
