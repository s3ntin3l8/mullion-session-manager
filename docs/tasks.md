# Task Master

Task Master turns a GitHub issue — or a task created directly in the
dashboard — into an autonomously-worked, reviewed, and promoted pull
request: an agent claims the task into an isolated worktree, works it, an
optional review agent looks at the diff, and a human decides whether to
approve or send it back — the review agent itself can only trigger one
bounded round of automatic rework before that human decision, never
approve/reject on its own.

**Gate:** whether Task Master is enabled — deploy-time default
`MULLION_TASK_MASTER_ENABLED` (`false`), overridable at runtime from
Settings → Task Master without a restart (see Configuring Task Master
below). This only gates _autonomous_ behavior — the background watcher's
GitHub ingest and auto-claim, and the claim/approve/retry endpoints. It
does **not** gate `reject`/give-up (the escape hatches for a task already
in review), an already-claimed task's own budget enforcement and status
sync to GitHub, or the local task board itself (create/edit/drag/delete a
locally-created task) — those all work regardless. See the Safety envelope
section below for the full breakdown. Once a task can exist with no linked
GitHub issue at all, "the task list is empty when the gate is off" is no
longer a property this gate can promise. See [`roadmap.md`](roadmap.md)'s
Phase 6 section and Task Model & Task Board section for the design
rationale.

## Task model

A task is a row in Mullion's own `tasks` table — that row, not the GitHub
issue, is authoritative for workflow status, board order, and runtime state
(worktree path, branch, linked session). A GitHub issue, when one is
linked, is authoritative for the durable subset it actually closes over:
title, spec (issue body), and the final PR link.

- **GitHub-linked task**: created by the background watcher polling for
  open issues carrying the `mullion-task` label (configurable via
  `MULLION_TASK_LABEL`) on any connected project's repo — local or
  remote-hosted (#484). Every poll re-syncs the durable subset (title/body/
  `htmlUrl`) from the issue without touching status, board order, or any
  runtime field — a retitled issue is picked up on the next sweep instead
  of staying stale forever. When webhooks are enabled (see
  [`github-integration.md`](github-integration.md#webhook-delivery)), a
  `labeled`/`opened` delivery ingests the same way immediately instead of
  waiting for the next poll tick.

  An issue that loses the `mullion-task` label (or closes) while its task
  is still `backlog`/`ready` is **not** left untouched: the task fails
  (reversible via Retry) rather than sitting in `ready` forever eligible
  for auto-claim on an issue that's no longer trackable. A task that's
  already `claimed`/`in_progress`/`reviewing` — real work behind it, a
  worktree, maybe a branch — is left strictly alone either way; silently
  failing it out from under a label removal would be destructive. Both the
  webhook `unlabeled`/`closed` handlers and the poll loop's own read-back
  apply this identically, via one shared function, so the two can't
  produce different outcomes for the same issue.

- **Local task**: created directly on the board (`POST /api/tasks`), no
  GitHub issue at all. Works with the flag off. Local-board editing has
  three independent rules, not one: `boardOrder` is always editable
  regardless of status or issue linkage; `title`/`body` are only editable
  while there's **no linked issue** (the issue is where those get edited
  once one exists — a local edit would just be overwritten by the next
  sync, per the read-back rule above); `status` is only settable via the
  plain PATCH endpoint while the task's **current** status is `backlog` or
  `ready` (linkage isn't checked here — a linked task still sitting in
  `ready` can be dragged back to `backlog`). Deleting a task outright is
  the one operation gated on both conditions together: still
  `backlog`/`ready` **and** no linked issue. Once a task is claimed, or
  once it reaches a status past `ready`, the state machine below drives it
  instead.

## Lifecycle

Seven states:

```
backlog     → ready, failed
ready       → claimed, backlog, failed
claimed     → in_progress, reviewing, failed
in_progress → reviewing, failed
reviewing   → done, in_progress, failed
done        → (terminal)
failed      → backlog, ready
```

- **A locally-created task** starts in `backlog`; dragging it to `ready` on
  the board is the interactive "make this claimable" trigger.
- **A watcher-ingested issue** is inserted directly into `ready` — i.e.
  auto-claim-eligible — **unless** its body contains a line reading
  `Manual: true`, in which case it lands in `backlog` instead. This is the
  opt-out: an ingested issue is autonomous by default, matching the "make
  this production-grade and auto-claimable" goal.
- **`claimed → in_progress`** fires on the reconciler's next poll once the
  claimed session's derived status is anything other than `idle` — not
  specifically "real activity": a session merely blocked on a permission
  prompt, or mid-compaction, also flips the task to `in_progress`.
- **`* → reviewing`** fires when the worker session reaches
  `sessionStatus === "finished"` (its last turn ended and no background
  tasks are still running) **and** that finish postdates this
  `claimed`/`in_progress` spell (`task.claimedAt`) **and** the branch has at
  least one commit past its recorded `baseSha` (`task-reconciler.ts`'s
  `checkReviewingGate`, `#722`). `claimed → reviewing` directly (skipping
  `in_progress`) is a real, reachable edge: the reconciler polls on an
  interval, and a task whose agent finishes its very first turn between two
  polls is legitimately never observed `in_progress` in between.

  Both extra conditions close real gaps a plain "finished" signal left open:
  - **The commits check is deliberately keyed on "any commits past
    `baseSha`", not tree cleanliness.** A `stop_failure` (a rate-limit, a
    quota exhaustion) produces the identical "phase: done" signal a real
    completion does — without this check, a task could reach `reviewing`
    with zero commits and a dirty tree (observed in production: task
    213765/branchDAM issue #201). A **dirty-but-committed** tree still
    advances normally, exactly as before — only "HEAD is still at
    `baseSha`" (genuinely no commits at all) blocks the transition, since an
    untracked scratch file after a real turn is the ordinary case (see Task
    → PR promotion below), not the failure this exists to catch. When it
    does block, the task fails instead (see `* → failed` below), and this
    check fails OPEN — advances normally — whenever it can't be determined
    (no `baseSha` recorded, an unreachable worktree), and **unconditionally
    for every remote-hosted project**, not just one whose host predates the
    git-status proxy (`#484`): the salvage commit `* → failed` below relies
    on is local-only, and firing this check without it would fail a
    remote-hosted task, terminate its session, and leave the tree dirty —
    worse than not having this check at all. So it can never itself strand
    a healthy task.
  - **The finished-since-claim check closes the reject snap-back.**
    `sessionStatus === "finished"` is a level, not an edge — once a
    session's last-turn-ended latch is set, it stays set until that
    session's NEXT turn starts or a genuine keystroke clears it. Reject
    (below) deliberately leaves a still-alive session's latch untouched so a
    human can type feedback into it themselves; without this check, the
    very next reconcile tick would re-derive "finished" from that SAME
    stale latch and snap the task straight back to `reviewing` before the
    human ever got a chance to type — pushing again and spawning a second
    review agent that clobbers `reviewSessionId`. `claimedAt` is reset on
    every fresh entry into `claimed`/`in_progress` (a new claim, Retry, and
    Reject alike), so requiring the finish signal to postdate it covers all
    three without a new column.

- **`reviewing → in_progress`** has two triggers, one human and one
  automatic. The human one is Reject (see below). The automatic one is the
  review-findings loop's own auto-return (`#569`'s follow-up — see Agent
  selection's review-agent paragraph): once, per task, when the review
  agent's findings are non-empty and `taskMaster.enabled`. Both land on the
  same target status; `recordTaskTransition`'s `via` tag (`"reject"` vs.
  `"review-feedback"`) is what tells them apart in the transition log and
  the `/ws/tasks` stream.
