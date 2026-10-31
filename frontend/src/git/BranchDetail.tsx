import { useEffect, useState } from "react";
import { LOCAL_HOST_ID } from "../../../src/shared/constants.js";
import { api } from "../api/index.js";
import type { GitBranchDetail } from "../api/types.js";
import type { MullionLinkEntry } from "../hooks/useMullionLinks.js";
import { useBranchPreview } from "../hooks/useBranchPreview.js";
import { describeError } from "../lib/describeError.js";
import { formatRelativeAge } from "../relativeTime.js";
import { useDashboardStore } from "../store/index.js";
import { ConfirmButton } from "../ui/ConfirmButton.js";
import {
  GitBranchIcon,
  GlobeIcon,
  HistoryIcon,
  PlayTriangleIcon,
  PullIcon,
  TrashIcon,
} from "../ui/icons.js";
import {
  Button,
  DetailHeader,
  SessionPills,
  StatusChip,
  StatusTriad,
  TaskChip,
} from "../ui/sidebar/index.js";
import { mergeChip } from "./branchGroups.js";
import { rebaseNotice, runBranchOp } from "./branchOps.js";
import { prTriad } from "./prTriad.js";
import { deleteBranchTitle, reasonMessage } from "./gitReasons.js";
import { openSessionOn } from "./sessionLaunch.js";
import { refreshGitEverywhere } from "./useSourceControl.js";
import { useRepoUrl } from "./useRepoUrl.js";

export interface BranchDetailProps {
  projectId: number;
  name: string;
  entry: MullionLinkEntry | undefined;
  isDefault: boolean;
  onBack: () => void;
  onReload: () => void;
}

