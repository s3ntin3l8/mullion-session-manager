import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { SessionTimeline } from "../SessionTimeline.js";
import { TaskActions } from "../TaskActions.js";
import { useCanPopOutTask } from "../hooks/useOpenTask.js";
import { goSidebarBack } from "../sidebarBack.js";
import { epicProjectId, isPlainClick } from "../lib/sidebarLinks.js";
import type { Session, Task, TaskBlocker } from "../api/types.js";
import { matchSessionPr } from "../github/matchSessionPr.js";
import { prStatuses, prTriadItems, type PrStatusInput } from "../github/prPhase.js";
import { parseReviewRounds } from "../lib/reviewRounds.js";
import { reviewPhaseText } from "../needsHuman.js";
import { STATUS_PRESENTATION, formatStatusLabel } from "../sessionStatus.js";
import { useDashboardStore } from "../store/index.js";
import {
  taskStatusBadge,
  reviewRunState,
  taskRelations,
  taskRowLabel,
  findTaskForIssue,
} from "../taskStatusModel.js";
import { EmptyStateNote } from "../ui/EmptyState.js";
import { ExternalLinkIcon } from "../ui/icons.js";
import { Markdown } from "../ui/Markdown.js";
import {
  DetailHeader,
  IconButton,
  SidebarSection,
  StatusChip,
  StatusTriad,
  TaskStatusBlock,
} from "../ui/sidebar/index.js";
import { SidebarDetailSlotContext } from "../ui/sidebar/detailSlot.js";
import { TaskAgents } from "./TaskAgents.js";

// The Tasks sidebar's detail mode (epic #2847): one task, status first. It
// reads its own task by id from the store, so it does not depend on what the
// list is scoped to: a backlog, done, archived or other-project task opens.
// The section order is the design's: status block, review, pull request,
// actions, details, hierarchy, timeline.

const BODY_COLLAPSED_CHARS = 280;

const HERMES_LABEL = { running: "running", finished: "finished", unsent: "not sent" } as const;

function SessionPill({
  role,
  session,
  ended = false,
}: {
  role: string;
  session: Session | undefined;
  /** The task names a session that is no longer in the store (the card says "ended"). */
  ended?: boolean;
}) {
  // "Open session in Workspace" (#3009): from Tasks mode this switches to
  // Workspace and opens the session there; this task stays in the sidebar.
  const openSessionInWorkspace = useDashboardStore((s) => s.openSessionInWorkspace);
  if (!session)
    return (
      <span className="sb-dim">
        {role}: {ended ? "ended" : "none"}
      </span>
    );
  const presentation = STATUS_PRESENTATION[session.sessionStatus];
  return (
    <StatusChip
      tone="info"
      onClick={() => openSessionInWorkspace(session.id)}
      title={`Open the ${role} session in Workspace`}
    >
      {role} · {formatStatusLabel(presentation, session.sessionStatusDetail, "compact")}
      <ExternalLinkIcon size={10} aria-hidden="true" />
    </StatusChip>
  );
}

/** A reference to another task, or to its bare GitHub issue when no task tracks it. */
function TaskRef({
  label,
  task,
  blocker,
  trailing,
}: {
  label: string;
  task?: Task;
  blocker?: TaskBlocker;
  trailing?: ReactNode;
}) {
  const openTaskInSidebar = useDashboardStore((s) => s.openRightSidebarTask);
  return (
    <div className="sb-hier-row">
      {task ? (
        <button
          type="button"
          className="sb-link"
          title={`Open task: ${task.title}`}
          onClick={() => openTaskInSidebar(task.id)}
        >
          {label}
        </button>
      ) : blocker?.htmlUrl ? (
        <a className="sb-link" href={blocker.htmlUrl} target="_blank" rel="noreferrer">
          {label}
          <ExternalLinkIcon size={10} aria-hidden="true" />
        </a>
      ) : (
        <span>{label}</span>
      )}
      <span className="sb-hier-title">{task?.title ?? blocker?.title ?? ""}</span>
      {trailing}
    </div>
  );
}

