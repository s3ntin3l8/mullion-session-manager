import { useMemo } from "react";
import { useDashboardStore } from "../store/index.js";
import { SidebarRow, SidebarSection, StatusChip } from "../ui/sidebar/index.js";
import { taskTone } from "../ui/sidebar/linkDecisions.js";
import type { Tone } from "../lib/statusTone.js";
import { countTasks, needsYouTasks } from "../github/taskMasterSummary.js";

const MAX_ROWS = 5;

const CHIPS: Array<{ key: keyof ReturnType<typeof countTasks>; label: string; tone: Tone }> = [
  { key: "ready", label: "ready", tone: taskTone("ready") },
  { key: "running", label: "running", tone: taskTone("in_progress") },
  { key: "reviewing", label: "reviewing", tone: taskTone("reviewing") },
  { key: "awaitingApproval", label: "awaiting approval", tone: "warn" },
  { key: "waiting", label: "waiting", tone: "warn" },
  { key: "failed", label: "failed", tone: taskTone("failed") },
];

// Task Master status for the followed project, above the PR list. Hidden when
// Task Master is off.
export function TaskMasterSection({
  projectId,
  onOpenTasks,
}: {
  projectId: number;
  onOpenTasks: () => void;
}) {
  const enabled = useDashboardStore((s) => s.taskMasterEnabled);
  const allTasks = useDashboardStore((s) => s.tasks);
  const requestOpenTask = useDashboardStore((s) => s.requestOpenTask);
  const tasks = useMemo(
    () => allTasks.filter((t) => t.projectId === projectId),
    [allTasks, projectId],
  );
  const counts = useMemo(() => countTasks(tasks), [tasks]);
  const needsYou = useMemo(() => needsYouTasks(tasks), [tasks]);
  if (!enabled) return null;
  const chips = CHIPS.filter((c) => counts[c.key] > 0);
  if (chips.length === 0 && needsYou.length === 0) return null;
  return (
    <SidebarSection title="Task Master" persistKey="github-task-master">
      {chips.length > 0 && (
        <div className="sb-chip-strip" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {chips.map((c) => (
            <StatusChip
              key={c.key}
              tone={c.tone}
              onClick={onOpenTasks}
              title="Open the Tasks board"
            >
              {counts[c.key]} {c.label}
            </StatusChip>
          ))}
        </div>
      )}
      {needsYou.slice(0, MAX_ROWS).map(({ task, reason }) => (
        <SidebarRow
          key={task.id}
          title={`#${task.issueNumber ?? task.id} ${task.title}`}
          meta={reason}
          onClick={() => requestOpenTask(task.id)}
        />
      ))}
      {needsYou.length > MAX_ROWS && (
        <SidebarRow title={`+${needsYou.length - MAX_ROWS} more`} onClick={onOpenTasks} />
      )}
    </SidebarSection>
  );
}
