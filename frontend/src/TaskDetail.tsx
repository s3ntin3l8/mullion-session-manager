import { useEffect, useState } from "react";
import { useDashboardStore } from "./store/index.js";
import { statusLabel, computeTaskReorder, orderTasksForColumn } from "./tasksBoard.js";
import { SessionTimeline } from "./SessionTimeline.js";
import { api, ApiError, normalizeAgentId } from "./api/index.js";
import type { GitHubCiStatus, Launcher, Session, Task, TaskBlocker } from "./api/index.js";
import { commandToBinary } from "./cliLogos.js";
import { useAsyncData } from "./hooks/useAsyncData.js";
import { Dropdown } from "./ui/primitives.js";
import {
  BlockedIcon,
  BotIcon,
  GitHubIcon,
  TerminalPromptIcon,
  WarningTriangleIcon,
} from "./ui/icons.js";
import { formatRelativeAge } from "./relativeTime.js";
import { EmptyStateNote } from "./ui/EmptyState.js";

const UNSET_AGENT = "";

export interface TaskDetailParams {
  taskId: number;
}

// Same "success/failure/in_progress/null -> good/bad/pending/none" mapping
// duplicated across Sidebar.tsx/GitHubPanel.tsx/Dock.tsx/UnifiedBoard.tsx —
// this codebase's own established precedent for this exact small guard.
function taskDetailPrDotClass(status: GitHubCiStatus): "good" | "bad" | "pending" | "none" {
  if (status === "success") return "good";
  if (status === "failure") return "bad";
  if (status === "in_progress") return "pending";
  return "none";
}

// #667 — same "N blocker(s) not visible to this token" special-case as
// UnifiedBoard.tsx's own blockerLabel (duplicated per this codebase's own
// precedent for this exact small guard, e.g. the two dot-class functions
// above and below).
function taskDetailBlockerLabel(b: TaskBlocker): string {
  return b.htmlUrl === null ? b.title : `#${b.number}`;
}

