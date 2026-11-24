# The notification bell: only what needs a decision, in two sections, in a bigger view

Design note for [#2985](https://github.com/s3ntin3l8/mullion-session-manager/issues/2985).
It specifies a presentation and a classification. No product code changes with
this note. It describes `main` as of 291eaac2.

## Decisions

The owner decided these on 2026-11-24 (the newest comment on #2985). The rest
of the note follows them.

1. **The bell lists only items that need a decision**: a permission, a plan, a
   question, a failure, a review verdict. Purely informative events are grouped
   or dropped.
2. **Two sections, Sessions and Tasks**, each with its own needs-you count.
3. **A full-height panel with filters on phone and tablet.** Desktop is "the
   same panel or a larger popover", settled below.

Settled in this note (§ Desktop): desktop gets the same panel, as a full-height
side panel beside the left rail, not a larger popover.

## What exists today

The bell (`frontend/src/NotificationBell.tsx`) is a feed of **session events
only**:

- The feed is built from the store's per-session `NotificationEvent` ring
  buffers (`store/slices/events.ts`), filtered by `notifyKind()`
  (`eventDescriptions.ts`) to the events that "ring": a generic `attention`
  event, a process exit, a waiting review gate, a dev-server offer, red PR
  news. Rows are grouped by session under a sticky header, and consecutive
  identical rows fold into "×N" (`foldConsecutiveRows`).
- **Tasks are not in the bell.** Task transitions travel on a separate
  session-less channel, `/ws/tasks` (`services/task-events.ts`), on purpose:
  `NotificationEvent` is per-session at four layers. That channel is a
  doorbell with no payload, no `seq` and no replay; the frontend refetches.
  A task "needs you" through derived state: `needsYouReason(task)` in
  `frontend/src/github/taskMasterSummary.ts`, the one definition behind the
  Tasks badge in `LeftRail.tsx`.
- Presentation: a 380px popover (`.notif-panel`, `lib/notifPanelPosition.ts`)
  on desktop and non-touch tablet; a `ui/BottomSheet.tsx` on the phone and on
  touch tablets (`notificationSheet = compact && isCoarsePointer`, `App.tsx`),
  with a "Needs you | All" filter that counts sessions.
- "Read" is the per-session `lastSeenSeq` cursor (issue #166) shared with the
  pane tabs' badges. "Dismiss" is separate (`dismissedEventKeys`). The toolbar
  badge is `countUnread`: raw unread notify-worthy events.

## Every notification type

`NotificationEvent["kind"]` (`src/shared/types.ts`) has 25 kinds. A row below is
what the code does today and what this note decides. "Fires" is from code, not
from a live count (see § Limits of the evidence).

### Hook-sourced signals (an agent CLI's hook channel, `hook-handlers.ts`)

| Kind / signal                          | Source                                            | Fires                                                           | Today in the bell                             | Decision                                                                                     |
| -------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `permission_request` (+ `attention`)   | tool needs approval                               | each ask; the attention twin settles 2s (`ATTENTION_SETTLE_MS`) | listed, severity "blocked"                    | **Listed** (a decision). Fold repeats of the same pattern ("×25").                           |
| `plan_ready`                           | agent proposes a plan                             | once per plan                                                   | listed, "blocked"                             | **Listed**                                                                                   |
| `question`, `elicitation`              | agent asks the human                              | once per ask (a resolution event reuses the kind, `state`)      | listed on `state: "started"`                  | **Listed**                                                                                   |
| `review_gate` (`state: waiting`)       | a gate waits for Approve/Deny                     | once per gate; resolution appends a new event                   | listed, with inline Approve/Deny              | **Listed**, keeps the inline buttons (they key off the live `gates`)                         |
| `promote_request`                      | agent asks to promote to worktree                 | once per request                                                | blocked severity (via `specificKindSeverity`) | **Listed**                                                                                   |
| `stop_failure` (API error)             | the turn ended on an API error                    | settles 2s; once per failure                                    | listed, "error"                               | **Listed** as Failed: the agent has stopped and will not recover alone.                      |
| `tool_failure`                         | a tool call failed                                | settles 2s; can be frequent in a turn                           | listed, "error"                               | **Dropped** from the bell. The agent's next turn usually resolves it. Stays in the timeline. |
| `attention` / `agentIdle` ("Finished") | turn ended, agent waits                           | settles 3s; once per turn                                       | listed, "done"                                | **Grouped**, informative (see § Grouped).                                                    |
| `attention` / `hookNotification`       | generic catch-all, fired alongside specific kinds | once per hook message                                           | listed, "blocked"                             | **Listed only when no specific-kind sibling covers it**. See § Where the code resists.       |

### Byte-parsed signals (PTY heuristics, `attention-detect.ts`)

`bell`, `notification`, `titleIdle`, `altScreenExit`, `silence` (after
`SUSTAINED_SILENCE_MS` = 10s). Each is an `attention` event with a signal
label, severity "done". These are guesses: they say "something happened", not
what. **Dropped** from the bell (kept in the timeline). For a session with a
hook adapter they duplicate a hook signal; for one without, they are all the
bell has, and the session still shows its own `attention` state in the
sidebar and pane tab.

### Session lifecycle and machine-sourced

| Kind                                                                           | Source                                  | Fires                                          | Decision                                                                                                                                                                                         |
| ------------------------------------------------------------------------------ | --------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `status_change` (`reason: "exited"`) / `session_end`                           | the process ended                       | once per session                               | **Grouped**. Today it is listed; an exit is information. A crash would be Failed, but the payload is not confirmed to carry an exit code (issue 1 checks).                                       |
| `dev_server_detected`                                                          | scrollback shows a dev server listening | once per detected port (#404)                  | **Dropped** from the bell: an offer, nothing blocks on it. The session keeps its own banner (`pendingDevServerPort`).                                                                            |
| `pr_review_submitted` `CHANGES_REQUESTED`                                      | GitHub poller (`pr-session-events.ts`)  | on a change of `reviewDecision`                | **Listed** as Review verdict                                                                                                                                                                     |
| `pr_review_submitted` `APPROVED`                                               | same                                    | same                                           | **Listed as Review verdict only for a manual session's PR**; for a task's PR the Tasks section already carries "approved, needs your approval" (`approvalState`). Today it is not listed at all. |
| `pr_ci_failed`, `pr_conflicts`                                                 | same                                    | on the transition into red/conflicting         | **Listed** as Failed, one row per PR, resolved by `pr_ci_passed`. For a task-owned PR the Tasks section covers it (`ci-still-red`, `rebase-exhausted`), so the row is dropped there.             |
| `pr_ci_passed`, `pr_merged`, `pr_new_comments`                                 | same                                    | on transition                                  | **Dropped** (timeline only). Today also not listed.                                                                                                                                              |
| `message_sent`, `message_received`                                             | `sessions.message` audit (#2270)        | per message                                    | **Dropped** (audit rows)                                                                                                                                                                         |
| `status_change` (other), `title_change`, `file_change`, `todo`, `session_diff` | PTY and hooks                           | high frequency (every title, every file write) | **Dropped** (timeline only). Today also not listed.                                                                                                                                              |

### Task needs-you (derived, no event)

`needsYouReason(task)` returns a reason for: a failed task (`failureReason`),
`worker-not-started`, a parked red CI check, a merge that cannot proceed
(`rebase-exhausted`, `blocked-threads`, `pr-closed`, `ci-status-stalled`), the
review round cap, a merge or release error, and a review that approved and
waits for the human (`approvalState === "awaiting-human"`). These map to the
owner's categories: **failed**, **review verdict** (awaiting approval), and a
review loop that stopped and wants a decision.

### Limits of the evidence

Frequencies above are from the code's own timers and the tests
(`eventDescriptions.test.ts`, `NotificationBell.test.tsx`,
`NotificationBell.unreadSplit.test.tsx`), not from a count of a real or demo
stream. The issue asked for "how many per day need a decision versus inform";
that number does not exist in the repo, and a demo instance's stream is scripted,
so its counts would describe the script. Issue 1 below adds the one place a real
count can be read; the owner can judge the classification against their own
instance after it ships. The classification does not depend on the counts: it
follows the owner's rule (decision or not).

## What "read" means

Today "read" and "needs you" are tangled: `countUnread` counts every unread
notify-worthy event, including exits and finished turns. Split them:

- **Needs you is state, not a cursor.** A decision item needs you while the
  decision is open: the session's live `attention` is set (or its `gates` still
  holds the gate); the task's `needsYouReason` is non-null. It leaves the list
  when that state clears, however it cleared (answered in the terminal, a gate
  timing out, a task merged). Viewing the panel never clears it.
- **Read applies only to the grouped informative rows.** Opening the panel
  marks them read; "Read all" advances `lastSeenSeq` (the same cursor the tab
  badges use) only for sessions that have no open decision, because the cursor
  is monotonic and advancing it past a session's newest event would also mark
  that session's older decision events read. The tab badges keep working off
  the same cursor and do not change.
- **Dismiss stays** as a separate per-event action (`dismissedEventKeys`), for
  a decision row the user does not want to act on.
- **The bell badge is the sum of the two needs-you counts**, not an unread
  count. A muted session contributes nothing (as today).
- Tasks have no read state. There is no event to hold a cursor, and a task row
  that stays until the state resolves is what the Tasks badge already does.

## The two sections and their counts

- **Sessions**: needs-you count = sessions with at least one open decision
  (permission, plan, question, elicitation, review gate, promote, stop failure,
  review verdict on a manual PR, red PR on a manual session). One row per
  decision, grouped under the session's header as today; identical rows fold.
  This is `collectNeedsYouIds` narrowed to decision kinds.
- **Tasks**: needs-you count = `needsYouTasks(tasks).length`, the number on the
  Tasks mode switch and the rail badge, so the three can never disagree. One
  row per task, with `needsYouReason` as its text and the task's project.
- The header shows both counts as the section switch ("Sessions 2 · Tasks 1").
  The panel opens on the section with something to decide, Sessions first on a
  tie, and on Sessions when both are empty.

### Grouped

A third element sits at the bottom of the Sessions section: a collapsed
"Earlier, no decision needed" group with one line per session ("`<session>`
finished, exited"), not counted anywhere, expandable. It holds the informative
kinds that are worth a glance but are not decisions (`agentIdle`, exit). The
desktop and phone sounds and OS notifications (`desktopNotify.ts`) are out of
scope and unchanged.

## The bigger view

One panel, three presentations:

| Tier                             | Presentation                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------ |
| Phone (under 700px)              | Full-height sheet (`BottomSheet`, full height); the back gesture closes it                       |
| Tablet, touch                    | Full-height panel anchored to the edge of the rail that holds the bell, 480px wide, with a scrim |
| Tablet with a mouse, and desktop | The same panel, 420px wide, no scrim; Esc and an outside click close it                          |

Contents, top to bottom: the section switch with counts; the status filter
(chips); the list; "Read all" for the grouped rows. The status filter per
section: Sessions: Needs you (default when non-zero) / All, and kind chips
(Permission, Plan, Question, Failed, Review); Tasks: Needs you / All, and
Failed, Review, Stopped (the review loop's hold). The "All" view keeps the
grouped and already-read rows; "Needs you" shows open decisions only.

### Desktop

**The same panel, not a larger popover.** Reasons:

1. On desktop the bell lives in the left rail's bottom cluster
   (`placement="beside"`), so the popover grows upward from the screen's
   bottom edge, and that, not its width, is what limits it: a taller list
   cannot fit and a 380px column cannot hold two sections plus filters.
2. One component with one anchor behaves the same on every tier, which is the
   point of the bigger view; a popover needs its own clamping
   (`notifPanelPosition.ts`) that the panel does not.
3. Desktop does not get a first-level view: Tasks mode already is the task
   list, and a view that covers the workspace to show notifications would
   interrupt the session the notification is about. A side panel lets the user
   keep the terminal visible while deciding.

## How a row links to its target, and returns

- **A session row** opens the session in Workspace (`onOpenSession`), switching
  from Tasks mode if needed. A row's secondary action opens its timeline
  (`onOpenTimeline`), as today. A gate row keeps inline Approve/Deny.
- **A task row** opens the task in Tasks mode through `useOpenTask`, the one
  entry point for "show me this task"; it does not choose the surface itself.
- **A PR row** (Sessions section, `pr_*`) opens the PR in the right sidebar, as
  today (`openRightSidebarPr`).
- **Return.** Opening a target closes the panel (always on phone and touch
  tablet; on desktop the panel stays until the target is open, then closes). The store remembers the
  panel's section and filter (not its scroll position), so reopening the bell
  returns to the same list. On the phone the back gesture from the target
  reopens the panel, the same pattern as `crossLinkReturn` (set when "Open
  session in Workspace" leaves Tasks, #3014); the new field is written by the
  panel's open-target handler and read by the phone back handler. On desktop
  and tablet the return is the bell itself.
- A deep link does not carry the panel's state; a reload closes the panel.

## Where the code makes the direction impractical

1. **Tasks have no events, so the Tasks section is a live list of derived
   state, not a feed.** No read state, no history, no "N new since you looked".
   Adding task notification events would widen the model the invariants warn
   against touching; this note does not.
2. **Most decision events record the request, not the answer.** A
   `permission_request` row has no matching "resolved" event (only gates and
   `question`/`elicitation`/`promote_request` do). Needs-you must therefore key
   off the session's live `attention` (and `gates`), not off the event alone;
   an event whose session no longer needs the user is history. If `attention`
   clears for a reason that is not an answer (the agent's own next output),
   a real decision could drop off the list: issue 1 pins this with tests
   against `attention-tracker.ts`'s settle rules.
3. **`hookNotification` cannot be told apart from an idle ping.** Claude Code's
   generic notification fires both for "needs your permission" and for "waiting
   for input"; with a specific sibling the specific one wins, without one the
   bell cannot tell a decision from idleness. Rule: listed only when
   unpaired, and counted as needs-you only while `attention` holds. If the
   owner finds it noisy, dropping it is a one-line change in the classifier.
4. **Agents without hooks (byte-parsed only) have no decision kinds.** Their
   permission prompts surface only as heuristic `attention`. Dropping those
   signals means such a session is invisible in the bell while its pane tab and
   sidebar still flag it. The note accepts this: the direction asks for
   decisions only, and the heuristics cannot say what the decision is.
5. **The read cursor is monotonic per session** (see § What "read" means), so
   "Read all" is limited to sessions with no open decision.
6. **No real count.** See § Limits of the evidence.

## Implementation issues

Ordered; each is one PR. Filed as sub-issues of the UI/UX epic
([#2186](https://github.com/s3ntin3l8/mullion-session-manager/issues/2186)).
`blocked_by` gates the order.

| #   | Issue                                                                                                                             | Blocked by   |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| 1   | [#3458](https://github.com/s3ntin3l8/mullion-session-manager/issues/3458) the bell lists only open decisions                      | none         |
| 2   | [#3459](https://github.com/s3ntin3l8/mullion-session-manager/issues/3459) Tasks section with its own needs-you count              | #3458        |
| 3   | [#3460](https://github.com/s3ntin3l8/mullion-session-manager/issues/3460) group informative events, split read from needs-you     | #3458        |
| 4   | [#3461](https://github.com/s3ntin3l8/mullion-session-manager/issues/3461) full-height phone sheet with section switch and filters | #3459, #3460 |
| 5   | [#3462](https://github.com/s3ntin3l8/mullion-session-manager/issues/3462) one full-height panel on tablet and desktop             | #3461        |
| 6   | [#3463](https://github.com/s3ntin3l8/mullion-session-manager/issues/3463) rows open their target, back returns to the panel       | #3461        |
