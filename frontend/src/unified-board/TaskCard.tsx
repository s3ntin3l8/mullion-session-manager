import { useRef, useState } from "react";
import type { CSSProperties, DragEvent, MouseEvent } from "react";
import { useDashboardStore } from "../store/index.js";
import type { Theme } from "../store/index.js";
import type { Session, Task } from "../api/index.js";
import type { TaskBlocker } from "../api/index.js";
import { commandToBinary } from "../cliLogos.js";
import { matchSessionPr } from "../github/matchSessionPr.js";
import { sessionPrDotClass } from "../lib/sidebarStatus.js";
import { rowClassNameForSeverity } from "../sessionStatus.js";
import { BlockedIcon, BotIcon, ClockIcon, GitHubIcon, WarningTriangleIcon } from "../ui/icons.js";
import { formatRelativeAge } from "../relativeTime.js";
import {
  approvalStateText,
  isMergeNeedsHumanReason,
  needsHumanText,
  reviewPhaseText,
} from "../needsHuman.js";
import { MergeBlockedThreadsDetail } from "../MergeBlockedThreadsDetail.js";
import { describeTaskHost } from "../lib/hostBadge.js";
import { isPlainClick, openEpicInSidebar } from "../lib/sidebarLinks.js";
import { parseWorkflowChange, visibleTaskSyncError } from "../workflowChange.js";
import { awaitingMergeReason, isAwaitingMerge } from "./awaitingMerge.js";
import { TASK_DRAG_MIME } from "./dragTypes.js";
import { epicColourVar, epicUrl } from "./taskLanes.js";
import { TaskSessionSlot } from "./TaskSessionSlot.js";
import { reviewRunState } from "../taskStatusModel.js";

// #667 — the synthetic "N blocker(s) not visible to this token" entry
// (task-dependencies.ts's refreshTaskBlockers, the defensive-count-shortfall
// case) has no real issue number to show — its own title carries the
// message instead. Every other entry is a real GitHub issue, `#N`.
function blockerLabel(b: TaskBlocker): string {
  return b.htmlUrl === null ? b.title : `#${b.number}`;
}

