import { TaskActions } from "./TaskActions.js";
import { FailureDiagnostics } from "./FailureDiagnostics.js";
import { useEffect, useState } from "react";
import { useDashboardStore } from "./store/index.js";
import { statusLabel } from "./tasksBoard.js";
import { SessionTimeline } from "./SessionTimeline.js";
import { api, ApiError, normalizeAgentId } from "./api/index.js";
import type { Launcher, Session, Task, TaskBlocker } from "./api/index.js";
import { commandToBinary } from "./cliLogos.js";
import { useAsyncData } from "./hooks/useAsyncData.js";
import { Dropdown } from "./ui/primitives.js";
import {
  BlockedIcon,
  BotIcon,
  ClockIcon,
  GitHubIcon,
  GitBranchIcon,
  TerminalPromptIcon,
  WarningTriangleIcon,
} from "./ui/icons.js";
import { formatRelativeAge } from "./relativeTime.js";
import { EmptyStateNote } from "./ui/EmptyState.js";
import { matchSessionPr } from "./github/matchSessionPr.js";
import { sessionPrDotClass } from "./lib/sidebarStatus.js";
import { useStartSessionFrom } from "./hooks/useStartSessionFrom.js";
import { sessionBranch } from "./hooks/useMullionLinks.js";
import type { MullionLinkEntry } from "./hooks/useMullionLinks.js";
import { decideSessionAction } from "./ui/sidebar/linkDecisions.js";
import { Markdown } from "./ui/Markdown.js";
import { STATUS_PRESENTATION, formatStatusLabel } from "./sessionStatus.js";
import { approvalStateText, needsHumanText, reviewPhaseText } from "./needsHuman.js";
import { describeTaskHost } from "./lib/hostBadge.js";
import {
  HERMES_REVIEW_OPTION,
  hermesReviewerAvailable,
  withCurrentReviewAgent,
} from "./settings/agentOptions.js";
import { parseReviewRounds } from "./lib/reviewRounds.js";
import { parseWorkflowChange, visibleTaskSyncError } from "./workflowChange.js";

const UNSET_AGENT = "";

export interface TaskDetailParams {
  taskId: number;
}

// #667 — same "N blocker(s) not visible to this token" special-case as
// UnifiedBoard.tsx's own blockerLabel (duplicated per this codebase's own
// precedent for this exact small guard, e.g. the two dot-class functions
// above and below).
function taskDetailBlockerLabel(b: TaskBlocker): string {
  return b.htmlUrl === null ? b.title : `#${b.number}`;
}

// Hermes review, PR #1195 — one banner shape, rendered for both the worker
// and review session so neither role is invisible here (see the call sites'
// own comment for the gap this closes). `session` is `undefined` for "no
// session linked" and for "linked id no longer resolves" alike — both
// render nothing, same as the "Open session" button above does.
function SessionAttentionBanner({
  role,
  session,
  onOpenSession,
  rebasing = false,
}: {
  role: "Worker" | "Review";
  session: Session | undefined;
  onOpenSession: (session: Session) => void;
  // The worker is an auto-rebase worker: its "Finished" is the expected end
  // of its job, and the task's own review-phase line explains what's next.
  rebasing?: boolean;
}) {
  if (!session || !session.sessionStatusAttentionRequired) return null;
  if (rebasing && session.sessionStatus === "finished") return null;
  return (
    <div className="task-detail-session-attention">
      <TerminalPromptIcon size={12} />
      {role} session needs attention:{" "}
      {formatStatusLabel(STATUS_PRESENTATION[session.sessionStatus], session.sessionStatusDetail)}
      {" — "}
      <button className="task-detail-link" onClick={() => onOpenSession(session)}>
        open it
      </button>
    </div>
  );
}

