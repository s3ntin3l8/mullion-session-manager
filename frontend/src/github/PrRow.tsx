import { useEffect, useRef, useState } from "react";
import type { GitHubPROrWithChecks, Task } from "../api/types.js";
import type { MullionLinkEntry } from "../hooks/useMullionLinks.js";
import { useRunJobs } from "../hooks/useGitHubData.js";
import { useDashboardStore } from "../store/index.js";
import { ThreadIcon } from "../ui/icons.js";
import {
  Button,
  SessionPills,
  SidebarRow,
  StatusChip,
  StatusTriad,
  TaskChip,
  type TriadItem,
} from "../ui/sidebar/index.js";
import { ChecksDrill, MergeDrill, ReviewsDrill } from "./PrStatusViews.js";
import { prStatuses, prTriadItems, relayPillTitle, runIdFromUrl } from "./prPhase.js";

const HOVER_PREFETCH_MS = 120;

/** One PR: status first — the CI / Review / Merge triad is always on show. */
export function PrRow({
  pr,
  projectId,
  links,
  onOpen,
}: {
  pr: GitHubPROrWithChecks;
  projectId: number;
  links: MullionLinkEntry | undefined;
  onOpen: (number: number) => void;
}) {
  const [openKey, setOpenKey] = useState<TriadItem["key"] | null>(null);
  const prefetchGithubPr = useDashboardStore((st) => st.prefetchGithubPr);
  // Cached per run, so closing, re-opening or coming back from the PR detail
  // keeps the jobs instead of refetching them.
  const runIds = pr.actionsRuns.flatMap((run) => {
    const id = runIdFromUrl(run.htmlUrl);
    return id == null ? [] : [id];
  });
  const jobsByRun = useRunJobs(projectId, runIds, openKey === "ci");

  // A short intent delay, so sweeping the pointer down a long list doesn't
  // fire a live GitHub call per row it crosses.
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelWarm = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  };
  const warmDetail = () => {
    cancelWarm();
    hoverTimer.current = setTimeout(
      () => prefetchGithubPr(projectId, pr.number),
      HOVER_PREFETCH_MS,
    );
  };
  useEffect(() => cancelWarm, []);

  const statuses = prStatuses(pr, pr.relayReview ?? null, jobsByRun);
  const toggle = (key: TriadItem["key"]) => setOpenKey((k) => (k === key ? null : key));

  const task =
    links?.task ??
    (pr.taskId != null && pr.taskStatus
      ? { id: pr.taskId, status: pr.taskStatus as Task["status"] }
      : null);
  const run = links?.reviewRun;
  const reviewers = pr.reviewSummary
    ? [
        ...pr.reviewSummary.approved.map((login) => ({ login, state: "APPROVED" })),
        ...pr.reviewSummary.changesRequested.map((login) => ({
          login,
          state: "CHANGES_REQUESTED",
        })),
        ...pr.reviewSummary.commented.map((login) => ({ login, state: "COMMENTED" })),
      ]
    : (pr.reviewers ?? []);
  const requested = pr.reviewSummary?.requested ?? pr.requestedReviewers ?? [];
  const threads = pr.unresolvedThreads ?? 0;

  const sessions = links?.sessions ?? [];
  const showLinks = sessions.length > 0 || !!task || !!run;

  return (
    <div
      className="pr-row"
      data-pr={pr.number}
      onMouseEnter={warmDetail}
      onMouseLeave={cancelWarm}
      onFocus={warmDetail}
      onBlur={cancelWarm}
    >
      <SidebarRow
        lead={<span className={`sb-dot sb-dot--${statuses.merge.tone}`} aria-hidden="true" />}
        title={pr.title}
        meta={
          <>
            <span className="mono">#{pr.number}</span> · {pr.headBranch} → {pr.baseBranch}
            {pr.author ? ` · ${pr.author}` : ""}
          </>
        }
        trailing={
          threads > 0 ? (
            <span
              className="pr-threads"
              title={`${threads} unresolved review thread${threads === 1 ? "" : "s"}`}
            >
              <ThreadIcon size={13} />
              {threads}
            </span>
          ) : undefined
        }
        onClick={() => onOpen(pr.number)}
        extra={
          <>
            <StatusTriad items={prTriadItems(statuses, toggle)} openKey={openKey} />
            {showLinks && (
              <div className="pr-row-links">
                {sessions.length > 0 && <SessionPills links={sessions} />}
                {task && <TaskChip task={task} />}
                {run && (
                  <StatusChip
                    tone={
                      run.state === "landed"
                        ? pr.relayReview?.verdict === "CHANGES_REQUESTED"
                          ? "danger"
                          : "success"
                        : run.unverified
                          ? "neutral"
                          : "info"
                    }
                    title={pr.relayReview ? relayPillTitle(pr.relayReview) : "Review requested"}
                  >
                    {run.state === "landed"
                      ? "review posted"
                      : run.unverified
                        ? "review unconfirmed"
                        : "review running"}
                  </StatusChip>
                )}
              </div>
            )}
            {openKey === "ci" && (
              <ChecksDrill
                projectId={projectId}
                runs={pr.actionsRuns}
                jobsByRun={jobsByRun}
                title={`Checks · ${statuses.ci.text}`}
              />
            )}
            {openKey === "review" && (
              <ReviewsDrill
                reviewers={reviewers}
                requested={requested}
                status={statuses.review}
                title={`Reviews · ${statuses.review.text}`}
              />
            )}
            {openKey === "merge" && (
              <MergeDrill text={`Merge · ${statuses.merge.text}`}>
                <Button size="sm" onClick={() => onOpen(pr.number)}>
                  Open pull request
                </Button>
              </MergeDrill>
            )}
          </>
        }
      />
    </div>
  );
}
