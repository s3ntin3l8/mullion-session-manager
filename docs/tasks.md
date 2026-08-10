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
  `MULLION_TASK_LABEL`) on a **locally-hosted** project's repo — GitHub
  issue ingest doesn't run for remote-hosted projects via polling (see
  Known limitations). Every poll re-syncs the durable subset (title/body/
  `htmlUrl`) from the issue without touching status, board order, or any
  runtime field — a retitled issue is picked up on the next sweep instead
  of staying stale forever. When webhooks are enabled (see
  [`github-integration.md`](github-integration.md#webhook-delivery)), a
  `labeled`/`opened` delivery ingests the same way immediately instead of
  waiting for the next poll tick — and, because webhook repo resolution is
  host-agnostic unlike the poll sweep, this path also reaches
  remote-hosted projects the poll loop can't.

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
  `sessionStatus === "finished"` — its last turn ended and no background
  tasks are still running. `claimed → reviewing` directly (skipping
  `in_progress`) is a real, reachable edge: the reconciler polls on an
  interval, and a task whose agent finishes its very first turn between two
  polls is legitimately never observed `in_progress` in between.
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

Every transition is logged and broadcast on the live `/ws/tasks` channel
(`#488`, see The task board below) through a single chokepoint,
`recordTaskTransition` (`task-state.ts`) — every status write in this
section calls through it rather than logging/broadcasting independently, so
the two can't drift out of sync.

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

- **Write findings** to a round-suffixed file outside the worktree
  (`task-prompt.ts`'s `taskReviewFindingsPath` — writing inside the worktree
  would dirty it and block approve's own clean-tree check). The reconciler
  (`task-reconciler.ts`'s `processReviewingTasks`) reads this back once the
  review session's turn ends, posts it as a comment on the task's PR
  (falling back to the linked issue), and appends it to `tasks.reviewFindings`
  — durable across the worktree's own eventual removal, and rendered in the
  task detail drawer's Review card.
- **Trigger one automatic `reviewing → in_progress` round.** If those
  findings are non-empty and this task hasn't already used its one round
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
  injects keystrokes into a live, possibly mid-tool-call TUI.
- A task with **zero findings** (or a review agent whose adapter can't
  receive a seed at all — see `reviewSeedDelivered` below) simply stays in
  `reviewing`; the findings comment still posts ("Review complete — no
  findings."), so a finished review is never silently invisible, but nothing
  auto-transitions.

`processReviewingTasks` is a genuinely separate poll from the
claimed/in_progress reconcile loop (see the Lifecycle section's own note):
it never touches session liveness or the time budget, and it must run even
on a tick with zero claimed/in_progress tasks.

**A claim/retry/review spawn delivers its prompt as the agent's own
initial-turn argv** (e.g. `claude -- '<prompt>'`, `agy -i='<prompt>'`),
appended to the spawned command line at launch time — **not** via
stashing a seed for the `SessionStart` hook to return as
`additionalContext`, the mechanism this used before. `additionalContext`
injects context into the agent's conversation but never submits a turn, so
an unattended agent spawned that way sat at an empty prompt forever (never
observed as anything other than `idle`, so the reconciler could never
advance it past `claimed`) — this is what "seed" now means throughout this
doc and the API's `seedDelivered`/`reviewSeedDelivered` fields: the initial
prompt, however it's actually delivered, not literally a stashed
SessionStart seed. (The promote-to-worktree flow, where a human is present
to type the next message themselves, is unaffected and still uses the
stashed-seed mechanism.) The leading `--` form (rather than a bare
`claude '<prompt>'`/`codex '<prompt>'`) matters: a task title starting with
`-` would otherwise be parsed as an unrecognized option by claude's or
codex's own CLI, and the agent would exit before its first turn — verified
live against both. agy uses `-i=<value>` rather than a space-separated
`-i <value>` for the same reason in principle, though Task Master's actual
(interactive, no `-p`) spawn shape accepts a leading-hyphen value fine
either way — the equals form only matters for a print-mode invocation Task
Master doesn't use today; kept anyway since it's strictly more robust.

Not every agent can receive an initial prompt this way (only adapters that
declare an `initialPromptArgs` argv form — Claude Code, Codex, and agy
today, not OpenCode or any `KNOWN_AGENTS` entry with no adapter at all,
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

| Control                               | Setting (overrides the env default)          | Env default                                    | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------- | -------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Whether Task Master runs at all       | `settings.taskMaster.enabled`                | `MULLION_TASK_MASTER_ENABLED` (`false`)        | Gates every _new_ piece of autonomous work: the watcher's GitHub ingest + auto-claim, the claim/approve/retry endpoints (all refuse with 403/501 while off), and the reconciler's `claimed`/`in_progress` → `reviewing` transition itself (which includes spawning the review-agent session) — a finished session while disabled is left in `claimed`/`in_progress` instead, still reachable by the budget force-fail below, and transitions normally on the next tick once re-enabled. **`reject`/give-up are deliberately NOT gated** (Hermes review, PR #480, fourth pass; extended to give-up by `#483`): they're the only routes that can resolve an already-`reviewing` task, so a task that reached `reviewing` before the toggle flipped off — the one case the transition-gate above can't prevent — still has an escape hatch (back to `in_progress`, or to `failed`) instead of being stranded until re-enabled; `approve`/`retry` stay gated since they create a real PR/spawn a real session. Does **not** gate an already-in-flight task's own budget enforcement or `claimed`↔`in_progress` status sync to GitHub — that stays a safety net regardless. The local task board (create/edit/drag/delete) works regardless too — see the Flag semantics decision above. |
| Max concurrent autonomous claims      | `settings.taskMaster.maxConcurrent`          | `MULLION_TASK_MAX_CONCURRENT` (`2`)            | Tasks in `claimed`/`in_progress` count against this cap; both manual and auto-claim share one transactional reservation, so this is an actual ceiling, not a soft throttle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Per-task time budget                  | `settings.taskMaster.budgetMinutes`          | `MULLION_TASK_BUDGET_MINUTES` (`120`)          | The reconciler force-fails and terminates the session of any `claimed`/`in_progress` task that's been running longer than this, regardless of what the agent is doing. `0` = unlimited.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Runtime kill-switch                   | `settings.taskMaster.autoClaimPaused`        | — (no env equivalent; default `false`)         | Checked by the auto-claim sweep every poll. Stops new claims; tasks already `claimed`/`in_progress` are unaffected. Surfaced in Settings → Task Master as "Pause auto-claim", disabled with a hint while Task Master itself is off.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Progress-comment throttle             | `settings.taskMaster.progressCommentMinutes` | `MULLION_TASK_PROGRESS_COMMENT_MINUTES` (`15`) | Minimum minutes between two `in_progress` progress comments the GitHub sync posts to the same linked issue, so a chatty agent (or a reconciler tick observing "still working" repeatedly) can't spam one comment per poll. `0` = no throttle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Skip permissions on unattended spawns | `settings.taskMaster.skipPermissions`        | `MULLION_TASK_SKIP_PERMISSIONS` (`false`)      | When on, a claim/auto-claim/retry/review-agent spawn passes the resolved agent's own skip-permissions flag (e.g. `--dangerously-skip-permissions`), so an unattended agent doesn't stall at a permission/trust prompt with no one to answer it. Off by default — an autonomous agent bypassing every tool-permission check is an explicit opt-in, not a safe default. Independent of `settings.launchers.skipPermissionsAgents`, which only drives the frontend's manual-launch CommandPalette and never reaches these spawns.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

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
Local-hosted projects only (remote-hosted claims branch from the literal
`"HEAD"`, so `baseSha` stays null); preserved unchanged across Retry, since
retry resumes the same branch from the same original base. When `baseSha`
is null, or the diff itself can't be computed, the comment is posted with no
number rather than a guessed one.

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

**Local-hosted projects only.** Claim and the worktree lifecycle both work
on remote-hosted projects (see Worktree lifecycle below), but promotion
doesn't yet — a remote-hosted task's `→ reviewing` transition skips opening
a draft PR (logged, not recorded as a sync error — this isn't a broken
connection, just an unsupported host) and approving it 501s with
`remote-not-supported` rather than silently misreading "can't reach the
filesystem" as "not a repo." Proxying git status/push/base-ref resolution
to a remote host, the way worktree create/remove/prune already are, is
future work.

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
construction, no coordination needed. A dirty tree, a remote-hosted
project, or an undeterminable default branch just means no draft opens yet;
none of those block the `→ reviewing` transition itself, and approve's own
checks below still apply regardless of whether a draft exists.

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

- **GitHub issue ingest via polling is local-hosted-projects only.** The
  watcher's labeled-issue polling doesn't run for remote-hosted
  projects — via polling, a task can only be created there by the local
  board, not by labeling an issue. When webhooks are enabled, though,
  ingest **does** reach remote-hosted projects (see Task model above and
  `#490`'s slice bullet below) — this gap is specifically about the poll
  path. Once a task exists, claim/work/worktree-cleanup all work
  end-to-end on it (see Worktree lifecycle above). Tracked, together with
  the promotion gap directly below and Retry's remote-hosted restriction
  (see Worktree lifecycle above), as
  [#484](https://github.com/s3ntin3l8/mullion-session-manager/issues/484).
- **Task → PR promotion doesn't work for remote-hosted projects.** Claim
  and worktree lifecycle both proxy to a remote host; PR promotion doesn't
  yet — approving a remote-hosted task's review 501s with
  `remote-not-supported`. See Task → PR promotion above. Tracked as
  [#484](https://github.com/s3ntin3l8/mullion-session-manager/issues/484).
- **Retrying a task whose preserved worktree path already has something
  sitting at it (e.g. a crashed prior retry attempt) has no automatic
  cleanup.** `resumeTaskWorktree`'s `git worktree add` simply fails in that
  case (surfaced as `worktree-failed`), the same way a fresh claim's own
  orphan-clearing (`clearOrphanedTaskWorktree`) would refuse a dirty
  leftover — but retry doesn't run that clearing step first, since it would
  delete exactly the branch retry exists to preserve. A human needs to
  resolve it manually today.
- **GitHub App scoping is opt-in and repo-level, not per-task.** A GitHub
  App configured via `PUT /api/integrations/github/app` (see
  [`github-integration.md`](github-integration.md#github-app-opt-in-layers-on-top-of-the-pat-oauth-token))
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