function RelatedList({ title, tasks }: { title: string; tasks: Task[] }) {
  const [all, setAll] = useState(false);
  if (tasks.length === 0) return null;
  const shown = all ? tasks : tasks.slice(0, 3);
  return (
    <div className="sb-hier-group">
      <div className="sb-hier-label">
        {title} {tasks.length}
      </div>
      {shown.map((t) => {
        const badge = taskStatusBadge(t);
        return (
          <TaskRef
            key={t.id}
            label={taskRowLabel(t)}
            task={t}
            trailing={<StatusChip tone={badge.tone}>{badge.label.toLowerCase()}</StatusChip>}
          />
        );
      })}
      {tasks.length > 3 && !all && (
        <button type="button" className="sb-link" onClick={() => setAll(true)}>
          + {tasks.length - 3} more
        </button>
      )}
    </div>
  );
}

export function TaskDetailView({ taskId, onBack }: { taskId: number; onBack: () => void }) {
  const task = useDashboardStore((s) => s.tasks.find((t) => t.id === taskId));
  const allTasks = useDashboardStore((s) => s.tasks);
  const sessions = useDashboardStore((s) => s.sessions);
  const projects = useDashboardStore((s) => s.projects);
  const prsByProject = useDashboardStore((s) => s.prsByProject);
  const openTaskInSidebar = useDashboardStore((s) => s.openRightSidebarTask);
  const requestOpenTask = useDashboardStore((s) => s.requestOpenTask);
  // The pop-out to a docked panel is offered from 1100px only (#3011, see
  // useCanPopOutTask).
  const canPopOut = useCanPopOutTask();
  const [bodyOpen, setBodyOpen] = useState(false);
  // A task is shown from outside the rail (a board card, a notification, a
  // task chip in the GitHub or Git views) as often as from inside it, and the
  // store selection moves no focus by itself. Without this a keyboard user who
  // pressed Enter on a card lands nowhere: nothing in the sidebar is focused
  // and nothing is announced (the board's old drawer focused its close button,
  // trapped Tab and closed on Escape for exactly that reason). Focus the Back
  // button when a task's detail appears or another task replaces it. In the
  // right sidebar DetailHeader portals the header (Back included) into the
  // drawer's detail slot, outside this view's own root, so Back is looked up
  // in the slot when there is one and in the root otherwise. A screen reader
  // announces "Back, button" there, not the task; the view's region is labelled
  // with the task for when focus moves into the body.
  // `detailSlot` is a dependency because the slot element arrives one render
  // after the panel mounts: the first run finds the inline header, the next
  // finds the portalled one.
  const detailSlot = useContext(SidebarDetailSlotContext);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    (detailSlot ?? rootRef.current)?.querySelector<HTMLElement>('[aria-label="Back"]')?.focus();
  }, [taskId, detailSlot]);

  if (!task) {
    return (
      <div className="tasks-sidebar-view" ref={rootRef}>
        <DetailHeader title="Task" onBack={onBack} />
        <EmptyStateNote>This task no longer exists.</EmptyStateNote>
      </div>
    );
  }

  const projectName = projects.find((p) => p.id === task.projectId)?.name ?? task.projectName;
  const worker =
    task.sessionId !== null ? sessions.find((s) => s.id === task.sessionId) : undefined;
  const reviewer =
    task.reviewSessionId !== null ? sessions.find((s) => s.id === task.reviewSessionId) : undefined;
  const runState = reviewRunState(task);
  const rounds = parseReviewRounds(task.reviewFindings);
  const phaseText = reviewPhaseText(
    task.reviewPhase,
    task.reReviewAt,
    task.reviewFindings !== null,
  );
  const showReview =
    task.status === "reviewing" ||
    task.status === "done" ||
    task.reviewSessionId !== null ||
    task.reviewRunId !== null ||
    task.reviewFindings !== null ||
    worker !== undefined;
  const pr =
    task.prNumber !== null
      ? matchSessionPr(prsByProject[task.projectId]?.prs, {
          branch: task.branchName,
          taskPrNumber: task.prNumber,
        })
      : undefined;
  const openPr = () =>
    useDashboardStore.getState().openRightSidebarPr(task.projectId, task.prNumber as number, {
      kind: "task",
      taskId: task.id,
    });
  const openIssue = () =>
    useDashboardStore.getState().openRightSidebarIssue(task.projectId, task.issueNumber as number, {
      kind: "task",
      taskId: task.id,
    });
  const epicProject = epicProjectId(allTasks, task);
  const openEpicIssue = (projectId: number, number: number) =>
    useDashboardStore.getState().openRightSidebarIssue(projectId, number, {
      kind: "task",
      taskId: task.id,
    });
  const relations = taskRelations(task, allTasks);
  const hasHierarchy =
    task.parentIssueNumber !== null ||
    relations.blockedBy.length > 0 ||
    relations.blocks.length > 0 ||
    relations.siblings.length > 0 ||
    relations.children.length > 0 ||
    (task.subIssueTotal !== null && task.subIssueTotal > 0);
  const body = task.body?.trim() ?? "";
  const longBody = body.length > BODY_COLLAPSED_CHARS;

  return (
    <div
      className="tasks-sidebar-view tasks-detail sb-detail"
      data-testid="task-detail-view"
      ref={rootRef}
      role="region"
      aria-label={`Task ${taskRowLabel(task)} ${task.title}`}
    >
      <DetailHeader
        title={`${taskRowLabel(task)} ${task.title}`}
        onBack={() => goSidebarBack({ kind: "task", taskId: task.id }, onBack)}
        externalUrl={task.htmlUrl}
        externalLabel="Open the issue on GitHub"
        actions={
          canPopOut ? (
            <IconButton label="Pop out to a docked panel" onClick={() => requestOpenTask(task.id)}>
              <ExternalLinkIcon size={13} />
            </IconButton>
          ) : undefined
        }
      />
      <TaskStatusBlock
        task={task}
        renderBlocker={(b) => {
          const t = findTaskForIssue(allTasks, b);
          return t ? (
            <button type="button" className="sb-link" onClick={() => openTaskInSidebar(t.id)}>
              #{b.number}
            </button>
          ) : b.htmlUrl ? (
            <a className="sb-link" href={b.htmlUrl} target="_blank" rel="noreferrer">
              #{b.number}
            </a>
          ) : (
            `#${b.number}`
          );
        }}
      />

      {showReview && (
        <SidebarSection title="Review" persistKey="task-detail-review" variant="card">
          <dl className="sb-kv">
            <dt>Verdict</dt>
            <dd>
              {rounds?.latest.verdict ?? task.lastReviewVerdict ?? "none yet"}
              {rounds?.latest.counts && (
                <span className="sb-dim">
                  {" "}
                  · {rounds.latest.counts.critical} critical, {rounds.latest.counts.warnings}{" "}
                  warnings, {rounds.latest.counts.suggestions} suggestions
                </span>
              )}
            </dd>
            <dt>Round</dt>
            <dd>
              {rounds ? `${rounds.latest.round}` : "—"}
              {task.autoReturnRounds > 0 && (
                <span className="sb-dim">
                  {" "}
                  · {task.autoReturnRounds} auto-return{task.autoReturnRounds === 1 ? "" : "s"}
                  {task.autoReturnCapped ? " (limit reached)" : ""}
                </span>
              )}
            </dd>
            {phaseText && (
              <>
                <dt>Phase</dt>
                <dd>{phaseText}</dd>
              </>
            )}
            <dt>Approval</dt>
            <dd>
              {task.approvalState === "awaiting-human"
                ? "waiting for a human"
                : task.approvalState === "auto-pending"
                  ? "automatic when the review passes"
                  : "—"}
            </dd>
            <dt>Sessions</dt>
            <dd className="sb-pills">
              <SessionPill role="worker" session={worker} ended={task.sessionId !== null} />
              {task.reviewSessionId === null && runState !== null ? (
                <StatusChip
                  tone={runState === "unsent" ? "warn" : "info"}
                  onClick={task.prNumber !== null ? openPr : undefined}
                  title={
                    task.prNumber !== null
                      ? "Open the PR's review in the GitHub tab"
                      : "External review (Hermes)"
                  }
                >
                  Hermes · {HERMES_LABEL[runState]}
                </StatusChip>
              ) : (
                <SessionPill
                  role="reviewer"
                  session={reviewer}
                  ended={task.reviewSessionId !== null}
                />
              )}
            </dd>
          </dl>
        </SidebarSection>
      )}

      {task.prNumber !== null && (
        <SidebarSection title="Pull request" persistKey="task-detail-pr" variant="card">
          <div className="sb-pr-line">
            <button
              type="button"
              className="sb-link"
              onClick={openPr}
              title="Open the pull request"
            >
              PR #{task.prNumber}
            </button>
            <span className="sb-hier-title">{task.prTitle ?? ""}</span>
          </div>
          {pr && (
            <StatusTriad
              items={prTriadItems(prStatuses(pr as unknown as PrStatusInput, pr.relayReview), () =>
                openPr(),
              )}
            />
          )}
        </SidebarSection>
      )}

      <div className="sb-actions-block">
        <TaskActions task={task} confirmApprove />
      </div>

      <SidebarSection title="Details" persistKey="task-detail-details" variant="card">
        <dl className="sb-kv">
          <dt>Project</dt>
          <dd>{projectName}</dd>
          <dt>Issue</dt>
          <dd>
            {task.issueNumber !== null ? (
              <button type="button" className="sb-link" onClick={openIssue}>
                #{task.issueNumber}
              </button>
            ) : (
              "none (local task)"
            )}
          </dd>
        </dl>
        <TaskAgents task={task} />
        {body && (
          <div className="sb-body">
            <div
              id={`task-body-${task.id}`}
              className={longBody && !bodyOpen ? "sb-body-text--clamped" : undefined}
            >
              <Markdown text={body} />
            </div>
            {longBody && (
              <button type="button" className="sb-link" onClick={() => setBodyOpen((v) => !v)}>
                {bodyOpen ? "Show less" : "Show more"}
              </button>
            )}
          </div>
        )}
      </SidebarSection>

      {hasHierarchy && (
        <SidebarSection title="Hierarchy" persistKey="task-detail-hierarchy">
          {task.parentIssueNumber !== null && (
            <div className="sb-hier-group">
              <div className="sb-hier-label">Epic</div>
              {relations.parent ? (
                <TaskRef label={`#${task.parentIssueNumber}`} task={relations.parent} />
              ) : (
                <div className="sb-hier-row">
                  <a
                    className="sb-link"
                    href={`https://github.com/${task.parentIssueRepo}/issues/${task.parentIssueNumber}`}
                    target="_blank"
                    rel="noreferrer"
                    // A plain click opens the epic in the GitHub tab (when a project tracks its
                    // repo); Ctrl/⌘/middle-click keep the real link.
                    onClick={(e) => {
                      if (epicProject !== null && isPlainClick(e)) {
                        e.preventDefault();
                        openEpicIssue(epicProject, task.parentIssueNumber as number);
                      }
                    }}
                  >
                    #{task.parentIssueNumber}
                    <ExternalLinkIcon size={10} aria-hidden="true" />
                  </a>
                  <span className="sb-hier-title">{task.parentIssueTitle ?? ""}</span>
                </div>
              )}
            </div>
          )}
          {task.subIssueTotal !== null && task.subIssueTotal > 0 && (
            <div className="sb-hier-group">
              <div className="sb-hier-label">Sub-issues</div>
              <div className="sb-dim">
                {task.subIssueCompleted ?? 0} of {task.subIssueTotal} complete
              </div>
            </div>
          )}
          {relations.blockedBy.length > 0 && (
            <div className="sb-hier-group">
              <div className="sb-hier-label">Blocked by</div>
              {relations.blockedBy.map(({ blocker, task: t }) => (
                <TaskRef
                  key={`${blocker.owner}/${blocker.repo}#${blocker.number}`}
                  label={`#${blocker.number}`}
                  task={t}
                  blocker={blocker}
                  trailing={
                    t ? (
                      <StatusChip tone={taskStatusBadge(t).tone}>
                        {taskStatusBadge(t).label.toLowerCase()}
                      </StatusChip>
                    ) : undefined
                  }
                />
              ))}
            </div>
          )}
          <RelatedList title="Also blocked by the same task" tasks={relations.siblings} />
          <RelatedList title="Blocks" tasks={relations.blocks} />
          <RelatedList title="Sub-issue tasks" tasks={relations.children} />
        </SidebarSection>
      )}

      <SidebarSection title="Timeline" persistKey="task-detail-timeline">
        <SessionTimeline
          surface="task"
          params={{ sessionIds: task.sessionId !== null ? [task.sessionId] : [] }}
        />
      </SidebarSection>
    </div>
  );
}
