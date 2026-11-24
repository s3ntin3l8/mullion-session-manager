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
  session-less channel, `/ws/tasks` (`src/services/task-events.ts`), on purpose:
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

`NotificationEvent["kind"]` (`src/shared/types.ts`) has 24 kinds. A row below is
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

| Kind                                                                           | Source                                  | Fires                                          | Decision                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------ | --------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status_change` (`reason: "exited"`) / `session_end`                           | the process ended                       | once per session                               | **Grouped**. Today the `status_change` exit is listed (`session_end` itself never rings); an exit is information. A non-zero exit is Failed where the adapter reports one: `session_end` carries `exitCode?` (`hook-protocol.ts`), so issue 1 checks adapter coverage, not payload shape. |
| `dev_server_detected`                                                          | scrollback shows a dev server listening | once per detected port (#404)                  | **Listed** while the session's `pendingDevServerPort` is this port (changed in #3458, see § As built). The first draft dropped it as "an offer", but the bell row is the only place "Use this port" exists (`docs/dock.md`); there is no session banner.                                  |
| `pr_review_submitted` `CHANGES_REQUESTED`                                      | GitHub poller (`pr-session-events.ts`)  | on a change of `reviewDecision`                | **Listed** as Review verdict                                                                                                                                                                                                                                                              |
| `pr_review_submitted` `APPROVED`                                               | same                                    | same                                           | **Listed as Review verdict only for a manual session's PR**; for a task's PR the Tasks section already carries "approved, needs your approval" (`approvalState`). Today it is not listed at all.                                                                                          |
| `pr_ci_failed`, `pr_conflicts`                                                 | same                                    | on the transition into red/conflicting         | **Listed** as Failed, one row per PR, resolved by `pr_ci_passed`. For a task-owned PR the Tasks section covers it (`ci-still-red`, `rebase-exhausted`), so the row is dropped there.                                                                                                      |
| `pr_ci_passed`, `pr_merged`, `pr_new_comments`                                 | same                                    | on transition                                  | **Dropped** (timeline only). Today also not listed.                                                                                                                                                                                                                                       |
| `message_sent`, `message_received`                                             | `sessions.message` audit (#2270)        | per message                                    | **Dropped** (audit rows)                                                                                                                                                                                                                                                                  |
| `status_change` (other), `title_change`, `file_change`, `todo`, `session_diff` | PTY and hooks                           | high frequency (every title, every file write) | **Dropped** (timeline only). Today also not listed.                                                                                                                                                                                                                                       |

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
  (permission, plan, question, elicitation, review gate, promote, stop failure, a non-zero exit,
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
kinds that are worth a glance but are not decisions (`agentIdle`, an exit with code zero or none). The
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

## As built

What the implementation does where it had to choose, recorded in the PR that
chose it.

### Classification and liveness (#3458, #3460)

- **`bellClass(event)`** (`frontend/src/eventDescriptions.ts`) implements the
  per-type table: `decision`, `failed`, `verdict`, `grouped` or `dropped`, an
  exhaustive switch over `NotificationEvent["kind"]`. The `attention` twin of
  a specific kind (permissionRequest, planReady, question, elicitation,
  reviewGate, promoteRequest, apiError) is `dropped`: every raise site in
  `hook-handlers.ts` emits the specific kind beside it, which carries the
  content.
- **Liveness keys off each kind's own latch, not `attention` alone.**
  `sessionOpenDecisions` reads `permissionState`, `planState`,
  `elicitationState`, `promoteState`, `gates` (by `gateId`), `errorState`,
  `pendingDevServerPort` and `alive`. Keying everything off `attention` would
  resurrect every answered ask the moment a later "Finished" raised attention
  again. A latch holds one request, so only the newest event of a latched
  kind is open; older ones were answered before it was raised. `question`
  uses `questionState`, which the backend already sent (`SessionInfo`) but
  the frontend type did not declare; without it (an older backend) it falls
  back to `attention && attentionKind === "question"`. Attention alone would
  not do: two specific asks keep only the newest as `attentionKind`
  (`moreAuthoritativeKind`), so a question followed by a plan would hide. An unpaired `hookNotification` is open while it is the
  confirmed `attentionKind` and no specific ask landed within 5s of it,
  answered or not (`hasRecentStructuredAsk` already drops most twins
  server-side).
- **An event counts only for the current raise of its latch.** A latch is set
  before its event is emitted (a permission settles for up to 2s first, and is
  never emitted if it is auto-approved meanwhile), so the newest
  `permission_request` can belong to an earlier, answered raise. The frontend
  now declares the raise timestamps the backend already sends
  (`permissionAt`, `planAt`, `elicitationAt`, `questionAt`, `promoteAt`), and
  an event older than its latch's raise is not listed. Only a request (not a
  resolution record reusing its kind) pairs with a generic notification.
- **The "×25" fold** stays for identical open rows, but under newest-only
  latching only review gates (each its own `gateId`) can stack; 25
  auto-approved permission asks are answered and no longer listed at all.
- **A decision can leave without an answer**, which § Where the code
  resists, 2 asked to pin: the stale-latch sweep (#320) clears a blocked latch
  older than `staleErrorSeconds` (30 minutes by default, Settings) when the
  agent has made no output since, and the row leaves with it, as the session's
  own status degrades. That is the backstop for an ask whose resolving hook
  never fires, so the bell follows it rather than keeping a row the session no
  longer shows; a test pins it.
- **`attention-tracker.ts` check** (§ Where the code resists, 2): the
  decision kinds are `OUTPUT_IMMUNE_KINDS`, so the agent's own output never
  clears them; they clear on the user's input, a `turn_start`, or the kind's
  own resolution hook. `apiError` is output-clearable, which is why
  `stop_failure` keys off `errorState` (cleared only by progress), and an
  `ackAttention` from opening the row does not close it either.
- **Dev-server offers are listed** (table above): dropping them would have
  removed the only "Use this port" surface.
- **Non-zero exit:** classified `failed` where `session_end` carries an
  `exitCode`, open while the process is down, and then not repeated as a
  grouped "exited" line. Adapter coverage: only the Claude Code forwarder
  maps `exit_code` (`mapClaudeCodeSessionEnd`), and Claude Code's
  `SessionEnd` input does not document one; codex and mcode map
  `session_end` without a code; agy registers no `SessionEnd`. So today every
  exit is grouped. The PTY's own exit status is the dtach client's, not the
  program's, so it cannot stand in.
- **PR rows:** red CI is open until a later pass, failure or merge of the
  same PR number; conflicts and a verdict until a later one of the same kind
  or a merge. The poller emits no "conflicts resolved", so Dismiss closes that
  row otherwise. A task's sessions (its worker and reviewer) list no PR rows.
- **Muted sessions** still list their decisions (they can still be answered
  from the bell) but count nowhere, as before.
- **Read:** opening the bell advances the read cursor for sessions with
  grouped rows and no open decision; the lines keep their "new" marking until
  the panel closes. "Read all" also acknowledges those sessions (clearing a
  "Finished" the sidebar shows). Decision rows have no "Mark read".
- **Focus:** the desktop panel focuses its own dialog root when it opens: its
  rows are virtualized and mount a frame later, and with no "Read all" button
  to land on, focus would otherwise stay outside, where Escape is not heard.
- Found on the way: the pane tab badge checked dismissed events with a
  two-part key (`id:seq`) while the store writes three (`id:seq:ts`, #1427),
  so dismissing a row in the bell never cleared the tab's badge. Fixed with
  #3458.

### The Tasks section (#3459)

- **Counts:** the Tasks segment is `needsYouTasks(tasks).length` over the
  store's `tasks`, the same expression `LeftRail.tsx` and `PhoneModeBar.tsx`
  use. The bell's badge is the Sessions count plus this one.
- **Rows:** one per task: its kind (`taskNeedsYouKind`: Failed for a failed
  task, merge or release; Review for an approval waiting on you; Stopped for a
  review-loop or merge hold), title, `needsYouReason` and project. No read or
  dismiss state. A tap calls `useOpenTask` and closes the panel.
- **Default section:** Sessions when it has an open decision, else Tasks when
  it has one, else Sessions. The sheet's "Needs you | All" filter and "Read
  all" belong to the Sessions section.

### The bigger view (#3461, #3462, #3463, #3466)

- **Phone:** the `BottomSheet` is full height (the backdrop's whole box, less
  the status bar). The section switch and the chips are pinned above the list;
  the back gesture closes it, as before.
- **Tablet and desktop:** one side panel, fixed from the rail's right edge to
  the window's (`--shell-top` and `--kb-inset`, so it clears the keyboard when
  the Deny field raises it). 420px with no scrim and not modal; on a touch
  tablet 480px, `aria-modal`, over a `.motion-scrim` that stops at the rail
  (so the bell stays where it was) and closes on a tap, and the back gesture
  closes it (`usePhoneBackStack`), as the sheet it replaces did. It keeps the
  `.pane-tab-overflow-menu` material shell (and so its text-token remap) and
  overrides that class's popover geometry. `notifPanelPosition.ts` is gone.
- **Chips:** single-select. Sessions: Needs you (the open decisions of the
  sessions that count, the default when there are any), All (every open
  decision, muted sessions' too, and the grouped lines), and one chip per
  `decisionCategory` with an open row: a permission is a tool permission, a
  review gate or a promote; a question is a question, an elicitation or an
  agent's generic "needs your input"; a dev-server offer only shows under
  Needs you and All. **Tasks has no "All"**: the section lists open items
  only, so "All" would be "Needs you" again; it has Needs you, Failed, Review
  and Stopped. Kind chips show only when they have a row (or are selected).
- **Return:** a row's open handler opens the target, then writes
  `bellReturn` (section and chip): after the target, because a session row
  from Tasks mode switches mode, and a mode switch clears it. The next opening
  of the bell restores it **once** (otherwise a stale chip would greet every
  later opening, against § The two sections' default-section rule). On the
  phone App.tsx registers a back entry while `bellReturn` is set; back asks
  the bell to reopen (`bellReopenSeq`). The target stays open under it, so a
  second back closes the bell and shows it. A real mode change clears the
  return, like `crossLinkReturn`. An inline gate answer stays in the panel.
- **The sticky group header (#3466):** a deliberate solid band,
  `--sticky-band` (`--chrome`), in the panel and the sheet. Blending was tried
  and measured over a white and a black page in both themes: a header with no
  surface of its own and a backdrop blur matched the panel's pixels exactly
  while its scroller was masked, but the rows showed through it; with the
  scroller unmasked the rows hid, and the header doubled the tint (dark over
  white: 18 against the panel's 49). The bell's scrollers are out of the
  scroll-edge mask: the band is their edge.

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
