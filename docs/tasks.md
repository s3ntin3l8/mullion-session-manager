# Task Master

Task Master turns a GitHub issue — or a task created directly in the
dashboard — into an autonomously-worked, reviewed, and promoted pull
request: an agent claims the task into an isolated worktree, works it, an
optional review agent looks at the diff, and a human decides whether to
approve or send it back — the review agent itself can only trigger up to a
bounded number of automatic rounds of rework before that human decision
(and even that human step can be removed — see "Auto-approve" in
[`tasks-internals.md`](tasks-internals.md#auto-approve)), never
approve/reject on its own.

**See also: [`tasks-internals.md`](tasks-internals.md)** for reconciler
mechanics — the gates, auto-return, auto-approve, auto-rebase, rate-limit
grace, GitHub sync, and review-agent internals behind everything summarized
here.

**Gate:** whether Task Master is enabled — deploy-time default
`MULLION_TASK_MASTER_ENABLED` (`false`), overridable at runtime from
Settings → Task Master without a restart (see Configuring Task Master
below). This only gates _autonomous_ behavior — the background watcher's
GitHub ingest and auto-claim, and the claim/approve/retry endpoints. It
does **not** gate `reject`/give-up/re-review (the escape hatches for a task
already in review), an already-claimed task's own budget enforcement and
status sync to GitHub, or the local task board itself (create/edit/drag/
delete a locally-created task) — those all work regardless. See the Safety
envelope section below for the full breakdown. Once a task can exist with no
linked GitHub issue at all, "the task list is empty when the gate is off" is
no longer a property this gate can promise. See [`roadmap.md`](roadmap.md)'s
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
  rather than sitting in `ready` forever eligible for auto-claim on an
  issue that's no longer trackable. The recorded `failureReason`
  distinguishes the two triggers — `"GitHub issue lost its tracking
label"` vs. `"GitHub issue was closed"` — even though both route
  through the same shared function (`syncUnlabeledIssueToLocal`,
  `task-github-sync.ts`), so a closed issue doesn't misreport as a label
  problem. A task that's already `claimed`/`in_progress`/`reviewing` —
  real work behind it, a worktree, maybe a branch — is left strictly
  alone either way; silently failing it out from under a label removal
  would be destructive. Both the webhook `unlabeled`/`closed` handlers
  and the poll loop's own read-back apply this identically, via one
  shared function, so the two can't produce different outcomes for the
  same issue.

  A task that failed this way was never claimed, so it has no preserved
  branch — Retry (`failed → backlog`/`ready`, below) can't resume it
  (`no-worktree`), which used to leave it permanently orphaned: not local
  (so the delete route refused it), and past `backlog`/`ready` (so did the
  delete route's other guard). `DELETE /api/tasks/:id` (#729) carves out
  exactly this case: a `failed` GitHub-linked task with **no preserved
  branch** (`branchName === null`) can be deleted once a fresh read of the
  linked issue confirms it's genuinely no longer trackable (closed, or open
  but missing the label) — the same check the read-back above uses, so
  deleting it can't race the watcher into re-creating the row on its next
  sweep. The `branchName === null` condition matters on its own, separately
  from the issue check: a task that WAS claimed carries a real
  worktree/branch Retry CAN resume from, and its linked issue can
  independently end up closed/unlabeled later (at promote time, a
  maintainer tidying labels, ...) — deleting that row would silently
  discard recoverable work, since nothing cascades to clean up
  `worktreePath`/`branchName` on a task delete. That task keeps the
  original refusal regardless of what its issue is doing; so does a
  never-claimed `failed` task whose issue is **still** tracked (a genuine
  lost-label failure with the label put back, say) — use Retry for the
  claimed case, or re-fix the label/issue for the never-claimed one.

  **Done tasks are deletable too (`#746`)**, for both local and
  GitHub-linked rows, since the board otherwise accumulates finished tasks
  forever. Local: no extra check — `done` is terminal, no Retry exists for
  it, and the row itself carries no live state. GitHub-linked: reuses the
  same fresh-`isIssueStillTrackable` round-trip the `failed` case above
  uses, rather than trusting local status alone — the linked issue's own
  closed-and-relabeled-`mullion-done` state usually confirms it, but a
  maintainer could have reopened and relabeled it back to `mullion-task`
  since the task finished, and that check is what catches it. Deliberately
  does **not** extend the `branchName === null` guard to `done` — that
  guard exists so Retry can still resume a `failed` task, and `done` has no
  Retry to protect: every done task from the normal pipeline has a branch,
  so requiring one to be absent would make this exception dead on arrival.
  Deleting a done task's row only removes Mullion's own record: the closed
  issue and its PR stay on GitHub untouched — not necessarily _merged_:
  `approveTask` sets `prNumber`/`prUrl` unconditionally but only requests a
  merge when the project has `mergeOnApprove` on (default off), and even
  then the merge sweep is async/best-effort, so a done task's PR is often
  still open — and the local branch is untouched too (worktree cleanup at
  approve time already removed the worktree directory, never the branch —
  see the Worktree lifecycle section below). `failed` task cleanup beyond
  the `#729` case above is deliberately out of scope here — a separate
  effort, since Retry must still be able to resume an ordinary
  claimed-then-failed task.

  **A "Hide done" board toggle (`#746`)** complements deletion for anyone
  who wants finished tasks kept as reference rather than deleted: it
  collapses the Done and Failed columns to header-only (title + count),
  rather than filtering them out of `tasks` — collapsing keeps the count
  visible; filtering would hide it too. Persisted client-side
  (`crs.taskHideDone`, `frontend/src/lib/persistedState.ts`), alongside the
  board's other filters (project, blocked-only, `#701`'s parent filter) —
  not through `AppSettings`/the Settings panel, a deliberate deviation from
  how the sidebar's own `hideEndedSessions`/`showTaskSessions` toggles work,
  since this is a board filter sitting next to three others that already
  use this mechanism. Rendered unconditionally, unlike the blocked-only
  toggle (which only appears once something is actually blocked) — there's
  no "nothing qualifies" state to gate on, so no render-time-reset dance is
  needed either.

  **Bulk "Clear done" (`#746`)** — `POST /api/tasks/clear-done`, an optional
  `{ projectIds?, deleteBranches? }` body — deletes every `done` task the
  same deletability check above allows, in one request, via the board
  toolbar's "Clear done" button. Shares `checkTaskDeletable` with the
  single-row `DELETE` route so a row's fate is decided in exactly one
  place; no existing route in this codebase returned a per-row ok/failed
  shape before this one, so the response (`{ deleted, failed, branches,
remaining }`) is modeled on `git-worktree.ts`'s own
  `cleanupOrphanWorktrees` (`{ removed, skipped }`). Capped at 20 rows per
  call — the same `MAX_READBACK_CHECKS_PER_SWEEP` precedent
  `task-watcher.ts` already uses, since a GitHub-linked done task costs one
  `isIssueStillTrackable` round-trip and 50+ of those in one request is
  exactly the call-volume pattern `#759`/`#777` exist to prevent — with the
  remainder reported (`remaining > 0`), not silently dropped; the toolbar
  button calls again itself until the sweep finishes. The install-wide
  GitHub rate-limit budget (`isGitHubRateLimited`, `github-fetch.ts`) is
  checked once per request, not once per row: a GitHub-linked candidate
  caught by it is reported failed with a rate-limit reason rather than
  opening a call the transport layer already knows will fail; a local
  (no linked issue) candidate is entirely unaffected.

  Branch deletion (`deleteBranches: true`, off by default) is a **local**
  concern only — the merge sweep already deletes the remote branch on a
  successful merge (`deleteRemoteBranch`, called from `attemptMerge`). This
  repo squash-merges, so a merged task branch's commits are not literally in
  `main`'s history: a non-force `git branch -d` would return `"unmerged"`
  for practically every done task, but blind `force: true` is not
  acceptable either. Resolved explicitly, per row: only force-deletes once
  a fresh `getPullRequestByNumber` read confirms the task's PR actually
  merged; otherwise the branch is reported skipped with its reason
  (`no-pr`/`not-merged`/`merge-check-failed`/`rate-limited`/the
  `DeleteBranchReason` a local `git branch -D` itself can fail with) and
  **left alone** — a branch failure never blocks the row deletion, which
  already committed by the time the branch check runs. Branch deletes run
  strictly serially (never `Promise.all`), the same posture every other
  bulk git operation in this codebase takes — concurrent git operations
  across this repo's own developer worktrees have twice corrupted shared
  objects.

  A label-lost failure — never a close — also self-heals on its own,
  without needing the delete-and-recreate path above: if the same issue
  is re-sighted still open and labeled again, and the task never had a
  branch or worktree (i.e. it failed while still `backlog`/`ready`),
  `upsertIssueTask` (`task-watcher.ts`) springs it back to
  `ready`/`backlog` automatically on the next poll tick or `labeled`
  webhook delivery — no separate trigger needed, since it lands on the
  same shared ingest path every re-sighting already goes through.
  Deliberately local-only: no comment is posted and nothing is restored
  on the issue itself, so its last comment still reads "Task failed:
  GitHub issue lost its tracking label" after recovery. Retry (`failed →
claimed`, below) does not help here in practice even though the table
  allows `failed → backlog`/`ready`: Retry requires a preserved
  `mullion/task-<id>-<slug>` branch, which a task that failed while still
  `backlog`/`ready` never had.

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
  normally gated on both conditions together: still `backlog`/`ready`
  **and** no linked issue — with two deliberate exceptions: a `failed`
  GitHub-linked task whose issue is confirmed no longer trackable (see the
  lost-label paragraph above), and force-deleting via Abandon (see "Board
  actions" below), which additionally allows a local `failed` task and a
  GitHub-linked `failed`/`done` task regardless of what its issue reports.
  Once a task is claimed, or once it reaches a status past `ready` (outside
  those exceptions), the state machine below drives it instead.

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

`claimed` is the **queue** state (task-claim queueing, rate-limit-storm
fix) — a task a human clicked Claim on, or auto-claim picked up, that is
waiting for a free concurrency slot. It never holds a session; see the
`claimed → in_progress` bullet below and Concurrency (the Safety envelope's
"Max concurrent autonomous workers" row) for the full design.

- **A locally-created task** starts in `backlog`; dragging it to `ready` on
  the board is the interactive "make this claimable" trigger.
- **A watcher-ingested issue** is inserted directly into `ready` — i.e.
  auto-claim-eligible — **unless** its body contains a line reading
  `Manual: true`, or it carries **open** GitHub sub-issues (`#1016` — it's a
  tracking epic, not leaf work: dispatching it produces a zero-commit
  turn), in either of which cases it lands in `backlog` instead. This is
  the opt-out: an ingested issue is autonomous by default, matching the
  "make this production-grade and auto-claimable" goal. An issue that
  _gains_ open sub-issues after already being ingested `ready` is demoted
  back to `backlog` the same way, but only while it's still untouched
  (`ready`, no session ever attached) — a task already claimed or further
  along keeps going regardless of what GitHub reports about its children
  afterward, and once all of an epic's children close it stops being
  demoted on its next re-sighting, but that's not automatic **promotion**
  back to `ready` either — a human still drags it there. See
  [`tasks-internals.md`](tasks-internals.md#task-hierarchy-sub-issues-701)
  for exactly how "open sub-issues" is computed.
- **`claimed` is the queue, not a reconciler-observed transient state**
  (task-claim queueing, rate-limit-storm fix — see the Safety envelope
  below for the full design). A manual claim or an auto-claim candidate
  always enters `claimed` unconditionally (`task-claim.ts`'s
  `enqueueTask`), with no session yet. **`claimed → in_progress`** fires
  the moment `dispatchClaimedTask` reserves a free concurrency slot —
  inside the same transaction that flips the status, before the
  worktree/session are created — either off `task-dispatch.ts`'s
  opportunistic hook (any transition that just freed a slot or just queued
  a task) or its periodic sweep on the watcher's own poll tick. There is no
  longer a window where a `claimed` row has a live session: dispatch
  commits the status flip first.

  **Retry is the one exception that skips this queue.** `POST
/api/tasks/:id/retry` (`failed → in_progress`, below) performs its own
  separate, single-phase atomic reservation (`task-claim.ts`'s `retryTask`)
  — it does **not** go through `enqueueTask`/`dispatchClaimedTask` at all.
  It briefly writes `status: "claimed"` as part of its own transaction (so
  the same `CONCURRENCY_CAPPED_STATUSES`-based cap check that gates a fresh
  claim also gates a retry), then resumes the preserved worktree, spawns
  the session, and flips straight to `in_progress` — all synchronously
  within the one HTTP request. A retry that can't win the reservation 429s
  immediately rather than queuing; one that wins but then fails to resume
  the worktree or spawn a session rolls the row back to `failed` (`via:
"retry-release"`), never leaving it stuck at `claimed` with nothing behind
  it.

- **`in_progress → reviewing`** fires once the worker's turn has genuinely
  ended and the branch has commits past its base — see
  [`tasks-internals.md`](tasks-internals.md#the-no-commits-gate-and-turn-finished-check)
  for the exact gate (`checkReviewingGate`), why a `stop_failure` alone
  isn't enough, how `claimedAt` resets across a claim/Retry/Reject/
  auto-return spell, and the shell-tail and remote-host WIP-salvage
  exceptions.
- **`reviewing → in_progress`** has two triggers, one human and one
  automatic. The human one is Reject (see "Board actions" below). The
  automatic one is the review-findings loop's own auto-return, and a red
  required CI check or an unresolved PR review comment can trigger the same
  transition too — see
  [`tasks-internals.md`](tasks-internals.md#review-agent-mechanics) and
  [`tasks-internals.md`](tasks-internals.md#auto-approve). Both land on the
  same target status; `recordTaskTransition`'s `via` tag (`"reject"` vs.
  `"review-feedback"`/`"ci-feedback"`/`"pr-comment-feedback"`) is what tells
  them apart in the transition log and the `/ws/tasks` stream.
- **`* → failed`** fires automatically on session exit (a `claimed`/
  `in_progress` task whose session dies is failed, not left pointing at a
  dead session forever), on exceeding the per-task time budget (see Safety
  envelope below), or on the no-commits case the `* → reviewing` bullet
  above describes — `failureReason: "agent ended its turn with no commits on
<branch>"`. That last one first attempts a machine-made salvage commit
  (`commitWipChanges`/`commitHostWipChanges`, `git-worktree.ts`/
  `host-git.ts` — both local and remote-hosted hosts, since `#1100`) so the
  branch isn't left truly empty and Retry (below) can actually resume the
  work; the worktree is then removed if (now) clean, same as every other
  automatic failure. `reviewing → failed` is **not** automatic on session
  exit — the worker's turn is already over and the work is committed on
  its branch, still promotable regardless of whether that session is still
  alive.
- **`failed → in_progress`** (`#483`) — **Retry**, on a `failed` task,
  resumes work rather than restarting it: it checks out the task's
  preserved `mullion/task-<id>-<slug>` branch (see Worktree lifecycle below for
  why that branch survives a failure) into a fresh worktree and spawns a
  new session there, so committed-but-unfinished work isn't lost. See the
  `claimed → in_progress` bullet above for how Retry's own reservation
  differs from a fresh claim's. This is a dedicated route
  (`POST /api/tasks/:id/retry`), not the `failed → backlog`/`ready` table
  edges — those two remain legal but have their own separate, automatic
  trigger too (relabel-resurrection, see "Task model" above), since retry
  supersedes the two-step "flip to ready, then claim" flow they would
  otherwise have required for a task Retry can actually resume. Gated on
  Task Master being enabled, same as Claim, since it also spawns a session.
  Still cap-checked — a retry can still 429 at capacity.
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

Auto-claim also respects GitHub's native issue dependencies, so a
fully-ordered roadmap can be labeled `ready` end to end without hand-gating
each issue — see
[`tasks-internals.md`](tasks-internals.md#dependency-aware-claiming-667)
for the mechanism, its GitHub-call budget, and its fail-closed posture on an
unresolved dependency state.

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
  through the actions below instead, since those are the only
  transitions the plain `PATCH /api/tasks/:id` endpoint accepts (dragging a
  card between any two other columns is rejected client-side before the
  request is even sent). Reordering within any single column (including
  the autonomous-only ones) always works — `boardOrder` is a purely local
  render tier with no GitHub representation, so it's editable regardless
  of status.
- Clicking a card opens its detail as an inline drawer on the board's own
  right side (not a separate panel), with the worker session's embedded
  timeline and — when a review agent is configured — a distinct "Review"
  card with the review agent's own timeline, its captured findings text,
  and (once the task has auto-returned) a round indicator.
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

### Board actions

Every action below lives in the task detail drawer (Claim/Approve/Reject/
Retry/Re-review/Give up), or is a delete/archive control reachable from the
same drawer (Abandon, Archive/Unarchive). Claim, Approve, and Retry are
disabled (with an explanatory hint) whenever Task Master is off, since all
three spawn or promote autonomous work; Reject, Give up, Re-review, Abandon,
and Archive/Unarchive stay enabled regardless — see "Whether Task Master
runs at all" in the Safety envelope below for exactly which routes are
gated and why. The board and local CRUD (create/edit/drag/delete a
non-Abandon-path task) are not gated either way.

- **Claim** (`ready → claimed`) — a human clicking Claim, or auto-claim
  picking up a `ready` task, queues it; see "Lifecycle" above for how the
  queue and dispatch actually work.
- **Approve** (`reviewing → done`) — pushes the branch if needed, marks the
  draft PR ready for review (or opens one directly if no draft exists),
  closes the linked GitHub issue, and — with `mergeOnApprove` on — arms an
  async merge. See
  [`tasks-internals.md`](tasks-internals.md#task--pr-promotion) for the
  full promotion mechanics, and
  [`tasks-internals.md`](tasks-internals.md#merge-on-approve) for what
  happens after. A dirty worktree 409s the request rather than silently
  dropping uncommitted work. On a tracking epic with open sub-issues,
  Approve is advisory, not blocking — it 409s with a warning the drawer
  turns into a two-stage confirmation, and re-POSTing with `?force=true`
  closes it anyway.
- **Reject** (`reviewing → in_progress`) — sends the task back to the
  worker with the human's feedback text as its prompt. The worktree and
  session are left alone by default (the agent may still be watching); if
  the session already exited, a fresh one is re-seeded in the **same**
  worktree. Unlike an automatic auto-return round, Reject never spends
  `tasks.autoReturnRounds`.
- **Retry** (`failed → in_progress`) — resumes a failed task's preserved
  branch into a fresh worktree and spawns a new worker; see "Lifecycle"
  above for its own reservation mechanics. Only available when the task
  has a preserved branch (a task that failed before ever committing
  anything has nothing to resume — see "Known limitations" below).
- **Re-review** (`reviewing`, no status change) — `POST
/api/tasks/:id/re-review`, for a task whose `lastReviewVerdict` is stuck at
  `"inconclusive"` (a review agent that went idle with no reported error at
  all). Kills the stale review session and clears the same four columns an
  automatic hourly re-arm sweep (`reannounceInconclusiveReviewsAfterGrace`,
  issue `#1345`/`#1346`) already uses, so a fresh review agent spawns on the
  next tick — but with no time grace and no rearm-count cap, since a human
  explicitly clicking this is a stronger signal than the sweep's own
  conservative heuristics. **Deliberately not gated** on Task Master being
  enabled, the same reasoning as Reject/Give-up: a disabled install must
  not permanently strand a task stuck on `inconclusive`. Surfaced as a
  "Re-review" button in `TaskDetail.tsx` only when `lastReviewVerdict ===
"inconclusive"`.
- **Give up** (`reviewing → failed`) — the other resolver of a `reviewing`
  task besides Approve/Reject, for "stop trying entirely." Closes a
  still-open draft PR. Not automatic on session exit, and ungated, the same
  as Reject.
- **Abandon** (delete, `?force=true`; issue `#1014`) — the escape hatch for
  a task Retry can't (or shouldn't) resume: a force-delete that additionally
  allows deleting a local `failed` task (previously not deletable at all)
  and a GitHub-linked `failed`/`done` task regardless of whether its issue
  is still tracked. For a GitHub-linked task, the `mullion-task` label is
  removed from the issue **before** the row is deleted — if that unlabel
  fails, the row is left untouched rather than risking the watcher
  re-ingesting the very issue the human just asked to get rid of. Once the
  row is gone, teardown is best-effort: any live worker/review session is
  killed, the worktree is force-removed (not the clean-check-gated removal
  every automatic cleanup path uses — the whole point of Abandon is to
  discard whatever's there), and the branch is force-deleted last. A
  leftover session/worktree/branch after a teardown failure is a cleanup
  gap, not a correctness problem, since the task row itself is already
  gone. Only offered for `failed`/`done` tasks — never one with a live
  in-flight worker.
- **Archive / Unarchive** (issue `#1015`) — `POST`/`DELETE
/api/tasks/:id/archive`, orthogonal to `status`, not a transition: hides a
  finished (`done`/`failed`) task from the board's default view without
  touching its status, its PR linkage, or anything that branches on
  `status === "done"`. A "Show archived" toggle in the board toolbar
  (persisted client-side, `crs.taskShowArchived`) reveals them again; an
  archived task is excluded from the column counts too, not just hidden —
  unlike "Hide done" above, which only collapses the column visually.
  Restricted to `done`/`failed` for the same reason Abandon's force-delete
  is: archiving an in-flight task would hide it from the board while its
  worker keeps running (and holding a concurrency slot), or from the person
  whose approval it's waiting on. Unarchiving clears only `archivedAt`,
  never `mergedAt` — the latter is a fact about the PR, not something
  unarchiving undoes. `POST /api/tasks/archive-merged` is the bulk
  companion — an optional `{ projectIds? }` body, capped and rate-limit-
  aware the same way `clear-done` is — for backfilling tasks that merged
  before this feature existed, or that the reconciler never itself observed
  merging (`mergeOnApprove` off, so nothing armed `processMergeRequests`
  against them); it only archives a `done` task with a PR that GitHub
  confirms actually merged, gated on `mergedAt IS NULL` (not just
  `archivedAt IS NULL`) so a manual Unarchive of an already-merged task
  sticks instead of being silently re-archived on the next run.

## Agent selection

Two independent choices are resolved per task, most-specific tier wins:

**Worker agent** (which agent actually claims and works the task):

1. The issue body's own `Agent: <name>` line (e.g. `Agent: codex`).
2. The owning project's `defaultAgent` setting (Project Settings' Default
   Agent dropdown, or `projects.defaultAgent` directly).
3. The install-wide `settings.taskMaster.defaultAgent` (Task Master Settings'
   Default agent — independent of the terminal launcher's own default, which
   only drives the launcher).

**Review agent** (the optional reviewer — see
[`tasks-internals.md`](tasks-internals.md#review-agent-mechanics)):

1. The issue body's own `ReviewAgent: <name>` line.
2. The owning project's `defaultReviewAgent` setting.
3. The install-wide `settings.taskMaster.defaultReviewAgent` (Task Master
   Settings' Default review agent). When unset, or explicitly `"none"`/empty,
   no review agent is spawned and a human reviews directly — today's
   unchanged default behavior. **The issue body's own `ReviewAgent: none` or
   `ReviewAgent: false` (strict lowercase compare, in
   `task-agent-resolve.ts`'s `resolveReviewAgentCommand`) also disables
   review outright, independent of the settings tier.** A review agent remains an additive,
   advisory feature; both tiers just let an operator engage (or disengage)
   one for every task without configuring it per project.

   This becomes load-bearing, not just advisory, once a project's
   `autoApprove` setting is on (see
   [`tasks-internals.md`](tasks-internals.md#auto-approve)): auto-approve's
   gate requires an ingested `clean` verdict, which only exists if a review
   agent actually ran. No review agent configured on a project means that
   project's tasks can never auto-approve, by design — the same "opt-in, no
   global default" posture above, just with a consequence attached now.

Both directives are matched case-insensitively on their **key** on their own
line (a document that merely _mentions_ "Agent: claude" in prose isn't picked
up), but the **value** is compared case-sensitively against the `KNOWN_AGENTS`
allowlist (`agent-detect.ts`). `Agent: Claude` matches the
line, then fails the allow-list and falls through to the next tier with a
warning — easy to misread today's wording as "any casing works." An
unrecognized agent name at any tier is logged and falls through to the next
tier rather than failing the claim — a typo in an issue body shouldn't block
autonomous pickup, and neither should a stale project setting.

**Model directives.** A Task Master worker or review spawn accepts three
additional issue-body directives, all matched case-insensitively on the
**key** (same shape as `Agent:` above) but case-sensitively on the value
against an allowlist. **`Model:` works for every CLI** — claude-code, codex,
and agy resolve it as a bare `--model` value (`resolveCliModel`/
`validateCliModel`, `task-model-resolve.ts`, a strict charset allowlist with
no whitespace/quotes/`$`/backticks/leading `-`); opencode resolves it (along
with `Reviewer-Model:`/`SmallModel:`) as a `provider/model` string
(`resolveOpenCodeModel`/`validateModel`) instead. `Reviewer-Model:` also
works for every CLI (claude-code/codex/agy take a bare `--model` value;
install-wide, `settings.<cli>.reviewerModel` backs it). `SmallModel:` works
for opencode (`provider/model`) and claude-code (a bare name, exported as
`ANTHROPIC_DEFAULT_HAIKU_MODEL`; install-wide via
`settings.claudeCode.smallModel`) — silently inert for codex/agy, which have
no small-model setting wired up.
`commandIsOpencode`/`commandModelCli` (`hook-adapters/index.ts`) are what
each spawn site checks to pick the right resolver.

1. `Model: <value>` — the primary model for the worker (and, independently,
   the review agent — see
   [`tasks-internals.md`](tasks-internals.md#review-agent-mechanics)).
   Falls back to the CLI's/opencode's own default if unset.
2. `Reviewer-Model: <value>` — the reviewer's model (`provider/model` for
   opencode, a bare name for the other CLIs). Falls back to `Model:` if
   unset, then to the install-wide reviewer model, then the implementer
   default. A task's recorded worker model (`tasks.model`) never overrides
   the reviewer's resolution.
3. `SmallModel: <value>` (opencode and claude-code) — the model used for
   small/fast operations (e.g. title derivation in #761). Falls back to the
   install-wide small model, then the CLI's own default, if unset.

opencode's `<provider>/<model>` format accepts **more than one slash**, e.g.
`openrouter/anthropic/claude-sonnet-4-5` — the format check requires
non-whitespace content on either side of the first and last `/`, not exactly
one slash. Roughly 60% of the live catalog on the reference install has two
slashes (a routing prefix in front of the underlying provider/model pair).
An unrecognized model value at any tier is logged and falls through with a
warning — same posture as `Agent:`.

The resolved worker command is recorded once, at claim time, on the task's
own `agentCommand` field — so the task board can show which agent actually
ran a task without re-deriving precedence after the fact (the issue body,
project setting, or global default could all have changed since).

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

| Control                               | Setting (overrides the env default)          | Env default                                    | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------- | -------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Whether Task Master runs at all       | `settings.taskMaster.enabled`                | `MULLION_TASK_MASTER_ENABLED` (`false`)        | Gates every _new_ piece of autonomous work: the watcher's GitHub ingest + auto-claim, the claim/approve/retry endpoints (all refuse with 403/501 while off), and the reconciler's `in_progress` → `reviewing` transition itself (which includes spawning the review-agent session) — a finished session while disabled is left in `in_progress` instead, still reachable by the budget force-fail below, and transitions normally on the next tick once re-enabled. **`reject`/give-up/re-review are deliberately NOT gated** (Hermes review, PR #480, fourth pass; extended to give-up by `#483` and to re-review by `#1345`): they're the only routes that can act on an already-`reviewing` task, so a task that reached `reviewing` before the toggle flipped off — the one case the transition-gate above can't prevent — still has an escape hatch instead of being stranded until re-enabled; `approve`/`retry` stay gated since they create a real PR/spawn a real session. Does **not** gate an already-in-flight task's own budget enforcement or `in_progress` status sync to GitHub — that stays a safety net regardless. The local task board (create/edit/drag/delete) works regardless too, as does Abandon/Archive. |
| Max concurrent autonomous workers     | `settings.taskMaster.maxConcurrent`          | `MULLION_TASK_MAX_CONCURRENT` (`2`)            | Only tasks in `in_progress` count against this cap (task-claim queueing, rate-limit-storm fix) — `claimed` is the queue, and `reviewing` never held it. `dispatchClaimedTask`'s own transactional reservation (count `in_progress` + flip `claimed → in_progress`) is the sole correctness authority for a fresh claim; Retry performs its own separate reservation against the same `in_progress` count (see "Lifecycle" above) rather than sharing that transaction. A manual claim, auto-claim, and Retry are all cap-checked, so this is an actual ceiling on live workers, not a soft throttle — it's just no longer a ceiling on how many tasks may be QUEUED, which is unbounded by design (that's the whole point: a manual claim past capacity queues instead of 429ing). `reviewing` deliberately isn't counted either, even though it can hold a live review-agent session and an open draft PR.                                                                                                                                                                                                                                                                                                                         |
| Per-task time budget                  | `settings.taskMaster.budgetMinutes`          | `MULLION_TASK_BUDGET_MINUTES` (`120`)          | The reconciler force-fails and terminates the session of any `in_progress` task that's been running longer than this, measured from `claimedAt` (stamped at dispatch, when the worker spell actually starts, not at enqueue — time spent queued never counts). One exception: a task past its deadline whose worker has already finished — cleanly, or stuck behind a stale background shell job past `SHELL_TAIL_GRACE_MS` (5 minutes) — with commits on the branch is handed to the normal `→ reviewing` gate instead of force-failed, so completed work isn't thrown away purely because the handoff was a few minutes late; see [`tasks-internals.md`](tasks-internals.md#the-no-commits-gate-and-turn-finished-check). `0` = unlimited.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Runtime kill-switch                   | `settings.taskMaster.autoClaimPaused`        | — (no env equivalent; default `false`)         | Checked by the auto-claim sweep every poll. Stops the watcher picking new candidates off `ready`; it does **not** stop dispatch draining the queue — a task a human already queued (or that was auto-claimed before the pause) still dispatches once a slot is free, same as if the toggle were off. Surfaced in Settings → Task Master as "Pause auto-claim", disabled with a hint while Task Master itself is off.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Progress-comment throttle             | `settings.taskMaster.progressCommentMinutes` | `MULLION_TASK_PROGRESS_COMMENT_MINUTES` (`15`) | Minimum minutes between two `in_progress` progress comments the GitHub sync posts to the same linked issue, so a chatty agent (or a reconciler tick observing "still working" repeatedly) can't spam one comment per poll. `0` = no throttle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Skip permissions on unattended spawns | `settings.taskMaster.skipPermissions`        | `MULLION_TASK_SKIP_PERMISSIONS` (`false`)      | When on, a claim/auto-claim/retry/review-agent spawn passes the resolved agent's own skip-permissions flag (e.g. `--dangerously-skip-permissions`), so an unattended agent doesn't stall at a permission/trust prompt with no one to answer it. Off by default — an autonomous agent bypassing every tool-permission check is an explicit opt-in, not a safe default. Independent of `settings.launchers.skipPermissionsAgents`, which only drives the frontend's manual-launch CommandPalette and never reaches these spawns.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Review-agent CI wait                  | `settings.taskMaster.reviewCiWaitMinutes`    | — (no env equivalent; default `15`)            | How long the reconciler holds a `reviewing` task whose PR has CI still `in_progress` or not yet registered before spawning the review agent anyway. `0` disables waiting. See [`tasks-internals.md`](tasks-internals.md#review-agent-mechanics).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Rate-limit grace window               | `settings.taskMaster.rateLimitGraceMinutes`  | `MULLION_TASK_RATE_LIMIT_GRACE_MINUTES` (`5`)  | How long the reconciler holds a task alive after the agent reports a subscription-quota `rate_limit` failure (Claude Code's weekly limit, opencode go's quota, agy's `RESOURCE_EXHAUSTED`) before falling through to the normal fail path. Max 1440 (24h); `0` opts out. Durable on the task row, so it survives the session's own error-state TTL clearing — see [`tasks-internals.md`](tasks-internals.md#rate-limit-grace) for the full mechanism.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

### Trusted authors

The label alone isn't a trust boundary: on a public repo an outsider can open
issues and comment freely, and a template or Action can label an issue on
their behalf. So Task Master only ingests an issue whose author has
GitHub `author_association` `OWNER`, `MEMBER` or `COLLABORATOR`, or whose
login is in the trusted list (`settings.taskMaster.trustedLogins`, unioned with
comma-separated `MULLION_TASK_TRUSTED_LOGINS`; case-insensitive — use it for
bot accounts, which never carry those associations). An issue from anyone else
is ignored entirely (logged once), and comments from anyone else are dropped
from the worker's prompt, replaced by a one-line "N comments from unverified
authors omitted" marker. The comment fetch pages back (at most 5 requests
per thread) past untrusted comments, so an outsider flood can't crowd out an
earlier maintainer comment. A missing association is treated as untrusted.

No separate control for dependency-aware claiming (`#667`) — a
zero-dependency issue costs nothing extra to begin with, so there's
nothing to opt out of. Its own cost is bounded by the mechanisms in
[`tasks-internals.md`](tasks-internals.md#dependency-aware-claiming-667),
not a Settings toggle.

## Worktree lifecycle

A task's worktree lives at `.mullion-worktrees/mullion-task-<id>-<slug>`,
on branch `mullion/task-<id>-<slug>` — the path and branch are both
derived from the task's id and a sanitized title slug via
`git-worktree.ts`'s `deriveTaskBranchName`, the single source of truth
for the shape. The id sits in the name so two tasks titled the same
under one project still get distinct branches and directories; the
slug makes them self-describing in `git branch` and on the GitHub PR
header. Both are stamped onto the task row at claim/enqueue time (not
eagerly at task creation), but not actually created on disk until
dispatch (task-claim queueing, rate-limit-storm fix — see
`enqueueTask`/`dispatchClaimedTask`). The slug is frozen at claim
time: title edits after claim do NOT rename the branch. It's
removed only once its task reaches `done` or `failed` — never on session
death alone — and only when `getGitStatus` reports the tree clean; a
refusal leaves the path on the task row rather than destroying anything
with uncommitted work. There is no periodic retry of a refused removal,
though — the reconciler's main sweep only polls `in_progress` tasks (a
`claimed` row is queued, session-less, and invisible to it by
construction — see Lifecycle above), not `done`/`failed` ones. The only
two paths that revisit a refused-but-now-clean worktree are a boot-time
sweep (below) and a re-claim of the same task.

**Sessions get the same treatment (`#772`).** A task's worker and (optional)
review sessions are killed — `killSession`, so the row actually flips to
`"killed"`, not left for the 30s exited-session reconciler to eventually
mark `"exited"` — at every point that supersedes or ends the link: approve
(human or auto-approve), give-up, Retry (the old worker session, before a
fresh one is spawned), every fresh `→ reviewing` entry (the prior round's
review session, on a reject-and-re-review cycle), and closing the linked
GitHub issue directly on GitHub instead of through Mullion (`#775`) —
`syncClosedIssueToLocal`'s `reviewing → done` write, reachable from both the
`issues.closed` webhook and the poll sweep's read-back, is the one path
`#772` didn't cover; it's gated on the same CAS the transition itself uses,
so only the pass that actually wins the race runs cleanup. Before this,
nothing in the task lifecycle ever terminated a session once it stopped
being the task's current one — it just kept running, invisible from the
task view once its pointer was overwritten or nulled, and cluttering both
the sidebar and the Unified Board's ad-hoc lane indefinitely (both filter
out `"killed"` sessions, never `"active"`/`"exited"` ones).

**Task sessions are named and hidden from the sidebar by default (`#9`).**
Every task-owned spawn (claim/retry's worker, the reviewer, a rebase worker
— `#758`) is created with `name: "Task #<id> · worker"` / `"Task #<id> ·
review"` and `nameLocked: true`, instead of the bare launch command a
manually-started `claude`/`opencode` session would show as. `nameLocked:
true` here is a deliberate deviation from that column's own default
intent: a launch-time name pattern (`CommandPalette`'s
`expandSessionNamePattern`) leaves it `false` on purpose, so a live OSC
title update can still override it, but a task session's whole point is a
name that reliably identifies which task it belongs to — which an OSC
update would defeat. Once named, a task session is still hidden from the
sidebar by default (a new `settings.sessions.showTaskSessions` setting, off
by default, same persistence mechanism as `hideEndedSessions`) — reusing
`taskLinkedSessionIds` (`frontend/src/unifiedBoard.ts`) as the membership
check. This is a toggle, not a hard exclusion: a `"killed"` task session is
already filtered out of the sidebar unconditionally (the status check
above runs first, before this setting is even consulted), so the toggle
only ever governs whether a currently-live task session is visible — a
human may still want to glance at or attach to one directly without
navigating into the task view first.

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
Restricted to the same closed `mullion/task-<id>-<slug>` namespace
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

- **The reviewer App (`#737`) can't satisfy a CODEOWNERS-based rule.** A
  GitHub App can't be listed in a `CODEOWNERS` file — only a repo's numeric
  "require N approving reviews" branch protection rule can consume its
  `APPROVE`. If a repo's required-review rule is CODEOWNERS-driven instead,
  the reviewer App's approval satisfies nothing and the PR stays `blocked`
  regardless of how clean the review agent's verdict is.
- **Promotion, issue ingest, the boot-time orphan sweep, Retry, and
  review-findings/commit-title ingestion and seeding all now work for
  remote-hosted projects (`#484`, `#760`, `#778`).** The one remaining gap
  is version skew: a remote host running an agent build older than the
  feature in question degrades per-path rather than breaking — promotion
  501s with `remote-not-supported` (see
  [`tasks-internals.md`](tasks-internals.md#task--pr-promotion)), Retry
  501s the same way, the ingest/orphan sweeps just log and skip that host,
  and a remote host too old to have `/internal/task-review-findings`
  (`#760`) or `/internal/task-commit-title` (`#778`) makes
  `readTaskReviewFindings`/`readTaskCommitTitle` throw a `HostRequestError`
  — logged and either retried next tick (review-findings) or gracefully
  falling back to the raw task title (commit-title), same as a genuinely
  unreachable host, never misread as "the review/worker wrote nothing."
  `resolveSessionsDir()`'s own failure (a peer too old to have
  `/internal/config` — unlikely, since that route long predates `#778` —
  or simply unreachable) falls back to the primary's local path with a
  warn, the seed-side equivalent of the same posture. Update the agent
  build on that host to close the gap.
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
  gate's own no-commits failure (`#722`, now proxied to remote hosts too
  via `commitHostWipChanges`, issue `#1100` — see
  [`tasks-internals.md`](tasks-internals.md#the-no-commits-gate-and-turn-finished-check)):
  it salvages a WIP commit before failing, which is what lets
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
- **`tasks.assignee` is never populated.** The assignee flow is one-way: on
  claim, Mullion assigns the linked issue to the integration's own login on
  GitHub, but nothing ever writes the local `tasks.assignee` column, so it is
  always null despite being plumbed through the API and rendered in the task
  detail drawer.
- **GitHub only.** Non-GitHub issue trackers are out of scope.
- **A re-parenting (or de-parenting) between polls produces no live push
  (`#701`).** Sub-issue hierarchy has no push-based path the way dependency
  edges do — `sub_issues` is deliberately not a subscribed webhook event
  (see [`tasks-internals.md`](tasks-internals.md#task-hierarchy-sub-issues-701)),
  and `upsertIssueTask`'s own `/ws/tasks` broadcast only fires on a task's
  first sighting, not a re-sighting with a real column change. A poll
  writes the new parent correctly, but a board a user is already looking at
  only picks it up on the frontend's own next periodic refetch, not
  instantly.
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
  "never observed" the same as "known blocked" (see
  [`tasks-internals.md`](tasks-internals.md#dependency-aware-claiming-667)
  for why that's the deliberate, fail-closed choice, not an oversight).
  Visible on the board as the blocked icon with a "Checking dependencies…"
  tooltip rather than silent; manual Claim still works regardless.
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
- **`dependencyGate` only sees a blocker an issue actually declares as a
  `blocked_by` edge — nothing cross-checks an issue's own prose against
  another issue's or PR's real state.** Issue #1326 is the concrete case:
  its body describes PR #1324 (`feat/android-device-panel`) as already
  landed ("has a complete backend ... and a working frontend panel
  component") and scopes an addition on top of it, but #1324 was still
  open — `mergeable: CONFLICTING`, no reviews — when #1326 was labeled
  `ready`. `blocked_by` on #1326 was empty, so the gate read `clear`, the
  task was claimed, and the worker's worktree (branched from `origin/main`)
  had none of the files the spec named. There is no code fix for this: an
  issue whose scope depends on a not-yet-merged PR needs that PR's issue
  declared as a `blocked_by` edge (or the `ready` label held off) at file
  time — the gate has no way to infer a prose dependency claim.
- **With webhooks off (or unreachable), a landed blocker's dependents wait
  up to the poll interval, not the ~1s the webhook push gives them** — see
  [`tasks-internals.md`](tasks-internals.md#github-sync)'s blocker-close
  read-back — this requires a delivered `issues`/`closed` webhook or the
  next poll's own read-back to fire; there is no separate faster path for
  this specific case.
- **Stale as of `#818` — the pipeline now DOES reach a merged release, when
  configured to.** All three absences this bullet used to describe have
  shipped: a per-project `autoTagRelease` toggle, a post-merge trigger, and
  a durable `tasks.releaseError` field. See
  [`tasks-internals.md`](tasks-internals.md#autorelease-after-tasks-land-744)
  for the full mechanism. What's still real: `autoTagRelease` does nothing
  without `mergeOnApprove` also on (no task PR ever merges through Mullion
  otherwise), and a repo whose release workflow is `workflow_dispatch`-only
  (no `on: push` trigger) never gets a release PR out of a task landing at
  all — a human still needs the manual Run button there.
- **A silently-stalled review agent gets exactly one automatic re-arm per
  review round (issue `#1344`/task 409707), and a human can re-arm it again
  any time via Re-review (issue `#1345`, see "Board actions" above).** A
  review agent that goes idle with no reported `errorState`/`errorDetail` at
  all (unlike a reported `rate_limit`, which the rate-limit grace window
  already covers) is ingested as `lastReviewVerdict = "inconclusive"` once
  the review-findings grace period elapses. The automatic sweep
  (`reannounceInconclusiveReviewsAfterGrace`, `task-reconciler.ts`) re-arms
  such a task once `tasks.lastReviewVerdictAt` is more than an hour old,
  bounded to `tasks.inconclusiveReviewRearmCount < 1` so a genuinely-broken
  review adapter can't loop forever unattended. See
  [`tasks-internals.md`](tasks-internals.md#review-agent-mechanics) for the
  columns it clears and why.

## Troubleshooting

- **A task is stuck in `reviewing` with a `lastReviewVerdict` of
  `"inconclusive"`.** Click Re-review (see "Board actions" above) rather
  than waiting for the hourly automatic re-arm, or editing the DB by hand —
  see "Known limitations" above.
- **A `done` task's PR won't merge (`mergeOnApprove` is on and it's stuck).**
  Check `tasks.mergeError` in the task drawer — it names the actual cause
  (`behind`/`unstable`/`blocked`/`dirty`/a required-review gap). "Merge
  now"/"Retry merge" in the drawer re-arms the sweep immediately. See
  [`tasks-internals.md`](tasks-internals.md#merge-on-approve) for what each
  `mergeable_state` means and what the sweep does about it, and
  [`tasks-internals.md`](tasks-internals.md#auto-rebase-758) if the project
  has `autoApprove` on and the PR is `dirty`.
- **A required CI check never seems to trigger an automatic return to the
  worker.** This is very likely `#1360`'s known gap, not a bug in your
  project: the branch-protection lookup CI-auto-return depends on is a
  silent no-op for a GitHub App-backed install unless `READ_PERMISSIONS`
  has been widened for it. See [`ci-cd.md`](ci-cd.md)'s "Branch protection"
  section, and the "Red required CI returns the task to the worker" bullet
  in [`tasks-internals.md`](tasks-internals.md#auto-approve).
- **Retry says `no-worktree` and refuses.** The task failed before it ever
  had a branch/worktree (e.g. it failed while still `backlog`/`ready`, or
  it's a `#729`-deleted-and-recreated GitHub-linked task) — there's nothing
  for Retry to resume. See "Task model" above for the relabel-resurrection
  path that handles this case instead.
- **A task's GitHub label/comment never appeared.** Check
  `tasks.githubSyncError` in the task drawer — GitHub sync is best-effort
  and does not retry a missed write; see
  [`tasks-internals.md`](tasks-internals.md#github-sync). A read-only
  token 403s on the very first write (claim), so this is often a scope
  problem — see [`github-integration.md`](github-integration.md#task-master-additional-scope).
- **A task board looks like nothing is happening for minutes at a time.**
  Check Settings → Task Master's "Pause auto-claim" toggle first (a paused
  install still dispatches already-queued tasks, but won't pick up new
  `ready` candidates), then the install-wide GitHub rate limit (a
  `GitHubRateLimitError` in the server log means every GitHub-dependent
  sweep is fast-failing until the budget clears — see
  [`tasks-internals.md`](tasks-internals.md#github-rate-limiting-759)).
