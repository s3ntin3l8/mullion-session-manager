# Task Master

Task Master turns a GitHub issue — or a task created directly in the
dashboard — into an autonomously-worked, reviewed, and promoted pull
request: an agent claims the task into an isolated worktree, works it,
and a human (or, for the review step, an optional advisory agent)
decides whether to approve or send it back.

**Gate:** `MULLION_TASK_MASTER_ENABLED` (default `false`). This only gates
_autonomous_ behavior — the background watcher's GitHub ingest and
auto-claim, the claim endpoint, and any GitHub write. The local task board
itself (create/edit/drag/delete a locally-created task) works regardless of
the flag: once a task can exist with no linked GitHub issue at all, "the
task list is empty when the flag is off" is no longer a property this flag
can promise. See [`roadmap.md`](roadmap.md)'s Phase 6 section and Task
Model & Task Board section for the design rationale.

## Task model

A task is a row in Mullion's own `tasks` table — that row, not the GitHub
issue, is authoritative for workflow status, board order, and runtime state
(worktree path, branch, linked session). A GitHub issue, when one is
linked, is authoritative for the durable subset it actually closes over:
title, spec (issue body), assignee, and the final PR link.

- **GitHub-linked task**: created by the background watcher polling for
  open issues carrying the `mullion-task` label (configurable via
  `MULLION_TASK_LABEL`). Every poll re-syncs the durable subset
  (title/body/assignee) from the issue without touching status, board
  order, or any runtime field — a retitled or unlabeled issue is picked up
  on the next sweep instead of staying invisible forever.
- **Local task**: created directly on the board (`POST /api/tasks`), no
  GitHub issue at all. Works with the flag off. Local task CRUD
  (create/edit board order/drag/delete) is restricted to tasks that are
  still `backlog` or `ready` and have no linked issue — once claimed, or
  once a GitHub issue is attached, the task's lifecycle is driven by the
  state machine below instead.

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
- **`claimed → in_progress`** fires on the claimed session's first real
  activity (a `progress`/`tool_done`/`file_change` hook event, or the
  session's first `working` status).
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
  session is still alive. It's reachable only via an explicit human
  "give up" action.
- **`failed → backlog`/`ready`** is an explicit human retry, clearing
  runtime fields (worktree/branch/session) so the task can be claimed
  fresh.

Every transition is logged (`app.log.info`/`app.log.warn`); it does not yet
push a live event into the Phase 1 notification model (see Known
limitations below) — the Tasks panel picks transitions up via its own
polling interval instead.

## The Tasks panel

Command Palette → Integrations → **Tasks** (or the sidebar's own Tasks nav
entry, which shows a badge count of tasks needing a decision right now —
`ready` + `reviewing`). It's the first _global_ dockview panel: one board,
not scoped to a project, with a column per status above.

- Cards show title, status, owning project, linked-issue number, resolved
  agent name, and a linked-session indicator.
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
- The task detail panel adds Claim/Approve/Reject, the worker session's
  embedded timeline, and — when a review agent is configured — a distinct
  "Review (advisory)" card with the review agent's own timeline. Claim,
  Approve, and Reject are disabled (with an explanatory hint) whenever
  `MULLION_TASK_MASTER_ENABLED` is off; the board and local CRUD are not.

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
`session_start` among what they emit — Claude Code and Codex today, not
OpenCode or agy). For an **autonomous** claim, resolving to an agent with
no seed channel is refused outright rather than spawning a blind agent
with no instructions. A **manual** human claim still proceeds — a person
is present to paste the prompt in — with the response's `seedDelivered:
false` reflecting that.

## Safety envelope

| Control                          | Config                                                            | Behavior                                                                                                                                                                                                                   |
| -------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Max concurrent autonomous claims | `MULLION_TASK_MAX_CONCURRENT` (default `2`)                       | Tasks in `claimed`/`in_progress` count against this cap; both manual and auto-claim share one transactional reservation, so this is an actual ceiling, not a soft throttle.                                                |
| Per-task time budget             | `MULLION_TASK_BUDGET_MINUTES` (default `120`, `0` = unlimited)    | The reconciler force-fails and terminates the session of any `claimed`/`in_progress` task that's been running longer than this, regardless of what the agent is doing.                                                     |
| Runtime kill-switch              | `settings.taskMaster.autoClaimPaused` (default `false`)           | Checked by the auto-claim sweep every poll — pausing takes effect without a restart, unlike the env-var flag. **No dedicated Settings UI toggle exists yet** — see Known limitations below.                                |
| Progress-comment throttle        | `MULLION_TASK_PROGRESS_COMMENT_MINUTES` (default `15`, `0` = off) | Minimum minutes between two `in_progress` progress comments the GitHub sync posts to the same linked issue, so a chatty agent (or a reconciler tick observing "still working" repeatedly) can't spam one comment per poll. |

## GitHub sync

Best-effort with respect to the local transition: **the local row is the
hub and is never blocked by GitHub being unreachable.** A sync failure is
logged and retried on the next watcher sweep, never rolled back into local
state.

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
for exactly what to (re-)provision; a read-only token 403s on the very
first write, surfaced on the task as a specific failure reason rather than
a generic error.

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
tree clean; a refusal leaves the path on the task row for the next
reconciler pass to retry, so nothing with uncommitted work is ever
destroyed. A boot-time sweep prunes worktrees left behind by a crash or an
out-of-band `rm -rf`. Works on remote-hosted projects via the same
`SessionBackend`/`/internal/*` proxy pattern the rest of Mullion's
remote-host support uses. See `src/services/git-worktree.ts` for the
implementation and its own extensive design comments.

## Known limitations

- **Task → PR promotion doesn't work for remote-hosted projects.** Claim
  and worktree lifecycle both proxy to a remote host; PR promotion doesn't
  yet — approving a remote-hosted task's review 501s with
  `remote-not-supported`. See Task → PR promotion above.
- **No per-task GitHub token scope.** Mullion's GitHub credential is
  install-wide by construction (one row in the `integrations` table for
  the whole install) — every autonomous task write uses the same token.
  Per-task scoping would need per-project credentials or a GitHub App, a
  cross-cutting change larger than Task Master itself. The cap/budget/
  kill-switch above are the achievable subset that ships today.
- **No dedicated Settings UI for the runtime kill-switch.**
  `settings.taskMaster.autoClaimPaused` exists and is checked every
  auto-claim sweep, but the only way to flip it today is a direct
  `PATCH /api/settings` call with `{"taskMaster": {"autoClaimPaused": true}}`
  — there's no toggle in the dashboard yet.
- **Transitions don't push a live notification event.** The Tasks panel
  and notification bell learn about a state change on their next poll
  tick, not immediately over the existing `/ws/events` stream — the
  session-scoped event model (`pty-manager.ts`) has no session-less
  channel a task without a live session yet (`backlog`/`ready`) could key
  an event on.
- **Polling only**, matching the base GitHub integration. Webhook-driven
  task sync is a future enhancement, not present today.
- **GitHub only.** Non-GitHub issue trackers are out of scope.
