import { useMemo, useState } from "react";
import { api } from "../api/index.js";
import type { GitBranchInfo, GitWorktreeInfo } from "../api/types.js";
import { PHASE_LABEL } from "../github/prPhase.js";
import { describeError } from "../lib/describeError.js";
import { statusTone } from "../lib/statusTone.js";
import { useDashboardStore } from "../store/index.js";
import { ConfirmButton } from "../ui/ConfirmButton.js";
import { PlayTriangleIcon, TrashIcon } from "../ui/icons.js";
import {
  IconButton,
  SessionPills,
  SidebarRow,
  SidebarSection,
  StatusChip,
  TaskChip,
} from "../ui/sidebar/index.js";
import type { MullionLinks } from "../hooks/useMullionLinks.js";
import { FORCEABLE_REASONS, reasonMessage } from "./gitReasons.js";
import { isDevWorktree, isDockPreviewWorktree } from "./worktreeKinds.js";
import { openSessionOn } from "./sessionLaunch.js";
import { refreshGitEverywhere } from "./useSourceControl.js";

interface RowError {
  message: string;
  reason?: string;
}

export interface WorktreesSectionProps {
  projectId: number;
  worktrees: readonly GitWorktreeInfo[];
  branches: readonly GitBranchInfo[];
  links: MullionLinks;
  onReload: () => void;
}

