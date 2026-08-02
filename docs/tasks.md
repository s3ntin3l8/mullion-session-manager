# Task Master

Task Master turns a GitHub issue — or a task created directly in the
dashboard — into an autonomously-worked, reviewed, and promoted pull
request: an agent claims the task into an isolated worktree, works it,
and a human (or, for the review step, an optional advisory agent)
decides whether to approve or send it back.

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
  `MULLION_TASK_LABEL`) on a **locally-hosted** project's repo — GitHub
  issue ingest doesn't run for remote-hosted projects (see Known
  limitations). Every poll re-syncs the durable subset (title/body/
  `htmlUrl`) from the issue without touching status, board order, or any
  runtime field — a retitled issue is picked up on the next sweep instead
  of staying stale forever. An issue that loses the `mullion-task` label
  while staying open is a deliberate, stated gap: its task is left
  untouched (not archived or removed) rather than guessing whether the
  label removal meant "tidying up" or "abandoning the task."
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
  `sessionStatus === "finished"` — its last turn ended and no background
  tasks are still running. `claimed → reviewing` directly (skipping
  `in_progress`) is a real, reachable edge: the reconciler polls on an
  interval, and a task whose agent finishes its very first turn between two
  polls is legitimately never observed `in_progress` in between.
- **`* → failed`** fires automatically on session exit (a `claimed`/
  `in_progress` task whose session dies is failed, not left pointing at a
  dead session forever) or on exceeding the per-task time budget (see
  Safety envelope below). `reviewing → failed` is **not** automatic on
  session exit — the worker's turn is already over and the work is
  committed on its branch, still promotable regardless of whether that
  session is still alive.
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

Every transition is logged (`app.log.info`/`app.log.warn`); it does not yet
push a live event into the Phase 1 notification model (see Known
limitations below) — the Tasks panel picks transitions up via its own
polling interval instead.

## The Tasks panel

Command Palette → Integrations → **Tasks** (or the sidebar's own Tasks nav
entry, which shows a badge count of tasks needing a decision right now —
`ready` + `reviewing`). It's the first _global_ dockview panel: one board,
not scoped to a project, with a column per status above.

- Cards show title, owning project, linked-issue number, resolved agent
  name, and a linked-session indicator — status itself is the column a
  card sits in, not repeated on the card.
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
- The task detail panel adds Claim/Approve/Reject/Retry/Give up, the
  worker session's embedded timeline, and — when a review agent is
  configured — a distinct "Review (advisory)" card with the review agent's
  own timeline. Claim, Approve, and Retry (`#483`) are disabled (with an
  explanatory hint) whenever Task Master is off, since all three spawn or
  promote autonomous work; Reject and Give up stay enabled — see the
  Safety envelope table below for why. The board and local CRUD are not
  gated either way.

## Agent selection

Two independent choices are resolved per task, most-specific tier wins:

**Worker agent** (which agent actually claims and works the task):

1. The issue body's own `Agent: <name>` line (e.g. `Agent: codex`).
2. The owning project's `defaultAgent` setting (Project Settings' Default
   Agent dropdown, or `projects.defaultAgent` directly).
3. The install-wide `settings.launchers.defaultAgent`.

**Review agent** (the optional advisory reviewer — see below):

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
own `agentCommand` field — so the Tasks panel can show which agent actually
ran a task without re-deriving precedence after the fact (the issue body,
project setting, or global default could all have changed since).