- **`* → failed`** fires automatically on session exit (a `claimed`/
  `in_progress` task whose session dies is failed, not left pointing at a
  dead session forever), on exceeding the per-task time budget (see Safety
  envelope below), or on the no-commits case the `* → reviewing` bullet
  above describes — `failureReason: "agent ended its turn with no commits on
<branch>"`. That last one first attempts a machine-made salvage commit
  (`commitWipChanges`, `git-worktree.ts`, local hosts only for now) —
  `git add -u` plus untracked-and-not-gitignored files, `git commit
--no-verify` — so the branch isn't left truly empty and Retry (below) can
  actually resume the work; the worktree is then removed if (now) clean,
  same as every other automatic failure. `reviewing → failed` is **not**
  automatic on session exit — the worker's turn is already over and the
  work is committed on its branch, still promotable regardless of whether
  that session is still alive.
- **`failed → claimed`** (`#483`) — **Retry**, on a `failed` task, resumes
  work rather than restarting it: it checks out the task's preserved
  `mullion/task-<id>` branch (see Worktree lifecycle below for why that
  branch survives a failure) into a fresh worktree and spawns a new session
  there, so committed-but-unfinished work isn't lost. This is a dedicated
  route (`POST /api/tasks/:id/retry`), not the `failed → backlog`/`ready`
  table edges — those two remain legal but still have no separate trigger,
  since retry supersedes the two-step "flip to ready, then claim" flow they
  would have required. Gated on Task Master being enabled, same as Claim,
  since it also spawns a session.
- **`reviewing → failed`** (`#483`) — **Give up**, the other resolver of a
  `reviewing` task alongside Approve/Reject, for when the answer is "give
  up entirely" rather than "try again." Not automatic on session exit, same
  as Reject — always a deliberate human action. Ungated, the same escape
  hatch reasoning as Reject (see Safety envelope below).

Every transition is logged and broadcast on the live `/ws/tasks` channel
(`#488`, see The task board below) through a single chokepoint,
`recordTaskTransition` (`task-state.ts`) — every status write in this
section calls through it rather than logging/broadcasting independently, so
the two can't drift out of sync.

### Dependency-aware claiming (`#667`)

