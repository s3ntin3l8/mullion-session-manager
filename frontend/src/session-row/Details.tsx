import type {
  BackgroundTask,
  GitDiffStats,
  GitHubPROrWithChecks,
  GitStatus,
  SubagentInfo,
} from "../api/index.js";
import type { FileChangeSummary } from "../lib/sidebarStatus.js";
import { Chips } from "./Chips.js";
import { FileChanges } from "./FileChanges.js";
import { GitLine } from "./GitLine.js";

// Sidebar declutter — SessionRow's history/detail sections (git, files,
// agents, the agent's last message), all folded behind the row's single
// details chevron by default. Replaces the old always-rendered rows 3/4/5/6,
// which is what let a long-running session's sidebar entry balloon into a
// wall of history (subagent chips, file chips, git info) with no way to
// collapse any of it — see Sidebar.tsx's SessionRow for the fold state and
// the `foldDetails` escape hatch LaneCard.tsx uses to keep its own files/
// background-tasks rows unconditionally visible, matching their pre-existing
// kanban-card behavior.
export interface DetailsProps {
  open: boolean;
  sessionId: number;
  // Row: git — same guard/props GitLine always used (issue #202).
  gitStatus: GitStatus | null | undefined;
  displayBranch: string | null | undefined;
  worktreeLabel: string | null;
  effectiveCwd: string;
  matchedPr: GitHubPROrWithChecks | undefined;
  diffStats: GitDiffStats | null | undefined;
  // Row: files (issue #177) — `foldDetails` decides whether this renders
  // only when `open`, or always (LaneCard's pre-existing behavior).
  foldDetails: boolean;
  fileChanges: FileChangeSummary[];
  hiddenFileChanges: FileChangeSummary[];
  // Row: agents (Phase 5 Track A) and background tasks (issue #428).
  showSubagentsRow: boolean;
  subagents: SubagentInfo[];
  showBackgroundTasksRow: boolean;
  outstandingBackgroundTasks: BackgroundTask[];
  // Row: said — the agent's last turn, always behind the fold (new; no
  // pre-existing "always visible" case to preserve for LaneCard).
  lastAssistantMessage: string | null;
}

export function Details({
  open,
  sessionId,
  gitStatus,
  displayBranch,
  worktreeLabel,
  effectiveCwd,
  matchedPr,
  diffStats,
  foldDetails,
  fileChanges,
  hiddenFileChanges,
  showSubagentsRow,
  subagents,
  showBackgroundTasksRow,
  outstandingBackgroundTasks,
  lastAssistantMessage,
}: DetailsProps) {
  const filesVisible = fileChanges.length > 0 && (open || !foldDetails);
  const bgVisible = showBackgroundTasksRow && (open || !foldDetails);
  const agentsVisible = showSubagentsRow && open;

  if (!open && !filesVisible && !bgVisible) return null;

  return (
    <div className="session-details">
      {open && (gitStatus != null || displayBranch) && (
        <div className="session-detail-row">
          <span className="session-detail-label">git</span>
          <GitLine
            gitStatus={gitStatus}
            displayBranch={displayBranch}
            worktreeLabel={worktreeLabel}
            effectiveCwd={effectiveCwd}
            matchedPr={matchedPr}
            diffStats={diffStats}
          />
        </div>
      )}
      {filesVisible && (
        <div className="session-detail-row">
          <span className="session-detail-label">files</span>
          <FileChanges
            sessionId={sessionId}
            fileChanges={fileChanges}
            hiddenFileChanges={hiddenFileChanges}
          />
        </div>
      )}
      {(agentsVisible || bgVisible) && (
        <div className="session-detail-row">
          <span className="session-detail-label">agents</span>
          <div className="session-detail-content">
            <Chips
              sessionId={sessionId}
              showSubagentsRow={agentsVisible}
              subagents={subagents}
              showBackgroundTasksRow={bgVisible}
              outstandingBackgroundTasks={outstandingBackgroundTasks}
            />
          </div>
        </div>
      )}
      {open && lastAssistantMessage && (
        <div className="session-detail-row">
          <span className="session-detail-label">said</span>
          <span className="session-said" title={lastAssistantMessage}>
            {lastAssistantMessage}
          </span>
        </div>
      )}
    </div>
  );
}
