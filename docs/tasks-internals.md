# Task Master internals

This is the reconciler-mechanics companion to [`tasks.md`](tasks.md) — how
Task Master's autonomous machinery actually decides what to do next: the
gates that guard each transition, the auto-return/auto-approve/auto-rebase
loops, the rate-limit grace window, GitHub sync, and the review agent. Read
[`tasks.md`](tasks.md) first for the operator-facing model (enabling,
labeling, lifecycle overview, board actions, safety envelope); come here for
the "why does it actually do that" detail behind each of those.

## Dependency-aware claiming (`#667`)

Auto-claim (`autoClaimReadyTasks`, `task-watcher.ts`) respects GitHub's
native issue dependencies (`GET .../issues/{n}/dependencies/blocked_by`) —
filing a fully-ordered roadmap and labeling every issue `mullion-task` +
`ready` up front no longer requires hand-gating each one with `Manual: true`
and promoting them one at a time. A `ready` task with an open blocker is
**not** claimed — it stays `ready`, visible and manually claimable, rather
than moving to a separate status. There is deliberately no `blocked`
status: the seven-state lifecycle ([`tasks.md`](tasks.md#lifecycle)) is
unchanged, and a blocked task un-blocks itself with no transition once its
last blocker closes.

The gate is a three-way read off two columns on `tasks`:
`dependencyCount` (GitHub's `issue_dependencies_summary.total_blocked_by`,
captured on every ingest) and `blockedBy` (a JSON array of currently-open
blockers, resolved lazily — see below). `task-dependencies.ts`'s
`dependencyGate` is the single truth table:

| `dependencyCount` | `issueNumber` | `blockedBy` | Gate         |
| ----------------- | ------------- | ----------- | ------------ |
| `null`            | `null`        | `null`      | **clear**    |
| `null`            | set           | any         | `unresolved` |
| `0`               | set           | `null`      | **clear**    |
| `>0`              | set           | `null`      | `unresolved` |
| `>0`              | set           | `"[]"`      | **clear**    |
| `>0`              | set           | `[{…}]`     | `blocked`    |

`dependencyCount` is nullable rather than `NOT NULL DEFAULT 0` on purpose:
`null` means "not yet observed," which is not the same as "verified to have
no dependencies." A local task (no `issueNumber`) is always `clear` and
never makes a GitHub call — the pre-`#667` "auto-claim needs no GitHub
connection at all" behavior is unchanged. A GitHub-linked task whose
dependency state has never been observed (a fresh webhook-ingested row, a
row from before this shipped) reads `unresolved` and is skipped rather than
assumed clear — **fail closed**: claiming a genuinely blocked task out of
order is exactly the harm this feature exists to prevent, so an unknown
state is treated the same as a known-blocked one.

**The check is lazy, not eager, and that's deliberate.** The naive design —
resolve blockers for every `ready` task with `dependencyCount > 0` during
ingest — doesn't survive this feature's own motivating scenario: a
32-issue roadmap labeled `ready` up front has ~31 candidates with
dependencies, so "only check tasks with dependencies" filters nothing, and
a per-sweep cap alone would still mean dozens of calls/project/poll against
GitHub's rate limit. (`#759` added install-wide 429/`Retry-After` handling —
see "GitHub rate limiting" below — as the actual backstop against that
overrun; the per-sweep caps here still matter on their own terms, to keep
one project/pass from starving the others out of a poll tick, not just to
avoid tripping GitHub's limit.)
Instead, `autoClaimReadyTasks` only resolves blockers for a candidate it is
actually about to try, bounded three ways, cheapest first:

1. A **capacity pre-count** — zero GitHub calls once `claimed` + `in_progress`
   tasks already fill `maxConcurrent`. Deliberately counts BOTH (task-claim
   queueing, rate-limit-storm fix): this is pure pacing, not the real cap
   (`dispatchClaimedTask`'s own transactional reservation, `in_progress`
   only, is that) — without it, one sweep would drain the entire `ready`
   backlog into `claimed` the moment even one slot opens, since
   `enqueueTask` never itself cap-checks.
2. A **5-minute re-check TTL** (`blockedByCheckedAt`) — a recently-checked
   task isn't re-resolved every poll tick regardless of state.
3. A **per-sweep cap** (`MAX_DEPENDENCY_CHECKS_PER_SWEEP`, 20, mirroring the
   read-back sweep's own `MAX_READBACK_CHECKS_PER_SWEEP`) as a backstop for
   the pathological case where the first N candidates in `boardOrder` are
   all blocked — deferred, never permanently skipped, logged when hit.

`autoClaimReadyTasks` also now orders its candidates by `boardOrder`, `id`
— the missing `ORDER BY` this feature's issue was originally filed about —
matching the board's own render order (`routes/tasks.ts`'s `GET /api/tasks`).

A resolved `blocked_by` response's blocker count is compared against the
stored `dependencyCount`: a shortfall (fewer blockers returned than GitHub's
own summary reports) is treated as "some blockers aren't visible to this
token" and recorded as blocked with a distinct reason, rather than assumed
to mean fewer real blockers than reported — GitHub does not document
whether the summary and the list endpoint count private/cross-org blockers
the same way, so this fails toward blocked rather than risk an
under-scoped-token false negative. Verified live (Hermes review) that
`total_blocked_by` itself can lag GitHub's own dependency graph for a few
seconds after an edge is added/removed — a re-fetch immediately after a
`blocked_by_removed` API call can still return the pre-removal count — so a
shortfall isn't always a genuine scope gap; it can be this transient lag.
Because of that, a shortfall result does **not** stamp the task's re-check
TTL — it self-corrects on the very next sweep instead of holding a possibly
wrong "blocked" verdict for the full TTL window.

`GET .../dependencies/blocking` (the reverse direction) drives a second,
push-based path: when a labeled issue with dependents closes (webhook
`issues`/`closed`, or the poll's own close-sync), its dependents are
re-checked immediately rather than waiting for a poll tick — see
[GitHub sync](#github-sync) below and `docs/github-integration.md`'s
webhook event list.

**Display refresh is a separate, decoupled pass.** Everything above is
`autoClaimReadyTasks`'s own lazy check — it exists to gate a _claim
decision_ and is intentionally narrow: gated on `taskMaster.autoClaimPaused`,
scoped to `ready` tasks only, on a tight 5-minute TTL. Before this pass
existed, it was also the _only_ poll-path caller of `refreshTaskBlockers`,
which meant a paused install, or one whose GitHub-linked tasks hadn't been
dragged to `ready` yet, left every one of them at `dependencyGate() ===
"unresolved"` forever — the board's "Checking dependencies…" badge never
converged, because nothing was ever calling `refreshTaskBlockers` for those
rows. `resolveStaleTaskBlockers` (`task-watcher.ts`, called from `pollOnce`
right after `autoClaimReadyTasks`, reusing the same `githubContext`) fixes
this: it resolves blockers for the board's _badge_, independent of whether
anything is eligible to claim. It runs regardless of `autoClaimPaused`
(resolving a blocker for display is not autonomous behavior, unlike
claiming) but still respects `taskMaster.enabled` — when Task Master is
disabled, ingest itself never runs, so `dependencyCount` and every other
GitHub-derived field on every task is already frozen, and refreshing just
`blockedBy` against that frozen `dependencyCount` would leave a row in a
mixed-freshness state.

It differs from the claim-gate check in every dimension that check is
deliberately narrow:

- **Scope**: any status short of `done`/`failed`, not just `ready` — a
  manually-claimed task never goes through `dependencyGate` at all (claiming
  bypasses the gate), so it can sit in `claimed`/`in_progress`/`reviewing`
  with a never-resolved dependency state and the board has no other path to
  ever check it.
- **TTL**: a separate, longer `BLOCKER_DISPLAY_TTL_MS` (30 minutes vs. the
  claim gate's 5) — a badge can tolerate more staleness than a claim
  decision, and a blocker that closes is already pushed near-real-time by
  the webhook path above regardless of this TTL. The two _constants_ are
  independent; the `blockedByCheckedAt` column they're both compared
  against is not (see "Backoff on a hard error only" below for why that
  matters).
- **Budget**: its own `MAX_DISPLAY_DEPENDENCY_CHECKS_PER_SWEEP` (10),
  independent of `MAX_DEPENDENCY_CHECKS_PER_SWEEP` and not shared with it —
  same reasoning as the read-back sweep's own two independent caps: sharing
  one budget would let either kind of churn starve the other out of a
  sweep entirely.
- **Candidate filtering happens in the query, not the loop**: rows
  `dependencyGate` already resolves to `clear` for free (`dependencyCount
=== 0`, short-circuiting before `blockedBy` is ever read) are excluded by
  the `WHERE` clause, not skipped inside the loop — otherwise they'd still
  occupy queue positions ahead of the cap, and since they also have
  `blockedByCheckedAt IS NULL` they'd sort to the front, crowding out rows
  that actually need a call on a large board.
- **Backoff on a hard error only.** `refreshTaskBlockers`'s claim-path
  behavior — never stamping `blockedByCheckedAt` on a shortfall, so the very
  next sweep retries with a fresher count (see above) — stays in force for
  this pass too, deliberately, even though it means a persistently
  shortfalling row is re-checked every tick. `blockedByCheckedAt` is a
  single column shared with the claim path's own 5-minute TTL; stamping it
  on a shortfall from here would silently extend that path's freshness
  window to this pass's 30 minutes as well, which very nearly shipped and
  was caught only by tracing what the claim path would read on the next
  sweep after this pass ran. What this pass **does** opt in to,
  via `refreshTaskBlockers`'s `stampOnFailure` flag, is stamping on a hard
  error only (network, 404, 403, an under-scoped token) — an exception has
  no "maybe GitHub just hasn't caught up yet" reading, so there's no
  freshness ambiguity to protect there. A persistently shortfalling row is
  instead bounded the same way the claim path already bounds it: by this
  pass's own per-sweep cap. The claim path and both webhook callers omit
  `stampOnFailure` entirely and keep their documented immediate-retry
  behavior on any failure.

  The hard-error stamp shares that same column too, so the leak isn't
  fully eliminated, only bounded and pushed to a case where it's provably
  safe: if this pass hits a _transient_ hard error (a network blip) on a
  row the claim path also cares about, the claim path's own lazy check
  will read that stamp as "freshly checked" and suppress its own recheck
  for up to its 5-minute TTL, where before this pass existed it would have
  retried on the very next sweep. Deliberately accepted rather than
  introducing a second TTL column just for this pass — a claim decision
  merely gets delayed by at most 5 minutes, it is never made on data that
  reads as more resolved than it is (a hard error never touches
  `blockedBy`/`dependencyCount`, only the TTL stamp), so the fail-closed
  property holds throughout.

- **No same-tick double-refresh with the claim path.** `pollOnce` runs this
  pass right after `autoClaimReadyTasks` in the same tick, and passes it the
  set of task ids the claim path itself already called `refreshTaskBlockers`
  on this sweep. This pass skips those ids outright rather than relying on
  the SQL-level TTL filter to catch them — a shortfall is never stamped (see
  above), so without this a row the claim path just shortfall-checked would
  still read as "never checked" and get a second GitHub call in the same
  sweep.

## Task hierarchy (sub-issues) (`#701`)

Projects that organize their roadmap with GitHub sub-issues (a parent
tracking issue with several children) get that structure surfaced on the
board: a child card names its parent, the toolbar can filter to one parent
("phase"), and the drawer lists both directions.

**Parentage costs zero extra GitHub calls.** `parent_issue_url` and
`sub_issues_summary` ride the exact same `listLabeledIssues` response
`dependencyCount` already reads (`github.ts`) — written on every ingest,
same cadence, same call. This corrects `#701`'s own original scoping,
which assumed no such field existed on the plain issues-list response and
planned a `GET .../issues/{n}/sub_issues` call per parent to derive it; that
call is never made.

Five columns on `tasks`, all nullable — `parentIssueNumber` /
`parentIssueRepo` (the parent's own `"owner/repo"`, which can differ from
the child's project repo: cross-repo sub-issues are first-class in GitHub's
model) / `parentIssueTitle` / `subIssueTotal` / `subIssueCompleted`. Unlike
`dependencyCount`, nullability here carries no fail-closed meaning for the
four parent-identity columns — they stay **display-only**, so "not yet
observed" and "known to have no parent" don't need to be distinguishable the
way they do for dependencies.

**`subIssueTotal`/`subIssueCompleted` together are the one exception, since
`#1016`.** `isEpicIssue` (`task-watcher.ts`) reads
`(subIssueTotal ?? 0) - (subIssueCompleted ?? 0) > 0` — i.e. this issue has
at least one **open** sub-issue right now, not merely "has ever had any" —
and `upsertIssueTask` checks it at ingest (and on every re-sighting) to keep
a tracking epic out of `ready` — see [`tasks.md`](tasks.md#lifecycle). An
epic whose sub-issues later all close stops being gated the next time it's
re-sighted, since the same `total - completed` expression then reads `0`;
there's no separate "un-park" transition needed. Neither column alone fails
closed the way an unresolved `dependencyCount` does: `subIssueTotal ===
null` ("not yet observed" — a webhook-sourced sighting) simply defers the
epic check to the next poll sweep, which always carries a real
`sub_issues_summary`.

`parentIssueNumber`/`parentIssueRepo`/`subIssueTotal`/`subIssueCompleted`
follow the same three-state write lockstep `dependencyCount` established in
`upsertIssueTask`: `undefined` (a webhook-built `TaskIssue`, which has no
summary to read) leaves a stored value alone; a poll-sourced value —
including an explicit `null` parent — overwrites it. The `null` case matters
here in a way it doesn't for `dependencyCount`: a parent can be removed, and
a poll-sourced `null` must actively clear a stale one rather than merely
declining to update it.

**The title is the one piece that isn't free**, and gets a deliberately
different shape from the dependency-badge display pass above. Resolving it
is `fillParentIssueTitles` (`task-watcher.ts`), a **one-shot cache-fill, not
a TTL-guarded refresh**: an issue's title doesn't go stale in a way that
matters to a chip, so there's no TTL and no periodic re-check. The
candidate query is simply `parentIssueTitle IS NULL`, deduped to one
GitHub call per **distinct parent** (not per child — the reference install's
32 children of 10 parents is 10 calls, not 32), converges to zero rows once
caught up, and then costs one cheap `SELECT` per sweep forever, doing
nothing further. `upsertIssueTask` is what re-arms it, by nulling a stored
title only when the parent identity itself changes (a re-parenting). A
parent that 404s (deleted, private) is retried up to
`MAX_PARENT_TITLE_ATTEMPTS` (3) sweeps before this pass gives up on it for
the life of the process — otherwise one permanently-unreachable parent would
burn a cap slot every sweep forever with no TTL to rate-limit it. Trying
every distinct project token a shared parent's children resolve to (not
just the first one found) before counting that as a failure keeps one
under-scoped project's token from starving a sibling project's otherwise-
resolvable children on the same parent.

The candidate query excludes `done`/`failed` tasks, which means a child
that reaches either status before this pass ever reaches it keeps a bare
`#N` chip forever — no re-arm on reopen. Accepted: a terminal task's board
relevance is already winding down, and re-checking it forever would cost a
permanent trickle of calls for a cosmetic detail on a task nobody is
actively looking at.

**The `sub_issues` webhook is deliberately not subscribed.** For
dependencies, the `issue_dependencies` webhook was the cheap path to
correctness because a blocker refresh was an extra, TTL-gated API call.
Parentage already re-syncs on every 60s poll at zero marginal cost, so a
`sub_issues` subscription would only buy latency: `upsertIssueTask`'s
`/ws/tasks` push (`kind: "ingested"`) fires only on a task's first sighting,
not a re-sighting, so a re-parenting written by a later poll produces no
live broadcast at all — it surfaces whenever the frontend's own periodic
`refreshTasks()` next runs, not instantly. (The `kind: "hierarchy"` event is
separate and narrower: it's `fillParentIssueTitles` announcing a newly
_filled title_, not a changed parent identity.) Subscribing to the webhook
would also force `WEBHOOK_EVENTS_VERSION` (`github-webhook.ts`) up, which
re-registers the hook on every connected project — accepted deferred cost,
filed as a follow-up rather than bundled in.

**Labeling a tracking epic today:** A `mullion-task`-labeled epic issue with
`Manual: true` in its body is parked in `backlog` by `isManualOnly`
(`task-watcher.ts`) and never auto-claimed. The `N/M` sub-issue progress
chip on `TaskCard.tsx` renders whenever `subIssueTotal > 0`, regardless of
the parent's status — so a `backlog`-parked epic still shows its children's
progress. The labeling buys the chip without the auto-claim risk, and
`Manual: true` is sufficient to achieve this today; `#1016`'s auto-park on
open sub-issues is an additive safety net (catches the case where the human
forgot `Manual: true`), not the only path.

Note on the parent-context flow: a worker's prompt **does** receive the
parent epic's body, framed explicitly as "context only, not your task" via
`renderParent` (`task-prompt.ts`) and routed through `TaskPromptTask.parent`
/ `TaskPromptSibling[]` (`task-prompt.ts`, resolved by
`task-issue-context.ts`). A worker handed a child issue therefore sees the
epic's spec and a sibling list — but is told explicitly not to implement
other streams. If you want a worker to know specific context, put it in the
child issue's body; the parent block arrives automatically when
`parentIssueNumber`/`parentIssueRepo` resolve. Do **not** assume a labeled
parent buys the parent block — the resolution path fails OPEN
(`task-issue-context.ts`, "advisory, not a gate") on a GitHub hiccup, and
the field is absent for non-GitHub tasks.

Board surfaces: `TaskCard.tsx` renders a `↳ <parent title>` meta chip
(falling back to `#N` until the title pass fills it) and an `N/M` sub-issue
progress chip — the latter renders on zero cards on an install where no
parent issue itself carries the task label, which is the common case, not a
bug. `UnifiedBoard.tsx`'s toolbar gets a phase `<select>` (not chips, like
the project filter — a full-title option list runs long) that composes with
the project/blocked-only filters through the same `absoluteDropIndex`
translation that keeps `boardOrder` correct under any combination of them.
`TaskDetail.tsx`'s drawer gets a "Hierarchy" section listing the parent link
and any sibling tasks that are themselves known (labeled) Task Master tasks
— a child issue without the task label still counts toward `subIssueTotal`
but isn't individually listed, since nothing on this side of the API knows
it exists.

## The no-commits gate and turn-finished check

[`tasks.md`](tasks.md#lifecycle)'s `in_progress → reviewing` bullet
summarizes the outward behavior; this is the mechanism behind it.

`in_progress → reviewing` fires when the worker session reaches
`sessionStatus === "finished"` (its last turn ended and no background tasks
are still running) **and** that finish postdates this `in_progress` spell
(`task.claimedAt`) **and** the branch has at least one commit past its
recorded `baseSha` (`task-reconciler.ts`'s `checkReviewingGate`, `#722`).
The transition table still lists `claimed → reviewing` as legal
(`task-state.ts`'s `canTransition` stays advisory, bypassed in several
places already), but it is no longer reachable in practice: dispatch always
flips `claimed → in_progress` synchronously, inside its own reservation
transaction, before a session ever exists — so by the time any session
could report "finished," the task is already `in_progress`. (Historically
this WAS a reachable edge, when a single-phase `claimTask` reserved and
spawned in one step and the reconciler polled for activity afterward — see
task-claim queueing, rate-limit-storm fix, for why that changed.)

Two extra conditions close real gaps a plain "finished" signal left open:

- **The commits check is deliberately keyed on "any commits past
  `baseSha`", not tree cleanliness.** A `stop_failure` (a rate-limit, a
  quota exhaustion) produces the identical "phase: done" signal a real
  completion does — without this check, a task could reach `reviewing`
  with zero commits and a dirty tree (observed in production: task
  213765/branchdam issue #201). A **dirty-but-committed** tree still
  advances normally, exactly as before — only "HEAD is still at `baseSha`"
  (genuinely no commits at all) blocks the transition, since an untracked
  scratch file after a real turn is the ordinary case (see
  [Task → PR promotion](#task--pr-promotion)), not the failure this exists
  to catch. When it does block, the task fails instead (see
  [`tasks.md`](tasks.md#lifecycle)'s `* → failed`), and this check fails
  OPEN — advances normally — whenever it can't be determined (no `baseSha`
  recorded, an unreachable worktree).

  **Runs for every host now, not just the local one (`#1100`).** Before
  `#1100`, the check fell back to "advance anyway" unconditionally for every
  remote-hosted task, because the salvage commit the `* → failed` path
  below relies on could only be taken on the local filesystem — firing the
  gate without a way to salvage would have failed a remote-hosted task,
  terminated its session, and left the tree dirty with no way back, worse
  than not having the check at all. `host-git.ts`'s `commitHostWipChanges`
  (`commitWipChanges` locally, a proxied `/internal/git-commit-wip` route
  remotely) closed that gap, so `checkReviewingGate` now runs unconditionally
  for every host. `failReviewingGate` — the function that actually executes
  a no-commits failure — is what now decides whether a remote host's version
  skew or unreachability should fail this gate open: it probes
  `commitHostWipChanges` **first**, before its own status CAS lands, and
  only proceeds with the failure once that probe succeeds (`ok: true`,
  whether or not anything was actually dirty). An `"unsupported"` (an agent
  build predating that route) or `"unreachable"` result leaves the task's
  status untouched and logs a warning instead — the same fail-open posture
  the gate used to apply to every remote host, now correctly scoped to only
  the version-skew/unreachable case. `hasCommitsPastBase` (the grace-window
  lookup used for the shell-tail/rate-limit checks below) has the identical
  no-host-restriction fix, for the same reason.

- **The finished-since-claim check closes the reject snap-back.**
  `sessionStatus === "finished"` is a level, not an edge — once a
  session's last-turn-ended latch is set, it stays set until that
  session's NEXT turn starts or a genuine keystroke clears it. Reject
  (see [`tasks.md`](tasks.md)'s board actions) deliberately leaves a
  still-alive session's latch untouched so a human can type feedback into
  it themselves; without this check, the very next reconcile tick would
  re-derive "finished" from that SAME stale latch and snap the task
  straight back to `reviewing` before the human ever got a chance to type
  — pushing again and spawning a second review agent that clobbers
  `reviewSessionId`. `claimedAt` is reset on every fresh entry into
  `claimed`/`in_progress` — a new claim, Retry, a human Reject, **and an
  automatic auto-return round** (`autoReturnTask`, issue `#1357`) —
  covering all four without a new column. A rolled-back auto-return (its
  own re-seed attempt failed) restores the original `claimedAt` too, for
  the same "the clock the budget check reads must not have moved" reason.

**Shell-tail handoff (`#1380`, task 441117).** An outstanding background job
normally suppresses the completion signal, so the hand-off to review waits
on it — but a stuck **shell** job (a `until ...; do sleep 5; done` wait loop
the worker started for its own gate run and never stopped) would otherwise
hold the session at `derived.status === "background"` forever, since
nothing re-stamps `backgroundTasksAt` after the final turn and the
stale-latch sweep can't beat the claim-anchored budget. `isShellTailHandoff`
(`task-reconciler.ts`) treats the worker's turn as finished once its turn
ended since the claim and the ONLY thing keeping the session from deriving
`finished` is outstanding **shell** tasks that have outlived
`SHELL_TAIL_GRACE_MS` (5 minutes) past that turn end — outstanding
agent/subagent/MCP background work still blocks the hand-off regardless
(issue #428). This backstop feeds two places: the `in_progress → reviewing`
handoff above (once the grace has elapsed, the reconciler stops waiting and
runs the normal commits-past-base gate), and the per-task time budget
(`tasks.md`'s Safety envelope) — a task that hits its budget while its
worker has finished (cleanly, or behind such a shell tail) **with commits on
the branch** is handed to `reviewing` instead of force-failed, since failing
it now would throw away completed work the normal handoff was about to pick
up anyway. Outstanding non-shell background work, or a worker still mid-turn
with no commits, still fails on budget expiry exactly as before.

## The agent's contract

Every Task Master spawn is prompted with a standing preamble ahead of the
issue text, built in one place (`task-prompt.ts`) and shared by every
worker spawn site — claim, retry, the reject re-seed, and the reconciler's
automated re-seeds (red CI, PR review comments, review feedback, rebase);
the review agent gets its own shorter preamble instead (below). Before it, a
worker received literally the issue title and body and nothing else, which
left it to guess a completion contract it can't see from inside the
worktree. The rules it states, and why each is unguessable:

- **Ending your turn is the completion signal.** It's purely observed — the
  agent's `Stop` hook maps to a `done` progress message, which is what makes
  the session read as `finished`, which is what advances `in_progress →
reviewing`. There is no marker to write, tool to call, or endpoint to hit.
- **But do not exit the process.** A session that dies before the task
  reaches `reviewing` fails the task unconditionally (see
  [`tasks.md`](tasks.md#lifecycle)). "Stop talking" and "quit" are
  indistinguishable from inside the agent and as different as possible from
  outside it.
- **Drain background jobs before ending the turn.** See "Shell-tail
  handoff" above for the one bounded exception.
- **Review your own diff before committing.** The worker cannot see from
  inside the worktree that its diff goes to a separately spawned reviewer
  (see [Review agent mechanics](#review-agent-mechanics) below) that cannot
  edit files there and draws on a small, never-reset round budget shared
  with CI and PR-comment auto-returns — a defect the worker catches itself
  costs nothing, and the same defect caught downstream spends one of very
  few automatic chances to fix it. Deliberately CLI-neutral (no named
  command or subagent): it has to hold on whatever CLI and target repo Task
  Master is running against, the same reasoning `buildTaskMasterPreamble`'s
  own doc comment gives for naming no verification commands either.
- **Commit, and leave the worktree clean.** Untracked files block approval
  exactly as hard as uncommitted edits — promotion refuses a dirty tree, and
  `git status --porcelain` counts untracked as dirty. Uncommitted work also
  reports as "nothing changed" in the `→ reviewing` diff-stat.
- **Don't push, open the PR, or touch the issue.** Mullion does all of that
  on human approve.
- **Budget**, when one is configured, stated explicitly.
- **Never block on a question or a permission prompt.** This used to be
  conditional on an `auto` flag — a claim a human made was assumed to have
  someone watching to answer. It doesn't anymore (issue #964): the
  `in_progress → reviewing` gate's "no commits ahead of base" failure
  doesn't care how the task was claimed, so a manually-claimed worker that
  stops to ask dies exactly the same death as an autonomously-claimed one,
  and every re-seed (retry, reject, red CI, review feedback, rebase) hands a
  fresh session to nobody regardless of who made the original claim.
  branchdam-mobile tasks #66/#67 are the concrete case this closed: an
  opencode worker invoked the superpowers `brainstorming` skill, asked a
  clarifying question nobody answered, and failed with no commits.

The review agent gets its own shorter preamble instead — it keeps the
advisory "you are not expected to make changes" framing and adds the hazard
that it runs in the worker's _own_ worktree, so any file it writes there
blocks the human's approve.

The preamble is prose in the prompt, not a parsed protocol; nothing reads it
back. Editing the wording is safe as long as no line becomes a whole-line
`Manual:`/`Agent:`/`ReviewAgent:` directive — there's a test guarding that.

The bundle's `task-worker` skill (`src/bundle/skills/task-worker/`, shipped
to every CLI the same way `host`/`browser`/etc. are — see
[`agent-guide.md`](agent-guide.md)'s "Where your skills actually come from")
elaborates on the last bullet: what to actually do instead of asking, and
how to split a worker's own self-review pass from the separate reviewer's.
It gates itself on the opening line of the worker's own prompt rather than
an env var, since nothing marks a Task Master session in the process
environment, and explicitly excludes the review agent's own prompt shape.
It deliberately does not restate anything already in this preamble.

The review agent's own counterpart, `task-reviewer`
(`src/bundle/skills/task-reviewer/`, issue #955, same delivery mechanism),
elaborates on `buildReviewPrompt` the same way: what actually earns a
`findings` entry (a verdict of `changes-requested` spends one of the round
budget above regardless of finding severity — nothing in the code gates on
severity, so an all-nits verdict costs exactly the same round a blocker
would), what a `clean` verdict should mean, and the constraint of verifying
a diff from inside the worker's own live worktree without dirtying it. It
gates on the review prompt's own opening line, excludes the worker's prompt
shape, and is deliberately self-contained: it does not depend on or
reference a project's own custom reviewer subagent (`project_tooling.
reviewerAgent`) or any externally-installed review-methodology skill,
since neither is guaranteed present on an arbitrary target repo or CLI —
those remain separate, optional layers on top, not something this skill
leans on.

## Review agent mechanics

**The review agent is not purely advisory — it can drive one bounded round
back to the worker.** It runs once per `reviewing` entry, in the worker's own
worktree (the worker's turn is already over, so there's no concurrent-write
race), seeded with the task's title/body and pointed at the diff ("Review
this task's diff. You are not expected to make changes."). It has **no**
path to approve, reject, or send a task to `done`/`failed` — approve and
reject stay a human's call, via the buttons in the task detail panel
(unless `autoApprove` removes that human step — see
[Auto-approve](#auto-approve) below). What it CAN do:

- **Wait for CI before it even starts.** The spawn is decoupled from the `→
reviewing` transition itself — `task-reconciler.ts`'s
  `processPendingReviewSpawns` is a separate pass, run every reconcile tick
  (gated on `settings.taskMaster.enabled`, same as the transition it used to
  ride along inside — a review-agent spawn is new autonomous work, not the
  "already claimed/in_progress" progression the reconcile tick stays ungated
  for), that spawns the review agent for any `reviewing` task with no
  `reviewSessionId` yet. This exists because the transition and the draft PR
  open aren't atomic: a reviewer spawned inline at the transition would run
  before the PR — and therefore CI — exists at all. If the task has a PR,
  this pass resolves CI on its head commit (`github.ts`'s
  `fetchRunsForHead`/`computeCiStatus`) and holds — on `in_progress`, on
  `null` (no runs registered yet, indistinguishable at lookup time from
  "this repo has no CI at all"), **and** on the lookup itself throwing (a
  transient network blip, or GitHub not yet consistent on the brand-new
  PR) — up to `settings.taskMaster.reviewCiWaitMinutes` (default 15; `0`
  disables waiting — no env-var counterpart, since this is the one knob a
  stranded task on a repo with no CI needs live rather than a restart). All
  three share the same root cause: the very first lookup happens within
  moments of the push that created the head commit, before GitHub has
  necessarily registered the Actions run or even become fully consistent on
  the PR itself, so treating any of them as "proceed" on the very first
  check reproduces the #213782 incident this whole change exists to fix.
  Past the deadline — or immediately, for the genuinely nothing-to-check
  cases (no repo configured, no token, no PR yet) — it spawns anyway rather
  than let CI awareness become the reason a task never gets reviewed; a
  missing/failed check just means the reviewer sees no CI context instead
  of real pass/fail results. Waiting on `null`/throws too means a repo with
  no CI configured at all now costs up to `reviewCiWaitMinutes` worth of
  polling (two GitHub calls per tick) before its first review spawns,
  instead of spawning instantly — a deliberate tradeoff (Hermes review, PR
  #742) given this pass has no per-task backoff, acceptable at this tool's
  scale.

  Model resolution for the reviewer follows the same per-CLI split as the
  worker's own (see [`tasks.md`](tasks.md#agent-selection)) — `commandIsOpencode`/
  `commandModelCli` pick opencode's `Reviewer-Model:`/`Model:` fallback chain
  or a claude-code/codex/agy reviewer's own `--model` flag, resolved
  independently of whatever the worker command used.

  A CAS on `tasks.reviewSpawnClaimedAt`, claimed immediately before the
  spawn's own I/O, keeps a concurrent Reject/Give-up/Approve from racing a
  reviewer into existence for a task that's already moved on — but only for
  the claim _write_ itself; `createSessionRecord` is real async work after
  that (possibly a network round-trip to a remote host), so the _final_
  write that records the new `reviewSessionId` re-checks `status =
"reviewing"` too, and kills (`killSession`, not a bare backend
  `terminate` — the row must flip to `"killed"` or the exited-session
  reconciler surfaces it later as an unexplained crash) the session outright
  if the task moved on while it was spawning. A failed spawn clears its own
  claim so the next tick retries; a claim abandoned mid-flight by a process
  crash/redeploy (nothing else ever clears it) is reclaimed once it's older
  than 10 minutes.

- **Write an explicit verdict, atomically.** The reviewer is told to ALWAYS
  write a round-suffixed file outside the worktree (`task-prompt.ts`'s
  `taskReviewFindingsPath` — writing inside the worktree would dirty it and
  block approve's own clean-tree check), as JSON:
  `{verdict: "clean" | "changes-requested", summary, findings: [{path, line,
side, severity, body}], verified?, notes?, looksGood?}` — `summary` is one
  verdict sentence; `verified`/`notes`/`looksGood` are optional string
  arrays for what was checked, cross-cutting observations that don't anchor
  to a line, and what's solid about the change, respectively. Written to a
  temp file and moved into place as the last step, not written directly, so
  a reconcile tick can never observe a torn/partial write.
  `parseReviewFindings` tolerantly falls back to `changes-requested` (the
  whole file as `summary`, no anchored findings, no `verified`/`notes`/
  `looksGood`) for anything that isn't valid JSON in that shape — an agent
  that ignores the contract must never silently read as a clean review.
  `renderReviewFindingsMarkdown` renders the parsed verdict into the
  Hermes-style sectioned body actually posted: `**Verdict:**` line, then
  `### Critical` (severity `blocker`/`major`), `### Warnings`
  (`minor`/unset), `### Suggestions` (`nit`) — each with `- None` when
  empty — followed by `### Verified`/`### Notes`/`### Looks Good` when
  non-empty. A freeform (non-JSON) review renders verbatim instead, since
  its `summary` holds the whole file, not one sentence.

  A missing file is treated as **inconclusive**, not "no findings" and not
  "clean" — but not on the very first tick that observes it missing.
  `task-reconciler.ts`'s `processReviewingTasks` only accepts a missing file
  as genuinely absent once the review session has either `exited` (nothing
  more can ever be written) or been alive past `REVIEW_FINDINGS_GRACE_MS`
  (30 minutes — a real review commonly runs the repo's own verification
  gate before writing anything, so several minutes of silence with no file
  yet is normal, not evidence of a crash; `buildReviewPrompt` itself never
  instructs this, deliberately — see the `task-reviewer` skill above).
  Before this fix
  (Task Master trial 220921 / PR #743's incident), a `finished` turn-end
  with no file yet was ingested as inconclusive immediately, and durably —
  `reviewFindingsIngestedSessionId` latched permanently, so a real verdict
  file that landed moments later could never be read. The findings file is
  also unlinked at spawn time (`spawnReviewAgentNow`), not only once
  ingested, so a leftover from a prior same-round attempt is never
  re-ingested as this attempt's fresh output.

- **Post as an actual GitHub PR review**, not a plain conversation comment.
  Once the review session's turn ends, `task-reconciler.ts`'s
  `processReviewingTasks` reads the verdict back and
  `task-github-sync.ts`'s `postReviewFindingsComment` posts it via
  `createPullRequestReview` (`github-write.ts`) — each anchored finding
  becomes an inline comment on its own `path`/`line`, with the round header
  and summary as the review's own body. Falls back to a plain issue comment
  only when the task has no PR yet. **#737 — the verdict maps onto a gating
  review event**: `clean` → `event: "APPROVE"`, `changes-requested` →
  `event: "REQUEST_CHANGES"`, missing/inconclusive → `event: "COMMENT"`
  (unchanged). A gating event is only ever posted from a second, separately
  configured **reviewer App** identity (`resolveReviewerToken`,
  `github-integration.ts`; see
  [GitHub integration's Reviewer App section](github-integration.md#reviewer-app-opt-in-a-second-identity--737)
  for how to configure one) — the primary identity that opened the PR
  (`task-promote.ts`'s `openDraftPRForTask`) still can only ever post
  `COMMENT`, since GitHub 422s both `APPROVE` and `REQUEST_CHANGES` from a
  PR's own author. No reviewer App configured, not installed on this repo,
  or a mint failure all quietly downgrade that round's review to `COMMENT`
  from the primary identity — logged at `debug`, never a `githubSyncError`,
  the expected steady state for a repo the reviewer App doesn't cover. A 422
  on a gating attempt (the anchors rejected, or an unexpected rejection of
  the gating event itself) retries once, dropped back to a plain `COMMENT`
  from the primary identity, so the round's findings still land either way.
  Either way, the rendered text is also appended to `tasks.reviewFindings` —
  durable across the worktree's own eventual removal, and rendered in the
  task detail drawer's Review card.
- **Trigger an automatic `reviewing → in_progress` round.** If the verdict
  is `changes-requested`, this task hasn't already spent its round budget,
  and `taskMaster.enabled`: the task flips back to `in_progress` and the
  worker is re-seeded with the findings as its prompt — via `autoReturnTask`
  (`task-reconciler.ts`), the mechanism shared by every automatic
  "reviewing → in_progress" trigger (`#756`; a red required CI check and an
  unresolved PR review comment are later triggers on the same model — see
  `AUTO_RETURN_VIA`'s three `via` tags: `review-feedback`, `ci-feedback`,
  `pr-comment-feedback` — and [Auto-approve](#auto-approve) below). That
  helper wraps `task-reseed.ts`'s `reseedTaskIfSessionExited`, called with
  `force: true`. That force flag matters: unlike Reject's own re-seed (which
  leaves a still-alive session alone, since a human is expected to type
  into it themselves), the worker's own prompt tells it to "End your turn
  and stay running" — so the common case here is a still-`active` but
  genuinely idle session with nobody watching to feed it anything. `force`
  terminates that survivor first, then always spawns fresh via the same
  argv-prompt mechanism every other Task Master spawn uses — it never
  injects keystrokes into a live, possibly mid-tool-call TUI. A `clean`
  verdict never auto-returns — nor does an inconclusive (missing-file) one.
- **The round budget** (`tasks.autoReturnRounds`, renamed from
  `reviewRounds` — the TS property only; the SQL column stays
  `review_rounds`, since every other migration in this repo is a purely
  additive `ALTER TABLE ... ADD` and a genuine column rename risks
  drizzle-kit treating it as a drop-and-add against a live DB) is a counter
  that's incremented but **never reset** — not by Retry, not by a human
  Reject, so a task's auto-return budget is spent once per lifecycle no
  matter how many times a human sends it back around by hand. It's bounded
  by a resolved per-project cap (`resolveMaxAutoReturnRounds`/
  `projects.maxAutoReturnRounds`, `DEFAULT_MAX_AUTO_RETURN_ROUNDS = 2`) —
  before `#756` this was hardcoded to a single round for every project.
  `tasks.lastAutoReturnReason` records which trigger most recently spent a
  round. A task that wants another round but has none left gets one extra
  sentence folded into its posted review comment, naming the cap, so it's
  distinguishable from a task that was never going to auto-return in the
  first place — and stays in `reviewing` for a human either way.
- A `clean` or inconclusive verdict (or a review agent whose adapter can't
  receive a seed at all — see [Seed delivery](#seed-delivery) below) simply
  stays in `reviewing`; the review still posts, so a finished review is
  never silently invisible, but nothing auto-transitions.

`processReviewingTasks` is a genuinely separate poll from the
claimed/in_progress reconcile loop: it never touches session liveness or the
time budget, and it must run even on a tick with zero claimed/in_progress
tasks.

## Seed delivery

**A claim/retry/review spawn delivers its prompt as the agent's own
initial-turn argv** (e.g. `claude -- '<prompt>'`, `agy -i='<prompt>'`,
`opencode --prompt '<prompt>'`), appended to the spawned command line at
launch time — **not** via stashing a seed for the `SessionStart` hook to
return as `additionalContext`, the mechanism this used before.
`additionalContext` injects context into the agent's conversation but
never submits a turn, so an unattended agent spawned that way sat at an
empty prompt forever (never observed as anything other than `idle`, so the
reconciler could never advance it past `claimed`) — this is what "seed"
means throughout this doc and the API's `seedDelivered`/
`reviewSeedDelivered` fields: the initial prompt, however it's actually
delivered, not literally a stashed SessionStart seed. (The
promote-to-worktree flow — a human present, but idle just the same until
someone notices and types — had this exact bug too; it now prefers the
same argv delivery whenever the adapter supports it, and only falls back
to the stashed-seed mechanism for an adapter with none — and also
whenever an opencode promote's full-context transfer succeeds (see
`routes/sessions.ts`'s promote handler and `docs/agent-hooks.md`): there
the argv `--prompt` seed is skipped entirely, since the whole
conversation history carries over into the resumed `--session <id>` and
no auto-submitted turn is possible on a resume, but a supplied seed still
rides the stashed channel as static context alongside it.) The leading
`--` form (rather than
a bare
`claude '<prompt>'`/`codex '<prompt>'`) matters: a task title starting with
`-` would otherwise be parsed as an unrecognized option by claude's or
codex's own CLI, and the agent would exit before its first turn — verified
live against both. agy uses `-i=<value>` rather than a space-separated
`-i <value>` for the same reason in principle, though Task Master's actual
(interactive, no `-p`) spawn shape accepts a leading-hyphen value fine
either way — the equals form only matters for a print-mode invocation Task
Master doesn't use today; kept anyway since it's strictly more robust.

Not every agent can receive an initial prompt this way (only adapters that
declare an `initialPromptArgs` argv form — Claude Code, Codex, agy, and
OpenCode today; no `KNOWN_AGENTS` entry with no adapter at all has one,
currently `aider`/`gemini`/`pi`). For an **autonomous claim** (the worker
agent only), a resolved agent with no such form is refused outright rather
than spawning a blind agent with no instructions. A **manual** human claim
still proceeds — a person is present to paste the prompt in — with the
response's `seedDelivered: false` reflecting that; the task row's own
`seedDelivered` field also records it, so it stays visible on a later view
of the task, not just at the moment of the claim/retry HTTP response.
**The review agent has no such refusal**: it's always spawned once a task
enters `reviewing` (when one is configured), since refusing outright would
remove the one artifact (the empty session) that lets a human notice
something's wrong — but the prompt being skipped for an unseedable adapter
is no longer silent: the task row's `reviewSeedDelivered` field records it,
a warning is logged, and the task detail drawer's review card surfaces it
directly.

**A remote-hosted spawn's `seedDelivered` is never trusted from local
capability alone.** An agent build too old to know about the spawn body's
`initialPrompt` field silently strips it (Fastify's default
`removeAdditional` behavior applies even when the route's own schema
declares `additionalProperties: false`) — the session spawns promptless
and idle, the exact bug this mechanism exists to fix, while a naive
"this agent's adapter supports it, so it must have worked" guess would
still report success. `POST /internal/sessions` instead echoes back
`initialPromptApplied`, computed fresh by that agent's own build from the
request it actually received; its **absence** from an old build's response
(not a `false` value) is the version-skew signal — an old build's route
handler has no idea the field exists and simply never includes it. A
local-hosted spawn skips this uncertainty entirely (same process/build as
the primary, so there's nothing to skew).

## GitHub sync

Best-effort with respect to the local transition: **the local row is the
hub and is never blocked by GitHub being unreachable.** A sync failure is
logged and, since #485, also recorded on the task's `githubSyncError`
field — but there is still **no persistent retry queue**. A transient
GitHub outage means that one transition's label/comment is simply never
posted; the next transition's sync still fires normally, it just doesn't
go back and catch up the missed one. This is a stated, accepted gap (a
real retry would need genuinely tracking per-write retry state, or
accepting duplicate comments on every process restart) — not silently
dropped, but not automatically recovered either. `githubSyncError` is
scoped to write/scope failures only and cleared the next time a GitHub
**write** for that task succeeds, so it always reflects the current
write-scope state, not history.

Read-back runs the other direction too: the watcher also notices when a
linked issue **closes on GitHub**, and syncs that to the local task as
`done` — the table below is the local→GitHub half, not the whole
picture. A read-back failure (a transient rate limit, a 5xx) is logged
but deliberately **not** recorded into `githubSyncError` (Hermes review,
PR #495, second pass): that field's only clearing path is a successful
write, so a transient read hiccup recorded there would linger on the
banner until some unrelated write happened to fire, long after the
read-back problem itself resolved.

A third, narrower read-back exists purely for dependency freshness
(`#667`): closing a labeled issue that has dependents (`issues`/`closed`,
webhook or poll-driven) re-checks each dependent's blockers immediately via
`GET .../dependencies/blocking`, rather than waiting for that dependent's
own next poll tick. Best-effort and fire-and-forget, same posture as
everything else in this section — a failure here just leaves the dependent
`unresolved` until its own next check.

An `issue_dependencies`/`blocked_by_added`/`blocked_by_removed` delivery
drives the same kind of immediate re-check on the blocked task itself. For
`blocked_by_removed` specifically, the delivery's own known count (the
stored `dependencyCount` minus the one blocker this delivery proves was
just removed) is passed to the refresh instead of the raw stored value —
GitHub's `total_blocked_by` summary can still report the pre-removal count
for a few seconds even on an immediate re-fetch (verified live during
review), and passing it straight through would otherwise manufacture a
false "blocker(s) not visible to this token" entry on the common
single-blocker case.

### GitHub rate limiting (`#759`)

Every GitHub call in the process — REST or GraphQL, read or write, task
sync or task-reconciler.ts's own sweeps — shares one install-wide budget:
a module-scope "rate-limited until T" (`github-fetch.ts`), set whenever
any response classifies as a rate limit (`429` unconditionally, or `403`
carrying `Retry-After` or `X-RateLimit-Remaining: 0` alongside a
not-yet-passed `X-RateLimit-Reset`), and observed by both transports —
`githubApiFetch` (the shared chokepoint most reads and `githubGraphQL` go
through) and `github-write.ts`'s own `githubRequest` (which deliberately
bypasses `githubApiFetch` — see that file's header comment — so it checks
and records independently). A call made while the budget is in effect
fails fast and locally with `GitHubRateLimitError`, without spending a
request (or its 5s timeout) proving what the budget already knows.

**This is enforced at the transport, not threaded into
task-reconciler.ts's three per-task backoff maps**
(`draftPrRetryState`/`mergeRetryState`/`autoApproveRetryState`). Those maps
record an attempt optimistically, before the network call even happens —
there's no single catch site to hook a server-provided resume time into
without a deeper refactor of the discriminated-result types the sweeps
already use to swallow errors (`ApproveOutcome`/`PromoteOutcome`-style
shapes). The transport-level budget gets the same practical protection —
nothing anywhere in the process makes a GitHub call while rate-limited —
without that refactor, and it covers call sites this feature doesn't
enumerate too (`task-watcher.ts`'s dependency/readback/parent-title
passes). The three sweeps above also each check the budget at their own
entry point (skip opening a pass known to fail) and once per task inside
their loop (a limit can land mid-pass) — belt-and-suspenders on top of the
transport check, logged once per skipped sweep rather than once per call.

**Deliberately not gated at `task-watcher.ts`'s poll-tick level.**
`autoClaimReadyTasks` and `dispatchQueuedTasks` work with no GitHub
connection at all (a locally-created task can reach `ready` and claim with
zero GitHub calls) — skipping the whole tick whenever GitHub is
rate-limited would silently stop local-only auto-claim from working too,
which is exactly the GitHub-availability coupling this codebase's
local-board-works-regardless-of-GitHub decision rejects. Its GitHub-only
sub-passes (`syncProjectTasks`, `resolveStaleTaskBlockers`,
`fillParentIssueTitles`) still fail fast per-call via the transport check
above.

The **misdiagnosis** this also fixes: `githubRequest` used to classify
_any_ 403 as `GitHubWriteScopeError` ("the token likely lacks write
access"). GitHub returns 403 for a secondary rate limit and for an
exhausted primary limit too — before this, a rate-limited write was
reported to the user as a broken token. The rate-limit classification now
runs **before** that scope-error branch in both `githubRequest` and
`githubGraphQL`.

The budget is process-local, not persisted — same posture as the three
backoff maps above — so a restart just means one more live check against
GitHub, not a correctness problem.

| Transition      | GitHub side effect                                                                                                                                                                                                                                                                                                                            |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `→ claimed`     | Add `mullion-claimed`, comment "Task claimed — agent starting…"                                                                                                                                                                                                                                                                               |
| `→ in_progress` | Progress comment, throttled (see [`tasks.md`](tasks.md#safety-envelope))                                                                                                                                                                                                                                                                      |
| `→ reviewing`   | Swap `mullion-claimed` → `mullion-reviewing`, comment "Task ready for review." plus a diff-stat summary when available (`#491`); also opens a **draft** pull request (see [Task → PR promotion](#task--pr-promotion) below) — a separate, best-effort write, not part of this label/comment sync and not blocked by its failure or vice versa |
| `→ done`        | Swap `mullion-reviewing` → `mullion-done`, comment with the PR link, close the issue                                                                                                                                                                                                                                                          |
| `→ failed`      | Comment with the failure summary, remove active labels, leave the issue open                                                                                                                                                                                                                                                                  |
| reject          | Comment with the human's feedback text                                                                                                                                                                                                                                                                                                        |

`→ done`'s label swap/comment/issue-close all happen synchronously at approve,
same as always — none of it waits on the PR actually merging. Whether the PR
merges is a separate, asynchronous concern; see [Merge on approve](#merge-on-approve)
below.

The `→ reviewing` diff-stat (`#491`) is computed from `tasks.baseSha`, a
commit SHA `task-claim.ts` resolves and pins **before** creating the
worktree — the worktree is branched from that exact SHA, not a symbolic ref
like `origin/main` that could move between resolution and branch creation.
Works for a remote-hosted project too (#484: base-ref/SHA resolution and the
diff-stat computation both proxy to the owning host); `baseSha` stays null
only when that resolution itself failed (the host was unreachable at claim
time, or an old agent build predating the proxy route), same as a local
resolution failure. Preserved unchanged across Retry, since retry resumes
the same branch from the same original base. When `baseSha` is null, or the
diff itself can't be computed, the comment is posted with no number rather
than a guessed one.

This requires **write** access on Issues, Pull requests, and Contents —
broader than the read-only scope the base GitHub integration needs for its
Dock widget/panel. See
[`github-integration.md`](github-integration.md#task-master-additional-scope)
for exactly what to (re-)provision. A read-only token 403s on the first
write — every write in the table above (including the very first one, on
claim), plus a promotion failure (approve), is logged server-side **and**
recorded on the task's `githubSyncError` field, rendered in the task
detail drawer regardless of the task's status (see
[`tasks.md`](tasks.md#the-task-board)). If claiming a task never actually
labels/comments on its GitHub issue, the task itself will now say why —
`githubSyncError` is not `failureReason`: the latter is only rendered when
`status === "failed"` and also carries reject feedback, so a sync problem
never overwrites it.

## Task → PR promotion

**Works for remote-hosted projects too (#484).** Claim, the worktree
lifecycle, and promotion all proxy status/push/base-ref resolution to the
owning host (`src/services/host-git.ts`) the way worktree create/remove/
prune already did. The one remaining gap is version skew: a remote host
running an agent build that predates these proxy routes gets a draft-PR
skip (logged, not recorded as a sync error — this isn't a broken
connection) and approving it 501s with `remote-not-supported`, telling the
human to update that host's agent build — rather than silently misreading
"the route doesn't exist yet" as "not a repo" or "nothing to push."

**A PR is opened as a draft as soon as the task enters `reviewing`**, not
only at approve (`openDraftPRForTask`, `src/services/task-promote.ts`,
called best-effort from the reconciler's `→ reviewing` transition — a
failure here is logged and never blocks the transition that already
committed, same posture as the review-agent spawn next to it). This exists
so CI (`ci-cd.yml`/`codeql.yml` both trigger on plain `pull_request:`,
drafts included) and a human — or the optional review agent, see
[`tasks.md`](tasks.md#agent-selection) — have a real diff and real check
results to look at before a human commits to approving it. A dirty tree, an
unreachable host, an old agent build, or an undeterminable default branch
just means no draft opens yet; none of those block the `→ reviewing`
transition itself, and approve's own checks below still apply regardless of
whether a draft exists.

**The PR stays draft through all of `reviewing` and is undrafted only at
approve** (`promoteTaskToPR`'s own mark-ready call, `src/services/
task-promote.ts`) — the same timing that let branchdam-mobile task 348423 /
PR #83's external reviewer (Hermes) take its first look at the diff on (or
after) the exact instant the task flipped to "done", with nowhere for its
findings to land (`done` has no outgoing edge). That's safe today not
because the timing changed, but because such a workflow now structurally
cannot fire on a Task Master PR at all — see [External review workflows](#external-review-workflows)
below. An earlier design (PR #989) instead moved the undraft earlier, to
the moment Task Master's own review converged, to sequence around an
external reviewer; retired once the branch exclusion made that sequencing
unnecessary.

**A stranded `reviewing` task with no PR is retried, not left for dead**
(`retryStrandedDraftPRs`, `src/services/task-reconciler.ts`, its own sweep
inside `reconcileTasks`, separate from `processReviewingTasks` — that one is
joined on the _review_ session and can't see a task with no review agent
configured). Every reconcile tick, any `reviewing` task with `prNumber IS
NULL` gets another `openDraftPRForTask` attempt — starting at 5 minutes after
the last one and doubling on every further consecutive failure, capped at 1
hour, so a permanently-stuck reason doesn't retry forever at full frequency
(process-local, in-memory backoff — not durable, and deliberately so: losing
it on a restart just costs one harmless extra attempt; deliberately not a
give-up cap either — see the constant's own comment). This is
what makes "the worker cleaned up its worktree and ended its turn again,
trusting Mullion to push and open the PR" (task-prompt.ts's own framing)
actually work when the first, inline attempt at `→ reviewing` failed —
before this existed, that inline attempt was the task's only chance, ever.

The push itself (`pushBranch`, `src/services/git-push.ts`) always passes
**`--no-verify`** — it deliberately skips the _target_ repo's own local
`pre-push` hook. A promotion push is a machine action on a commit whose
pre-**commit** hooks already ran in the agent's own worktree; CI on the
resulting PR is the real gate, and an arbitrary repo's pre-push suite (which
can run a full test suite, install tooling, etc.) is not something this
synchronous push can afford to wait on.

On approve (`reviewing → done`): the worktree's tree must be clean (a dirty
tree 409s the approve request rather than silently excluding uncommitted
work from the PR), the branch is pushed if it has unpushed commits or no
upstream yet (idempotent either way — a plain `git push`, not `--force`),
and then: if a draft PR is already open (`tasks.prNumber` set — the common
case now), it's marked ready for review; otherwise a PR is opened directly,
non-draft, the same fallback behavior this had before drafts existed (title
from the task title, body from the task body plus a `Closes #N` line when a
GitHub issue is linked — a local-only task still gets a PR, it just has no
issue to close). These steps are ordered so that any failure leaves the
task in `reviewing`, untouched and safely retryable — never half-promoted.

On reject (`reviewing → in_progress`): the worktree and session are left
untouched by default so the agent can pick the feedback up on its own. If
its session has already exited, a fresh one is re-seeded in the **same**
worktree (never a new one) with the feedback as its prompt. A draft PR, if
one is open, is left as-is — the next `→ reviewing` (whether from this
same round or a later one) pushes the new commits to it, no new PR.

On give-up (`reviewing → failed`): a still-open draft PR is closed
(`closeDraftPRForTask`) — the only path that resolves `reviewing → failed`,
since a budget/session-death failure never reaches `reviewing` in the first
place and so never has a draft to close.

### Merge on approve

By default, approving a task does everything above and stops — the PR is
open, ready for review, non-draft, and nobody merges it. A per-project
setting, **`mergeOnApprove`** (Project Settings; a column on `projects`, no
install-wide equivalent — same "opt-in per project" posture as
`defaultReviewAgent`), changes that: approving a task also requests a merge
for its PR. A related setting, **`autoApprove`**, has a `reviewing` task
approve itself once its review agent's last verdict was `clean` and CI is
green — see [Auto-approve](#auto-approve) below.

Both default off. `mergeOnApprove` alone still requires a human to click
Approve; combined with `autoApprove`, the pair gives a fully automatic
issue-to-merged-`main` pipeline for that project.

**Why merging isn't synchronous.** A merge can't happen inside the approve
request itself — `main`'s branch protection requires the branch to be up to
date and its required checks green, and a branch that was just pushed almost
never satisfies either yet. GitHub's native auto-merge doesn't help either:
it does not update a behind branch under a `strict` (up-to-date-required)
protection rule, so relying on it would still need this same update-branch
step by hand. Approving instead sets `tasks.mergeRequestedAt` (the durable
_intent_), and a reconciler sweep (`processMergeRequests`,
task-reconciler.ts) lands the merge asynchronously, once GitHub allows it:

| PR state (`mergeable_state`)     | Sweep action                                                                                                                      |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `clean`                          | Squash-merges (explicit commit title — see the caveat below) and deletes the remote branch                                        |
| `behind`                         | Updates the branch, waits for the next tick (checks must re-run first)                                                            |
| `unstable`                       | Backs off and retries — does **not** merge (a non-required check, e.g. this repo's own `test-e2e`, is failing/pending; see below) |
| `blocked`                        | Backs off and retries — see the review-decision breakdown and re-assert behavior below                                            |
| `dirty`                          | Spawns a worker to auto-rebase (bounded, opt-in — see "Auto-rebase" below); backs off and retries otherwise                       |
| `unknown` (`mergeable === null`) | Backs off and retries — GitHub is still computing mergeability                                                                    |
| merged/closed (out of band)      | Clears the merge flag — idempotent no-op                                                                                          |

The sweep never gives up on a retryable state — `behind`/`unstable`/`blocked`/
`unknown` all become resolvable on their own (a check goes green, GitHub
finishes computing mergeability), and a give-up cap would just strand the
task the same way an unbounded-wait bug would. A **"Merge now"/"Retry
merge"** button in the task drawer (`POST /api/tasks/:id/merge`) re-arms the
sweep immediately, for cases that need a human to actually go fix something
first.

**Approve on a tracking epic (`#1020`).** When the task's underlying issue
is a tracking epic (open sub-issues remain — see [Task hierarchy](#task-hierarchy-sub-issues-701)
above) and still has open children
(`subIssueTotal - subIssueCompleted > 0`), Approve is **advisory, not
blocked**. The handler at `src/routes/tasks.ts` posts a GitHub comment
naming the open sub-issue count and returns `409
{ code: "tracking-epic-with-open-sub-issues", subIssueStatus }`; the
board's `TrackingEpicApprovalConfirm` component surfaces a two-stage
confirmation, and on "Close anyway" the frontend re-POSTs with
`?force=true` to bypass the warning and execute the close. Advisory was
chosen over blocking because #1016 already auto-parks ingested epics in
`backlog`, so a human clicking Approve on a `backlog`-parked epic is doing
it deliberately — a hard block would strand legitimate deprioritization
cases.

**`blocked` isn't one state (`#737`).** GitHub collapses several distinct
reasons a PR can't merge into this one `mergeable_state` value — a required
CHECK red or still pending, or a required APPROVING REVIEW missing or
dismissed. `attemptMerge` reads the PR's aggregate
`reviewDecision` (`getPullRequestReviewDecision`, `github-write.ts`,
GraphQL-only — REST has no equivalent) to tell them apart and records a
`tasks.mergeError` that actually names the cause:

| `reviewDecision`    | `mergeError`                                           |
| ------------------- | ------------------------------------------------------ |
| `CHANGES_REQUESTED` | "Changes were requested on the PR"                     |
| `REVIEW_REQUIRED`   | "Waiting on a required approving review"               |
| `APPROVED` / `null` | "Required checks are red or still pending" (unchanged) |

`null` covers both "the read itself failed" (logged, falls back to the
generic message) and "this repo has no review requirement configured at
all" — the same generic message is correct either way, since a required
CHECK is the only thing `blocked` could then mean.

**Re-asserting a dismissed approval.** A task only ever reaches `attemptMerge`
once it's `done` — a human clicked Approve, or auto-approve's own gate
fired — so an `APPROVED` review going missing here can only mean something
_dismissed_ it after the fact. The obvious cause is Mullion's own later
pushes: `"behind"`'s `updatePullRequestBranch` above, or an auto-rebase
worker's commits, both of which a repo with "Dismiss stale pull request
approvals when new commits are pushed" enabled will dismiss automatically.
When `reviewDecision` is specifically `REVIEW_REQUIRED` — no active review
objects, but the required-approval count isn't met, exactly what a
push-dismissed approval produces — the sweep resolves the reviewer
identity's token (`resolveReviewerToken`) and posts a fresh `APPROVE`
before falling back to recording an error. **Deliberately excludes
`CHANGES_REQUESTED`** (Hermes review, PR #827): a `done` task only ever got
there via the clean-gate or a human Approve, so a `CHANGES_REQUESTED`
decision at that point can only be a review posted _after_ — a human on
GitHub, or a later round — and re-asserting `APPROVE` over that would
silently override an explicit rejection instead of re-affirming a decision
that was already made. `CHANGES_REQUESTED` just gets the "Changes were
requested on the PR" message above, same as `REVIEW_REQUIRED` with no
reviewer App available. A successful re-assert normally flips
`reviewDecision` back to `APPROVED` immediately, closing the condition, so
the number of re-asserts is bounded by pushes to the head branch, not by how
long the sweep has been retrying — **except** when the reviewer App's
`APPROVE` doesn't actually satisfy branch protection at all (it isn't an
eligible approver — the CODEOWNERS limitation below), in which case
`reviewDecision` never flips and that argument breaks on its own (Hermes
review, PR #827, round 2). Guarded separately: the sweep memoizes the head
SHA a re-assert was last attempted for (alongside the rest of this task's
merge backoff state) and only tries again once `pr.headSha` actually
changes — bounding it to once per push regardless of whether any given
re-assert counts, rather than relying on `reviewDecision` flipping as the
only thing stopping it. A human's explicit "Merge now"/"Retry merge" click
resets this along with the rest of the backoff, so it isn't stuck waiting
for a push either. No reviewer App configured (or the re-assert attempt
itself failing) just falls through to recording the review-decision-aware
message above, same as before this existed.

**What this needs in branch protection to actually gate anything.** None of
this does anything unless the repo's branch protection has "Require a pull
request before merging" with at least **1** required approving review, and
a [reviewer App configured](github-integration.md#reviewer-app-opt-in-a-second-identity--737).
Turning that on has consequences worth knowing before you do it:

- Every human-authored PR in that repo now needs an approval too — this
  isn't scoped to Task Master's own PRs.
- A task with **no review agent configured** will sit at `blocked` /
  "Waiting on a required approving review" until a human approves it on
  GitHub — Mullion deliberately does not rubber-stamp a review requirement
  it has no verdict to back.
- "Dismiss stale approvals on push" is supported, not worked around: expect
  to see the reviewer App's review reappear after every rebase/branch-update
  push on a task that required one. That's the re-assert behavior above
  working as intended, not a bug.

#### Auto-rebase (`#758`)

`dirty` is different from the rest of that table: a
real conflict with the base branch never resolves on its own. `attemptAutoRebase`
(task-reconciler.ts) has **two call sites**, not one: the merge sweep's
`dirty` row above (a `done` task, already approved, whose worktree
`approveTask` already removed at approve time), and — separately —
[Auto-approve](#auto-approve)'s own gate below, for a still-`reviewing` task
whose PR is already `dirty`/unmergeable before it has ever been approved.
Both share the exact same function and the exact same opt-in: with
`projects.autoApprove` on (the same "nobody is watching" opt-in `#755`'s
red-CI-return and `#757`'s PR-comment-ingest use), it spawns a worker into
the task's branch to fix the conflict instead of just backing off:

- Recreates the worktree with `resumeTaskWorktree` (the same primitive Retry
  uses) at a deterministic path, **force-removing whatever's already there
  first** — this is not just cleanup of a stale prior attempt: on the
  `reviewing`-path call site, the task's worktree is very much still
  present (approve hasn't run yet), and possibly still holds an **active
  review session**. Before touching the worktree, `attemptAutoRebase`
  terminates any still-`active` session it knows about at that point — the
  rebase worker's own prior attempt (if `rebaseStartedAt` is stale) AND, for
  the first attempt on a `reviewing` task, the review session
  (`task.reviewSessionId`) itself — clearing `reviewSessionId` in the DB
  too if the worktree can't be recreated afterward. Force-removing a
  worktree with a live process still attached to it would yank the
  directory out from under a running agent, not just leak one.
- The seed prompt (`buildRebasePrompt`) asks the worker to rebase onto the
  current base, resolve conflicts, re-run the repo's own verification gate,
  and — unlike every other Task Master spawn — push the result itself with
  `git push --force-with-lease`: Mullion's own push only ever happens once,
  at the `-> reviewing` transition, and neither call site revisits it
  through the ordinary path.
- The task's status never changes as a _direct_ result of this function —
  a `done` task stays `done` throughout its own call site; a `reviewing`
  task stays `reviewing` throughout its own (the rebase worker's eventual
  commits still have to clear the ordinary `in_progress → reviewing` gate
  if the task ever gets re-seeded back through the normal pipeline — in
  practice a rebase worker is told to push directly and keep running, the
  same "stay running" contract every other re-seed uses). This is a sibling
  to the merge sweep's own retry loop, not an `autoReturnTask` round:
  `tasks.rebaseAttempts` is a separate, dedicated counter (default cap: **2**,
  no per-project override yet, shared across both call sites), and
  `tasks.rebaseStartedAt` tracks whether an attempt is still in its window
  (30 minutes) so consecutive sweep ticks don't spawn a second worker into
  the same worktree — deliberately NOT session-exit detection, since a Task
  Master worker is told to keep the session running after it finishes.
- If `resumeTaskWorktree` can't recreate the worktree (branch deleted or
  checked out elsewhere), or the attempt cap is spent, the sweep falls back to
  today's plain `dirty` backoff — surfaced in `tasks.mergeError` for a human,
  same as `mergeOnApprove` without `autoApprove`.

**Why `unstable` doesn't merge.** `unstable` means a _non-required_ check is
failing or still running — and this repo deliberately does not require
`test-e2e` or `codecov/patch` (see [`ci-cd.md`](ci-cd.md)). Merging on
`unstable` would silently skip whatever that check was verifying, right after
a fresh push while e2e is still queued. A human clicking Squash-and-merge on
GitHub at least sees the red X first; "Merge now" is the equivalent override
here. The flip side: a non-required check that never reports at all leaves a
PR `unstable` — and therefore never auto-merging — forever.

**Exception — PR-title lint self-heals (`#1035`).** A failing **PR-title
lint** check (e.g. `wagoid/commitlint-github-action` on repos that adopted
it after #761/#1037) is now self-healed rather than left `unstable`. The
shape — a check name like `lint-pr-title` / `commitlint` / `pr-title` / etc.
failing on a task's PR — is recognized by
`task-reconciler.ts`'s `attemptSelfHealPrTitle` at **two** call sites, not
one: the auto-approve gate's own red-required-check return path (ahead of
the ordinary "return to worker" flow, so a title-lint failure doesn't burn
an auto-return round) and the merge sweep's `unstable` handling above.
`resolvePrTitle` re-derives a Conventional Commits title from the task and
`updatePullRequestTitle` PATCHes the PR. No auto-return round is consumed
either way (the worker is forbidden by `buildTaskMasterPreamble` from
editing the PR, so re-seeding it for a title fix would burn rounds for
nothing). A check that isn't in the small curated set, or one where the
title can't be re-derived, falls through to the original `unstable`/
red-required-check path respectively.

**Commit title caveat, and the opt-in fix (`#761`).** This repo's squash-merge
uses the PR title as the `main` commit message, and an unprefixed title (no
`feat:`/`fix:`/...) silently drops out of release-please's changelog. By
default a task's PR title is still the raw task title, with no Conventional
Commits enforcement — matters more with `mergeOnApprove`/`autoApprove` on,
since nobody is reading the title before it becomes a permanent commit
message.

With `projects.conventionalCommitTitles` on, the worker is asked (via
`buildTaskMasterPreamble`) to write a `type(scope)?: description` title to a
`sessionsDir`-relative file (`taskCommitTitlePath`, task-prompt.ts — same
outside-the-worktree convention `taskReviewFindingsPath` already uses, and
for the same reason: a file written inside the worktree would dirty the tree
and block approval). `task-reconciler.ts` reads and validates it
(`parseCommitTitle`) at the exact "-> reviewing" transition, right before
`openDraftPRForTask`'s first PR-create call, and stores it on `tasks.prTitle`
— **not round-suffixed**, unlike the review-findings file: a worker
re-seeded for a later round only needs to rewrite it if the type should
change, and a round that doesn't touches nothing (`?? task.prTitle` on the
write). `task-promote.ts`'s `createOrRecoverPR` then uses `resolvePrTitle`
(task-prompt.ts), not a bare `task.prTitle ?? task.title` — see below for why
that distinction matters.

**Detection and auto-enable (`project-release-please.ts`).** The branchdam-
mobile incident: a target repo's issue titles used task-label prefixes
(`[T2-7b] ...`) rather than Conventional Commits ones, `conventionalCommitTitles`
was off (the default), and every squash-merged commit onto `main` was
unparseable to release-please — 16 of 21 commits since the last release,
completely silently, since `release-please-action` exits 0 on "no release
needed." Mullion now detects release-please itself — `release-please-config.json`
or `.release-please-manifest.json` committed at the repo root, via the
GitHub contents API (`detectReleasePleaseConfig`, github.ts) — and turns the
flag on automatically:

- **At project create** (`routes/projects.ts`'s POST handler) and, for
  projects that already existed before this shipped, **once per project in
  the reconciler tick** (`processConventionalTitlesAutoEnable`,
  task-reconciler.ts), gated on `projects.conventionalCommitTitlesResolvedAt
IS NULL` so each project costs at most one real detection attempt, ever.
- **One-shot, and permanent once a human decides.**
  `conventionalCommitTitlesResolvedAt` is stamped by the sweep on ANY
  definite outcome (detected or not) — and, independently, by a human PATCH
  of `conventionalCommitTitles` itself (`routes/projects.ts`), even if that
  PATCH happens before the sweep ever ran for that project. Without the
  PATCH-side stamp, an explicit "off" set before the sweep's first pass would
  look identical to "never decided," and the next tick would silently flip
  it back on.
- **Writes over a stored `false`, not just `null`** — the whole point, since
  a project that predates this feature is an explicit `0`, not `null`.
- **Standing warning, not just a one-time default.** `GET
/api/projects/:id/release` computes `conventionalTitlesWarning` — true when
  the repo has release-please config present and the flag is off — and the
  GitHub panel renders it as a sibling of the Release section (which itself
  returns nothing for `detection.kind === "not-configured"`, precisely this
  incident's own shape; see `RELEASE_WORKFLOW_FILENAMES`'s own doc comment,
  github-write.ts, for why a real release-please repo routinely fails that
  narrower, filename-based detection). Short-circuits to no probe at all
  once the flag is already on.

**`resolvePrTitle` — why auto-enabling a stored `false` is safe.**
Overriding a project's existing setting could regress a repo whose issue
titles were already hand-written and conventional (this repo's own `fix:`/
`chore:`/`fix(tasks):` titles, for instance) by letting a worker's own guess
replace them. `resolvePrTitle` (task-prompt.ts) prevents that: an issue title
that already parses as Conventional Commits wins over `tasks.prTitle`, in
every one of its four read sites (`task-promote.ts`'s create, its 422-adopt
re-sync, `openDraftPRForTask`'s re-sync, and `promoteTaskToPR`'s approve-time
re-sync). This makes auto-enable a strict no-op for a repo that was already
fine.

**The second silent layer this doesn't close on its own.** Even with the
flag on, a worker that skips writing the title file, or writes something
`parseCommitTitle` rejects, still falls back — previously visible only via
one `app.log.warn` in `task-reconciler.ts`. `withPrTitleFallback`
(`routes/tasks.ts`) computes the actual "did this fall back to a
non-conventional title" signal (not the same as raw `prTitle === null` — an
already-conventional issue title also leaves `prTitle` null but needs no
worker title at all) and TaskDetail.tsx renders it in the task drawer.

### Autorelease after tasks land (`#744`)

The manual half of `#744` (see `docs/github-integration.md`'s Release
section) gives a human a Run/Merge pair for a repo's own release-please PR.
**`autoTagRelease`** (Project Settings; a column on `projects`, same
per-project-only, default-off posture as `mergeOnApprove`/`autoApprove`
above) closes the last step: once a task's own PR merges (the `clean` branch
of the merge-on-approve sweep's table above — nothing else, notably not
`already-done`, which also covers a PR **closed without merging**), it arms
`tasks.releaseRequestedAt`. **`autoTagRelease` does nothing on its own** — it
only ever fires downstream of a task PR actually merging, so it requires
`mergeOnApprove` too; with `mergeOnApprove` off, no task PR ever merges
through Mullion and this setting is a no-op.

A second reconciler sweep, `processReleaseRequests` (task-reconciler.ts, runs
every tick right after `processMergeRequests`), groups every task with
`releaseRequestedAt` set **by project** and, once no task on that project has
landed for **10 minutes** (`RELEASE_QUIET_MS` — a quiet window, not a "wait
for release-please" timer specifically; it just needs to comfortably outlast
both release-please's own run and GitHub's async `mergeable_state`
recompute), merges the repo's open release-please PR — using the exact same
decision logic (`resolveReleaseMerge`, `services/release-merge.ts`) as the
manual Merge button, so "behind"/"dirty" refuse and back off rather than
update-branch/auto-rebase, for the same reasons that route's own doc comment
gives. A burst of several task merges on the same project inside one quiet
window coalesces into **one** release, not one per task — every armed task
in the group clears together on success.

The sweep only ever merges, never dispatches: the task PR's own merge is
already the `on: push` that regenerates the release PR, so nothing here
needs an `actions: write` token. A repo whose release workflow is
`workflow_dispatch`-only (no `on: push` trigger at all) never gets a release
PR out of a task landing — autorelease waits indefinitely in that
configuration; a human still needs the manual Run button there.

Failures are recorded per-task on `tasks.releaseError` (rendered in the task
drawer, same posture as `mergeError`) and retried indefinitely — same
never-give-up reasoning as the merge sweep's own table — with one exception:
if the repo turns out to have no release-please workflow at all, the sweep
gives up and clears the intent (retrying forever against a misconfigured
toggle is pointless noise), but leaves the explanatory message in place so
the failure stays visible instead of just going quiet.

Absent (feature off) or malformed (didn't match the pattern, or exceeded the
length bound) both fall back identically to the raw task title, one
`app.log.warn` — this never blocks promotion. Both the SEED path (telling a
worker where to write the file — `task-claim.ts`'s claim/retry spawns,
`task-reconciler.ts`'s rebase/CI-return/PR-comment-return/review-round
re-seeds, and `routes/tasks.ts`'s reject re-seed) and the READ path
(`task-reconciler.ts`'s `-> reviewing` ingest) are routed through
`SessionBackend` (`resolveSessionsDirWithFallback`/`readTaskCommitTitle`,
`#778`), so a remote-hosted task's worker writes to — and the primary reads
from — the OWNING host's own `sessionsDir`, not the primary's. A failure to
resolve the remote sessionsDir (host unreachable, version skew) falls back
to the primary's local path with a warn rather than blocking the spawn; a
failure to read the title file falls back to the raw task title, same as a
malformed one. The merge sweep passes the commit title explicitly so the
result is deterministic regardless of the repo's own squash-title setting,
but neither this nor the sweep gates the merge on a prefix check — that's
this repo's own policy, not
a Mullion-wide one.

**The title is re-synced to GitHub on every push, not just at creation
(`#782`).** `tasks.prTitle` updates correctly on every round (the
round-persistence design above), and all three places that can land an
already-existing PR number now sync it to the live PR: `promoteTaskToPR`'s
already-open branch (approve) already fetches the PR via
`getPullRequestByNumber`, so it compares against `pr.title` and PATCHes
only when they differ — zero extra API calls in the common (unchanged)
case. `openDraftPRForTask`'s already-open branch (every `-> reviewing`
after the first) makes no other GitHub call, so it takes a bare, idempotent
PATCH instead of fetching just to compare. `createOrRecoverPR`'s 422-adopt
branch (a `createPullRequest` collision — a human's out-of-band PR for the
same branch, or a duplicate-create race) picks up whatever title the
adopted PR already has, so it gets the same compare-then-PATCH as the
approve branch. A worker that legitimately changes the Conventional
Commits type between rounds (round 1 seeds a `docs:` fix, review feedback
turns it into `feat:` work) now reaches the live GitHub title — and
therefore the eventual squash-merge commit message (`attemptMerge` reads
`pr.title` from GitHub) — instead of staying frozen at whichever round
first opened the PR. A title-sync failure never
blocks promotion, same "never gate promotion on the title" posture `#761`
established for the read side.

### Auto-approve

With `autoApprove` on, a `reviewing` task approves itself — no human click —
once **all** of the following hold:

1. Task Master is enabled.
2. The task's current review round has actually been ingested
   (`reviewFindingsIngestedSessionId === reviewSessionId` — the _latest_
   round's verdict, not a stale one from an earlier round).
3. That round's verdict (`tasks.lastReviewVerdict`, written alongside
   ingestion by `processReviewingTasks`) is `clean`.
4. CI on the PR head reads an explicit `success` — via the same
   PR-plus-Actions-runs lookup the review-agent spawn already uses to wait
   for CI (`fetchCurrentCiStatus`, factored out of `resolveReviewCi`).
   **Unlike** that caller, there is no deadline after which auto-approve
   gives up and proceeds anyway: `in_progress`, no CI found at all, and a
   thrown lookup all simply mean "not yet," forever. A repo with no CI
   configured therefore never auto-approves — the right default for a gate
   whose whole job is to be a gate, not a formality that eventually
   rubber-stamps itself.
5. **The PR's `mergeable` field reads exactly `true` (`#1334`)** —
   `mergeable === null` ("unknown," GitHub still computing after a push) is
   neither confirmed-clean nor confirmed-dirty, and this gate mirrors the
   strictness of the dirty-clearing check next to it rather than falling
   through on merely `!== false`, so an unconfirmed state can't get
   auto-approved. `attemptAutoApprove` (`task-reconciler.ts`) evaluates these
   in a specific order, not the 1–5 numbering above: CI is fetched first
   (feeding the CI-return and PR-comment-return auto-return checks below),
   then steps 2 and 3 (round ingestion, clean verdict), then the
   dirty/mergeable check right below, then step 5 (`mergeable === true`),
   and only then step 4 (`status === "success"`) as the final gate before
   `approveTask` runs. If the PR is `dirty` or `mergeable === false` once
   steps 2/3 pass, `project.autoApprove` + an unspent `rebaseAttempts`
   budget triggers [Auto-rebase](#auto-rebase-758) right there — on the
   still-`reviewing` task, before it has ever been approved — instead of
   recording a merge error and waiting; only once the rebase paths are
   exhausted (attempts spent, or the worktree can't be recreated) does this
   record `mergeError` and hold.

Anything else — no review agent configured on the project (so no verdict is
ever ingested), `changes-requested`, `inconclusive`, CI red or still
running, or an unresolved `mergeable` state — leaves the task in `reviewing`
for a human... with one exception below (`#755`). Auto-approving records
the transition with `via: "auto-approve"`, distinct from a human's `via:
"approve"` in the task timeline and on `/ws/tasks`.

This gate is Mullion's own, enforced before a merge is ever requested — a
GitHub required-review is a separate, independent gate. **#737 — now
shipped**: when a reviewer App is configured, the same `clean` verdict
that drives auto-approve here is what `postReviewFindingsComment`
(`task-github-sync.ts`) maps onto an actual `event: "APPROVE"` on GitHub,
so both gates can be satisfied by the same review round rather than needing
a human to separately approve on GitHub too. See "Post as an actual GitHub
PR review" in [Review agent mechanics](#review-agent-mechanics) and
`blocked`'s review-decision breakdown above for the mechanism.

**Red required CI returns the task to the worker (`#755`).** The CI lookup
(step 4 above) is fetched _before_ steps 2/3, not after: a project with no
review agent configured never writes a verdict at all (step 2 never
passes), and an `inconclusive` verdict never satisfies step 3 either — so a
red **required** check on either of those would otherwise stall in
`reviewing` forever, exactly the gap this closes. "Required" means a name
present in `required_status_checks.contexts` from
`GET /repos/{owner}/{repo}/branches/{branch}/protection`
(`fetchRequiredStatusContexts`, `github.ts`, cached per repo/branch for an
hour — branch protection changes about never). The protection lookup needs
`administration: read` on the GitHub App token, and `mintInstallationToken`
(`github-app.ts`) never requests it for this scope — `READ_PERMISSIONS`
deliberately excludes it (scope creep for one feature), and an installation
token can only ever carry what's both granted on GitHub's side AND
requested at mint time, so granting the App broader permissions changes
nothing without also widening `READ_PERMISSIONS`; a 403/404 there fails
**closed** — "don't know" is never read as "nothing is required," and the
task is simply left in `reviewing` exactly as it would be without `#755`
at all. This means `#755` is silently a no-op for every task, every time,
on **every** install, with no operator-side remediation — only a code
change (widening `READ_PERMISSIONS`, or a new dedicated scope) fixes it,
which is deliberately out of scope for issue `#1360`. That issue instead
adds a throttled reconcile-log warning (once per repo/branch/hour) the
first time this 403 is actually seen, distinguished from the ordinary "no
protection configured" 404 (`getRequiredStatusContextsFailureReason`,
`github.ts`), so the silence is at least visible — it does not change the
fail-closed behavior itself. See [`docs/ci-cd.md`](ci-cd.md)'s "Branch
protection" section for the full writeup. A red required check whose shape
matches the PR-title-lint pattern above is self-healed instead of returned
to the worker — see "Exception — PR-title lint self-heals" above.

**Matched against Check Runs, not Workflow Runs — a fresh-review catch on
the first version of this feature.** `required_status_checks.contexts`
names live in a different GitHub API namespace than
`fetchRunsForHead`'s Workflow Run names: a single workflow run (`"CI/CD"`,
`"CodeQL"`) fans out into many per-job Check Runs
(`"test-node / lint-and-test"`, `"analyze / Analyze
(javascript-typescript)"`, ...), and it's the check-run name GitHub itself
compares against the required set — verified live against this repo's own
protection. The two namespaces share no names at all for a repo using
GitHub's standard "require these specific job checks" protection (the
common case, not an edge case), so the original implementation, which
compared `fetchRunsForHead`'s names against the required set, could never
match anything. The fix: `fetchCheckRunsForHead` (`github.ts`) reads
`GET /commits/{sha}/check-runs` directly, in the same namespace as the
required set, and that's what's actually matched. `fetchRunsForHead`
(unchanged) still supplies the coarse "is anything red at all" pre-filter —
a red workflow run and a red one of its constituent check runs are
correlated in practice (a job failure fails its parent workflow run too),
so this avoids a second GitHub call on the ordinary green-CI tick, at the
cost of not accounting for a `continue-on-error: true` job (out of scope).
A red run whose name isn't in the required set (this repo's own
`test-e2e`) is left alone either way, since the merge sweep itself doesn't
gate on it.

**`mergeableState === "blocked"` was considered and rejected** for the same
reason the original #755 design doc already ruled it out: this repo (like
most with `required_conversation_resolution` on) can read `"blocked"` with
perfectly green CI whenever Mullion's own review agent has left an
unresolved inline PR comment thread — a false positive unrelated to CI.

Shares `tasks.autoReturnRounds`/`maxAutoReturnRounds` — the same counter and
cap every other auto-return trigger uses (`reason: "ci"`). Once the cap is
spent, one PR comment names it (the same `postReviewFindingsComment`
mechanism the review-feedback loop's own cap-reached note uses) and the
task stays in `reviewing` — deduped per round (`ciCapCommentedRounds`,
`task-reconciler.ts`) so a task stuck red-and-capped gets exactly one
comment, not a fresh one on every sweep tick indefinitely; unlike the
review-feedback loop's own cap comment, which is naturally single-shot
(tied to a findings-ingestion CAS write), this path runs unconditionally
every tick a candidate row still matches, with no equivalent state
transition to hang a "have I already said this" check on. The worker is
re-seeded with a rendering of the same `ReviewCiInfo` the review agent
itself would see (`renderCiSummary`/`buildCiFailurePrompt`,
`task-prompt.ts`) — Mullion does not fetch or summarize Actions logs
itself; the worker has a shell and the real worktree, and can run
`gh run view --log-failed` far more precisely.

**A remote-hosted task can now auto-approve (`#760`).** Review-findings
ingestion (step 2 above) used to be local-only — this process could only
read the findings file off its own filesystem, so a remote-hosted review
agent's file (written on the REMOTE host) was invisible, and
`lastReviewVerdict` never got written for one regardless of what its
review agent actually found. `SessionBackend` gained a narrow,
identifier-only pair —
`readTaskReviewFindings(taskId, round)`/`deleteTaskReviewFindings(taskId,
round)` — that reads/deletes from whichever host actually ran the review,
mirroring the git-worktree proxy methods already on that interface
(`resumeTaskWorktree`, `listTaskWorktreeDirs`, ...). The remote agent-side
route (`/internal/task-review-findings`) derives the path entirely from
its own `hookSocketPath` plus the two numeric identifiers — no
caller-supplied path fragment at all, the same "target never a
caller-supplied path" safety `/internal/agent-rules` already relies on for
its own global-scope targets.

**The seed-side gap this left is now closed too (`#778`).** A remote-hosted
review agent's _seed prompt_ (`buildReviewPrompt`, telling it where to
write) used to be computed from THIS process's own local `sessionsDir`
unconditionally — a real (not merely theoretical) risk for a remote host
whose `sessionsDir` differs from the primary's: the read side would see a
genuinely-absent file (`null`, not an error) and, once
`REVIEW_FINDINGS_GRACE_MS` elapses, that reads identically to "the agent
never wrote anything," ingesting the task as **inconclusive** with a posted
PR comment — a confident wrong answer, worse than the honest stall this
gap produced before `#760`. Fixed via `SessionBackend.resolveSessionsDir()`
— `LocalBackend` returns `path.dirname(app.pty.hookSocketPath)` as before;
`RemoteBackend` asks the peer's own `/internal/config` route (already
existed, issue #247/roadmap 7.4) for its `sessionsDir`. Deliberately
uncached (a spawn happens once per round, not once per sweep tick, and
caching risks staleness across a remote host redeploy the primary never
restarts for); a resolution failure falls back to the primary's local path
with a warn rather than blocking the spawn. The same primitive fixes the
identical gap in the Conventional Commits title's seed path (`#761`'s
`commitTitlePath`, at every worker/re-seed spawn site) and adds a matching
`readTaskCommitTitle`/`/internal/task-commit-title` pair for its READ side
— see the Commit title section above.

**New PR review comments return the task to the worker (`#757`).** A human
leaving inline review comments directly on GitHub — not through Mullion's
own review agent — is a second real feedback channel Task Master used to
ignore entirely once a task reached `reviewing`. Hoisted the same way
`#755`'s CI check is, above steps 2/3, for the identical reason: a project
with no review agent never writes a verdict, and an `inconclusive` verdict
never satisfies step 3, so PR comments plus either would otherwise stall
forever. Resolved-vs-unresolved thread state has no REST equivalent —
`fetchPullRequestReviewThreads` (`github-write.ts`) is this repo's second
GraphQL call (after `markPullRequestReadyForReview`), reading
`reviewThreads { isResolved, comments { author, createdAt, path, line,
body } }` for the task's PR. Only **unresolved** threads with at least one
comment newer than `tasks.lastPrReviewCommentAt` trigger a round — GitHub
leaves a thread unresolved until a human clicks Resolve, so without that
cursor the same thread would re-trigger a round on every reconcile tick
forever. The cursor only advances once `autoReturnTask` actually confirms
the round started, never on a lost CAS race, so a losing attempt can't
cause a later, successful one to skip comments.

Mullion's own review posts (`postReviewFindingsComment`) are filtered out
by comparing each comment's author against `viewerLogin` — the identity
`token` itself authenticates as (an App's `<slug>[bot]` for an installation
token, a human login for a PAT fallback) — read from the same GraphQL
response rather than hardcoded, so this can't feed on its own output
regardless of which auth mode is configured.

Shares `tasks.autoReturnRounds`/`maxAutoReturnRounds` with every other
auto-return trigger (`reason: "pr-comment"`). Once the cap is spent, one PR
comment names it, deduped per round (`prCommentCapCommentedRounds`,
`task-reconciler.ts`) — same posture as `#755`'s own cap-reached comment,
kept in a separate map since the two triggers can each hit the cap for a
task independently and post different text.

### External review workflows

Some repos configure their own PR-triggered review automation, separate
from Task Master's own review agent — this repo's is Hermes
(`.github/workflows/hermes.yml`, invoking the org's reusable
`hermes-review.yml` on a self-hosted runner). Task Master does not depend
on it, use it, or wait for it: **Task Master's own review agent**
(`defaultReviewAgent`, resolved per task by `resolveReviewAgentCommand`)
**is the terminal review for every task it manages** — see
[Auto-approve](#auto-approve) above.

**Task Master's own PRs are deliberately excluded from such workflows'
automatic triggers.** `hermes.yml`'s `auto-review` job gates on
`!startsWith(github.event.pull_request.head.ref, 'mullion/task-')` —
`mullion/task-` is a closed namespace exclusive to Task Master
(`deriveTaskBranchName`, `git-worktree.ts`; the worker preamble forbids
pushing anything else there), so this is a complete exclusion, not a
heuristic. An earlier design (PR #989) instead made Task Master _wait_ for
an external reviewer like this before finalizing a task — it both raced (a
human's Approve could finalize before the external run even started; see
issue history on #981/#982/#991, closed as superseded) and duplicated work
Task Master's own review agent already does more reliably (a directly-
spawned, directly-tracked session, vs. guessing whether a GitHub Actions
run will happen and polling for its result asynchronously afterward).
Retired in favor of this simpler exclusion.

Manual/on-demand review requests (e.g. `@s3ntin3l8-hermes Review`) are
**not** gated — a human can still explicitly ask for a second opinion on a
Task Master PR; only the automatic trigger is excluded.

**If your project relies on a similar auto-triggered review workflow,** add
the same `mullion/task-` branch exclusion to its automatic trigger, or Task
Master's own PRs will race it.

## Rate-limit grace

`settings.taskMaster.rateLimitGraceMinutes` (env default
`MULLION_TASK_RATE_LIMIT_GRACE_MINUTES`, `5`) is the Settings-surfaced
control — see [`tasks.md`](tasks.md#safety-envelope). This is the mechanism
behind it.

When the agent fires a `rate_limit` `stop_failure` (subscription quota
exhaustion — Claude Code's weekly limit, opencode go's quota, and — since
issue `#1356` — agy's own `RESOURCE_EXHAUSTED` gRPC status from a
GCP/Antigravity backend, mapped onto the same `errorType: "rate_limit"`
classification `mapClaudeCodeStopFailure` already used, since agy has no
`error_type` enum of its own the way Claude Code does), the reconciler
holds the task alive for `rateLimitGraceMinutes` before falling through to
the normal fail path. The worker path gates `in_progress → reviewing` on
`checkReviewingGate` (no-commits → fail) — without this grace, a worker
that hit a subscription quota before committing anything would be failed
immediately. The review-agent path gates `isUsableSignal` for review
sessions with no findings file — without it, a review agent stuck on a
quota gets an inconclusive verdict and strands the task in `reviewing`
(auto-return requires `derived.status === "finished"`, never true for
`api_error`).

The grace state lives on the task row (`tasks.lastRateLimitAt`, captured by
`recordRateLimitEvent` in `task-rate-limit-grace.ts`) so it survives the
session's in-memory `errorState` TTL clearing at
`settings.sessions.staleErrorSeconds` (default 30 min) — this is the only
way the multi-day cooldown case (Claude Code's weekly limit, opencode go's
monthly cap) actually works, since the session's hook-driven `errorDetail`
is gone by then. The outer reconciler gate widens to include `finished` OR
`api_error` OR `in_grace` so a post-TTL-cleared session whose
`lastRateLimitAt` is still recent keeps getting re-checked (a `stop_failure`
never sets `lastTurnEndedAt`, so the cleared session would otherwise derive
to a non-`api_error`/non-`finished` status and strand the task).

Max 1440 minutes (24h): quotas can be weekly/monthly. `0` opts out (fail
immediately, the pre-grace behavior). Independent of `budgetMinutes` — the
time budget is the hard backstop; this is a softer "wait for recovery"
that's checked each reconciler tick. Independent of `staleErrorSeconds` —
the durable task-row anchor decouples the grace window from the session's
TTL.