Auto-claim (`autoClaimReadyTasks`, `task-watcher.ts`) respects GitHub's
native issue dependencies (`GET .../issues/{n}/dependencies/blocked_by`) —
filing a fully-ordered roadmap and labeling every issue `mullion-task` +
`ready` up front no longer requires hand-gating each one with `Manual: true`
and promoting them one at a time. A `ready` task with an open blocker is
**not** claimed — it stays `ready`, visible and manually claimable, rather
than moving to a separate status. There is deliberately no `blocked`
status: the seven-state lifecycle above is unchanged, and a blocked task
un-blocks itself with no transition once its last blocker closes.

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
GitHub's rate limit (this repo has no 429/`Retry-After` handling anywhere).
Instead, `autoClaimReadyTasks` only resolves blockers for a candidate it is
actually about to try, bounded three ways, cheapest first:

1. A **capacity pre-count** — zero GitHub calls once `claimed`/
   `in_progress` tasks already fill `maxConcurrent`.
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
re-checked immediately rather than waiting for a poll tick — see GitHub
sync below and `docs/github-integration.md`'s webhook event list.

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

### Task hierarchy (sub-issues) (`#701`)

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
`dependencyCount`, nullability here carries no fail-closed meaning — this
is **display-only** and never gates a claim decision, so "not yet observed"
and "known to have no parent" don't need to be distinguishable the way they
do for dependencies.

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

## The task board

The task board and the session board (originally two separate surfaces —
issue #211's session-only Kanban view and this section's own dockview
panel) have merged into one unified Kanban view (`frontend/src/
UnifiedBoard.tsx`). Command Palette → Integrations → **Tasks**, the
sidebar's own Tasks nav entry (badge count of tasks needing a decision
right now — `ready` + `reviewing`), or the list/Kanban toggle in the
toolbar all switch to it — it's an overlay over the dockview grid, not a
panel, so toggling back to list view instantly restores whatever was
tiled underneath. Task status columns are the board; a task with a linked
worker or review session renders that session's live status nested on its
own card, and any session not owned by a task collects in an "ad-hoc
sessions" lane beneath the columns, grouped by the same severity tiers
the original session board used.

- Cards show title, owning project, linked-issue number, resolved agent
  name, and — nested directly on the card — its worker/review session's
  live status dot and label, not just a static indicator. A session whose
  id is still on the task but that's no longer live (killed or reaped)
  renders a muted "ended" chip instead. Status itself is the column a card
  sits in, not repeated on the card.