/** One branch: status triad, Mullion card, details, unique commits, sticky actions. */
export function BranchDetail({
  projectId,
  name,
  entry,
  isDefault,
  onBack,
  onReload,
}: BranchDetailProps) {
  const repoUrl = useRepoUrl(projectId);
  const pr = useDashboardStore((s) =>
    s.prsByProject[projectId]?.prs.find((p) => p.headBranch === name),
  );
  const task = useDashboardStore((s) =>
    s.tasks.find((t) => t.projectId === projectId && t.branchName === name),
  );
  const hostId = useDashboardStore((s) => s.projects.find((p) => p.id === projectId)?.hostId);
  const hostName = useDashboardStore((s) => s.hosts.find((h) => h.id === hostId)?.name);
  const openRightSidebarPr = useDashboardStore((s) => s.openRightSidebarPr);
  const openRightSidebarHistory = useDashboardStore((s) => s.openRightSidebarHistory);
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "unavailable" }
    | { kind: "error"; message: string }
    | { kind: "ready"; detail: GitBranchDetail }
  >({ kind: "loading" });
  // So a double click can't make two sessions.
  const [starting, setStarting] = useState(false);
  const [actionError, setActionError] = useState<{ message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  // Bumped after a checkout/rebase, which changes what this view shows.
  const [loadKey, setLoadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api
      .getProjectGitBranch(projectId, name)
      .then((detail) => {
        if (!cancelled) setState(detail ? { kind: "ready", detail } : { kind: "unavailable" });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({ kind: "error", message: describeError(err, "Could not load the branch.") });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, name, loadKey]);

  const detail = state.kind === "ready" ? state.detail : null;
  const taskId = detail?.taskId ?? task?.id ?? null;
  const owningTask = task ?? (taskId != null ? { id: taskId, status: "claimed" } : null);
  const prNumber = pr?.number ?? detail?.pr?.number ?? null;
  const blocked = detail?.isCurrent
    ? "Cannot delete the current branch"
    : isDefault
      ? "Cannot delete the default branch"
      : detail?.worktreePath
        ? `Checked out in ${detail.worktreePath.split("/").pop()}`
        : null;

  const remove = async () => {
    try {
      const result = await api.deleteProjectGitBranch(projectId, name, true);
      if (result.deleted) {
        refreshGitEverywhere(projectId);
        onReload();
        onBack();
        return;
      }
      setActionError({ message: reasonMessage(result.reason, result.detail) });
    } catch (err) {
      setActionError({ message: describeError(err, "Request failed — try again.") });
    }
  };

  // Issue #1672 — guarded checkout / rebase. A refusal shows inline, and
  // is just a message: neither offers a Force.
  const moveHead = async (kind: "checkout" | "rebase") => {
    if (moving) return;
    setMoving(true);
    setNotice(null);
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
      setActionError({ message: outcome.message });
      return;
    }
    setActionError(null);
    setNotice(outcome.notice);
    setLoadKey((k) => k + 1);
    onReload();
  };

  const openSession = async () => {
    if (starting) return;
    setStarting(true);
    try {
      await openSessionOn(projectId, { branch: name });
      setActionError(null);
    } catch (err) {
      setActionError({ message: describeError(err, "Could not start a session.") });
    } finally {
      setStarting(false);
    }
  };

  const branchPreview = useBranchPreview(projectId);

  const merge = detail?.mergeState ? mergeChip(detail.mergeState, detail.pr) : null;

  return (
    <div className="sc-detail">
      <DetailHeader
        onBack={onBack}
        backLabel="Back to Source Control"
        title={<span className="mono">{name}</span>}
        subtitle={detail?.isCurrent ? "current branch" : undefined}
        externalUrl={
          repoUrl ? `${repoUrl}/tree/${encodeURIComponent(name).replaceAll("%2F", "/")}` : null
        }
        externalLabel="Open branch on GitHub"
      />
      <div className="sc-scroll">
        {state.kind === "loading" && <div className="sc-empty">Loading…</div>}
        {state.kind === "unavailable" && (
          <div className="sc-empty">
            Branch details are only available for projects on this host.
          </div>
        )}
        {state.kind === "error" && (
          <div className="sc-row-error" role="alert">
            {state.message}
          </div>
        )}

        {pr && (
          <div className="sc-card">
            <div className="sc-card-h">Status · PR #{pr.number}</div>
            <div className="sc-card-b">
              <StatusTriad items={prTriad(pr, () => openRightSidebarPr(projectId, pr.number))} />
              <Button size="sm" block onClick={() => openRightSidebarPr(projectId, pr.number)}>
                Open PR #{pr.number}
              </Button>
            </div>
          </div>
        )}

        <div className="sc-card">
          <div className="sc-card-h">Mullion</div>
          <div className="sc-card-b">
            <dl className="sc-kv">
              <dt>Sessions</dt>
              <dd>
                {entry && entry.sessions.length > 0 ? (
                  <SessionPills links={entry.sessions} />
                ) : (
                  "— none —"
                )}
              </dd>
              <dt>Task</dt>
              <dd>
                {owningTask ? (
                  <TaskChip
                    task={owningTask}
                    locked={taskId != null || entry?.taskOwned}
                    sessions={entry?.sessions}
                    reviewInFlight={entry?.reviewRun?.state === "requested"}
                  />
                ) : (
                  "— none —"
                )}
              </dd>
              {entry?.reviewRun && (
                <>
                  <dt>Review run</dt>
                  <dd>
                    <StatusChip tone="info">
                      {entry.reviewRun.state === "requested" ? "running" : "landed"}
                      {entry.reviewRun.status ? ` · ${entry.reviewRun.status}` : ""}
                    </StatusChip>
                  </dd>
                </>
              )}
              {entry?.preview && (
                <>
                  <dt>Preview</dt>
                  <dd>
                    <StatusChip tone="success">dock preview</StatusChip>
                  </dd>
                </>
              )}
              {hostId && hostId !== LOCAL_HOST_ID && (
                <>
                  <dt>Host</dt>
                  <dd>{hostName ?? hostId}</dd>
                </>
              )}
            </dl>
          </div>
        </div>

        {detail && (
          <div className="sc-card">
            <div className="sc-card-h">Details</div>
            <div className="sc-card-b">
              <dl className="sc-kv">
                {detail.upstream && (
                  <>
                    <dt>Upstream</dt>
                    <dd className="mono">
                      {detail.upstream}
                      {detail.upstreamGone && " (gone)"}
                      {!detail.upstreamGone && (detail.upstreamAhead || detail.upstreamBehind) ? (
                        <>
                          {" "}
                          <span className="gh-add">↑{detail.upstreamAhead ?? 0}</span>{" "}
                          <span className="gh-del">↓{detail.upstreamBehind ?? 0}</span>
                        </>
                      ) : null}
                    </dd>
                  </>
                )}
                {detail.base && (
                  <>
                    <dt>vs {detail.base.replace(/^origin\//, "")}</dt>
                    <dd>
                      <span className="gh-add">↑{detail.baseAhead ?? 0}</span>{" "}
                      <span className="gh-del">↓{detail.baseBehind ?? 0}</span>
                    </dd>
                  </>
                )}
                <dt>Merge state</dt>
                <dd>
                  {merge ? (
                    <StatusChip tone={merge.tone} title={merge.title}>
                      {merge.label}
                    </StatusChip>
                  ) : (
                    "not merged"
                  )}
                </dd>
                {detail.worktreePath && (
                  <>
                    <dt>Worktree</dt>
                    <dd className="mono" title={detail.worktreePath}>
                      {detail.worktreePath.split("/").slice(-2).join("/")}
                    </dd>
                  </>
                )}
                {prNumber != null && !pr && (
                  <>
                    <dt>PR</dt>
                    <dd>
                      <StatusChip
                        tone="neutral"
                        onClick={() => openRightSidebarPr(projectId, prNumber)}
                      >
                        {`#${prNumber} (${detail.pr?.state ?? "?"})`}
                      </StatusChip>
                    </dd>
                  </>
                )}
              </dl>
            </div>
          </div>
        )}

        {detail && (
          <section className="sc-card">
            <div className="sc-card-h">
              Commits only on this branch
              <span className="sb-count">
                {detail.uniqueCommits.length}
                {detail.uniqueTruncated ? "+" : ""}
              </span>
            </div>
            {detail.base === null && (
              <div className="sc-empty">No base branch to compare against.</div>
            )}
            {detail.base !== null && detail.uniqueCommits.length === 0 && (
              <div className="sc-empty">Nothing the base branch doesn’t have.</div>
            )}
            {detail.uniqueCommits.map((c) => (
              <button
                key={c.sha}
                type="button"
                className="sc-commit"
                title={`${c.sha.slice(0, 7)} · ${c.author} — show in History`}
                onClick={() => openRightSidebarHistory(projectId, `branch:${name}`)}
              >
                <span className="sc-commit-subj">{c.subject}</span>
                <span className="sc-commit-when">{formatRelativeAge(c.time * 1000)}</span>
              </button>
            ))}
          </section>
        )}

        {notice && (
          <div className="sc-note" role="status">
            {notice}
          </div>
        )}
        {actionError && (
          <div className="sc-row-error" role="alert">
            {actionError.message}
          </div>
        )}
      </div>
      <div className="sc-sticky">
        <Button variant="primary" onClick={() => void openSession()} disabled={starting}>
          <PlayTriangleIcon size={12} /> Open session
        </Button>
        <Button
          onClick={() =>
            void branchPreview.open(
              { kind: "branch", branch: name, isCurrent: detail?.isCurrent },
              entry?.preview,
            )
          }
          disabled={branchPreview.starting.has(`branch:${name}`)}
        >
          <GlobeIcon size={12} /> {entry?.preview ? "Open preview" : "Preview"}
        </Button>
        <Button onClick={() => openRightSidebarHistory(projectId, `branch:${name}`)}>
          <HistoryIcon size={12} /> History
        </Button>
        {detail?.isCurrent ? (
          <ConfirmButton
            variant="neutral"
            title="Rebase onto its upstream (or the default branch)"
            armedLabel="Confirm rebase"
            disabled={moving}
            onConfirm={() => void moveHead("rebase")}
          >
            <PullIcon size={12} /> Rebase…
          </ConfirmButton>
        ) : (
          detail && (
            <Button
              disabled={moving || detail.worktreePath !== null}
              title={
                detail.worktreePath
                  ? `Can't check out — in use by ${detail.worktreePath.split("/").pop()}`
                  : "Check out this branch in the project checkout"
              }
              onClick={() => void moveHead("checkout")}
            >
              <GitBranchIcon size={12} /> Checkout
            </Button>
          )
        )}
        <ConfirmButton
          title={blocked ?? deleteBranchTitle(detail?.mergeState, taskId)}
          disabled={blocked !== null}
          onConfirm={() => void remove()}
          armedLabel="Delete"
        >
          <TrashIcon size={12} /> Delete…
        </ConfirmButton>
      </div>
    </div>
  );
}