// The sidebar PR view's "Hand off", offered from the drawer: a plain ad-hoc
// session on the PR's branch, seeded with what is wrong with the PR. It is
// not the task's worker session, so it never touches the task's status,
// autoReturnRounds or worker/reviewer slots. `prNumber` is the open PR (the
// caller only renders this for one); an existing session on the branch is
// reused via the same decideSessionAction rule PrDetailView uses, ignoring
// the task's own worker/review sessions.
function FixInSessionAction({
  task,
  prNumber,
  branch,
}: {
  task: Task;
  prNumber: number;
  branch: string | null;
}) {
  const sessions = useDashboardStore((s) => s.sessions);
  const requestOpenSession = useDashboardStore((s) => s.requestOpenSession);
  const startSessionFrom = useStartSessionFrom(task.projectId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const entry = {
    sessions: sessions
      .filter(
        (s) =>
          s.projectId === task.projectId &&
          s.kind === "terminal" &&
          s.status !== "killed" &&
          s.id !== task.sessionId &&
          s.id !== task.reviewSessionId &&
          branch !== null &&
          sessionBranch(s) === branch,
      )
      .map((session) => ({
        session,
        severity: session.sessionStatusSeverity,
        attention: session.sessionStatusAttentionRequired,
        children: [],
      })),
  } as unknown as MullionLinkEntry;
  const action = decideSessionAction(entry);

  const onClick = async () => {
    if (action.kind === "open-existing") {
      requestOpenSession(action.sessionId);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { prompt, branch: prBranch } = await api.getProjectPrHandoff(task.projectId, prNumber);
      await startSessionFrom({ worktree: { branch: prBranch }, seedPrompt: prompt });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start a fix session");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="task-detail-fix-session">
      <button
        className="task-detail-meta-row task-detail-link"
        disabled={busy}
        title={busy ? "Preparing the fix session…" : undefined}
        onClick={() => void onClick()}
      >
        <GitBranchIcon size={12} />{" "}
        {action.kind === "open-existing" ? "Open existing session" : "Fix in a session"}
      </button>
      <span className="task-detail-hint">
        Starts an ordinary session on the PR branch — it does not change this task.
      </span>
      {error && <span className="task-detail-error">{error}</span>}
    </div>
  );
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
  onDeleted,
}: {
  params: TaskDetailParams;
  onOpenSession: (session: Session) => void;
  // Called once after this panel's own task is deleted, so the host can close
  // it. Without it "Task not found." renders until the host closes the panel.
  onDeleted?: () => void;
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
  const hosts = useDashboardStore((s) => s.hosts);
  const settings = useDashboardStore((s) => s.settings);
  const updateTask = useDashboardStore((s) => s.updateTask);
  const refreshTasks = useDashboardStore((s) => s.refreshTasks);
  // Selected unconditionally (task may still be undefined here, before the
  // not-found guard below) — same posture as UnifiedBoard.tsx's TaskCard,
  // joined on task.branchName once `task` is known to exist.
  const prsByProject = useDashboardStore((s) => s.prsByProject);
  const openRightSidebarPr = useDashboardStore((s) => s.openRightSidebarPr);

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

  // #2236 — from data already on the task/session/project, no placement call.
  const hostChip = describeTaskHost(
    task,
    task.sessionId !== null ? sessions.find((x) => x.id === task.sessionId) : null,
    projects?.find((p) => p.id === task.projectId)?.hostId,
    hosts ?? [],
  );
  const reviewRounds = parseReviewRounds(task.reviewFindings);
  // Computed once per render: each call re-reads Date.now() for the relative time.
  const phaseText = reviewPhaseText(
    task.reviewPhase,
    task.reReviewAt,
    task.reviewFindings !== null,
  );

  const agentOptions = Array.from(
    new Map(agentLaunchers.map((l) => [normalizeAgentId(l.id), l.title])).entries(),
  ).map(([value, label]) => ({ value, label }));

  function optionsWithCurrentValue(
    options: { value: string; label: string }[],
    current: string,
  ): { value: string; label: string }[] {
    if (current === UNSET_AGENT || options.some((o) => o.value === current)) return options;
    return withCurrentReviewAgent(options, current);
  }
  const hermesAvailable = hermesReviewerAvailable(settings?.reviewRelay);

  const project = projects?.find((p) => p.id === task.projectId);
  const projectDefaultAgent =
    project?.defaultAgent || settings?.taskMaster?.defaultAgent || "claude";
  const projectDefaultReviewAgent =
    project?.defaultReviewAgent || settings?.taskMaster?.defaultReviewAgent || "none";
  // Hermes review — the resolved value is lowercase "none"; capitalize it in
  // the dropdown label so it reads as "no review agent", not as an agent name.
  const projectDefaultReviewAgentLabel =
    projectDefaultReviewAgent === "none" ? "None" : projectDefaultReviewAgent;
  const isEditableStatus =
    task.status === "backlog" ||
    (task.status === "ready" && task.agentCommand === null) ||
    task.status === "failed";

  const workerSession =
    task.sessionId !== null ? sessions.find((s) => s.id === task.sessionId) : undefined;
  // Hermes review, PR #1195 — the board's TaskSessionSlot renders this same
  // status chip for BOTH roles; a review session (spawned into the same
  // worktree the worker used, task-reconciler.ts's spawnReviewAgentNow) can
  // sit attention-required just the same and was invisible here otherwise.
  const reviewSession =
    task.reviewSessionId !== null ? sessions.find((s) => s.id === task.reviewSessionId) : undefined;
  // Issue #1038 — see TaskCard.tsx's own comment on the same distinction:
  // autoReturnCapped flips true at the START of the last permitted round,
  // while the worker (and then the confirming review) may still be running.
  // Not genuinely "needs a human" until one of the three cap-notice
  // comments has actually landed on the PR.
  const capAnnounced = task.autoReturnCapAnnouncedAt !== null;
  const agentName = task.agentCommand ? commandToBinary(task.agentCommand) : null;
  const prsStatus = prsByProject[task.projectId];
  // Branch only (no taskPrNumber): the card below deliberately prefers the
  // branch-matched PR as the CURRENT one over task.prNumber.
  const matchedPr = matchSessionPr(prsStatus?.prs, { branch: task.branchName });
  // prsByProject only lists OPEN PRs, so a match is what "the PR is open" means.
  const matchedOpenPr = matchSessionPr(prsStatus?.prs, {
    branch: task.branchName,
    taskPrNumber: task.prNumber,
  });
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
  const syncError = visibleTaskSyncError(task);

  return (
    <div className="task-detail cmux-scroll">
      <div className="task-detail-header">
        <span className="task-detail-title">{task.title}</span>
        <span className={`task-status-badge task-status-${task.status}`}>
          {statusLabel(task.status)}
        </span>
      </div>

      <WorkflowChangeApproval task={task} />

      {/* One row for the remaining task actions, below any workflow approval
          panel and above the description, where a long body
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
        {/* #1015 (archive) — same done/failed restriction as the server
            (routes/tasks.ts's POST/DELETE /api/tasks/:id/archive): archiving
            in_progress/reviewing would hide a task whose worker is still
            running, or from whoever's approval it's waiting on. */}
        {(task.status === "done" || task.status === "failed") && (
          <ArchiveTaskAction taskId={task.id} archivedAt={task.archivedAt} />
        )}
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
            rather than hiding it).
            #746 — `done` (local or GitHub-linked) is rendered too, once the
            board's own cleanup path exists for it. The server only actually
            allows the delete once a linked issue is confirmed no longer
            trackable (see routes/tasks.ts's DELETE handler); otherwise this
            button's confirm step surfaces that as the same inline error.
            #1014 (Abandon) — a LOCAL `failed` task is now rendered too:
            previously the only local statuses shown here were
            backlog/ready/done, so a local task's own equivalent of the
            preserved-branch guard (routes/tasks.ts's "past the
            backlog/ready stage" refusal) had no UI path to Abandon past at
            all. The button's own 409 handling (below) offers the force
            re-prompt regardless of which refusal fired. */}
        {((task.issueNumber === null &&
          (task.status === "backlog" ||
            task.status === "ready" ||
            task.status === "done" ||
            task.status === "failed")) ||
          (task.issueNumber !== null && (task.status === "failed" || task.status === "done"))) && (
          <DeleteTaskAction
            taskId={task.id}
            isDone={task.status === "done"}
            isGithubLinked={task.issueNumber !== null}
            branchName={task.branchName}
            worktreePath={task.worktreePath}
            onDeleted={onDeleted}
          />
        )}
      </div>

      <div className="task-detail-meta">
        <span className="task-detail-meta-row">{task.projectName}</span>
        {hostChip && (
          <span className="task-detail-meta-row task-detail-host" title={hostChip.title}>
            {hostChip.label}
          </span>
        )}
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
            // Opens the PR in the right sidebar; a modified click (new tab,
            // download) and a row with no PR number keep the GitHub link.
            onClick={(e) => {
              const n = matchedPr?.number ?? task.prNumber;
              if (n === null || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              openRightSidebarPr(task.projectId, n);
            }}
          >
            {/* Prefer matchedPr's number for the same reason the href above
                does (PR #577/#582): it's the branch-matched CURRENT PR, so
                on a closed-and-reopened branch it's also the more accurate
                number to show, not just link to. Falls back to plain "Pull
                request" (no "#null") on the rare row where prUrl is set but
                prNumber isn't — see issue #972, a retryTask gap that can
                leave that pair inconsistent. */}
            <GitHubIcon size={12} /> Pull request
            {(matchedPr?.number ?? task.prNumber) !== null &&
              ` #${matchedPr?.number ?? task.prNumber}`}
            {matchedPr && (
              <span className={`github-panel-ci-dot ${sessionPrDotClass(matchedPr.ciStatus)}`} />
            )}
          </a>
        )}
        {/* #761's silent fallback: the project asked for a Conventional
            Commits title, a PR was opened, but the title actually in use
            isn't Conventional-Commits-shaped — the worker never wrote a
            usable one AND the raw issue title itself doesn't parse either
            (withPrTitleFallback, routes/tasks.ts; see that computation's own
            doc comment for why raw `prTitle === null` alone isn't this
            signal). task-reconciler.ts already logs this server-side
            (app.log.warn) but nothing rendered it anywhere a human would
            see it before this. */}
        {task.prTitleFallback && (
          <span className="task-detail-error">
            PR title fell back to the raw issue title, which isn't Conventional-Commits-shaped —
            release-please (or a similar tool) may skip it.
          </span>
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
                      label: `Project default (${projectDefaultReviewAgentLabel})`,
                    },
                    { value: "none", label: "None (disabled)" },
                    ...(hermesAvailable ? [HERMES_REVIEW_OPTION] : []),
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

      {task.prNumber !== null && task.mergedAt === null && matchedOpenPr && (
        <FixInSessionAction
          task={task}
          prNumber={matchedOpenPr.number}
          branch={matchedOpenPr.headBranch}
        />
      )}

      {task.body && <div className="task-detail-body">{task.body}</div>}

      {/* #1997 — a queued task's last dispatch error: it is still being
          retried, so this reads as waiting, not as the terminal failure
          below. */}
      {task.status === "claimed" && task.failureReason && (
        <div className="task-detail-dispatch">
          <ClockIcon size={12} />
          <span>
            Not dispatched yet
            {task.dispatchFailingSince &&
              ` (failing since ${formatRelativeAge(new Date(task.dispatchFailingSince).getTime())})`}
            : {task.failureReason}
          </span>
        </div>
      )}

      {task.status === "failed" && task.failureReason && (
        <div className="task-detail-failure">
          <WarningTriangleIcon size={12} />
          {task.failureReason}
        </div>
      )}

      {task.status === "failed" && task.failureDiagnostics && (
        <FailureDiagnostics text={task.failureDiagnostics} />
      )}

      {/* The task-view session-visibility gap this closes: TaskDetail
          previously read none of either linked session's own live status
          fields at all — a stuck/blocked worker or reviewer (needing
          permission, a plan decision, or any other in-terminal prompt) was
          invisible here even though "Open session" already sits right
          above, unlike TaskSessionSlot.tsx on the board, which has shown
          this same data (for BOTH roles) all along. Reuses
          session-status.ts's already-derived fields
          (STATUS_PRESENTATION/formatStatusLabel — the exact same lookup the
          board's own status dot uses), not a new detection mechanism; gated
          on sessionStatusAttentionRequired so a routine "working"/"idle"
          session stays silent here, matching the failureReason/
          githubSyncError/blockedState banners below. */}
      <SessionAttentionBanner
        role="Worker"
        session={workerSession}
        onOpenSession={onOpenSession}
        rebasing={task.reviewPhase === "rebasing"}
      />
      <SessionAttentionBanner role="Review" session={reviewSession} onOpenSession={onOpenSession} />

      {/* #485 — independent of status: a task can be happily in_progress
          while its GitHub sync is silently broken (e.g. an under-scoped
          token). Previously invisible outside a server-log grep; this is
          durable across remounts, unlike TaskActions' own transient
          setError. */}
      {syncError && (
        <div className="task-detail-sync-error">
          <GitHubIcon size={12} />
          GitHub sync: {syncError}
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

      {(task.reviewSessionId !== null ||
        task.reviewRunId !== null ||
        task.reviewFindings !== null ||
        task.reviewPhase) && (
        <div className="task-detail-section task-detail-review-section">
          <div className="task-detail-section-title">
            {task.reviewSessionId === null &&
            task.reviewRunId === null &&
            task.reviewFindings !== null
              ? "Review (previous round)"
              : "Review"}
          </div>
          {phaseText && (
            <div className="task-detail-review-round" role="status">
              {phaseText}
              {task.rebaseAttempts > 1 && ` (rebase attempt ${task.rebaseAttempts})`}
            </div>
          )}
          {/* Issue #1038 — three states, not two: capped-but-not-announced
              (autoReturnCapped true, capAnnounced false) still means a
              worker session or the confirming review may be actively
              running — "nothing further happens" is only true once
              capAnnounced, the actual "the machine stopped" signal. This
              section has no `task.status` gate (unlike TaskCard's round
              badge), so it can render this hint while status is still
              "in_progress" — the widest instance of the original bug: the
              old two-state version said "needs a human" through the
              entire final worker run. */}
          <div className="task-detail-review-hint">
            {task.approvalState === "awaiting-human"
              ? "The review approved this task. Nothing happens on its own from here — a human has to Approve it above."
              : task.approvalState === "auto-pending"
                ? "The review approved this task. This project auto-approves, so it will be approved automatically once CI is green."
                : task.autoReturnRounds > 0 && capAnnounced
                  ? "The automatic loop has stopped — nothing further happens on its own from here. It still cannot approve, reject, or otherwise transition this task; that's your call above."
                  : task.autoReturnRounds > 0 && task.autoReturnCapped
                    ? "It has spent its last automatic round and a final review is still confirming the outcome — it still cannot approve, reject, or otherwise transition this task; that's your call above, once it stops."
                    : task.autoReturnRounds > 0
                      ? "Its findings have been sent back to the worker automatically — this is that round's outcome. It still cannot approve, reject, or otherwise transition this task; that's still your call above."
                      : "It cannot approve, reject, or otherwise transition this task — that's still your call above. Non-empty findings may be sent back to the worker automatically before this task is ready for another look."}
          </div>
          {task.reviewRunId !== null && task.reviewSessionId === null && (
            <div className="task-detail-review-round" role="status" data-testid="hermes-review-run">
              {task.reviewRunUnsent
                ? "Hermes review could not be sent — Hermes was unreachable."
                : task.reviewRunIngestedId === task.reviewRunId
                  ? "Hermes review finished."
                  : "Hermes review running…"}
            </div>
          )}
          {task.approvalState && (
            <div className="task-detail-review-round" role="status">
              {approvalStateText(task.approvalState, task.autoReturnRounds)}
            </div>
          )}
          {task.autoReturnRounds > 0 && !task.approvalState && (
            <div
              className={
                capAnnounced
                  ? "task-detail-review-round task-detail-review-round-capped"
                  : "task-detail-review-round"
              }
            >
              {capAnnounced
                ? `Round ${task.autoReturnRounds} — ${needsHumanText(task.needsHumanReason)}, needs a human to take it from here`
                : task.autoReturnCapped
                  ? `Round ${task.autoReturnRounds} — review still in flight; nothing needs you yet`
                  : `Round ${task.autoReturnRounds} sent back to the worker automatically`}
            </div>
          )}
          {task.reviewSeedDelivered === false && (
            <div className="task-detail-review-noseed">
              <WarningTriangleIcon size={12} />
              This agent started with no initial instructions.
            </div>
          )}
          {reviewRounds ? (
            <>
              <div className="task-detail-review-summary">
                <span className="task-detail-review-summary-round">
                  Latest: round {reviewRounds.latest.round}
                </span>
                {reviewRounds.latest.verdict && <span>{reviewRounds.latest.verdict}</span>}
                {reviewRounds.latest.counts && (
                  <span className="task-detail-review-summary-counts">
                    {reviewRounds.latest.counts.critical} critical ·{" "}
                    {reviewRounds.latest.counts.warnings} warnings ·{" "}
                    {reviewRounds.latest.counts.suggestions} suggestions
                  </span>
                )}
              </div>
              <Markdown text={reviewRounds.latest.text} className="task-detail-review-findings" />
              {reviewRounds.earlier.length > 0 && (
                <details className="task-detail-review-earlier">
                  <summary>Earlier rounds ({reviewRounds.earlier.length})</summary>
                  {reviewRounds.earlier.map((block) => (
                    <Markdown key={block} text={block} className="task-detail-review-findings" />
                  ))}
                </details>
              )}
            </>
          ) : (
            task.reviewFindings && (
              <Markdown text={task.reviewFindings} className="task-detail-review-findings" />
            )
          )}
          {task.reviewSessionId !== null && (
            <SessionTimeline params={{ sessionIds: [task.reviewSessionId] }} />
          )}
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

// #1015 (archive) — no confirm step, unlike DeleteTaskAction below: archiving
// is reversible (Unarchive clears only archivedAt, see api/tasks.ts's own
// doc comment), so it doesn't need the same "click again to confirm" gate a
// destructive action does.
function ArchiveTaskAction({ taskId, archivedAt }: { taskId: number; archivedAt: string | null }) {
  const archiveTask = useDashboardStore((s) => s.archiveTask);
  const unarchiveTask = useDashboardStore((s) => s.unarchiveTask);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setSubmitting(true);
    setError(null);
    try {
      if (archivedAt !== null) await unarchiveTask(taskId);
      else await archiveTask(taskId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to update archive state");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="task-detail-actions">
      <button className="notif-gate-btn" disabled={submitting} onClick={run}>
        {archivedAt !== null ? "Unarchive" : "Archive"}
      </button>
      {error && <span className="task-detail-error">{error}</span>}
    </div>
  );
}

// Independent review, PR #477 — a "click again to confirm" step, same
// GateActions/notif-gate-* idiom as TaskActions below (not ConfirmButton.tsx,
// which is styled for its own specific parent contexts, e.g.
// .ws-group-actions .danger — dropping it in bare here would render
// unstyled). On success it calls `onDeleted` so the host closes the panel;
// a host that passes none (or a task that vanishes for any other reason)
// falls through to TaskDetail's own `if (!task)` guard, which renders
// "Task not found." — the no-optimistic-state posture the rest of this file
// follows.
function DeleteTaskAction({
  taskId,
  isDone,
  isGithubLinked,
  branchName,
  worktreePath,
  onDeleted,
}: {
  taskId: number;
  isDone: boolean;
  isGithubLinked: boolean;
  branchName: string | null;
  worktreePath: string | null;
  onDeleted?: () => void;
}) {
  const deleteTask = useDashboardStore((s) => s.deleteTask);
  // #1014 (Abandon), review fix — the label name is configurable
  // (MULLION_TASK_LABEL, env.ts), not always literally "mullion-task". This
  // is the same value TaskMasterSection.tsx's own Settings display reads.
  const taskMasterEnv = useDashboardStore((s) => s.taskMasterEnv);
  const taskLabel = taskMasterEnv?.issueLabel ?? "mullion-task";
  const [confirming, setConfirming] = useState(false);
  // #1014 (Abandon) — set once a plain delete 409s, per api/client.ts's own
  // guidance to branch on statusCode rather than the message text. Once
  // true, the confirm step below switches to naming exactly what a
  // force-delete destroys and re-issues with force: true. Mirrors the
  // Hosts cascade-delete flow (HostsSection.tsx's cascadePrompt state).
  const [needsForce, setNeedsForce] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Review fix — Cancel must also drop needsForce, or reopening this panel
  // skips straight to the Abandon/force prompt even if whatever triggered
  // the earlier 409 (a still-tracked issue, a since-resolved race) no
  // longer holds. A fresh open should always try the plain delete again
  // first.
  function cancel() {
    setConfirming(false);
    setNeedsForce(false);
    setError(null);
  }

  if (!confirming) {
    return (
      <div className="task-detail-actions task-detail-actions-delete">
        <button className="notif-gate-btn notif-gate-deny" onClick={() => setConfirming(true)}>
          Delete task
        </button>
      </div>
    );
  }

  // #746 — a done task's local row is the only thing this removes: the
  // closed issue and its PR stay on GitHub (whatever state that PR is in —
  // approveTask sets prNumber/prUrl unconditionally, but only requests a
  // merge when the project has mergeOnApprove on, default off, and even
  // then the merge sweep is async/best-effort, so "done" does not imply
  // "merged"), and cleanupTaskWorktree already removed the worktree
  // directory at approve time — the branch itself is untouched (see the
  // DELETE route's own doc comment on why that's true for the
  // GitHub-linked case).
  //
  // #1014 — once a plain delete has 409'd, the hint switches to naming
  // exactly what a force-delete (Abandon) destroys: the GitHub label (only
  // for a linked task), the worktree, the branch, and any live sessions.
  const hint = needsForce
    ? [
        "This task can't be deleted normally.",
        isGithubLinked
          ? `Abandoning it removes the ${taskLabel} label from the linked issue,`
          : "Abandoning it",
        worktreePath ? `deletes its worktree (${worktreePath}),` : null,
        branchName ? `deletes its branch (${branchName}),` : null,
        "and kills any of its sessions still running. This can't be undone.",
      ]
        .filter(Boolean)
        .join(" ")
    : isDone && isGithubLinked
      ? "Delete this task? The closed issue and its PR stay on GitHub, and the branch is untouched. This can't be undone."
      : isDone
        ? "Delete this task? The branch is untouched. This can't be undone."
        : "Delete this task? This can't be undone.";

  // The buttons keep the right-aligned slot "Delete task" occupied (same
  // wrapper class), and the hint/error go in a following full-width sibling so
  // a long hint wraps on its own line instead of pushing the buttons around
  // the action row.
  return (
    <>
      <div className="task-detail-actions task-detail-actions-delete">
        <button className="notif-gate-btn" disabled={submitting} onClick={cancel}>
          Cancel
        </button>
        <button
          className="notif-gate-btn notif-gate-deny-confirm"
          disabled={submitting}
          onClick={async () => {
            setSubmitting(true);
            setError(null);
            try {
              if (needsForce) await deleteTask(taskId, { force: true });
              else await deleteTask(taskId);
              onDeleted?.();
            } catch (err) {
              if (!needsForce && err instanceof ApiError && err.statusCode === 409) {
                setNeedsForce(true);
                setSubmitting(false);
                return;
              }
              setError(err instanceof ApiError ? err.message : "Failed to delete task");
              setSubmitting(false);
            }
          }}
        >
          {needsForce ? "Abandon task" : "Confirm delete"}
        </button>
      </div>
      <div className="task-detail-actions-note">
        <span className="task-detail-hint">{hint}</span>
        {error && <span className="task-detail-error">{error}</span>}
      </div>
    </>
  );
}

// A branch that edits `.github/workflows/` is held, not pushed, until the
// operator approves this exact head commit (backend task-workflow-gate.ts).
// Shows the files so the approval is informed; the sha rides along so the
// server can refuse if the branch moved after this was rendered.
function WorkflowChangeApproval({ task }: { task: Task }) {
  const { taskMasterEnabled, approveWorkflowChange, refreshTasks } = useDashboardStore();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = parseWorkflowChange(task.workflowChange);
  if (!change) return null;

  return (
    <div className="task-detail-workflow-change" role="group" aria-label="Workflow change">
      <div className="task-detail-workflow-change-title">
        This branch edits CI workflows — approval needed before it is pushed
      </div>
      <ul className="task-detail-workflow-change-files">
        {change.files.map((f) => (
          <li key={f}>
            <code>{f}</code>
          </li>
        ))}
      </ul>
      <div className="task-detail-actions">
        <button
          className="notif-gate-btn notif-gate-approve"
          disabled={submitting || !taskMasterEnabled || change.sha === ""}
          onClick={async () => {
            setSubmitting(true);
            setError(null);
            try {
              await approveWorkflowChange(task.id, change.sha);
            } catch (err) {
              // A stale approval can clear a hold that no longer applies or
              // replace it with a new head. Refresh before showing an error so
              // an obsolete panel doesn't leave the next action hidden.
              if (err instanceof ApiError && err.statusCode === 409) await refreshTasks();
              setError(
                err instanceof ApiError ? err.message : "Failed to approve the workflow change",
              );
            } finally {
              setSubmitting(false);
            }
          }}
        >
          Approve workflow change
        </button>
        {change.sha === "" && (
          <span className="task-detail-hint">
            The head commit could not be read, so this cannot be approved yet.
          </span>
        )}
        {error && <span className="task-detail-error">{error}</span>}
      </div>
    </div>
  );
}
