import { useCallback, useState } from "react";
import type { BackgroundTask, SubagentInfo } from "../api/index.js";
import { formatRelativeAge } from "../relativeTime.js";
import { STORAGE_KEYS, readJSON, writeJSON } from "../lib/persistedState.js";
import {
  backgroundTaskLetter,
  isSubagentLive,
  partitionSubagents,
  subagentDotClass,
} from "../lib/sidebarStatus.js";

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

// Sidebar declutter — whether a session's finished-subagent history toggle
// (below) is open, revealing the full list. Separate key/Set from
// expandedSubagentRows above: that one tracks each individual chip's own
// summary expand, this tracks the "N done" toggle itself. Same module-level
// Set + readJSON/writeJSON pattern.
function readExpandedSubagentHistory(): Set<number> {
  const parsed = readJSON<unknown>(STORAGE_KEYS.expandedSubagentHistory, []);
  return new Set(Array.isArray(parsed) ? parsed.filter((n) => typeof n === "number") : []);
}

const expandedSubagentHistory = readExpandedSubagentHistory();

function setSubagentHistoryExpanded(sessionId: number, expanded: boolean): void {
  if (expanded) expandedSubagentHistory.add(sessionId);
  else expandedSubagentHistory.delete(sessionId);
  writeJSON(STORAGE_KEYS.expandedSubagentHistory, [...expandedSubagentHistory]);
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
  const [historyOpen, setHistoryOpen] = useState(() => expandedSubagentHistory.has(sessionId));
  const toggleHistoryOpen = useCallback(() => {
    setHistoryOpen((prev) => {
      const next = !prev;
      setSubagentHistoryExpanded(sessionId, next);
      return next;
    });
  }, [sessionId]);

  // Sidebar declutter — a long-running session can rack up dozens of
  // finished subagents (pty-manager.ts keeps up to MAX_TRACKED_SUBAGENTS=50,
  // persisted across restarts), which used to render as an ever-growing
  // wrapped strip. Live ones stay always-visible chips; finished ones
  // collapse behind one summary toggle.
  const { live, finished, lastFinishedAt } = partitionSubagents(subagents);

  return (
    <>
      {showSubagentsRow && (
        <div className="session-subagents-line" onClick={(e) => e.stopPropagation()}>
          {live.map((subagent) => (
            <SubagentChip key={subagent.agentId} sessionId={sessionId} subagent={subagent} />
          ))}
          {finished.length > 0 && (
            <button
              type="button"
              className="session-subagent-history-toggle"
              aria-expanded={historyOpen}
              onClick={(e) => {
                e.stopPropagation();
                toggleHistoryOpen();
              }}
            >
              <span className="github-panel-ci-dot good" />
              {historyOpen ? "▾" : "▸"} {finished.length} done
              {lastFinishedAt != null && ` · last ${formatRelativeAge(lastFinishedAt)}`}
            </button>
          )}
        </div>
      )}
      {/* Gated on showSubagentsRow, same as the toggle button above whose
        click sets `historyOpen` in the first place — that toggle lives
        inside the showSubagentsRow block, but the persisted open/closed
        state itself is keyed only by sessionId (crs.expandedSubagentHistory),
        not per-view. Without this same gate here, a session viewed both in
        the sidebar and as a showSubagents={false} kanban card
        (LaneCard.tsx) would leak the history list onto the card with no
        toggle rendered there to close it. */}
      {showSubagentsRow && historyOpen && finished.length > 0 && (
        <div className="session-subagent-history" onClick={(e) => e.stopPropagation()}>
          {finished.map((subagent) => (
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