- Drag-and-drop uses its own `application/x-mullion-task` MIME type (not
  the session grid's `application/x-mullion-session`), so a task card can't
  be dropped into a terminal panel's dockview area. Only `backlog↔ready`
  is a valid drag target on **both** ends — every other column change goes
  through Claim/Approve/Reject instead, since those are the only
  transitions the plain `PATCH /api/tasks/:id` endpoint accepts (dragging a
  card between any two other columns is rejected client-side before the
  request is even sent). Reordering within any single column (including
  the autonomous-only ones) always works — `boardOrder` is a purely local
  render tier with no GitHub representation, so it's editable regardless
  of status.
- Clicking a card opens its detail as an inline drawer on the board's own
  right side (not a separate panel) with Claim/Approve/Reject/Retry/Give
  up, the worker session's embedded timeline, and — when a review agent is
  configured — a distinct "Review" card with the review agent's own
  timeline, its captured findings text, and (once the task has auto-returned)
  a round indicator. Claim, Approve, and Retry (`#483`) are disabled (with an
  explanatory hint) whenever Task Master is off, since all three spawn or
  promote autonomous work; Reject and Give up stay enabled — see the
  Safety envelope table below for why. The board and local CRUD are not
  gated either way.
- **Live updates (`#488`, ingest events added by `#490a`).** The board
  connects to `/ws/tasks` (`src/routes/ws-tasks.ts`) once on mount and
  refetches (debounced ~250ms) whenever an event arrives — a task moved
  by another tab or the reconciler, a webhook `closed` → `done` sync, or a
  genuinely new task appearing (whether ingested via webhook or the next
  poll sweep) all show up in ~1s instead of on the next poll tick.
  Deliberately a doorbell, not a data channel: two frame kinds share the
  channel — `transition` (`taskId`/`projectId`/`kind`/`from`/`to`/`ts`) and
  `ingested` (`taskId`/`projectId`/`kind`/`ts`, no `from`/`to` since the
  task wasn't anything before) — and the client always refetches rather
  than patching a row from either payload, so the board can't drift from
  the server's own view. The board's existing ~60s poll (matching the
  watcher's own default sweep interval) stays as the fallback for whenever
  this channel is disconnected or reconnecting — it's additive, not a
  replacement. Unlike `/ws/github`, this channel has no subscribe
  handshake — a connection receives every task event install-wide the
  moment it opens, since the board is cross-project by design.

## Agent selection

Two independent choices are resolved per task, most-specific tier wins:

**Worker agent** (which agent actually claims and works the task):

1. The issue body's own `Agent: <name>` line (e.g. `Agent: codex`).
2. The owning project's `defaultAgent` setting (Project Settings' Default
   Agent dropdown, or `projects.defaultAgent` directly).
3. The install-wide `settings.launchers.defaultAgent`.

**Review agent** (the optional reviewer — see below):

1. The issue body's own `ReviewAgent: <name>` line.
2. The owning project's `defaultReviewAgent` setting.
3. Unset → no review agent spawned; a human reviews directly, today's
   unchanged default behavior. There is **no** install-wide fallback tier
   for the review agent — it's opt-in per project/task, not a new global
   default.

Both directives are matched case-insensitively on their own line (a
document that merely _mentions_ "Agent: claude" in prose isn't picked up).
An unrecognized agent name at any tier is logged and falls through to the
next tier rather than failing the claim — a typo in an issue body shouldn't
block autonomous pickup, and neither should a stale project setting.

The resolved worker command is recorded once, at claim time, on the task's
own `agentCommand` field — so the task board can show which agent actually
ran a task without re-deriving precedence after the fact (the issue body,
project setting, or global default could all have changed since).

**The review agent is not purely advisory — it can drive one bounded round
back to the worker.** It runs once per `reviewing` entry, in the worker's own
worktree (the worker's turn is already over, so there's no concurrent-write
race), seeded with the task's title/body and pointed at the diff ("Review
this task's diff. You are not expected to make changes."). It has **no**
path to approve, reject, or send a task to `done`/`failed` — approve and
reject stay a human's call, via the buttons in the task detail panel. What
it CAN do:

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
  `fetchRunsForHead`/`computeCiStatus`) and holds — on `in_progress`
  **and** on `null` (no runs registered yet, indistinguishable at lookup
  time from "this repo has no CI at all" — the very first lookup happens
  within moments of the push that created the head commit, before GitHub
  has necessarily registered the Actions run) — up to
  `settings.taskMaster.reviewCiWaitMinutes` (default 15; `0` disables
  waiting — no env-var counterpart, since this is the one knob a stranded
  task on a repo with no CI needs live rather than a restart). Past the
  deadline, or on any resolution failure (no repo, no token, the lookup
  itself failing), it spawns anyway rather than let CI awareness become the
  reason a task never gets reviewed — a missing/failed check just means the
  reviewer sees no CI context instead of real pass/fail results. Waiting on
  `null` too means a repo with no CI configured at all now costs up to
  `reviewCiWaitMinutes` worth of polling (two GitHub calls per tick) before
  its first review spawns, instead of spawning instantly — a deliberate
  tradeoff (Hermes review, PR #742) given this pass has no per-task backoff,
  acceptable at this tool's scale.

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

- **Write an explicit verdict.** The reviewer is told to ALWAYS write a
  round-suffixed file outside the worktree (`task-prompt.ts`'s
  `taskReviewFindingsPath` — writing inside the worktree would dirty it and
  block approve's own clean-tree check), as JSON:
  `{verdict: "clean" | "changes-requested", summary, findings: [{path, line,
side, severity, body}]}`. `parseReviewFindings` tolerantly falls back to
  `changes-requested` (the whole file as `summary`, no anchored findings) for
  anything that isn't valid JSON in that shape — an agent that ignores the
  contract must never silently read as a clean review. A missing or empty
  file is treated as **inconclusive**, not "no findings" and not "clean": the
  review may not have happened at all (a crash, a killed session, or an
  agent that ignored the instruction), so `task-reconciler.ts` posts it as
  such rather than a confident "nothing wrong here."
- **Post as an actual GitHub PR review**, not a plain conversation comment.
  Once the review session's turn ends, `task-reconciler.ts`'s
  `processReviewingTasks` reads the verdict back and
  `task-github-sync.ts`'s `postReviewFindingsComment` posts it via
  `createPullRequestReview` (`github-write.ts`) — each anchored finding
  becomes an inline comment on its own `path`/`line`, with the round header
  and summary as the review's own body. Falls back to a plain issue comment
  only when the task has no PR yet. The review is always `event: "COMMENT"`
  — never `APPROVE`/`REQUEST_CHANGES` — since the PR is authored by this
  same GitHub App installation and GitHub rejects both from a PR's own
  author; it carries no merge-gating state. (A second identity able to
  actually approve/request-changes is tracked separately —
  [#737](https://github.com/s3ntin3l8/mullion-session-manager/issues/737) —
  a materially bigger, deliberately deferred piece of work.) Either way, the
  rendered text is also appended to `tasks.reviewFindings` — durable across
  the worktree's own eventual removal, and rendered in the task detail
  drawer's Review card.
- **Trigger one automatic `reviewing → in_progress` round.** If the verdict
  is `changes-requested` and this task hasn't already used its one round
  (`tasks.reviewRounds < 1`, a counter that's incremented but **never
  reset** — not by Retry, not by a human Reject, so a task auto-returns at
  most once across its whole lifecycle) and `taskMaster.enabled`: the task
  flips back to `in_progress` and the worker is re-seeded with the findings
  as its prompt (`task-reseed.ts`'s `reseedTaskIfSessionExited`, called with
  `force: true`). That force flag matters: unlike Reject's own re-seed
  (which leaves a still-alive session alone, since a human is expected to
  type into it themselves), the worker's own prompt tells it to "End your
  turn and stay running" — so the common case here is a still-`active` but
  genuinely idle session with nobody watching to feed it anything. `force`
  terminates that survivor first, then always spawns fresh via the same
  argv-prompt mechanism every other Task Master spawn uses — it never
  injects keystrokes into a live, possibly mid-tool-call TUI. A `clean`
  verdict never auto-returns — nor does an inconclusive (missing-file) one.
- A `clean` or inconclusive verdict (or a review agent whose adapter can't
  receive a seed at all — see `reviewSeedDelivered` below) simply stays in
  `reviewing`; the review still posts, so a finished review is never
  silently invisible, but nothing auto-transitions.

`processReviewingTasks` is a genuinely separate poll from the
claimed/in_progress reconcile loop (see the Lifecycle section's own note):
it never touches session liveness or the time budget, and it must run even
on a tick with zero claimed/in_progress tasks.

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

## The agent's contract

Every Task Master spawn is prompted with a standing preamble ahead of the
issue text, built in one place (`src/services/task-prompt.ts`) and shared by
all four spawn sites — claim, retry, the reject re-seed, and the review
agent. Before it, a worker received literally the issue title and body and
nothing else, which left it to guess a completion contract it can't see from
inside the worktree. The rules it states, and why each is unguessable:

- **Ending your turn is the completion signal.** It's purely observed — the
  agent's `Stop` hook maps to a `done` progress message, which is what makes
  the session read as `finished`, which is what advances `in_progress →
reviewing`. There is no marker to write, tool to call, or endpoint to hit.
- **But do not exit the process.** A session that dies before the task
  reaches `reviewing` fails the task unconditionally (see Lifecycle above).
  "Stop talking" and "quit" are indistinguishable from inside the agent and
  as different as possible from outside it.
- **Drain background jobs before ending the turn.** An outstanding one
  suppresses the completion signal entirely, so the task rides out its
  budget instead of reaching review.
- **Commit, and leave the worktree clean.** Untracked files block approval
  exactly as hard as uncommitted edits — promotion refuses a dirty tree, and
  `git status --porcelain` counts untracked as dirty. Uncommitted work also
  reports as "nothing changed" in the `→ reviewing` diff-stat.
- **Don't push, open the PR, or touch the issue.** Mullion does all of that
  on human approve.
- **Budget**, when one is configured, stated explicitly.

One line is conditional: an **autonomous** claim is additionally told nobody
is watching and not to stop and ask, which a manual claim (a human clicked
Claim, and is sitting right there) deliberately omits. The review agent gets
its own shorter preamble instead — it keeps the advisory "you are not
expected to make changes" framing and adds the hazard that it runs in the
worker's _own_ worktree, so any file it writes there blocks the human's
approve.

The preamble is prose in the prompt, not a parsed protocol; nothing reads it
back. Editing the wording is safe as long as no line becomes a whole-line
`Manual:`/`Agent:`/`ReviewAgent:` directive — there's a test guarding that.

## Configuring Task Master

Every control in the safety envelope below except the runtime pause has two
layers: a **deploy-time env default** and an optional **Settings override**
that supersedes it at runtime, without a restart — the same
default-with-override contract `PROJECTS_ROOTS`/`settings.projectRoots`
already has for project discovery. Settings → Task Master shows and edits
the **effective** value directly; a "Reset to environment defaults" button
clears every override back to whatever `.env` says. An install that never
opens that section behaves exactly as it always has, driven entirely by env
vars.

Two exceptions stay env-only, shown read-only in the Settings section:
`MULLION_TASK_LABEL` (changing it mid-flight would orphan every
already-labeled GitHub issue, with no migration path — it's effectively
deploy identity, not a preference) and `MULLION_TASK_POLL_INTERVAL` (a
GitHub rate-limit tradeoff nobody tunes from a browser).

Even **whether Task Master runs at all** is now a runtime toggle:
`MULLION_TASK_MASTER_ENABLED` is only the deploy-time default for
Settings → Task Master's "Enable Task Master" switch — no restart
required. Each consumer picks it up on its own schedule: the claim/
approve/reject endpoints re-resolve it per request (immediate), the
watcher's GitHub ingest + auto-claim on its next poll tick (up to
`MULLION_TASK_POLL_INTERVAL` seconds), and the task reconciler on its next
tick of `settings.sessions.reconcileIntervalSeconds` (30s default) — though
the reconciler's own safety-net work (budget enforcement, progressing
already-claimed tasks) runs regardless of this toggle either way, see the
Safety envelope table below.

## Safety envelope

Each control below is a runtime Settings override on top of a deploy-time
env default; see [`configuration.md`](configuration.md) for the
authoritative description of each env var — this table's own job is
mapping each one to its Settings key and explaining what it actually gates.

| Control                               | Setting (overrides the env default)          | Env default                                    | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------- | -------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Whether Task Master runs at all       | `settings.taskMaster.enabled`                | `MULLION_TASK_MASTER_ENABLED` (`false`)        | Gates every _new_ piece of autonomous work: the watcher's GitHub ingest + auto-claim, the claim/approve/retry endpoints (all refuse with 403/501 while off), and the reconciler's `claimed`/`in_progress` → `reviewing` transition itself (which includes spawning the review-agent session) — a finished session while disabled is left in `claimed`/`in_progress` instead, still reachable by the budget force-fail below, and transitions normally on the next tick once re-enabled. **`reject`/give-up are deliberately NOT gated** (Hermes review, PR #480, fourth pass; extended to give-up by `#483`): they're the only routes that can resolve an already-`reviewing` task, so a task that reached `reviewing` before the toggle flipped off — the one case the transition-gate above can't prevent — still has an escape hatch (back to `in_progress`, or to `failed`) instead of being stranded until re-enabled; `approve`/`retry` stay gated since they create a real PR/spawn a real session. Does **not** gate an already-in-flight task's own budget enforcement or `claimed`↔`in_progress` status sync to GitHub — that stays a safety net regardless. The local task board (create/edit/drag/delete) works regardless too — see the Flag semantics decision above. |
| Max concurrent autonomous claims      | `settings.taskMaster.maxConcurrent`          | `MULLION_TASK_MAX_CONCURRENT` (`2`)            | Tasks in `claimed`/`in_progress` count against this cap; both manual and auto-claim share one transactional reservation, so this is an actual ceiling, not a soft throttle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Per-task time budget                  | `settings.taskMaster.budgetMinutes`          | `MULLION_TASK_BUDGET_MINUTES` (`120`)          | The reconciler force-fails and terminates the session of any `claimed`/`in_progress` task that's been running longer than this, regardless of what the agent is doing. `0` = unlimited.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Runtime kill-switch                   | `settings.taskMaster.autoClaimPaused`        | — (no env equivalent; default `false`)         | Checked by the auto-claim sweep every poll. Stops new claims; tasks already `claimed`/`in_progress` are unaffected. Surfaced in Settings → Task Master as "Pause auto-claim", disabled with a hint while Task Master itself is off.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Progress-comment throttle             | `settings.taskMaster.progressCommentMinutes` | `MULLION_TASK_PROGRESS_COMMENT_MINUTES` (`15`) | Minimum minutes between two `in_progress` progress comments the GitHub sync posts to the same linked issue, so a chatty agent (or a reconciler tick observing "still working" repeatedly) can't spam one comment per poll. `0` = no throttle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Skip permissions on unattended spawns | `settings.taskMaster.skipPermissions`        | `MULLION_TASK_SKIP_PERMISSIONS` (`false`)      | When on, a claim/auto-claim/retry/review-agent spawn passes the resolved agent's own skip-permissions flag (e.g. `--dangerously-skip-permissions`), so an unattended agent doesn't stall at a permission/trust prompt with no one to answer it. Off by default — an autonomous agent bypassing every tool-permission check is an explicit opt-in, not a safe default. Independent of `settings.launchers.skipPermissionsAgents`, which only drives the frontend's manual-launch CommandPalette and never reaches these spawns.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Review-agent CI wait                  | `settings.taskMaster.reviewCiWaitMinutes`    | — (no env equivalent; default `15`)            | How long `processPendingReviewSpawns` (see below) holds a `reviewing` task whose PR has CI still `in_progress` **or** not yet registered (`null` — indistinguishable at lookup time from "no CI at all") before spawning the review agent anyway. `0` disables waiting — the reviewer spawns immediately regardless of CI state. No env-var counterpart: this is the one knob a task stranded on a repo whose CI will never report needs adjustable live, not only at process restart. A repo with no CI configured costs up to this long in polling before its first review spawns (no per-task backoff) — see the review-agent section's own note.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

No separate control for dependency-aware claiming (`#667`) — a
zero-dependency issue costs nothing extra to begin with, so there's
nothing to opt out of. Its own cost is bounded by the three mechanisms in
Lifecycle's "Dependency-aware claiming" section above, not a Settings
toggle.

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

| Transition      | GitHub side effect                                                                                                                                                                                                                                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `→ claimed`     | Add `mullion-claimed`, comment "Task claimed — agent starting…"                                                                                                                                                                                                                                                        |
| `→ in_progress` | Progress comment, throttled (see Safety envelope above)                                                                                                                                                                                                                                                                |
| `→ reviewing`   | Swap `mullion-claimed` → `mullion-reviewing`, comment "Task ready for review." plus a diff-stat summary when available (`#491`); also opens a **draft** pull request (see Task → PR promotion below) — a separate, best-effort write, not part of this label/comment sync and not blocked by its failure or vice versa |
| `→ done`        | Swap `mullion-reviewing` → `mullion-done`, comment with the PR link, close the issue                                                                                                                                                                                                                                   |
| `→ failed`      | Comment with the failure summary, remove active labels, leave the issue open                                                                                                                                                                                                                                           |
| reject          | Comment with the human's feedback text                                                                                                                                                                                                                                                                                 |

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
detail drawer regardless of the task's status (see The task board above).
If claiming a task never actually labels/comments on its GitHub issue,
the task itself will now say why — `githubSyncError` is not
`failureReason`: the latter is only rendered when `status === "failed"`
and also carries reject feedback, so a sync problem never overwrites it.

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
drafts included) and a human — or the optional review agent, see Agent
selection above — have a real diff and real check results to look at before
a human commits to approving it. `hermes.yml`'s own
`pull_request.draft == false` gate means Hermes never reviews the draft,
only once approve flips it ready-for-review — the two reviewers sequence by
construction, no coordination needed. A dirty tree, an unreachable host, an
old agent build, or an undeterminable default branch just means no draft
opens yet; none of those block the `→ reviewing` transition itself, and
approve's own checks below still apply regardless of whether a draft
exists.

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

## Worktree lifecycle

A task's worktree lives at `.mullion-worktrees/mullion-task-<id>`, on
branch `mullion/task-<id>`, created at claim time (not eagerly at task
creation) and removed only once its task reaches `done` or `failed` —
never on session death alone — and only when `getGitStatus` reports the
tree clean; a refusal leaves the path on the task row rather than
destroying anything with uncommitted work. There is no periodic retry of
a refused removal, though — the reconciler only polls `claimed`/
`in_progress` tasks, not `done`/`failed` ones. The only two paths that
revisit a refused-but-now-clean worktree are a boot-time sweep (below) and
a re-claim of the same task.

**`→ failed` removes only the worktree, never the branch (`#483`).** That
asymmetry is deliberate, not an oversight: the branch is what Retry (see
Lifecycle above) resumes on. `resumeTaskWorktree`
(`src/services/git-worktree.ts`) checks out that preserved branch into a
fresh worktree at the same deterministic path — a real branch checkout
(`git worktree add <path> <branch>`, no `-b`, no `--detach`), not
`checkoutBranchWorktree`'s dock-preview-specific detached-HEAD flow.
Refuses (returns `null`, surfaced as a `worktree-failed` 502) only when the
branch no longer exists or is already checked out elsewhere — both
unexpected states a human should look at, not silently worked around.
Restricted to the same closed `mullion/task-<id>` namespace
`clearOrphanedTaskWorktree` enforces. Proxies to a remote host via
`SessionBackend.resumeTaskWorktree` → `/internal/git-worktree/resume`
(`#484`), the same way create/remove/prune already did.

The boot-time sweep prunes worktrees left behind by a crash or an
out-of-band `rm -rf`, now for a remote-hosted project too (`#484`) — every
project is grouped by host and swept via `SessionBackend`
(`listTaskWorktreeDirs`/`pruneWorktrees`, both proxying to
`/internal/git-worktree/*`) rather than reading the primary's own
filesystem directly. A host that's unreachable at boot just has its orphan
cleanup deferred (claim-time `clearOrphanedTaskWorktree`, already
remote-capable since `#283`, remains the correctness backstop), not lost —
see `src/plugins/task-watcher.ts`'s own doc comment. Everything else in
this section — create, the clean-check removal above, and the reconciler's
own steady-state cleanup — proxies to a remote host via the same
`SessionBackend`/`/internal/*` pattern the rest of Mullion's remote-host
support uses. See `src/services/git-worktree.ts` and
`src/plugins/task-watcher.ts` for the implementation and their own
extensive design comments.

## Known limitations

- **Promotion, issue ingest, the boot-time orphan sweep, and Retry all now
  work for remote-hosted projects (`#484`).** The one remaining gap is
  version skew: a remote host running an agent build older than `#484`
  degrades per-path rather than breaking — promotion 501s with
  `remote-not-supported` (see Task → PR promotion above), Retry 501s the
  same way, and the ingest/orphan sweeps just log and skip that host.
  Update the agent build on that host to close the gap.
- **`git-push.ts`'s push credential is https-transport only.** A task's
  branch is pushed via `git -c http.extraHeader=...`, which only applies to
  an `origin` configured over https — a remote-hosted project whose
  `origin` is an ssh remote silently falls back to whatever ssh key is
  already set up on that host, which may or may not have push access. Same
  limitation a local push already had; proxying to a remote host (`#484`)
  doesn't change it.
- **Retrying a task whose preserved worktree path already has something
  sitting at it (e.g. a crashed prior retry attempt) has no automatic
  cleanup.** `resumeTaskWorktree`'s `git worktree add` simply fails in that
  case (surfaced as `worktree-failed`), the same way a fresh claim's own
  orphan-clearing (`clearOrphanedTaskWorktree`) would refuse a dirty
  leftover — but retry doesn't run that clearing step first, since it would
  delete exactly the branch retry exists to preserve. A human needs to
  resolve it manually today. This no longer includes the `* → reviewing`
  gate's own no-commits failure (`#722`, local hosts only — see that
  section): it salvages a WIP commit before failing, which is what lets
  `removeWorktreeIfClean` actually remove the worktree (it refuses on
  dirty, not on committed-but-unpushed). Every OTHER automatic failure that
  can leave a worktree dirty still has no salvage step — the budget-exceeded
  force-fail above, and session death (owned by `session-reconciler.ts`,
  outside this file) both go straight to `removeWorktreeIfClean` with
  whatever was on disk at the moment they fired, same as before `#722`.
- **GitHub App scoping is opt-in and repo-level, not per-task.** A GitHub
  App configured via `PUT /api/integrations/github/app` (see
  [`github-integration.md`](github-integration.md#github-app-opt-in-layers-on-top-of-the-patoauth-token))
  makes Task Master's writes and issue-label ingest use a short-lived
  installation token scoped to the single repo in question, instead of the
  shared install-wide PAT — but a GitHub App installation token can't scope
  to an individual issue/task, only a repository, so "per-task" here means
  "minted fresh per task, limited to that task's repo," not a token bound
  to one issue number. Without an App configured (the default), every write
  still shares the one install-wide PAT, same as before. The
  cap/budget/kill-switch above are unaffected either way.
- **`tasks.assignee` is never populated, and PR merges don't read back.**
  The assignee flow is one-way: on claim, Mullion assigns the linked issue
  to the integration's own login on GitHub, but nothing ever writes the
  local `tasks.assignee` column, so it is always null despite being plumbed
  through the API and rendered in the task detail drawer. Separately, the
  only read-backs that exist are issue-close and tracking-label removal (see
  GitHub sync above) — merging the promoted PR does not sync anything back;
  the task reaches `done` on approve, not on merge.
- **GitHub only.** Non-GitHub issue trackers are out of scope.
- **A re-parenting (or de-parenting) between polls produces no live push
  (`#701`).** Sub-issue hierarchy has no push-based path the way dependency
  edges do — `sub_issues` is deliberately not a subscribed webhook event
  (see Task hierarchy above), and `upsertIssueTask`'s own `/ws/tasks`
  broadcast only fires on a task's first sighting, not a re-sighting with a
  real column change. A poll writes the new parent correctly, but a board a
  user is already looking at only picks it up on the frontend's own next
  periodic refetch, not instantly.
- **A task branch in a resumable state refuses manual deletion from the
  GitPanel.** [#442](https://github.com/s3ntin3l8/mullion-session-manager/issues/442)'s
  branch-delete route refuses (`reason: "task-branch"`) a `mullion/task-<N>`
  branch belonging to a task whose status is `claimed`/`in_progress`/
  `reviewing`/`failed` — the same set `resumeTaskWorktree` (`#483`) checks
  out for Retry. Force overrides the refusal and **will break Retry**: once
  the branch is gone, `resumeTaskWorktree`'s `git worktree add` has nothing
  to check out and 502s `worktree-failed`, the same failure mode this
  section's "no automatic cleanup" gap above already describes for a
  crashed retry attempt.
- **A GitHub-linked task whose reads fail is never auto-claimed, where
  before `#667` it was.** A dead token, a rate limit, a 5xx — anything
  that prevents a sweep from observing an issue's dependency state — leaves
  `dependencyCount`/`blockedBy` unresolved, and `dependencyGate` treats
  "never observed" the same as "known blocked" (see Lifecycle's
  "Dependency-aware claiming" above for why that's the deliberate,
  fail-closed choice, not an oversight). Visible on the board as the
  blocked icon with a "Checking dependencies…" tooltip rather than silent;
  manual Claim still works regardless.
- **`.../dependencies/blocked_by` and `.../dependencies/blocking` are each
  capped at one page (100 items)**, matching `listLabeledIssues`' own
  documented page cap. A task with more than 100 blockers, or an issue with
  more than 100 dependents, only sees the first page.
- **A cyclic or permanently-open dependency stalls a task forever, with no
  detection.** GitHub does not prevent transitive dependency cycles, and a
  blocker closed as "not planned" unblocks its dependents exactly the same
  as one closed as completed (GitHub's `state` is `closed` regardless of
  `state_reason`) — but an abandoned, still-open blocker does not. The
  board's blocked badge is the only signal; there is no timeout or cycle
  detection.
- **With webhooks off (or unreachable), a landed blocker's dependents wait
  up to the poll interval, not the ~1s the webhook push gives them** — the
  GitHub sync section's blocker-close read-back above requires a delivered
  `issues`/`closed` webhook or the next poll's own read-back to fire; there
  is no separate faster path for this specific case.
