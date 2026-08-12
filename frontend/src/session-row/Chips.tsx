import { useCallback, useState } from "react";
import type { BackgroundTask, SubagentInfo } from "../api.js";
import { formatRelativeAge } from "../relativeTime.js";
import { STORAGE_KEYS, readJSON, writeJSON } from "../lib/persistedState.js";
import { backgroundTaskLetter, isSubagentLive, subagentDotClass } from "../lib/sidebarStatus.js";

// SessionRow's rows 5 (subagents, Phase 5 Track A #195/5.5a) and 6
// (background tasks, issue #428) — extracted verbatim from SessionRow
// (PR 27 phase 2, Wave 5 of .claude/plans/can-we-do-a-warm-cocke.md).
// Grouped together (the plan's "Chips" bucket) since both rows are the same
// shape: an always-visible strip of small chips, gated on a `showXRow`
// boolean SessionRow computes from session.hookEmits (see that component's
// own comments on why the gating can't move here — it needs
// isStatusReachable against the full EMITS_REQUIREMENTS table, a
// sessionStatus.ts concern, not a rendering one).

function readExpandedSubagentRows(): Set<string> {
  const parsed = readJSON<unknown>(STORAGE_KEYS.expandedSubagentRows, []);
  return new Set(Array.isArray(parsed) ? parsed.filter((s) => typeof s === "string") : []);
}

const expandedSubagentRows = readExpandedSubagentRows();

function subagentRowKey(sessionId: number, agentId: string): string {
  return `${sessionId}:${agentId}`;
}

function setSubagentRowExpanded(sessionId: number, agentId: string, expanded: boolean): void {
  const key = subagentRowKey(sessionId, agentId);
  if (expanded) expandedSubagentRows.add(key);
  else expandedSubagentRows.delete(key);
  writeJSON(STORAGE_KEYS.expandedSubagentRows, [...expandedSubagentRows]);
}

interface SubagentChipProps {
  sessionId: number;
  subagent: SubagentInfo;
}

// One subagent's collapsed chip (type/id, live/finished dot, elapsed time)
// plus its click-to-expand detail (summary + file/tool-failure counts) —
// same two-tier shape as FileChanges' own chip/detail split, but a small
// standalone component (rather than inline state in the .map() body) since
// expand state here is per-item and .map() can't call useState per
// iteration with a varying subagent count across renders.
function SubagentChip({ sessionId, subagent }: SubagentChipProps) {
  const [expanded, setExpanded] = useState(() =>
    expandedSubagentRows.has(subagentRowKey(sessionId, subagent.agentId)),
  );
  const toggleExpanded = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev;
      setSubagentRowExpanded(sessionId, subagent.agentId, next);
      return next;
    });
  }, [sessionId, subagent.agentId]);

  const label = subagent.agentType ?? subagent.agentId.slice(0, 8);
  const live = isSubagentLive(subagent);
  const ageLabel = formatRelativeAge(
    live ? subagent.startedAt : (subagent.endedAt ?? subagent.startedAt),
  );

  return (
    <>
      <button
        type="button"
        className="session-subagent-chip"
        title={subagent.agentId}
        onClick={(e) => {
          e.stopPropagation();
          toggleExpanded();
        }}
      >
        <span className={`github-panel-ci-dot ${subagentDotClass(subagent)}`} />
        <span className="session-subagent-name">{label}</span>
        <span className="session-subagent-age">
          {live ? "started" : "finished"} {ageLabel}
        </span>
      </button>
      {expanded && (
        <div className="session-subagent-detail" onClick={(e) => e.stopPropagation()}>
          {subagent.summary && <span className="session-subagent-summary">{subagent.summary}</span>}
          <span className="session-subagent-detail-meta">
            {subagent.fileChanges} file{subagent.fileChanges === 1 ? "" : "s"}
            {subagent.toolFailures > 0 &&
              ` · ${subagent.toolFailures} tool failure${subagent.toolFailures === 1 ? "" : "s"}`}
          </span>
        </div>
      )}
    </>
  );
}

interface BackgroundTaskChipProps {
  task: BackgroundTask;
}

// One outstanding background task's chip — deliberately simpler than
// SubagentChip above: no expand/collapse (a background task has no
// file-change/tool-failure counters to reveal), just the description with a
// title carrying whichever of command/agent_type/server the task reported,
// mirroring FileChanges' file-change letter+path convention.
function BackgroundTaskChip({ task }: BackgroundTaskChipProps) {
  const detail = task.command ?? task.agent_type ?? task.server ?? task.tool ?? task.name;
  const title = detail ? `${task.type}: ${detail}` : task.type;
  return (
    <span className="session-background-task-chip" title={title}>
      <span className="session-background-task-letter">{backgroundTaskLetter(task.type)}</span>
      <span className="session-background-task-desc">{task.description}</span>
    </span>
  );
}

export interface ChipsProps {
  sessionId: number;
  showSubagentsRow: boolean;
  subagents: SubagentInfo[];
  showBackgroundTasksRow: boolean;
  outstandingBackgroundTasks: BackgroundTask[];
}

export function Chips({
  sessionId,
  showSubagentsRow,
  subagents,
  showBackgroundTasksRow,
  outstandingBackgroundTasks,
}: ChipsProps) {
  return (
    <>
      {showSubagentsRow && (
        <div className="session-subagents-line" onClick={(e) => e.stopPropagation()}>
          {subagents.map((subagent) => (
            <SubagentChip key={subagent.agentId} sessionId={sessionId} subagent={subagent} />
          ))}
        </div>
      )}
      {showBackgroundTasksRow && (
        <div className="session-background-tasks-line" onClick={(e) => e.stopPropagation()}>
          {outstandingBackgroundTasks.map((task, index) => (
            // Index folded into the key (Hermes review, PR #453) —
            // hook-protocol.ts's validateBackgroundTasksField only
            // guarantees each element is a non-null object, not that `id`
            // is present or unique, so `task.id` alone could produce an
            // undefined or duplicate React key.
            <BackgroundTaskChip key={`${index}:${task.id}`} task={task} />
          ))}
        </div>
      )}
    </>
  );
}
