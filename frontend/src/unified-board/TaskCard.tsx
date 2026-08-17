import { useRef, useState } from "react";
import type { DragEvent } from "react";
import { useDashboardStore } from "../store/index.js";
import type { Theme } from "../store/index.js";
import type { GitHubCiStatus, Session, Task } from "../api/index.js";
import type { TaskBlocker } from "../api/index.js";
import { commandToBinary } from "../cliLogos.js";
import { rowClassNameForSeverity } from "../sessionStatus.js";
import { BlockedIcon, BotIcon, GitHubIcon, WarningTriangleIcon } from "../ui/icons.js";
import { formatRelativeAge } from "../relativeTime.js";
import { TASK_DRAG_MIME } from "./dragTypes.js";
import { TaskSessionSlot } from "./TaskSessionSlot.js";

// Same "success/failure/in_progress/null -> good/bad/pending/none" mapping
// as lib/sidebarStatus.ts's sessionPrDotClass/GitHubPanel.tsx's ciDotClass —
// duplicated rather than imported, this codebase's own established
// precedent for this exact small guard (see that module's own comment).
function taskCardPrDotClass(status: GitHubCiStatus): "good" | "bad" | "pending" | "none" {
  if (status === "success") return "good";
  if (status === "failure") return "bad";
  if (status === "in_progress") return "pending";
  return "none";
}

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
}: {
  task: Task;
  project: { id: number; name: string } | undefined;
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
}) {
  const [dropTarget, setDropTarget] = useState(false);
  const agentName = task.agentCommand ? commandToBinary(task.agentCommand) : null;

  // Matched client-side against the project's unfiltered PR list, same
  // posture as Sidebar.tsx's own matchedPr (its doc comment explains why:
  // avoids firing a `?branch=` request per card). Joined on task.branchName
  // — deterministic (`mullion/task-<id>`, set at claim time) — rather than
  // SessionRow's own displayBranch precedence dance, which exists only to
  // handle a worktree session's hook-reported branch lagging its actual
  // one; a task's branchName has no such ambiguity.
  const prsStatus = useDashboardStore((s) => (project ? s.prsByProject[project.id] : undefined));
  const matchedPr =
    task.branchName && prsStatus?.prs
      ? prsStatus.prs.find((pr) => pr.headBranch === task.branchName)
      : undefined;

  // Hermes review — the same click-after-drag issue TaskSessionSlot had
  // (see its own comment below): a completed reorder drop on an accepting
  // column still fires a plain click on the source card right after
  // dragend, which would pop the drawer open uninvited. Unlike the strip,
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
  // only in the drawer's own "Created ... Claimed ... Completed" footer
  // (TaskDetail.tsx). The timestamp that means "how long has this been
  // sitting here" changes with the column: claimedAt for claimed/
  // in_progress (still not started, or actively running), reviewingAt once
  // it's waiting on a look, completedAt once it's settled, createdAt
  // otherwise (backlog/ready, never yet claimed). Task's own timestamps are
  // ISO strings (api.ts) but formatRelativeAge takes epoch ms — converted
  // via Date.parse here vs. TaskDetail.tsx's own footer's `new
  // Date(x).getTime()`; same numeric result for an ISO string, just a
  // shorter spelling, not the literal same call.
  //
  // Hermes review — a Failed task also falls into that createdAt bucket,
  // but "how long has this been sitting here" is the wrong story for it: a
  // task can be claimed, run for weeks, and fail yesterday, and would still
  // read "3w ago" — time since creation, not time in Failed. There's no
  // failedAt column to read instead (schema.ts), so createdAt stays the
  // best available timestamp, but the label is honest about what it means
  // only for Failed rather than implying it's freshness of the failure.
  const statusTimestamp =
    task.status === "claimed" || task.status === "in_progress"
      ? task.claimedAt
      : task.status === "reviewing"
        ? task.reviewingAt
        : task.status === "done"
          ? task.completedAt
          : task.createdAt;
  const statusAge = statusTimestamp ? formatRelativeAge(Date.parse(statusTimestamp)) : null;
  const statusAgeLabel = statusAge && task.status === "failed" ? `created ${statusAge}` : statusAge;

  return (
    <div
      className={`task-card${severityClass ? ` ${severityClass}` : ""}${task.blockedState === "blocked" ? " task-card-is-blocked" : ""}${dropTarget ? " kanban-card-drop-target" : ""}`}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={() => setDropTarget(false)}
      onDrop={onDrop}
      onDragEnd={handleDragEnd}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      {/* D1 — the title is 2-line-clamped (styles.css), so a truncated one
          was previously unreadable even on hover: nothing carried the full
          text. */}
      <div className="task-card-title" title={task.title}>
        {task.title}
      </div>
      <div className="task-card-meta">
        {project && <span className="task-card-project">{project.name}</span>}
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
              onClick={(e) => {
                e.stopPropagation();
                if (suppressClickRef.current) e.preventDefault();
              }}
            >
              <GitHubIcon size={11} />#{task.issueNumber}
            </a>
          ) : (
            <span className="task-card-issue">
              <GitHubIcon size={11} />#{task.issueNumber}
            </span>
          ))}
        {/* #701 — sub-issue hierarchy. Ambient context, not a blocker, so
            this stays an inline meta chip rather than the promoted
            full-width treatment `blocked` gets below. Falls back to a bare
            `#N` until fillParentIssueTitles (task-watcher.ts) lazily fills
            the title — that's not free the way parent_issue_url itself is,
            so a brief `#N` is expected, not a bug. stopPropagation on click
            for the same reason the issue/PR links above do: the card root
            is itself a role="button" with its own onOpen handler, and a
            drag-then-click still lands a trailing click here. */}
        {task.parentIssueNumber !== null && (
          <a
            className="task-card-parent"
            href={`https://github.com/${task.parentIssueRepo}/issues/${task.parentIssueNumber}`}
            target="_blank"
            rel="noreferrer"
            title={task.parentIssueTitle ?? `Parent issue #${task.parentIssueNumber}`}
            onClick={(e) => {
              e.stopPropagation();
              if (suppressClickRef.current) e.preventDefault();
            }}
          >
            ↳ {task.parentIssueTitle ?? `#${task.parentIssueNumber}`}
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
            // drawer-open handler) from firing — it doesn't stop the
            // anchor's own default navigation, so the PR would still open
            // in a new tab as an unwanted side effect of the drag. Same
            // suppressClickRef guard the card's own handleClick uses above.
            onClick={(e) => {
              e.stopPropagation();
              if (suppressClickRef.current) e.preventDefault();
            }}
          >
            <span className={`github-panel-ci-dot ${taskCardPrDotClass(matchedPr.ciStatus)}`} />#
            {matchedPr.number}
          </a>
        )}
        {agentName && (
          <span className="task-card-agent" title={`Agent: ${agentName}`}>
            <BotIcon size={11} />
            {agentName}
          </span>
        )}
        {statusAgeLabel && <span className="task-card-age">{statusAgeLabel}</span>}
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
        {/* D4 — #485's own drawer-only sync-error banner (TaskDetail.tsx)
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
        {task.githubSyncError && (
          <span
            className="task-card-sync-error"
            role="img"
            title={`GitHub sync: ${task.githubSyncError}`}
            aria-label={`GitHub sync error: ${task.githubSyncError}`}
          >
            <WarningTriangleIcon size={11} aria-hidden="true" />
          </span>
        )}
      </div>
      {/* Promoted `blocked` strip — see the meta row's own comment above for
          why `unresolved` stays an inline chip and `blocked` gets this
          full-width treatment instead. Same role="img"/aria-label/
          aria-hidden pattern as every other status badge on this card. */}
      {task.blockedState === "blocked" && (
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
      {/* D5 — a Failed column of several identical-looking cards conveys
          nothing on its own; the reason is the one thing worth a glance. */}
      {task.status === "failed" && task.failureReason && (
        <div className="task-card-failure-reason" title={task.failureReason}>
          <WarningTriangleIcon size={11} />
          {task.failureReason}
        </div>
      )}
      {/* D5 — "sent back to the worker once" is the single most useful fact
          about a task sitting in Reviewing (mirrors TaskDetail.tsx's own
          round indicator in the drawer). */}
      {task.status === "reviewing" && task.reviewRounds > 0 && (
        <div className="task-card-review-round">Round {task.reviewRounds} · returned to worker</div>
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
      {task.status === "ready" && !taskMasterEnabled && (
        <div className="task-card-hint">Claiming is disabled — Task Master is off</div>
      )}
    </div>
  );
}
