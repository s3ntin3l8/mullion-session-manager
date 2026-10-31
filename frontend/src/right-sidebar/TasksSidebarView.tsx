import { useMemo, useState } from "react";
import { TaskActions } from "../TaskActions.js";
import type { Task } from "../api/types.js";
import { needsYouReason, taskBucket, type TaskBucket } from "../github/taskMasterSummary.js";
import { useDashboardStore } from "../store/index.js";
import { EmptyStateNote } from "../ui/EmptyState.js";
import { ExternalLinkIcon, RefreshIcon } from "../ui/icons.js";
import { IconButton, SidebarRow, StatusChip } from "../ui/sidebar/index.js";
import { taskTone } from "../ui/sidebar/linkDecisions.js";
import { SidebarHeader } from "./SidebarHeader.js";
import { VIEW_TITLES } from "./viewTitles.js";
import type { RightSidebarViewProps } from "./views.js";

type StatusFilter = TaskBucket | "all";

// Chip order: what needs a human first, then what is merely in flight.
const FILTERS: Array<{ key: TaskBucket; label: string; status: Task["status"] }> = [
  { key: "failed", label: "failed", status: "failed" },
  { key: "awaitingApproval", label: "awaiting approval", status: "reviewing" },
  { key: "reviewing", label: "reviewing", status: "reviewing" },
  { key: "waiting", label: "waiting", status: "claimed" },
  { key: "running", label: "running", status: "in_progress" },
  { key: "ready", label: "ready", status: "ready" },
  { key: "attention", label: "needs attention", status: "failed" },
];

// The dot matches the chip's tone: red for what is broken, amber for what waits on you.
const DOT_TONE: Record<TaskBucket, "danger" | "warn" | "info" | "success"> = {
  failed: "danger",
  attention: "danger",
  awaitingApproval: "warn",
  waiting: "warn",
  reviewing: "info",
  running: "info",
  ready: "success",
};

const BUCKET_LABEL: Record<TaskBucket, string> = Object.fromEntries(
  FILTERS.map((f) => [f.key, f.label]),
) as Record<TaskBucket, string>;

// Task Master's active work for the followed project, in the sidebar: what is
// running, what needs you, with the same per-status actions as the task panel.
// Done, backlog and archived tasks belong to the board and are not listed.
export function TasksSidebarView({ projectId, actions }: RightSidebarViewProps) {
  const enabled = useDashboardStore((s) => s.taskMasterEnabled);
  const allTasks = useDashboardStore((s) => s.tasks);
  const refreshTasks = useDashboardStore((s) => s.refreshTasks);
  const requestOpenTask = useDashboardStore((s) => s.requestOpenTask);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [openId, setOpenId] = useState<number | null>(null);

  const rows = useMemo(() => {
    const out: Array<{ task: Task; bucket: TaskBucket; reason: string | null }> = [];
    for (const task of allTasks) {
      if (task.projectId !== projectId) continue;
      const bucket = taskBucket(task);
      if (bucket) out.push({ task, bucket, reason: needsYouReason(task) });
    }
    // Needs-you first; otherwise the store's order (the board's order) holds.
    return out.sort((a, b) => Number(b.reason !== null) - Number(a.reason !== null));
  }, [allTasks, projectId]);
  const counts = useMemo(() => {
    const c: Partial<Record<TaskBucket, number>> = {};
    for (const r of rows) c[r.bucket] = (c[r.bucket] ?? 0) + 1;
    return c;
  }, [rows]);
  const needsYou = rows.filter((r) => r.reason !== null).length;
  // A chip disappears once its bucket empties (Retry on the last failed task,
  // a project switch): drop back to All rather than filter into a blank list.
  const active: StatusFilter = filter === "all" || counts[filter] ? filter : "all";
  const shown = active === "all" ? rows : rows.filter((r) => r.bucket === active);

  const openIssue = (issueNumber: number) =>
    useDashboardStore.getState().openRightSidebarIssue(projectId, issueNumber);

  return (
    <div className="tasks-sidebar-view">
      <SidebarHeader
        label={VIEW_TITLES.tasks}
        context={
          !enabled
            ? "Task Master is off"
            : needsYou > 0
              ? `${needsYou} need${needsYou === 1 ? "s" : ""} you`
              : `${rows.length} active`
        }
        actions={[
          {
            key: "refresh",
            label: "Refresh",
            icon: RefreshIcon,
            onClick: () => void refreshTasks(),
          },
        ]}
        overflow={[{ key: "open-board", label: "Open task board", onClick: actions.onOpenTasks }]}
      />
      {!enabled ? (
        <EmptyStateNote>
          Task Master is off. Turn it on in Settings to queue issues as tasks.
        </EmptyStateNote>
      ) : rows.length === 0 ? (
        <EmptyStateNote>No active tasks.</EmptyStateNote>
      ) : (
        <>
          <div className="tasks-sidebar-chips" role="group" aria-label="Filter tasks by status">
            <StatusChip tone="neutral" selected={active === "all"} onClick={() => setFilter("all")}>
              All {rows.length}
            </StatusChip>
            {FILTERS.filter((f) => counts[f.key]).map((f) => (
              <StatusChip
                key={f.key}
                tone={
                  f.key === "awaitingApproval" || f.key === "waiting" ? "warn" : taskTone(f.status)
                }
                selected={active === f.key}
                onClick={() => setFilter(active === f.key ? "all" : f.key)}
              >
                {counts[f.key]} {f.label}
              </StatusChip>
            ))}
          </div>
          {shown.length === 0 && <EmptyStateNote>No tasks match this filter.</EmptyStateNote>}
          {shown.map(({ task, bucket, reason }) => {
            const open = openId === task.id;
            return (
              <SidebarRow
                key={task.id}
                className="sb-row--tm"
                lead={<span className={`sb-dot sb-dot--${DOT_TONE[bucket]}`} aria-hidden="true" />}
                title={`#${task.issueNumber ?? task.id} ${task.title}`}
                meta={reason ?? BUCKET_LABEL[bucket]}
                expanded={open}
                onClick={() => setOpenId(open ? null : task.id)}
                actions={
                  <IconButton label="Open task" onClick={() => requestOpenTask(task.id)}>
                    <ExternalLinkIcon size={13} />
                  </IconButton>
                }
                extra={
                  <>
                    <div className="sb-triad">
                      {task.prNumber != null && (
                        <StatusChip
                          tone="neutral"
                          title="Open the pull request"
                          onClick={() =>
                            useDashboardStore
                              .getState()
                              .openRightSidebarPr(projectId, task.prNumber as number)
                          }
                        >
                          PR #{task.prNumber}
                        </StatusChip>
                      )}
                      {task.issueNumber != null && (
                        <StatusChip
                          tone="neutral"
                          title="Open the issue"
                          onClick={() => openIssue(task.issueNumber as number)}
                        >
                          Issue #{task.issueNumber}
                        </StatusChip>
                      )}
                    </div>
                    {open && <TaskActions task={task} />}
                  </>
                }
              />
            );
          })}
        </>
      )}
    </div>
  );
}
