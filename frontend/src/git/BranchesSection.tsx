import { useMemo, useState } from "react";
import { api } from "../api/index.js";
import type { GitBranchInfo, GitHubPROrWithChecks, GitWorktreeInfo } from "../api/types.js";
import { PHASE_LABEL } from "../github/prPhase.js";
import { describeError } from "../lib/describeError.js";
import { statusTone, type Tone } from "../lib/statusTone.js";
import { useDashboardStore } from "../store/index.js";
import { ConfirmButton } from "../ui/ConfirmButton.js";
import {
  GitBranchIcon,
  GlobeIcon,
  HistoryIcon,
  PlayTriangleIcon,
  PlusIcon,
  PullIcon,
  SearchIcon,
  TrashIcon,
} from "../ui/icons.js";
import {
  IconButton,
  SessionPills,
  SidebarRow,
  SidebarSection,
  StatusChip,
  TaskChip,
} from "../ui/sidebar/index.js";
import { isTaskBranch, type MullionLinks } from "../hooks/useMullionLinks.js";
import { useBranchPreview } from "../hooks/useBranchPreview.js";
import { groupBranches, isPrunable, mergeChip } from "./branchGroups.js";
import { rebaseNotice, runBranchOp } from "./branchOps.js";
import {
  deleteBranchTitle,
  FORCEABLE_REASONS,
  isDefaultBranchName,
  reasonMessage,
} from "./gitReasons.js";
import { NewBranchForm } from "./NewBranchForm.js";
import { openSessionOn } from "./sessionLaunch.js";
import { refreshGitEverywhere } from "./useSourceControl.js";
import { SearchInput } from "../ui/primitives.js";

interface RowError {
  message: string;
  reason?: string;
}

function branchTone(
  b: GitBranchInfo,
  pr: GitHubPROrWithChecks | undefined,
  prunable: boolean,
  taskOwned: boolean,
): Tone {
  if (b.isCurrent) return "info";
  if (taskOwned || prunable) return "merged";
  if (pr?.prPhase) return statusTone({ phase: pr.prPhase });
  return "neutral";
}

export interface BranchesSectionProps {
  projectId: number;
  branches: readonly GitBranchInfo[];
  worktrees: readonly GitWorktreeInfo[];
  defaultBranch: string | null | undefined;
  links: MullionLinks;
  onOpenBranch: (name: string) => void;
  onPrune: () => void;
  onReload: () => void;
}