// Phase 6 (6.5/#218) — the task board's detail panel: metadata, issue/PR
// links, Claim/Approve/Reject/Retry/Give up (GateActions idiom,
// NotificationBell.tsx's own precedent — no optimistic local state, the
// next tasks poll reconciles), and the worker session's embedded timeline.
// Reads straight off the store (same posture as SessionTimeline itself)
// rather than fetching its own copy, so it stays live as
// refreshTasks/refreshSessions tick.
export function TaskDetail({
  params,
  onOpenSession,
}: {
  params: TaskDetailParams;
  onOpenSession: (session: Session) => void;
}) {
  const task = useDashboardStore((s) => s.tasks.find((t) => t.id === params.taskId));
  // #701 — the full list, only for deriving this task's own children below
  // (no separate API call: sub-issue membership among already-ingested
  // tasks is derivable client-side for free). Selected unconditionally,
  // same posture as prsByProject below — `task` may still be undefined
  // here, before the not-found guard.
  const allTasks = useDashboardStore((s) => s.tasks);
  const sessions = useDashboardStore((s) => s.sessions);
  const projects = useDashboardStore((s) => s.projects);
  const settings = useDashboardStore((s) => s.settings);
  const updateTask = useDashboardStore((s) => s.updateTask);
  const refreshTasks = useDashboardStore((s) => s.refreshTasks);
  // Selected unconditionally (task may still be undefined here, before the
  // not-found guard below) — same posture as UnifiedBoard.tsx's TaskCard,
  // joined on task.branchName once `task` is known to exist.
  const prsByProject = useDashboardStore((s) => s.prsByProject);

  const [agentLaunchers, setAgentLaunchers] = useState<Launcher[]>([]);
  useAsyncData(
    () => (task ? api.listProjectActions(task.projectId) : Promise.resolve([])),
    (launchers) => setAgentLaunchers(launchers.filter((l) => l.kind === "agent")),
    () => {},
    [task?.projectId],
    { enabled: task !== undefined },
  );

  // A workspace layout can restore this panel (by taskId), or the unified
  // board's drawer can open it, before the store's own task list has loaded
  // — same "poll the full list, don't fetch a single row" convention
  // UnifiedBoard.tsx's own mount effect follows, rather than a separate
  // single-task fetch that'd duplicate Task's shape in local component
  // state.
  useEffect(() => {
    void refreshTasks();
  }, [refreshTasks]);

  if (!task) {
    return <EmptyStateNote>Task not found.</EmptyStateNote>;
  }

  const agentOptions = Array.from(
    new Map(agentLaunchers.map((l) => [normalizeAgentId(l.id), l.title])).entries(),
  ).map(([value, label]) => ({ value, label }));

  function optionsWithCurrentValue(
    options: { value: string; label: string }[],
    current: string,
  ): { value: string; label: string }[] {
    if (current === UNSET_AGENT || options.some((o) => o.value === current)) return options;
    return [...options, { value: current, label: `${current} (not detected)` }];
  }

  const project = projects?.find((p) => p.id === task.projectId);
  const projectDefaultAgent =
    project?.defaultAgent || settings?.launchers?.defaultAgent || "claude";
  const projectDefaultReviewAgent = project?.defaultReviewAgent || "None";
  const isEditableStatus =
    task.status === "backlog" ||
    (task.status === "ready" && task.agentCommand === null) ||
    task.status === "failed";

  const workerSession =
    task.sessionId !== null ? sessions.find((s) => s.id === task.sessionId) : undefined;
  const agentName = task.agentCommand ? commandToBinary(task.agentCommand) : null;
  const prsStatus = prsByProject[task.projectId];
  const matchedPr =
    task.branchName && prsStatus?.prs
      ? prsStatus.prs.find((pr) => pr.headBranch === task.branchName)
      : undefined;
  // #701 — sibling tasks that are themselves Task Master tasks (i.e. also
  // carry the task label) and list this task as their parent. Hermes
  // review — issue numbers are per-repo, and cross-repo parents are
  // first-class in this feature, so matching on `parentIssueNumber` alone
  // (even scoped to this project) isn't sufficient: another task in the
  // SAME project could point to `other/repo#30` as its parent while this
  // task merely happens to BE this project's own `#30` — a same-number,
  // different-repo coincidence, not an actual parent/child relationship.
  // `t.parentIssueRepo` is compared against this task's own repo slug,
  // parsed from `task.htmlUrl` (a task has no dedicated repo field of its
  // own). Guarded on issueNumber !== null and a parsed repo slug existing:
  // a local task's issueNumber is null, and `t.parentIssueNumber === null`
  // would otherwise match every OTHER parentless local task as a false
  // "child".
  const thisTaskRepoSlug = task.htmlUrl?.match(
    /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/\d+$/,
  )?.[1];
  const childTasks =
    task.issueNumber !== null && thisTaskRepoSlug !== undefined
      ? allTasks.filter(
          (t) =>
            t.projectId === task.projectId &&
            t.parentIssueNumber === task.issueNumber &&
            t.parentIssueRepo === thisTaskRepoSlug,
        )
      : [];

  return (
    <div className="task-detail cmux-scroll">
      <div className="task-detail-header">
        <span className="task-detail-title">{task.title}</span>
        <span className={`task-status-badge task-status-${task.status}`}>
          {statusLabel(task.status)}
        </span>
      </div>

      {/* One row for every action this task can take right now, directly
          under the title — not after the description, where a long body
          used to push Move/Claim/Approve/etc. below the fold. No chrome of
          its own (no padding/border/min-height): TaskActions returns null
          for claimed/in_progress/done and DeleteTaskAction renders nothing
          outside its own gated condition, so when both are absent this row
          has zero children and collapses to nothing rather than painting an
          empty bar. Delete is visually separated (margin-left: auto on its
          own .task-detail-actions) so it isn't a mis-click neighbour of
          Move to Ready/Claim. */}
      <div className="task-detail-actions-row">
        <TaskActions task={task} />
        {/* Independent review, PR #477 — mirrors routes/tasks.ts's own
            DELETE restriction exactly (no linked GitHub issue, status still
            backlog/ready): a locally-created task that turns out to be a
            mistake previously had no way to be removed anywhere in the UI
            at all. Local-board CRUD, so unlike Claim/Approve/Reject this
            isn't gated on taskMasterEnabled.
            #729 — a `failed` GitHub-linked task is rendered too: shown
            alongside Retry rather than replacing it, the same "render both,
            let the server's own guard decide" posture TaskActions already
            uses for Retry itself (a `failed` task with no preserved branch
            still shows the button and surfaces the 400 as an inline error
            rather than hiding it). The server only actually allows the
            delete once the linked issue is confirmed no longer trackable
            (see routes/tasks.ts's DELETE handler); otherwise this button's
            confirm step surfaces that as the same inline error, pointing
            back at Retry. */}
        {((task.issueNumber === null && (task.status === "backlog" || task.status === "ready")) ||
          (task.issueNumber !== null && task.status === "failed")) && (
          <DeleteTaskAction taskId={task.id} />
        )}
      </div>

      <div className="task-detail-meta">
        <span className="task-detail-meta-row">{task.projectName}</span>
        {task.issueNumber !== null && task.htmlUrl && (
          <a
            className="task-detail-meta-row task-detail-link"
            href={task.htmlUrl}
            target="_blank"
            rel="noreferrer"
          >
            <GitHubIcon size={12} /> Issue #{task.issueNumber}
          </a>
        )}
        {task.prUrl && (
          <a
            className="task-detail-meta-row task-detail-link"
            // Hermes review, PR #577/#582 — the CI dot below reflects
            // matchedPr (branch-matched, so it's the CURRENT PR on
            // task.branchName), but this href previously stayed on
            // task.prUrl regardless. If that branch's PR was closed and a
            // new one opened on the same branch, the dot would describe the
            // new PR while the link opened the old, closed one.
            href={matchedPr?.htmlUrl ?? task.prUrl}
            target="_blank"
            rel="noreferrer"
          >
            <GitHubIcon size={12} /> Pull request
            {matchedPr && (
              <span className={`github-panel-ci-dot ${taskDetailPrDotClass(matchedPr.ciStatus)}`} />
            )}
          </a>
        )}
        {isEditableStatus ? (
          <div className="task-detail-agents-config">
            <div className="task-detail-agent-select">
              <span className="task-detail-agent-label">
                <BotIcon size={12} /> Agent:
              </span>
              <Dropdown
                value={task.agent ?? UNSET_AGENT}
                onChange={async (val) => {
                  await updateTask(task.id, { agent: val === UNSET_AGENT ? null : val });
                }}
                options={optionsWithCurrentValue(
                  [
                    {
                      value: UNSET_AGENT,
                      label: `Project default (${projectDefaultAgent})`,
                    },
                    ...agentOptions,
                  ],
                  task.agent ?? UNSET_AGENT,
                )}
              />
            </div>
            <div className="task-detail-agent-select">
              <span className="task-detail-agent-label">
                <BotIcon size={12} /> Review agent:
              </span>
              <Dropdown
                value={task.reviewAgent ?? UNSET_AGENT}
                onChange={async (val) => {
                  await updateTask(task.id, { reviewAgent: val === UNSET_AGENT ? null : val });
                }}
                options={optionsWithCurrentValue(
                  [
                    {
                      value: UNSET_AGENT,
                      label: `Project default (${projectDefaultReviewAgent})`,
                    },
                    { value: "none", label: "None (disabled)" },
                    ...agentOptions,
                  ],
                  task.reviewAgent ?? UNSET_AGENT,
                )}
              />
            </div>
          </div>
        ) : (
          <>
            {agentName ? (
              <span className="task-detail-meta-row">
                <BotIcon size={12} /> Agent: {agentName}
              </span>
            ) : task.agent ? (
              <span className="task-detail-meta-row">
                <BotIcon size={12} /> Agent: {task.agent}
              </span>
            ) : null}
            {task.reviewAgent && task.reviewAgent !== "none" && (
              <span className="task-detail-meta-row">
                <BotIcon size={12} /> Review agent: {task.reviewAgent}
              </span>
            )}
          </>
        )}
        {task.assignee && <span className="task-detail-meta-row">Assignee: {task.assignee}</span>}
        {workerSession && (
          <button
            className="task-detail-meta-row task-detail-link task-detail-open-session"
            onClick={() => onOpenSession(workerSession)}
          >
            <TerminalPromptIcon size={12} /> Open session
          </button>
        )}
      </div>

      {task.body && <div className="task-detail-body">{task.body}</div>}

      {task.status === "failed" && task.failureReason && (
        <div className="task-detail-failure">
          <WarningTriangleIcon size={12} />
          {task.failureReason}
        </div>
      )}

      {/* #485 — independent of status: a task can be happily in_progress
          while its GitHub sync is silently broken (e.g. an under-scoped
          token). Previously invisible outside a server-log grep; this is
          durable across remounts, unlike TaskActions' own transient
          setError. */}
      {task.githubSyncError && (
        <div className="task-detail-sync-error">
          <GitHubIcon size={12} />
          GitHub sync: {task.githubSyncError}
        </div>
      )}

      {/* #667 — this is where "why isn't this moving?" actually gets
          answered; the board card (UnifiedBoard.tsx's TaskCard) only ever
          shows the count. */}
      {task.blockedState !== "clear" && (
        <div className="task-detail-blocked">
          <BlockedIcon size={12} />
          {task.blockedState === "unresolved" ? (
            "Checking dependencies…"
          ) : (
            <span>
              Blocked by{" "}
              {task.blockers.map((b, i) => (
                <span key={`${b.owner}/${b.repo}#${b.number}`}>
                  {i > 0 && ", "}
                  {b.htmlUrl ? (
                    <a
                      href={b.htmlUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="task-detail-link"
                    >
                      {taskDetailBlockerLabel(b)}
                    </a>
                  ) : (
                    taskDetailBlockerLabel(b)
                  )}
                </span>
              ))}
            </span>
          )}
        </div>
      )}

      {/* #701 — sub-issue hierarchy. Up: the parent this task belongs to,
          if any. Down: sub-issue progress plus whichever children are
          themselves known Task Master tasks — a child issue without the
          task label still counts toward subIssueTotal (GitHub's own
          count) but isn't individually listed here, since nothing on this
          side of the API knows it exists. Renders nothing at all when
          neither applies, same "no state, no chrome" posture as the
          blocked block above. */}
      {(task.parentIssueNumber !== null ||
        (task.subIssueTotal !== null && task.subIssueTotal > 0)) && (
        <div className="task-detail-section">
          <div className="task-detail-section-title">Hierarchy</div>
          {task.parentIssueNumber !== null && (
            <a
              className="task-detail-meta-row task-detail-link"
              href={`https://github.com/${task.parentIssueRepo}/issues/${task.parentIssueNumber}`}
              target="_blank"
              rel="noreferrer"
            >
              <GitHubIcon size={12} /> Parent:{" "}
              {task.parentIssueTitle ?? `#${task.parentIssueNumber}`}
            </a>
          )}
          {task.subIssueTotal !== null && task.subIssueTotal > 0 && (
            <div className="task-detail-meta-row">
              {task.subIssueCompleted ?? 0} of {task.subIssueTotal} sub-issues complete
            </div>
          )}
          {childTasks.length > 0 && (
            <ul className="task-detail-children">
              {childTasks.map((c) => (
                <li key={c.id}>
                  {c.htmlUrl ? (
                    <a
                      className="task-detail-link"
                      href={c.htmlUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      #{c.issueNumber} {c.title}
                    </a>
                  ) : (
                    <span>{c.title}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="task-detail-section">
        <div className="task-detail-section-title">Timeline</div>
        {task.seedDelivered === false && (
          <div className="task-detail-noseed">
            <WarningTriangleIcon size={12} />
            This agent started with no initial instructions.
          </div>
        )}
        <SessionTimeline params={{ sessionIds: task.sessionId !== null ? [task.sessionId] : [] }} />
      </div>

      {task.reviewSessionId !== null && (
        <div className="task-detail-section task-detail-review-section">
          <div className="task-detail-section-title">Review</div>
          <div className="task-detail-review-hint">
            {task.reviewRounds > 0
              ? "Its findings were sent back to the worker once, automatically — this is that round's outcome. It still cannot approve, reject, or otherwise transition this task; that's still your call above."
              : "It cannot approve, reject, or otherwise transition this task — that's still your call above. Non-empty findings may be sent back to the worker automatically, once, before this task is ready for another look."}
          </div>
          {task.reviewRounds > 0 && (
            <div className="task-detail-review-round">
              Round {task.reviewRounds} sent back to the worker automatically
            </div>
          )}
          {task.reviewSeedDelivered === false && (
            <div className="task-detail-review-noseed">
              <WarningTriangleIcon size={12} />
              This agent started with no initial instructions.
            </div>
          )}
          {task.reviewFindings && (
            <div className="task-detail-review-findings">{task.reviewFindings}</div>
          )}
          <SessionTimeline params={{ sessionIds: [task.reviewSessionId] }} />
        </div>
      )}

      <div className="task-detail-footer">
        Created {formatRelativeAge(new Date(task.createdAt).getTime())}
        {/* Task-claim queueing (rate-limit-storm fix) — queuedAt (joined
            the queue) and claimedAt (current worker spell started) can now
            both be present and meaningfully different; show both when they
            are. */}
        {task.queuedAt && <> · Queued {formatRelativeAge(new Date(task.queuedAt).getTime())}</>}
        {task.claimedAt && <> · Claimed {formatRelativeAge(new Date(task.claimedAt).getTime())}</>}
        {task.completedAt && (
          <> · Completed {formatRelativeAge(new Date(task.completedAt).getTime())}</>
        )}
      </div>
    </div>
  );
}

// Independent review, PR #477 — a "click again to confirm" step, same
// GateActions/notif-gate-* idiom as TaskActions below (not ConfirmButton.tsx,
// which is styled for its own specific parent contexts, e.g.
// .ws-group-actions .danger — dropping it in bare here would render
// unstyled). No explicit "close this panel" on success: once the store's
// task list no longer contains this id, TaskDetail's own `if (!task)` guard
// above already renders "Task not found." — the same no-optimistic-state,
// let-the-poll-reconcile posture the rest of this file follows.
function DeleteTaskAction({ taskId }: { taskId: number }) {
  const deleteTask = useDashboardStore((s) => s.deleteTask);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!confirming) {
    return (
      <div className="task-detail-actions task-detail-actions-delete">
        <button className="notif-gate-btn notif-gate-deny" onClick={() => setConfirming(true)}>
          Delete task
        </button>
      </div>
    );
  }

  return (
    <div className="task-detail-actions task-detail-actions-delete">
      <span className="task-detail-hint">Delete this task? This can't be undone.</span>
      <button
        className="notif-gate-btn notif-gate-deny-confirm"
        disabled={submitting}
        onClick={async () => {
          setSubmitting(true);
          setError(null);
          try {
            await deleteTask(taskId);
          } catch (err) {
            setError(err instanceof ApiError ? err.message : "Failed to delete task");
            setSubmitting(false);
          }
        }}
      >
        Confirm delete
      </button>
      <button className="notif-gate-btn" disabled={submitting} onClick={() => setConfirming(false)}>
        Cancel
      </button>
      {error && <span className="task-detail-error">{error}</span>}
    </div>
  );
}

// GateActions' own pattern (NotificationBell.tsx) — no optimistic state; the
// button just fires the request and the next tasks poll reflects whatever
// actually happened. Claim/Approve/Retry are disabled with a hint when
// taskMasterEnabled is off (the roadmap's Flag semantics decision: these
// spawn/promote autonomous agents, unlike the local board's own CRUD).
// Reject and Give up are deliberately NOT gated here (Hermes review, PR
// #480, fourth pass; extended to give-up by #483), mirroring the server
// routes: they're the only ways to resolve a task that's already in
// "reviewing" when the toggle flips off — disabling them client-side would
// hide the escape hatches the server still allows.
//
// Claim/Retry deliberately do NOT open the new session's panel — an
// autonomous auto-claim never opens one either (task-reconciler.ts has no
// UI to open a panel from), so a manual claim/retry now matches that
// behavior instead of being the one path that pops a terminal. The task
// card already shows the new session's live status, and "Open session" in
// TaskDetail's own meta row above opens it on demand.
function TaskActions({ task }: { task: Task }) {
  const {
    taskMasterEnabled,
    claimTask,
    approveTask,
    rejectTask,
    retryTask,
    giveUpTask,
    updateTask,
    refreshTasks,
    tasks,
  } = useDashboardStore();
  const [submitting, setSubmitting] = useState(false);
  // Which free-text-reason-then-confirm flow is open, if any — reject and
  // give-up share the same input/confirm/cancel shape, so one bit of state
  // (not two independent booleans) tracks which action a confirm click
  // resolves to.
  const [pendingAction, setPendingAction] = useState<"reject" | "give-up" | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const disabledHint = !taskMasterEnabled
    ? "Task Master is disabled — enable it to use this action."
    : null;

  // Backlog<->Ready is the board's only user-driven, non-terminal drag
  // (UnifiedBoard.tsx's DRAG_EDITABLE_STATUSES) — and drag is the ONLY way
  // to reach it, which HTML5 drag-and-drop never fires on a touch device.
  // Not gated on taskMasterEnabled — it's local board CRUD, same posture as
  // DeleteTaskAction above, not one of the spawn/promote-an-agent actions
  // that flag actually guards.
  //
  // Hermes review — an earlier version sent a bare `{ status }` patch and
  // claimed (wrongly) that this "always appends". PATCH /api/tasks/:id
  // (routes/tasks.ts) only writes the fields given and never reindexes, so
  // a status-only patch would have kept the task's PREVIOUS boardOrder and
  // left it wherever orderTasksForColumn's (boardOrder, id) sort happened
  // to place it in the new column — often not the end, and inconsistent
  // with the drag path. Reusing computeTaskReorder with a target index of
  // "one past the target column's last task" is the same REORDER MATH
  // UnifiedBoard.tsx's own applyDrop uses for a drop.
  //
  // Independent review — that parity claim didn't extend to failure
  // handling, which is NOT identical: applyDrop fires its updates
  // concurrently, each with its own resync-on-failure (a failed PATCH
  // there still calls refreshTasks(), so the store recovers whatever the
  // server actually persisted). This loop awaits sequentially inside one
  // try/catch instead — appropriate here, since a click-triggered action
  // wants one definitive success/failure outcome rather than N
  // independently-racing writes — but that also means a failure partway
  // through a multi-update reindex (rare: only when the target column
  // already has tasks needing their own boardOrder shifted) left earlier,
  // already-successful writes unreflected in the store until the next
  // regular poll. refreshTasks() in the catch closes that gap the same way
  // applyDrop's own per-update .catch does.
  const moveStatus = async (status: "backlog" | "ready") => {
    setSubmitting(true);
    setError(null);
    try {
      const targetIndex = orderTasksForColumn(tasks, status).length;
      const updates = computeTaskReorder(tasks, task.id, status, targetIndex);
      for (const update of updates) {
        const patch: { status?: "backlog" | "ready"; boardOrder: number } = {
          boardOrder: update.boardOrder,
        };
        if (update.id === task.id && update.status !== task.status) {
          patch.status = update.status as "backlog" | "ready";
        }
        await updateTask(update.id, patch);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to move task");
      void refreshTasks();
    } finally {
      setSubmitting(false);
    }
  };

  if (task.status === "backlog") {
    return (
      <div className="task-detail-actions">
        <button
          className="notif-gate-btn"
          disabled={submitting}
          onClick={() => void moveStatus("ready")}
        >
          Move to Ready
        </button>
        {error && <span className="task-detail-error">{error}</span>}
      </div>
    );
  }

  if (task.status === "ready") {
    return (
      <div className="task-detail-actions">
        <button
          className="notif-gate-btn notif-gate-approve"
          disabled={submitting || !taskMasterEnabled}
          onClick={async () => {
            setSubmitting(true);
            setError(null);
            try {
              await claimTask(task.id);
            } catch (err) {
              setError(err instanceof ApiError ? err.message : "Failed to claim task");
            } finally {
              setSubmitting(false);
            }
          }}
        >
          Claim
        </button>
        <button
          className="notif-gate-btn"
          disabled={submitting}
          onClick={() => void moveStatus("backlog")}
        >
          Move to Backlog
        </button>
        {disabledHint && <span className="task-detail-hint">{disabledHint}</span>}
        {error && <span className="task-detail-error">{error}</span>}
      </div>
    );
  }

  // #483 — resumes on the preserved mullion/task-<id> branch rather than
  // starting over. Gated like Claim, since it also spawns a session.
  if (task.status === "failed") {
    return (
      <div className="task-detail-actions">
        <button
          className="notif-gate-btn notif-gate-approve"
          disabled={submitting || !taskMasterEnabled}
          onClick={async () => {
            setSubmitting(true);
            setError(null);
            try {
              await retryTask(task.id);
            } catch (err) {
              setError(err instanceof ApiError ? err.message : "Failed to retry task");
            } finally {
              setSubmitting(false);
            }
          }}
        >
          Retry
        </button>
        {disabledHint && <span className="task-detail-hint">{disabledHint}</span>}
        {error && <span className="task-detail-error">{error}</span>}
      </div>
    );
  }

  if (task.status !== "reviewing") return null;

  if (pendingAction !== null) {
    const isGiveUp = pendingAction === "give-up";
    return (
      <div className="task-detail-actions">
        <input
          className="notif-gate-deny-reason"
          placeholder={isGiveUp ? "Reason (optional)" : "Feedback (optional)"}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          autoFocus
        />
        <button
          className="notif-gate-btn notif-gate-deny-confirm"
          disabled={submitting}
          onClick={async () => {
            setSubmitting(true);
            setError(null);
            try {
              if (isGiveUp) {
                await giveUpTask(task.id, reason.trim() || undefined);
              } else {
                await rejectTask(task.id, reason.trim() || undefined);
              }
              setPendingAction(null);
            } catch (err) {
              setError(
                err instanceof ApiError
                  ? err.message
                  : `Failed to ${isGiveUp ? "give up on" : "reject"} task`,
              );
            } finally {
              setSubmitting(false);
            }
          }}
        >
          {isGiveUp ? "Give up" : "Reject"}
        </button>
        <button
          className="notif-gate-btn"
          disabled={submitting}
          onClick={() => setPendingAction(null)}
        >
          Cancel
        </button>
        {error && <span className="task-detail-error">{error}</span>}
      </div>
    );
  }

  return (
    <div className="task-detail-actions">
      <button
        className="notif-gate-btn notif-gate-approve"
        disabled={submitting || !taskMasterEnabled}
        onClick={async () => {
          setSubmitting(true);
          setError(null);
          try {
            await approveTask(task.id);
          } catch (err) {
            setError(err instanceof ApiError ? err.message : "Failed to approve task");
          } finally {
            setSubmitting(false);
          }
        }}
      >
        Approve
      </button>
      <button
        className="notif-gate-btn notif-gate-deny"
        disabled={submitting}
        onClick={() => setPendingAction("reject")}
      >
        Reject
      </button>
      <button
        className="notif-gate-btn notif-gate-deny"
        disabled={submitting}
        onClick={() => setPendingAction("give-up")}
      >
        Give up
      </button>
      {disabledHint && (
        <span className="task-detail-hint">
          {disabledHint} Reject/Give up still work — they're the escape hatches out of review while
          disabled.
        </span>
      )}
      {error && <span className="task-detail-error">{error}</span>}
    </div>
  );
}