// Split out of UnifiedBoard.tsx (Wave 5 / PR 28 of
// .claude/plans/can-we-do-a-warm-cocke.md) — a single task card in the
// board's kanban columns (TaskColumn.tsx). Owns its own drag-to-reorder
// wiring and nested worker/review session strips (TaskSessionSlot.tsx).
export function TaskCard({
  task,
  project,
  workerSession,
  reviewSession,
  theme,
  taskMasterEnabled,
  acceptsDrop,
  onOpen,
  onOpenSession,
  onReorder,
  onDragBegin,
  onDragFinish,
  selected = false,
  inStack = false,
}: {
  task: Task;
  project:
    { id: number; name: string; hostId?: string; mergeOnApprove?: boolean | null } | undefined;
  // null = task.sessionId/reviewSessionId is null (no session was ever
  // linked); undefined = a session WAS linked but is no longer in
  // store.sessions (killed/reaped) — TaskSessionSlot renders differently
  // for each, see its own doc comment.
  workerSession: Session | undefined | null;
  reviewSession: Session | undefined | null;
  theme: Theme;
  taskMasterEnabled: boolean;
  acceptsDrop: boolean;
  onOpen: () => void;
  onOpenSession: (session: Session) => void;
  onReorder: (draggedId: number) => void;
  onDragBegin: () => void;
  onDragFinish: () => void;
  // #2841 — the task the sidebar detail is showing (#2842 wires it); rings the card.
  selected?: boolean;
  // Inside an expanded blocked stack, whose summary already says what blocks it.
  inStack?: boolean;
}) {
  const [dropTarget, setDropTarget] = useState(false);
  const epicColour = epicColourVar(task);
  const hosts = useDashboardStore((s) => s.hosts);
  const hostChip = describeTaskHost(task, workerSession, project?.hostId, hosts ?? []);
  const agentName = task.agentCommand ? commandToBinary(task.agentCommand) : null;

  // Matched client-side against the project's unfiltered PR list, same
  // posture as Sidebar.tsx's own matchedPr (its doc comment explains why:
  // avoids firing a `?branch=` request per card). Joined by matchSessionPr:
  // the task's recorded PR number first (it survives the worker switching
  // branches), else task.branchName — deterministic (`mullion/task-<id>`, set
  // at claim time) — rather than SessionRow's own displayBranch precedence
  // dance.
  const prsStatus = useDashboardStore((s) => (project ? s.prsByProject[project.id] : undefined));
  const matchedPr = matchSessionPr(prsStatus?.prs, {
    branch: task.branchName,
    taskPrNumber: task.prNumber,
  });

  // Hermes review — the same click-after-drag issue TaskSessionSlot had
  // (see its own comment below): a completed reorder drop on an accepting
  // column still fires a plain click on the source card right after
  // dragend, which would open the task uninvited. Unlike the strip,
  // this card can't just drop `draggable` — the drag IS the reorder. Guard
  // the click instead: dragend fires BEFORE that trailing click, so the
  // flag has to clear on a timeout, not synchronously in onDragEnd, or it'd
  // already be false by the time the click lands.
  const suppressClickRef = useRef(false);

  const onDragStart = (e: DragEvent<HTMLDivElement>) => {
    e.dataTransfer.setData(TASK_DRAG_MIME, String(task.id));
    e.dataTransfer.effectAllowed = "move";
    suppressClickRef.current = true;
    onDragBegin();
  };

  const handleDragEnd = () => {
    onDragFinish();
    setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
  };

  const handleClick = () => {
    if (suppressClickRef.current) return;
    onOpen();
  };

  // #2918 — a plain click on a linked #issue / PR / epic opens it in the right sidebar's GitHub
  // tab; Ctrl/⌘/middle-click keep the real href (a new tab). `open` returns false when it can't
  // (an epic in a repo no project tracks), and the link then behaves as the external link it is.
  const linkClick = (open: () => boolean) => (e: MouseEvent<HTMLAnchorElement>) => {
    e.stopPropagation();
    if (suppressClickRef.current) {
      e.preventDefault();
      return;
    }
    if (isPlainClick(e) && open()) e.preventDefault();
  };
  const openIssueLink = linkClick(() => {
    if (!project || task.issueNumber === null) return false;
    useDashboardStore.getState().openRightSidebarIssue(project.id, task.issueNumber);
    return true;
  });
  const openPrLink = (n: number) =>
    linkClick(() => {
      if (!project) return false;
      useDashboardStore.getState().openRightSidebarPr(project.id, n);
      return true;
    });
  const openEpicLink = linkClick(() => openEpicInSidebar(useDashboardStore.getState().tasks, task));

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!acceptsDrop || !e.dataTransfer.types.includes(TASK_DRAG_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(true);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    setDropTarget(false);
    if (!acceptsDrop) return;
    const idStr = e.dataTransfer.getData(TASK_DRAG_MIME);
    const draggedId = Number(idStr);
    if (!idStr || !Number.isFinite(draggedId)) return;
    e.preventDefault();
    e.stopPropagation();
    if (draggedId === task.id) return;
    onReorder(draggedId);
  };

  // A blocked/failed/waiting worker should be visible at column-scan
  // distance, not just inside its own nested strip — the mitigation for
  // losing the standalone "Needs Attention" session column (see the plan's
  // feature ledger). Only the worker session drives this, not the review
  // session (advisory, secondary).
  const severityClass = workerSession
    ? rowClassNameForSeverity(workerSession.sessionStatusSeverity)
    : "";

  // D3 — time in the task's current status, at scan distance rather than
  // only in the task detail's own "Created ... Claimed ... Completed" footer
  // (TaskDetail.tsx). The timestamp that means "how long has this been
  // sitting here" changes with the column: queuedAt for claimed (task-claim
  // queueing, rate-limit-storm fix — claimed now means "waiting for a
  // slot," not "actively spawning," so its age chip should answer "how
  // long has it been queued," not read claimedAt, which is null until
  // dispatch actually starts it), claimedAt for in_progress (the current
  // worker spell), reviewingAt once it's waiting on a look, completedAt
  // once it's settled, createdAt otherwise (backlog/ready, never yet
  // claimed). Task's own timestamps are ISO strings (api.ts) but
  // formatRelativeAge takes epoch ms — converted via Date.parse here vs.
  // TaskDetail.tsx's own footer's `new Date(x).getTime()`; same numeric
  // result for an ISO string, just a shorter spelling, not the literal
  // same call.
  //
  // Hermes review — a Failed task also falls into that createdAt bucket,
  // but "how long has this been sitting here" is the wrong story for it: a
  // task can be claimed, run for weeks, and fail yesterday, and would still
  // read "3w ago" — time since creation, not time in Failed. There's no
  // failedAt column to read instead (schema.ts), so createdAt stays the
  // best available timestamp, but the label is honest about what it means
  // only for Failed rather than implying it's freshness of the failure.
  const statusTimestamp =
    task.status === "claimed"
      ? task.queuedAt
      : task.status === "in_progress"
        ? task.claimedAt
        : task.status === "reviewing"
          ? task.reviewingAt
          : task.status === "done"
            ? task.completedAt
            : task.createdAt;
  const statusAge = statusTimestamp ? formatRelativeAge(Date.parse(statusTimestamp)) : null;
  const statusAgeLabel = statusAge && task.status === "failed" ? `created ${statusAge}` : statusAge;

  // Task-claim queueing (rate-limit-storm fix) — "review in flight" vs.
  // "awaiting your approval" for a reviewing task: a review agent that's
  // still running hasn't had its findings ingested yet
  // (reviewFindingsIngestedSessionId is set only once they're read — see
  // task-reconciler.ts's processReviewingTasks); no review agent at all
  // (reviewSessionId null) is pure human review, same "waiting on you" bucket
  // as a finished one.
  //
  // An external (Hermes) review is a run, not a session: same "verdict is in"
  // pairing (reviewRunIngestedId === reviewRunId). An unsent run (dispatch
  // gave up) never ran, so it is never in flight.
  const runState = reviewRunState(task);
  const hasReviewRun = runState !== null;
  const reviewInFlight =
    task.status === "reviewing" &&
    ((task.reviewSessionId !== null &&
      task.reviewFindingsIngestedSessionId !== task.reviewSessionId) ||
      runState === "running");

  // Issue #1038 — autoReturnCapped alone answers "has the round budget been
  // spent," not "has the machine actually stopped." autoReturnRounds hits
  // the cap at the START of the last permitted round (see task-reconciler.ts's
  // autoReturnTask), while a worker session is still running and one more
  // review is still guaranteed to spawn afterward — so a capped task isn't
  // genuinely parked for a human until one of the three cap-notice comments
  // has actually landed on the PR (autoReturnCapAnnouncedAt non-null). Below
  // that point it's still working, same bucket as reviewInFlight below.
  const capAnnounced = task.autoReturnCapAnnouncedAt !== null;
  // Computed once per render: each call re-reads Date.now() for the relative time.
  const phaseText = reviewPhaseText(
    task.reviewPhase,
    task.reReviewAt,
    task.reviewFindings !== null,
  );

  // #2108 — the push is held until the operator approves a change to
  // .github/workflows/. The approval control lives in the task detail, so this
  // strip only says WHAT is needed; a click anywhere on the card (the strip
  // included) opens that task detail.
  const workflowHold = parseWorkflowChange(task.workflowChange);
  const syncError = visibleTaskSyncError(task);
  // (The strip below is role="status", not this card's usual role="img" +
  // aria-label badge: it has real visible text, and a polite live-region
  // announcement when a hold first appears is deliberate — it is the one badge
  // on this card asking for the operator's action.)

  return (
    <div
      className={`task-card${severityClass ? ` ${severityClass}` : ""}${task.blockedState === "blocked" ? " task-card-is-blocked" : ""}${dropTarget ? " kanban-card-drop-target" : ""}${selected ? " task-card-selected" : ""}`}
      style={epicColour ? ({ "--task-epic-colour": epicColour } as CSSProperties) : undefined}
      aria-current={selected ? "true" : undefined}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={() => setDropTarget(false)}
      onDrop={onDrop}
      onDragEnd={handleDragEnd}
      onClick={handleClick}
    >
      {/* The card root is a plain container (a role="button" root would nest
          the issue/PR/epic links and the session buttons inside a button,
          axe's nested-interactive). Pointer users still open the task by
          clicking anywhere on the card (handleClick); keyboard and
          assistive-technology users get this one real button. It carries no
          onClick of its own: Enter/Space on a button fires a click that
          bubbles to handleClick, so the open runs exactly once, through the
          same suppressClickRef guard as a pointer click. aria-label rather
          than text content: nothing visible to mismatch, and queries by the
          card's text keep finding the title once. */}
      <button
        type="button"
        className="visually-hidden task-card-open"
        aria-label={`Open task: ${task.title}`}
      />
      {/* D1 — the title is 2-line-clamped (styles.css), so a truncated one
          was previously unreadable even on hover: nothing carried the full
          text. */}
      <div className="task-card-title" title={task.title}>
        {task.title}
      </div>
      <div className="task-card-meta task-card-meta-links">
        {task.issueNumber !== null &&
          (task.htmlUrl ? (
            // D2 — was a <span> whose only use of htmlUrl was as a tooltip;
            // the URL is right there, so make it a real link. Mirrors the PR
            // badge below, including its suppressClickRef guard, so a drag
            // that ends on this badge doesn't also navigate.
            <a
              className="task-card-issue"
              href={task.htmlUrl}
              target="_blank"
              rel="noreferrer"
              onClick={openIssueLink}
            >
              <GitHubIcon size={11} />#{task.issueNumber}
            </a>
          ) : (
            <span className="task-card-issue">
              <GitHubIcon size={11} />#{task.issueNumber}
            </span>
          ))}
        {matchedPr && (
          <a
            className="task-card-pr"
            href={matchedPr.htmlUrl}
            target="_blank"
            rel="noreferrer"
            title={matchedPr.title}
            // Hermes review, PR #577/#580 — this badge sits inside the
            // draggable card; a drag started on it still ends with the
            // trailing post-drop click landing on this anchor.
            // stopPropagation alone only stops handleClick (the card's own
            // open-task handler) from firing — it doesn't stop the
            // anchor's own default navigation, so the PR would still open
            // in a new tab as an unwanted side effect of the drag. Same
            // suppressClickRef guard the card's own handleClick uses above.
            onClick={openPrLink(matchedPr.number)}
          >
            <span className={`github-panel-ci-dot ${sessionPrDotClass(matchedPr.ciStatus)}`} />
            PR #{matchedPr.number}
          </a>
        )}
        {!matchedPr && task.prNumber !== null && task.prUrl && (
          <a
            className="task-card-pr"
            href={task.prUrl}
            target="_blank"
            rel="noreferrer"
            onClick={openPrLink(task.prNumber)}
          >
            PR #{task.prNumber}
          </a>
        )}
        <span className="task-card-meta-spacer" />
        {agentName && (
          <span className="task-card-agent" title={`Agent: ${agentName}`}>
            <BotIcon size={11} />
            {agentName}
          </span>
        )}
        {statusAgeLabel && <span className="task-card-age">{statusAgeLabel}</span>}
      </div>
      <div className="task-card-meta task-card-meta-context">
        {project && <span className="task-card-project">{project.name}</span>}
        {hostChip && (
          <span className="task-card-host" title={hostChip.title}>
            {hostChip.label}
          </span>
        )}
        {/* #2841 — the epic is a colour edge on the card plus this tag, not a truncated
            "↳ parent title" line that repeated on every card. The tag links to the epic
            issue; the full title is its tooltip. stopPropagation + suppressClickRef for
            the same drag-then-click reason the issue and PR links use. */}
        {task.parentIssueNumber !== null && (
          <a
            className="task-card-epic"
            href={epicUrl(task) ?? undefined}
            target="_blank"
            rel="noreferrer"
            title={`Epic: ${task.parentIssueTitle ?? `#${task.parentIssueNumber}`}`}
            onClick={openEpicLink}
          >
            <span className="task-card-epic-dot" aria-hidden="true" />
            epic #{task.parentIssueNumber}
          </a>
        )}
        {/* Only meaningful when this task is ITSELF someone's parent, which
            requires the parent to also carry the task label — on the
            reference install (branchdam) none currently do, so this
            renders on zero cards there today. Documented so a future
            reader doesn't mistake that for a bug. */}
        {task.subIssueTotal !== null && task.subIssueTotal > 0 && (
          <span className="task-card-subissues" title="Sub-issues completed">
            {task.subIssueCompleted ?? 0}/{task.subIssueTotal}
          </span>
        )}
        {/* #1015 (archive) — hidden by default (UnifiedBoard.tsx's
            showArchived toggle), so this badge only ever renders once the
            user has explicitly asked to see archived tasks. */}
        {isAwaitingMerge(task) && (
          <span
            className="task-card-awaiting-merge"
            title={awaitingMergeReason(task, project?.mergeOnApprove)}
          >
            PR open — needs merge
          </span>
        )}
        {task.archivedAt !== null && (
          <span className="task-card-archived" title="Archived">
            Archived
          </span>
        )}
        {/* #667 — the `unresolved` case only: a never-yet-checked task and
            a verified-clear one shouldn't look identical while genuinely
            different, so this stays a small inline chip in the meta row,
            muted via a CSS modifier — it's a "wait and see" state, not
            actionable. `clear` renders nothing here or below: a
            zero-dependency task's card stays byte-identical to before
            #667. The `blocked` case is promoted to its own full-width
            strip below (issue: dependency badges stuck on "Checking
            dependencies…" + blocked tasks being easy to miss) — a task
            that will never move on its own until a human notices deserves
            more than a chip lost in a crowded meta row. Same
            role="img"/aria-label/aria-hidden treatment as the sync-error
            badge below, which already carries the resolution of two
            review rounds on that exact pattern. */}
        {task.blockedState === "unresolved" && (
          <span
            className="task-card-blocked task-card-blocked-unresolved"
            role="img"
            title="Checking dependencies…"
            aria-label="Dependency state not yet checked"
          >
            <BlockedIcon size={11} aria-hidden="true" />
          </span>
        )}
        {/* D4 — #485's own detail-only sync-error banner (TaskDetail.tsx)
            defeats its own stated motivation if a task can be happily
            in_progress while its GitHub sync is silently broken and nothing
            on the board says so.
            Hermes review — this was an icon-only span with no accessible
            name of its own: the title attribute is a hover-only tooltip, so
            a screen reader announced an unnamed graphic. aria-label carries
            the same text as the tooltip; the icon itself is aria-hidden so
            it isn't announced a second time as an unlabeled image.
            Independent review — role="img" is the conventional pairing for
            an aria-label on an icon-conveying-status element like this
            (vs. a plain span, which has no implicit role for
            aria-label to attach meaning to on every screen reader). */}
        {syncError && !workflowHold && (
          <span
            className="task-card-sync-error"
            role="img"
            title={`GitHub sync: ${syncError}`}
            aria-label={`GitHub sync error: ${syncError}`}
          >
            <WarningTriangleIcon size={11} aria-hidden="true" />
          </span>
        )}
        {/* Hover tooltips don't exist on touch, so the sync error above is
            otherwise unreadable there. Hidden everywhere except phone
            (mobile.css); aria-hidden because the icon's aria-label already
            carries this text. */}
        {syncError && (
          <span className="task-card-sync-error-text" aria-hidden="true">
            {syncError}
          </span>
        )}
      </div>
      {/* Promoted `blocked` strip — see the meta row's own comment above for
          why `unresolved` stays an inline chip and `blocked` gets this
          full-width treatment instead. Same role="img"/aria-label/
          aria-hidden pattern as every other status badge on this card. */}
      {task.blockedState === "blocked" && !inStack && (
        <div
          className="task-card-blocked-strip"
          role="img"
          title={`Blocked by ${task.blockers.map(blockerLabel).join(", ")}`}
          aria-label={`Blocked by ${task.blockers.map(blockerLabel).join(", ")}`}
        >
          <BlockedIcon size={11} aria-hidden="true" />
          {task.blockers.length > 0 && (
            <span>
              Blocked by {blockerLabel(task.blockers[0])}
              {task.blockers.length > 1 && ` +${task.blockers.length - 1}`}
            </span>
          )}
        </div>
      )}
      {workflowHold && (
        <div
          className="task-card-workflow-hold"
          role="status"
          title={`Changes ${workflowHold.files.join(", ")} — open the task to approve${syncError ? `; GitHub sync: ${syncError}` : ""}`}
          aria-label={`Needs workflow approval${syncError ? `; GitHub sync error: ${syncError}` : ""}`}
        >
          <WarningTriangleIcon size={11} aria-hidden="true" />
          <span>Needs workflow approval{syncError ? " · GitHub sync error" : ""}</span>
        </div>
      )}
      {/* #2234 — the last review approved and nothing else is going to move
          this task unless a human approves it. role="status", like the
          workflow-hold strip above, so its appearance is announced. */}
      {task.approvalState && (
        <div
          className={
            task.approvalState === "awaiting-human"
              ? "task-card-approval-strip"
              : "task-card-approval-strip task-card-approval-strip-auto"
          }
          role="status"
        >
          <span>{approvalStateText(task.approvalState, task.autoReturnRounds)}</span>
        </div>
      )}
      {/* D5 — a Failed column of several identical-looking cards conveys
          nothing on its own; the reason is the one thing worth a glance. */}
      {task.status === "failed" && task.failureReason && (
        <div className="task-card-failure-reason" title={task.failureReason}>
          <WarningTriangleIcon size={11} />
          {task.failureReason}
        </div>
      )}
      {/* #1997 — a QUEUED task that keeps failing to dispatch (an unreachable
          host, a worktree git cannot cut, a required host that is not
          eligible yet) is still retried, so this is a waiting notice, not the
          terminal failure above. Cleared when the task dispatches. */}
      {task.status === "claimed" && task.failureReason && (
        <div className="task-card-dispatch-reason" title={task.failureReason}>
          <ClockIcon size={11} />
          Not dispatched yet
          {task.dispatchFailingSince &&
            ` (${formatRelativeAge(Date.parse(task.dispatchFailingSince))})`}
          : {task.failureReason}
        </div>
      )}
      {/* A reviewing task with no live review session is waiting, not stuck:
          after an auto-rebase the fresh reviewer is held back for a while,
          and nothing else on the card says so. */}
      {task.status === "reviewing" && task.reviewPhase !== "no-reviewer" && phaseText && (
        <div className="task-card-review-round" role="status">
          {phaseText}
        </div>
      )}
      {/* D5 — "sent back to the worker" is the single most useful fact
          about a task sitting in Reviewing (mirrors TaskDetail.tsx's own
          round indicator in the task detail).
          Task 258971's investigation: "returned to worker" is only true
          while a round is actually still cycling — once autoReturnCapped is
          true, the task is (eventually) genuinely parked.
          Issue #1038 — three states, not two: capped-but-not-announced still
          reads as in-progress (a worker session or the confirming review may
          still be running), not "needs a human" — that wording is reserved
          for capAnnounced, the actual "the machine stopped" signal. */}
      {isMergeNeedsHumanReason(task.needsHumanReason) && task.mergedAt === null && (
        <div
          className="task-card-review-round task-card-review-round-capped"
          role="status"
          data-testid="merge-needs-human"
        >
          {`Needs a human: ${needsHumanText(task.needsHumanReason)}`}
          {task.needsHumanReason === "blocked-threads" && (
            <MergeBlockedThreadsDetail raw={task.mergeBlockedThreads} />
          )}
        </div>
      )}
      {task.status === "reviewing" && task.autoReturnRounds > 0 && !task.approvalState && (
        <div
          className={
            capAnnounced
              ? "task-card-review-round task-card-review-round-capped"
              : "task-card-review-round"
          }
        >
          {capAnnounced
            ? `Round ${task.autoReturnRounds} · ${needsHumanText(task.needsHumanReason)}, needs a human`
            : task.autoReturnCapped
              ? `Round ${task.autoReturnRounds} · review in flight`
              : `Round ${task.autoReturnRounds} · returned to worker`}
        </div>
      )}
      {(task.needsHumanReason === "review-post-failed" || task.reviewPostFailed) &&
        task.mergedAt === null && (
          <div className="task-card-review-round task-card-review-round-capped" role="status">
            {needsHumanText("review-post-failed")}, needs a human
            {task.githubSyncError ? ` — ${task.githubSyncError}` : ""}
          </div>
        )}
      {task.reviewPostPending && (
        <div className="task-card-review-round" role="status">
          Review waiting to be posted to GitHub
        </div>
      )}
      {task.sessionId !== null && (
        <TaskSessionSlot
          session={workerSession ?? undefined}
          role="worker"
          theme={theme}
          onOpenSession={onOpenSession}
        />
      )}
      {task.reviewSessionId !== null && (
        <TaskSessionSlot
          session={reviewSession ?? undefined}
          role="review"
          theme={theme}
          onOpenSession={onOpenSession}
        />
      )}
      {hasReviewRun && task.reviewSessionId === null && (
        <span
          className={`task-card-session-strip${runState === "unsent" ? " is-gone" : ""}`}
          data-testid="task-card-hermes-review"
        >
          {runState === "unsent"
            ? "Hermes review · could not be sent"
            : `Hermes review · ${runState}`}
        </span>
      )}
      {task.status === "ready" && !taskMasterEnabled && (
        <div className="task-card-hint">Claiming is disabled — Task Master is off</div>
      )}
      {/* Task-claim queueing (rate-limit-storm fix) — a queued card renders
          with no session strip above (sessionId is null until dispatch),
          which otherwise looks identical to a genuinely stuck claimed task
          whose session was reaped. This is the "waiting for a slot" tell,
          following the same hint pattern as the ready/disabled case above. */}
      {task.status === "claimed" && task.sessionId === null && (
        <div className="task-card-hint task-card-queued">Queued — waiting for a free slot</div>
      )}
      {/* Issue #1038 — once a round badge is showing above (autoReturnRounds
          > 0), it already covers "still working" (capped-but-not-announced)
          or "needs a human" (capped-and-announced); this generic hint would
          otherwise repeat the former and contradict the latter. */}
      {reviewInFlight && task.autoReturnRounds === 0 && (
        <div className="task-card-hint">Review in progress</div>
      )}
    </div>
  );
}
