---
name: manual-review-methodology
description: "How to divide implement/review work when a human is directing you directly — not through an automated task queue: when a mechanical self-check is enough versus when to hand off to a fresh reviewing context, how to calibrate a finding worth surfacing, and how to avoid dirtying a shared worktree. Does not apply if your prompt opens by telling you you're working or reviewing a task as part of Mullion's own Task Master — those sessions have their own, more specific skills; this one is for everything else."
---

# Implementing and reviewing without an automated queue behind you

Check which of these your prompt actually is before reading further:

- It opens by telling you that you're working a task
  **as a Mullion Task Master worker**, or opens
  **"Review this task's diff. You are not expected to make changes."**
  — neither applies here. Those two sessions have their own skills, built
  specifically for an unattended queue with its own round budget and verdict
  contract; reading this one instead would give you the wrong instincts for
  that context.
- Neither — an ordinary session, a human asking you to build or fix
  something and telling you when it's done, whether or not you spawn your
  own subagents or child sessions along the way. This skill is for you.

There's no queue watching this session, no fixed round budget, and no
verdict format to fill in. What follows is judgement, not a contract:
when a change is small enough to trust your own read of it, when it's worth
spending a fresh pair of eyes on, and how to keep that second pass honest
instead of either a rubber stamp or manufactured busywork.

## Self-check versus a fresh reviewing context

You can always re-read your own diff. What you can't do is un-know the
assumptions you made while writing it — the edge case you didn't think of
won't surface just because you're looking at the same code a second time. A
fresh context (a `Task`-tool subagent, a spawned child session, or literally
asking the human to look) sees the diff without those assumptions built in.

- A small, mechanical, easily-reversible change — a typo fix, a
  one-line config tweak, something whose correctness you can verify by
  running it — is usually fine to self-check and ship. Re-read it once for
  what it claims to do versus what it actually does, run whatever verifies
  it, done.
- A change that touches logic with edge cases, crosses a boundary you don't
  fully own, or that you'd genuinely be surprised to be wrong about — hand
  it to a fresh context before calling it done. Being confident is not the
  same as having checked.
- If you do self-check, do the mechanical pass — does it do what was asked,
  does it match the surrounding code's own conventions, is anything left
  half-done — rather than trying to argue yourself into correctness from
  first principles. That's what a second pass is for; spending your own
  effort re-deriving it defeats the point of getting one.

## Calibrate what's worth surfacing

A review that reports nothing without having looked hard is worse than
useless. A review that pads its output to look thorough is its own
failure — every item competes for the human's attention with whatever
actually matters, and a human who gets burned by a pile of nitpicks stops
reading the next one closely.

- Surface it if a human would want to act on it: a real defect, a mismatch
  with what was asked, a missed edge case, a violation of a convention this
  repo actually documents somewhere.
- Don't surface a bare preference, a restatement of something already
  correct, or a style opinion the repo states nowhere — mention it in
  passing if it's genuinely useful context, but don't present it as
  something that needs fixing.
- Say plainly when you found nothing, if that's true. Don't manufacture a
  nitpick to look thorough, and don't bury a real finding under hedging
  that undersells it.

## Don't dirty a worktree you don't own

If a spawned subagent or child session shares your own working tree rather
than an isolated copy, its verification commands must stay read-only with
respect to tracked state — check mode, never `--fix`/`--write`, no
commits, no touching files outside what it was asked to look at. A
formatter's autofix or a test runner's update flag can silently rewrite the
exact thing that was supposed to be reviewed, out from under whoever's
still working in that tree. If a check genuinely needs to mutate something
to run at all, that's worth flagging back, not doing unasked.

If you're inside a Mullion-hosted session, `spawn_child_session` gives a
fresh reviewing context its own PTY and session — see the Mullion
session-ops skill for the mechanics. A `Task`-tool subagent shares your own
working tree instead, which is exactly when the paragraph above applies.