/** Search, grouped branch rows with Mullion links, hover actions, and the Prune entry. */
export function BranchesSection({
  projectId,
  branches,
  worktrees,
  defaultBranch,
  links,
  onOpenBranch,
  onPrune,
  onReload,
}: BranchesSectionProps) {
  const prs = useDashboardStore((s) => s.prsByProject[projectId]?.prs);
  const openRightSidebarHistory = useDashboardStore((s) => s.openRightSidebarHistory);
  const openRightSidebarPr = useDashboardStore((s) => s.openRightSidebarPr);
  const pushToast = useDashboardStore((s) => s.pushToast);
  const [filter, setFilter] = useState("");
  // So a double click can't make two sessions racing the worktree the first creates.
  const [opening, setOpening] = useState<ReadonlySet<string>>(new Set());
  const [rowErrors, setRowErrors] = useState<Record<string, RowError>>({});
  // One checkout/rebase at a time: both move the same checkout's HEAD.
  const [moving, setMoving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [prevProjectId, setPrevProjectId] = useState(projectId);
  if (projectId !== prevProjectId) {
    setPrevProjectId(projectId);
    setRowErrors({});
    setFilter("");
    setCreating(false);
  }

  const prByBranch = useMemo(() => new Map((prs ?? []).map((p) => [p.headBranch, p])), [prs]);
  const openPrBranches = useMemo(() => new Set(prByBranch.keys()), [prByBranch]);
  const groups = useMemo(
    () => groupBranches(branches, { worktrees, defaultBranch, links, openPrBranches, filter }),
    [branches, worktrees, defaultBranch, links, openPrBranches, filter],
  );

  // Keyed by project: a request that settles after a project switch must not
  // paint on the new project's same-named branch (its Force would carry the
  // old project's id).
  const errorKey = (pid: number, name: string) => `${pid}:branch:${name}`;
  const setError = (name: string, error: RowError | null) => {
    const key = errorKey(projectId, name);
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

  const deleteBranch = async (name: string, force = false) => {
    try {
      const result = await api.deleteProjectGitBranch(projectId, name, force);
      if (result.deleted) {
        setError(name, null);
        refreshGitEverywhere(projectId);
        onReload();
        return;
      }
      setError(name, {
        message: reasonMessage(result.reason, result.detail),
        reason: result.reason,
      });
    } catch (err) {
      setError(name, { message: describeError(err, "Request failed — try again.") });
    }
  };

  // Issue #1672 — guarded checkout / rebase. A refusal lands on the row,
  // inline, without a `reason`: none of these offer a Force.
  const moveHead = async (name: string, kind: "checkout" | "rebase") => {
    if (moving) return;
    setMoving(true);
    const outcome = await runBranchOp(
      projectId,
      () =>
        kind === "checkout"
          ? api.checkoutProjectGitBranch(projectId, name)
          : api.rebaseProjectGitBranch(projectId),
      kind === "checkout" ? () => `Checked out ${name}.` : rebaseNotice,
    );
    setMoving(false);
    if (!outcome.ok) {
      setError(name, { message: outcome.message });
      return;
    }
    setError(name, null);
    pushToast({ message: outcome.notice, kind: "success" });
    onReload();
  };

  const openSession = async (name: string) => {
    const flightKey = `${projectId}:${name}`;
    if (opening.has(flightKey)) return;
    setOpening((prev) => new Set(prev).add(flightKey));
    try {
      await openSessionOn(projectId, { branch: name });
      setError(name, null);
    } catch (err) {
      setError(name, { message: describeError(err, "Could not start a session.") });
    } finally {
      setOpening((prev) => {
        const next = new Set(prev);
        next.delete(flightKey);
        return next;
      });
    }
  };

  const branchPreview = useBranchPreview(projectId);

  const total = branches.length;
  const prunableCount = groups.find((g) => g.id === "prunable")?.branches.length ?? 0;

  return (
    <SidebarSection
      title="Branches"
      count={total}
      persistKey="git.branches"
      defaultOpen
      actions={
        <IconButton label="New branch" onClick={() => setCreating((c) => !c)}>
          <PlusIcon size={13} />
        </IconButton>
      }
    >
      {creating && (
        <NewBranchForm
          projectId={projectId}
          defaultFrom={
            defaultBranch?.replace(/^refs\/remotes\//, "") ??
            branches.find((b) => b.isCurrent)?.name ??
            ""
          }
          onDone={(notice) => {
            setCreating(false);
            pushToast({ message: notice, kind: "success" });
            onReload();
          }}
          onCancel={() => setCreating(false)}
        />
      )}
      <label className="sc-search ui-input-wrap">
        <SearchIcon size={13} />
        <SearchInput
          small
          aria-label="Filter branches"
          placeholder="Filter branches…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </label>
      {groups.length === 0 && (
        <div className="sc-empty">{filter ? "No branch matches the filter." : "No branches."}</div>
      )}
      {groups.map((g) => (
        <div key={g.id} className="sc-group" role="group" aria-label={g.title}>
          <div className="sc-group-h">
            <b>{g.title}</b>
            <span className="sb-count">{g.branches.length}</span>
            {g.id === "prunable" && (
              <button type="button" className="sc-link" onClick={onPrune}>
                Prune…
              </button>
            )}
          </div>
          {g.branches.map((b) => {
            const entry = links.byBranch.get(b.name);
            const pr = prByBranch.get(b.name);
            const prInfo = pr
              ? { number: pr.number, state: "open" as const }
              : b.pr
                ? { number: b.pr.number, state: b.pr.state }
                : null;
            const taskOwned = isTaskBranch(b.name) || entry?.taskOwned === true;
            const prunable = isPrunable(b, worktrees, defaultBranch, links);
            const worktree = worktrees.find((w) => w.branch === b.name && !w.isMain);
            const isDefault = isDefaultBranchName(b.name, defaultBranch);
            const merge = b.mergeState && !isDefault ? mergeChip(b.mergeState, b.pr) : null;
            const error = rowErrors[errorKey(projectId, b.name)];
            const blocked = b.isCurrent
              ? "Cannot delete the current branch"
              : isDefault
                ? "Cannot delete the default branch"
                : worktree
                  ? `Checked out in ${worktree.path.split("/").pop()}`
                  : null;
            return (
              <SidebarRow
                key={b.name}
                lead={
                  <span
                    className={`sb-dot sb-dot--${branchTone(b, pr, prunable, taskOwned)}`}
                    aria-hidden="true"
                  />
                }
                title={
                  <span title={b.upstream ? `${b.name}\nTracks: ${b.upstream}` : b.name}>
                    {b.name}
                  </span>
                }
                meta={
                  <>
                    {(b.ahead ?? 0) > 0 && <span className="gh-add">↑{b.ahead} </span>}
                    {(b.behind ?? 0) > 0 && <span className="gh-del">↓{b.behind} </span>}
                    {b.lastCommitRelative}
                  </>
                }
                trailing={
                  <>
                    {b.isCurrent && <StatusChip tone="info">current</StatusChip>}
                    {prInfo && (
                      <StatusChip
                        tone={pr?.prPhase ? statusTone({ phase: pr.prPhase }) : "neutral"}
                        short={`#${prInfo.number}`}
                        title={
                          pr?.prPhase
                            ? `PR #${prInfo.number} — ${PHASE_LABEL[pr.prPhase]}`
                            : `PR #${prInfo.number} (${prInfo.state})`
                        }
                        onClick={() => openRightSidebarPr(projectId, prInfo.number)}
                      >
                        {`#${prInfo.number}${pr?.prPhase ? ` · ${PHASE_LABEL[pr.prPhase]}` : ""}`}
                      </StatusChip>
                    )}
                    {merge && (
                      <StatusChip tone={merge.tone} short={merge.short} title={merge.title}>
                        {merge.label}
                      </StatusChip>
                    )}
                  </>
                }
                extra={
                  (entry && (entry.sessions.length > 0 || entry.task || taskOwned)) || error ? (
                    <>
                      {(entry?.sessions.length ?? 0) > 0 && (
                        <SessionPills links={entry?.sessions ?? []} />
                      )}
                      {(entry?.task || taskOwned) && (
                        <div className="sc-task-line">
                          {entry?.task ? (
                            <TaskChip task={entry.task} locked={taskOwned} />
                          ) : (
                            <StatusChip tone="merged" title="Owned by a Task Master task">
                              🔒 task branch
                            </StatusChip>
                          )}
                        </div>
                      )}
                      {error && (
                        <div className="sc-row-error" role="alert">
                          {error.message}
                          {error.reason && FORCEABLE_REASONS.has(error.reason) && (
                            <ConfirmButton
                              title="Force delete"
                              onConfirm={() => void deleteBranch(b.name, true)}
                              armedLabel="Confirm"
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
                    {b.isCurrent ? (
                      <ConfirmButton
                        variant="neutral"
                        compact
                        title="Rebase onto its upstream (or the default branch)"
                        disabled={moving}
                        onConfirm={() => void moveHead(b.name, "rebase")}
                      >
                        <PullIcon size={13} />
                      </ConfirmButton>
                    ) : (
                      <IconButton
                        label={
                          worktree
                            ? `Can't check out — in use by ${worktree.path.split("/").pop()}`
                            : "Check out"
                        }
                        onClick={() => void moveHead(b.name, "checkout")}
                        disabled={moving || worktree !== undefined}
                      >
                        <GitBranchIcon size={13} />
                      </IconButton>
                    )}
                    <IconButton
                      label={
                        entry?.sessions.length
                          ? "Open session on branch (another)"
                          : "Open session on branch"
                      }
                      onClick={() => void openSession(b.name)}
                      disabled={opening.has(`${projectId}:${b.name}`)}
                    >
                      <PlayTriangleIcon size={13} />
                    </IconButton>
                    <IconButton
                      label={entry?.preview ? "Open preview" : "Preview this branch"}
                      onClick={() =>
                        void branchPreview.open(
                          { kind: "branch", branch: b.name, isCurrent: b.isCurrent },
                          entry?.preview,
                        )
                      }
                      disabled={branchPreview.starting.has(`branch:${b.name}`)}
                    >
                      <GlobeIcon size={13} />
                    </IconButton>
                    <IconButton
                      label="View in History"
                      onClick={() => openRightSidebarHistory(projectId, `branch:${b.name}`)}
                    >
                      <HistoryIcon size={13} />
                    </IconButton>
                    {/* One arm-and-confirm, always forced: the title says what is
                        at stake, so a refusal-then-Force second round trip adds
                        nothing. A task-owned branch is deletable too — the
                        backend only guards a still-resumable one, and the title
                        names it. */}
                    <ConfirmButton
                      compact
                      title={blocked ?? deleteBranchTitle(b.mergeState, entry?.task?.id)}
                      disabled={blocked !== null}
                      onConfirm={() => void deleteBranch(b.name, true)}
                    >
                      <TrashIcon size={13} />
                    </ConfirmButton>
                  </>
                }
                onClick={() => onOpenBranch(b.name)}
              />
            );
          })}
        </div>
      ))}
      {prunableCount === 0 && total > 0 && !filter && (
        <div className="sc-empty">Nothing to prune.</div>
      )}
    </SidebarSection>
  );
}
