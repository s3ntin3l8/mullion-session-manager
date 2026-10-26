import { useEffect, useState } from "react";
import { LOCAL_HOST_ID } from "../../../src/shared/constants.js";
import { api } from "../api/index.js";
import type { GitBranchDetail } from "../api/types.js";
import type { MullionLinkEntry } from "../hooks/useMullionLinks.js";
import { describeError } from "../lib/describeError.js";
import { formatRelativeAge } from "../relativeTime.js";
import { useDashboardStore } from "../store/index.js";
import { ConfirmButton } from "../ui/ConfirmButton.js";
import { GlobeIcon, HistoryIcon, PlayTriangleIcon, TrashIcon } from "../ui/icons.js";
import {
  Button,
  DetailHeader,
  SessionPills,
  StatusChip,
  StatusTriad,
  TaskChip,
} from "../ui/sidebar/index.js";
import { mergeChip } from "./branchGroups.js";
import { prTriad } from "./prTriad.js";
import { FORCEABLE_REASONS, reasonMessage } from "./gitReasons.js";
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
  const [actionError, setActionError] = useState<{ message: string; reason?: string } | null>(null);

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
  }, [projectId, name]);

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
        : taskId != null || entry?.taskOwned
          ? `Owned by task${taskId != null ? ` #${taskId}` : ""} — can't be deleted here`
          : null;

  const remove = async (force = false) => {
    try {
      const result = await api.deleteProjectGitBranch(projectId, name, force);
      if (result.deleted) {
        refreshGitEverywhere(projectId);
        onReload();
        onBack();
        return;
      }
      setActionError({
        message: reasonMessage(result.reason, result.detail),
        reason: result.reason,
      });
    } catch (err) {
      setActionError({ message: describeError(err, "Request failed — try again.") });
    }
  };

  const openSession = async () => {
    try {
      await openSessionOn(projectId, { branch: name });
      setActionError(null);
    } catch (err) {
      setActionError({ message: describeError(err, "Could not start a session.") });
    }
  };

  const preview = async () => {
    try {
      const p = entry?.preview ?? (await api.createProjectPreview(projectId));
      window.open(`/api/previews/${encodeURIComponent(p.slug)}/open`, "_blank", "noopener");
    } catch (err) {
      setActionError({ message: describeError(err, "Could not open the preview.") });
    }
  };

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
                  <TaskChip task={owningTask} locked={taskId != null || entry?.taskOwned} />
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

        {actionError && (
          <div className="sc-row-error" role="alert">
            {actionError.message}
            {actionError.reason && FORCEABLE_REASONS.has(actionError.reason) && (
              <ConfirmButton
                title="Force delete"
                onConfirm={() => void remove(true)}
                armedLabel="Force delete"
              >
                Force
              </ConfirmButton>
            )}
          </div>
        )}
      </div>
      <div className="sc-sticky">
        <Button variant="primary" onClick={() => void openSession()}>
          <PlayTriangleIcon size={12} /> Open session
        </Button>
        {(entry?.preview || detail?.isCurrent) && (
          <Button onClick={() => void preview()}>
            <GlobeIcon size={12} /> Preview
          </Button>
        )}
        <Button onClick={() => openRightSidebarHistory(projectId, `branch:${name}`)}>
          <HistoryIcon size={12} /> History
        </Button>
        <ConfirmButton
          title={blocked ?? "Delete branch"}
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