/** Worktrees with live session pills, PR phase, "Open session here" and remove. */
export function WorktreesSection({
  projectId,
  worktrees,
  branches,
  links,
  onReload,
}: WorktreesSectionProps) {
  const prs = useDashboardStore((s) => s.prsByProject[projectId]?.prs);
  const projectName = useDashboardStore((s) => s.projects.find((p) => p.id === projectId)?.name);
  const openRightSidebarPr = useDashboardStore((s) => s.openRightSidebarPr);
  const [pruning, setPruning] = useState(false);
  const [pruneErrorState, setPruneErrorState] = useState<{
    projectId: number;
    message: string;
  } | null>(null);
  const pruneError = pruneErrorState?.projectId === projectId ? pruneErrorState.message : null;
  const [opening, setOpening] = useState<ReadonlySet<string>>(new Set());
  const [rowErrors, setRowErrors] = useState<Record<string, RowError>>({});
  const [prevProjectId, setPrevProjectId] = useState(projectId);
  if (projectId !== prevProjectId) {
    setPrevProjectId(projectId);
    setRowErrors({});
    setOpening(new Set());
  }

  const prByBranch = useMemo(() => new Map((prs ?? []).map((p) => [p.headBranch, p])), [prs]);
  const branchByName = useMemo(() => new Map(branches.map((b) => [b.name, b])), [branches]);

  // Keyed by project: a request settling after a project switch must not paint
  // on the new project (and its Force would carry the old project's id).
  const errorKey = (pid: number, path: string) => `${pid}:worktree:${path}`;
  const setError = (path: string, error: RowError | null) => {
    const key = errorKey(projectId, path);
    setRowErrors((prev) => {
      if (error === null) {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return { ...prev, [key]: error };
    });
  };

  const pruneStale = async () => {
    setPruning(true);
    setPruneErrorState(null);
    try {
      await api.pruneProjectGitWorktrees(projectId);
      refreshGitEverywhere(projectId);
      onReload();
    } catch (err) {
      setPruneErrorState({ projectId, message: describeError(err, "Prune failed — try again.") });
    } finally {
      setPruning(false);
    }
  };

  const remove = async (path: string, force = false) => {
    try {
      const result = await api.removeProjectGitWorktree(projectId, path, force);
      if (result.removed) {
        setError(path, null);
        refreshGitEverywhere(projectId);
        onReload();
        return;
      }
      setError(path, {
        message: reasonMessage(result.reason, result.detail),
        reason: result.reason,
      });
    } catch (err) {
      setError(path, { message: describeError(err, "Request failed — try again.") });
    }
  };

  // Ported from Source Control: an in-flight guard so a double click can't make two sessions.
  const openHere = async (path: string) => {
    if (opening.has(path)) return;
    setOpening((prev) => new Set(prev).add(path));
    try {
      await openSessionOn(projectId, { cwd: path });
      setError(path, null);
    } catch (err) {
      setError(path, { message: describeError(err, "Could not start a session.") });
    } finally {
      setOpening((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    }
  };

  const renderRow = (w: GitWorktreeInfo) => {
    const entry = links.byWorktree.get(w.path);
    const pr = w.branch ? prByBranch.get(w.branch) : undefined;
    const branch = w.branch ? branchByName.get(w.branch) : undefined;
    const done =
      !w.isMain &&
      isDevWorktree(w.path) &&
      (branch?.mergeState === "ancestor" ||
        branch?.mergeState === "pr-merged" ||
        branch?.mergeState === "upstream-gone");
    const basename = w.path.split("/").filter(Boolean).pop() || w.path;
    const error = rowErrors[errorKey(projectId, w.path)];
    const hasSessions = (entry?.sessions.length ?? 0) > 0;
    return (
      <SidebarRow
        key={w.path}
        lead={
          <span className={`sb-dot sb-dot--${w.isMain ? "info" : "neutral"}`} aria-hidden="true" />
        }
        title={<span title={w.path}>{w.isMain ? (projectName ?? basename) : basename}</span>}
        meta={
          <>
            <span className="mono">{w.branch ?? "(detached)"}</span>
            {w.isMain && " · primary"}
          </>
        }
        trailing={
          <>
            {pr && (
              <StatusChip
                tone={pr.prPhase ? statusTone({ phase: pr.prPhase }) : "neutral"}
                short={`#${pr.number}`}
                title={
                  pr.prPhase ? `PR #${pr.number} — ${PHASE_LABEL[pr.prPhase]}` : `PR #${pr.number}`
                }
                onClick={() => openRightSidebarPr(projectId, pr.number)}
              >
                {`#${pr.number}${pr.prPhase ? ` · ${PHASE_LABEL[pr.prPhase]}` : ""}`}
              </StatusChip>
            )}
            {isDockPreviewWorktree(w.path) && (
              <StatusChip tone="neutral" title="Made and cleaned up by a dock preview">
                auto
              </StatusChip>
            )}
            {done && (
              <StatusChip
                tone="merged"
                short="remove"
                title="Its branch is merged or gone — nothing here is unmerged work"
              >
                safe to remove
              </StatusChip>
            )}
          </>
        }
        extra={
          hasSessions || entry?.task || error ? (
            <>
              {hasSessions && <SessionPills links={entry?.sessions ?? []} />}
              {entry?.task && (
                <div className="sc-task-line">
                  <TaskChip task={entry.task} locked={entry.taskOwned} />
                </div>
              )}
              {error && (
                <div className="sc-row-error" role="alert">
                  {error.message}
                  {error.reason && FORCEABLE_REASONS.has(error.reason) && (
                    <ConfirmButton
                      title="Force remove"
                      onConfirm={() => void remove(w.path, true)}
                      armedLabel="Force remove"
                    >
                      Force
                    </ConfirmButton>
                  )}
                </div>
              )}
            </>
          ) : undefined
        }
        actions={
          <>
            <IconButton
              label="Open session here"
              onClick={() => void openHere(w.path)}
              disabled={opening.has(w.path)}
            >
              <PlayTriangleIcon size={13} />
            </IconButton>
            {!w.isMain && (
              <ConfirmButton compact title="Remove worktree" onConfirm={() => void remove(w.path)}>
                <TrashIcon size={13} />
              </ConfirmButton>
            )}
          </>
        }
      />
    );
  };

  const main = worktrees.filter((w) => w.isMain);
  const dev = worktrees.filter((w) => !w.isMain && isDevWorktree(w.path));
  const rest = worktrees.filter((w) => !w.isMain && !isDevWorktree(w.path));

  return (
    <SidebarSection
      title="Worktrees"
      count={worktrees.length}
      persistKey="git.worktrees"
      defaultOpen
      actions={
        <button
          type="button"
          className="sc-link"
          onClick={() => void pruneStale()}
          disabled={pruning}
          title="Clears administrative metadata for worktrees whose directory is already gone"
        >
          {pruning ? "Pruning…" : "Prune stale"}
        </button>
      }
    >
      {pruneError && (
        <div className="sc-row-error" role="alert">
          {pruneError}
        </div>
      )}
      {worktrees.length === 0 && <div className="sc-empty">No worktrees.</div>}
      {main.map(renderRow)}
      {rest.map(renderRow)}
      {dev.length > 0 && (
        <div className="sc-group" role="group" aria-label="Developer worktrees">
          <div className="sc-group-h">
            <b>Developer worktrees (.wt/)</b>
            <span className="sb-count">{dev.length}</span>
          </div>
          {dev.map(renderRow)}
        </div>
      )}
    </SidebarSection>
  );
}