**The review agent is advisory only.** It runs once, in the worker's own
worktree (the worker's turn is already over by the time `reviewing` is
entered, so there's no concurrent-write race), seeded with the task's
title/body and pointed at the diff ("Review this task's diff. You are not
expected to make changes."), and posts findings — it has **no** path to
approve, reject, or otherwise transition the task. That decision is always
a human's, via the Claim/Approve/Reject buttons in the task detail panel.

Not every agent can receive a seeded prompt (only adapters that declare
`session_start` among what they emit — Claude Code, Codex, and agy today,
not OpenCode or any `KNOWN_AGENTS` entry with no adapter at all, currently
`aider`/`gemini`/`pi`). For an **autonomous claim** (the worker agent only),
a resolved agent with no seed channel is refused outright rather than
spawning a blind agent with no instructions. A **manual** human claim
still proceeds — a person is present to paste the prompt in — with the
response's `seedDelivered: false` reflecting that. **The review agent has
no such refusal**: it's always spawned once a task enters `reviewing`
(when one is configured), since refusing outright would remove the one
artifact (the empty session) that lets a human notice something's wrong —
but the seed being skipped for an unseedable adapter is no longer silent:
the task row's `reviewSeedDelivered` field records it, a warning is
logged, and the Tasks panel's review card surfaces it directly.

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

| Control                          | Setting (overrides the env default)          | Env default                                    | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | -------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Whether Task Master runs at all  | `settings.taskMaster.enabled`                | `MULLION_TASK_MASTER_ENABLED` (`false`)        | Gates every _new_ piece of autonomous work: the watcher's GitHub ingest + auto-claim, the claim/approve/retry endpoints (all refuse with 403/501 while off), and the reconciler's `claimed`/`in_progress` → `reviewing` transition itself (which includes spawning the review-agent session) — a finished session while disabled is left in `claimed`/`in_progress` instead, still reachable by the budget force-fail below, and transitions normally on the next tick once re-enabled. **`reject`/give-up are deliberately NOT gated** (Hermes review, PR #480, fourth pass; extended to give-up by `#483`): they're the only routes that can resolve an already-`reviewing` task, so a task that reached `reviewing` before the toggle flipped off — the one case the transition-gate above can't prevent — still has an escape hatch (back to `in_progress`, or to `failed`) instead of being stranded until re-enabled; `approve`/`retry` stay gated since they create a real PR/spawn a real session. Does **not** gate an already-in-flight task's own budget enforcement or `claimed`↔`in_progress` status sync to GitHub — that stays a safety net regardless. The local task board (create/edit/drag/delete) works regardless too — see the Flag semantics decision above. |
| Max concurrent autonomous claims | `settings.taskMaster.maxConcurrent`          | `MULLION_TASK_MAX_CONCURRENT` (`2`)            | Tasks in `claimed`/`in_progress` count against this cap; both manual and auto-claim share one transactional reservation, so this is an actual ceiling, not a soft throttle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Per-task time budget             | `settings.taskMaster.budgetMinutes`          | `MULLION_TASK_BUDGET_MINUTES` (`120`)          | The reconciler force-fails and terminates the session of any `claimed`/`in_progress` task that's been running longer than this, regardless of what the agent is doing. `0` = unlimited.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Runtime kill-switch              | `settings.taskMaster.autoClaimPaused`        | — (no env equivalent; default `false`)         | Checked by the auto-claim sweep every poll. Stops new claims; tasks already `claimed`/`in_progress` are unaffected. Surfaced in Settings → Task Master as "Pause auto-claim", disabled with a hint while Task Master itself is off.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Progress-comment throttle        | `settings.taskMaster.progressCommentMinutes` | `MULLION_TASK_PROGRESS_COMMENT_MINUTES` (`15`) | Minimum minutes between two `in_progress` progress comments the GitHub sync posts to the same linked issue, so a chatty agent (or a reconciler tick observing "still working" repeatedly) can't spam one comment per poll. `0` = no throttle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

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

| Transition      | GitHub side effect                                                                   |
| --------------- | ------------------------------------------------------------------------------------ |
| `→ claimed`     | Add `mullion-claimed`, comment "Task claimed — agent starting…"                      |
| `→ in_progress` | Progress comment, throttled (see Safety envelope above)                              |
| `→ reviewing`   | Swap `mullion-claimed` → `mullion-reviewing`, comment "Task ready for review."       |
| `→ done`        | Swap `mullion-reviewing` → `mullion-done`, comment with the PR link, close the issue |
| `→ failed`      | Comment with the failure summary, remove active labels, leave the issue open         |
| reject          | Comment with the human's feedback text                                               |

This requires **write** access on Issues, Pull requests, and Contents —
broader than the read-only scope the base GitHub integration needs for its
Dock widget/panel. See
[`github-integration.md`](github-integration.md#task-master-additional-scope)
for exactly what to (re-)provision. A read-only token 403s on the first
write — every write in the table above (including the very first one, on
claim), plus a promotion failure (approve), is logged server-side **and**
recorded on the task's `githubSyncError` field, rendered in the Tasks panel
regardless of the task's status (see The Tasks panel above). If claiming a task
never actually labels/comments on its GitHub issue, the task itself will
now say why — `githubSyncError` is not `failureReason`: the latter is only
rendered when `status === "failed"` and also carries reject feedback, so a
sync problem never overwrites it.

## Task → PR promotion

**Local-hosted projects only.** Claim and the worktree lifecycle both work
on remote-hosted projects (see Worktree lifecycle below), but promotion
doesn't yet — approving a remote-hosted task's review 501s with
`remote-not-supported` rather than silently misreading "can't reach the
filesystem" as "not a repo." Proxying git status/push/base-ref resolution
to a remote host, the way worktree create/remove/prune already are, is
future work.

On approve (`reviewing → done`): the worktree's tree must be clean (a
dirty tree 409s the approve request rather than silently excluding
uncommitted work from the PR), the branch is pushed if it has unpushed
commits or no upstream yet, and a PR is opened from it — title from the
task title, body from the task body plus a `Closes #N` line when a GitHub
issue is linked. A local-only task still gets a PR; it just has no issue
to close. These steps are ordered so that any failure leaves the task in
`reviewing`, untouched and safely retryable — never half-promoted.

On reject (`reviewing → in_progress`): the worktree and session are left
untouched by default so the agent can pick the feedback up on its own. If
its session has already exited, a fresh one is re-seeded in the **same**
worktree (never a new one) with the feedback as its prompt.

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
`clearOrphanedTaskWorktree` enforces. Local-hosted projects only for
now — full remote support is `#484`'s scope, same as promotion.

The boot-time sweep prunes worktrees left behind by a crash or an
out-of-band `rm -rf`, but **only for locally-hosted projects** — it reads
the filesystem directly at the primary's own boot time, not through the
remote-host proxy, so a remote-hosted project's orphaned worktrees are out
of its reach. Everything else in this section — create, the clean-check
removal above, and the reconciler's own steady-state cleanup — does proxy
to a remote host via the same `SessionBackend`/`/internal/*` pattern the
rest of Mullion's remote-host support uses. See
`src/services/git-worktree.ts` and `src/plugins/task-watcher.ts` for the
implementation and their own extensive design comments.

## Known limitations

- **GitHub issue ingest is local-hosted-projects only.** The watcher's
  labeled-issue polling doesn't run for remote-hosted projects — a task
  can only be created there by the local board, not by labeling an issue.
  Once such a task exists, though, claim/work/worktree-cleanup all work
  end-to-end on it (see Worktree lifecycle above) — this gap is narrower
  than it sounds, and is specifically about auto-ingest, not the rest of
  the loop.
- **Task → PR promotion doesn't work for remote-hosted projects.** Claim
  and worktree lifecycle both proxy to a remote host; PR promotion doesn't
  yet — approving a remote-hosted task's review 501s with
  `remote-not-supported`. See Task → PR promotion above.
- **Retrying a task whose preserved worktree path already has something
  sitting at it (e.g. a crashed prior retry attempt) has no automatic
  cleanup.** `resumeTaskWorktree`'s `git worktree add` simply fails in that
  case (surfaced as `worktree-failed`), the same way a fresh claim's own
  orphan-clearing (`clearOrphanedTaskWorktree`) would refuse a dirty
  leftover — but retry doesn't run that clearing step first, since it would
  delete exactly the branch retry exists to preserve. A human needs to
  resolve it manually today.
- **No per-task GitHub token scope.** Mullion's GitHub credential is
  install-wide by construction (one row in the `integrations` table for
  the whole install) — every autonomous task write uses the same token.
  Per-task scoping would need per-project credentials or a GitHub App, a
  cross-cutting change larger than Task Master itself. The cap/budget/
  kill-switch above are the achievable subset that ships today.
- **Transitions don't push a live notification event.** The Tasks panel
  and notification bell learn about a state change on their next poll
  tick, not immediately over the existing `/ws/events` stream — the
  session-scoped event model (`pty-manager.ts`) has no session-less
  channel a task without a live session yet (`backlog`/`ready`) could key
  an event on.
- **Polling only**, matching the base GitHub integration. Webhook-driven
  task sync is a future enhancement, not present today.
- **GitHub only.** Non-GitHub issue trackers are out of scope.
