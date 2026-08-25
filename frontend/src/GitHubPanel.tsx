import { useCallback, useEffect, useState } from "react";
import { api } from "./api/index.js";
import type {
  GitHubActionsRun,
  GitHubJob,
  GitHubLogResponse,
  GitHubPRsStatus,
  GitHubPROrWithChecks,
  GitHubStatus,
  ProjectReleaseStatus,
  ReleaseRunReason,
  ReleaseMergeReason,
} from "./api/index.js";
import { ChevronDownIcon, GitHubIcon } from "./ui/icons.js";
import { useAsyncData } from "./hooks/useAsyncData.js";
import { useDashboardStore } from "./store/index.js";
import { EmptyStateNote } from "./ui/EmptyState.js";

export interface GitHubPanelParams {
  projectId: number;
}

function runIdFromUrl(url: string): number | null {
  const match = url.match(/\/actions\/runs\/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

function runDotClass(run: GitHubActionsRun): "good" | "bad" | "pending" {
  if (run.status !== "completed") return "pending";
  return run.conclusion === "success" ? "good" : "bad";
}

function ciDotClass(status: "success" | "failure" | "in_progress"): "good" | "bad" | "pending" {
  if (status === "success") return "good";
  if (status === "failure") return "bad";
  return "pending";
}

function CollapsibleSection({
  expanded,
  children,
}: {
  expanded: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="github-panel-collapsible">
      {expanded && <div className="github-panel-collapsible-body">{children}</div>}
    </div>
  );
}

function JobRow({ projectId, runId, job }: { projectId: number; runId: number; job: GitHubJob }) {
  const [log, setLog] = useState<GitHubLogResponse | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);

  const fetchLog = useCallback(() => {
    if (log !== undefined) {
      setLog(log ? null : undefined);
      return;
    }
    setLoading(true);
    api
      .getGitHubLogs(projectId, runId, job.id)
      .then((r) => {
        setLog(r);
      })
      .catch(() => setLog(null))
      .finally(() => setLoading(false));
  }, [projectId, runId, job.id, log]);

  return (
    <div className="github-panel-job-row">
      <button
        className="github-panel-run-row"
        onClick={(e) => {
          e.stopPropagation();
          fetchLog();
        }}
      >
        <span
          className={`github-panel-ci-dot ${job.conclusion === "success" ? "good" : job.conclusion === "failure" ? "bad" : "pending"}`}
        />
        <span className="github-panel-run-name">{job.name}</span>
        <span className="github-panel-run-status">
          {job.status === "completed" ? (job.conclusion ?? "unknown") : job.status}
        </span>
        <ChevronDownIcon
          size={10}
          style={{ transform: log != null ? "rotate(180deg)" : undefined, flexShrink: 0 }}
        />
      </button>
      {loading && <div className="github-panel-empty-row indent-job">Loading logs…</div>}
      {log && log.log && (
        <pre className="github-panel-log" onClick={(e) => e.stopPropagation()}>
          {log.log}
          {log.truncated && (
            <span className="github-panel-log-truncated">… ({log.lineCount} lines shown)</span>
          )}
        </pre>
      )}
      {log && !log.log && <div className="github-panel-empty-row indent-job">No log output</div>}
    </div>
  );
}

function WorkflowRunRow({ projectId, run }: { projectId: number; run: GitHubActionsRun }) {
  const [expanded, setExpanded] = useState(false);
  const [jobs, setJobs] = useState<GitHubJob[] | null | undefined>(undefined);

  const toggle = useCallback(() => {
    const next = !expanded;
    setExpanded(next);
    if (next && jobs === undefined) {
      const runId = runIdFromUrl(run.htmlUrl);
      if (runId == null) {
        setJobs(null);
        return;
      }
      api
        .getGitHubRunJobs(projectId, runId)
        .then((j) => setJobs(j))
        .catch(() => setJobs(null));
    }
  }, [expanded, jobs, projectId, run.htmlUrl]);

  const runId = runIdFromUrl(run.htmlUrl);
  if (runId == null) {
    return (
      <a href={run.htmlUrl} target="_blank" rel="noreferrer" className="github-panel-run-row">
        <span className={`github-panel-ci-dot ${runDotClass(run)}`} />
        <span className="github-panel-run-name">{run.name}</span>
        <span className="github-panel-run-status">
          {run.status === "completed" ? (run.conclusion ?? "unknown") : run.status}
        </span>
      </a>
    );
  }

  return (
    <div className="github-panel-run-group">
      <button
        className="github-panel-run-row"
        onClick={(e) => {
          e.stopPropagation();
          toggle();
        }}
      >
        <span className={`github-panel-ci-dot ${runDotClass(run)}`} />
        <span className="github-panel-run-name">{run.name}</span>
        <span className="github-panel-run-status">
          {run.status === "completed" ? (run.conclusion ?? "unknown") : run.status}
        </span>
        <ChevronDownIcon
          size={10}
          style={{ transform: expanded ? "rotate(180deg)" : undefined, flexShrink: 0 }}
        />
      </button>
      {expanded && jobs !== undefined && jobs !== null && (
        <div className="github-panel-jobs">
          {jobs.map((job) => (
            <JobRow key={job.id} projectId={projectId} runId={runId} job={job} />
          ))}
        </div>
      )}
      {expanded && jobs === null && (
        <div className="github-panel-empty-row indent-job">Failed to load jobs</div>
      )}
      {expanded && jobs === undefined && (
        <div className="github-panel-empty-row indent-job">Loading jobs…</div>
      )}
    </div>
  );
}

function PRCard({ pr, projectId }: { pr: GitHubPROrWithChecks; projectId: number }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="github-panel-pr-card">
      <button className="github-panel-pr-header" onClick={() => setExpanded(!expanded)}>
        <span className={`github-panel-ci-dot ${pr.ciStatus ? ciDotClass(pr.ciStatus) : "none"}`} />
        <a
          href={pr.htmlUrl}
          target="_blank"
          rel="noreferrer"
          className="github-panel-row-number"
          onClick={(e) => e.stopPropagation()}
        >
          #{pr.number}
        </a>
        <span className="github-panel-row-title">{pr.title}</span>
        {pr.author && <span className="github-panel-pr-author">{pr.author}</span>}
        <ChevronDownIcon
          size={12}
          style={{ transform: expanded ? "rotate(180deg)" : undefined, flexShrink: 0 }}
        />
      </button>
      <div className="github-panel-branch-labels">
        {pr.baseBranch} <span className="github-panel-branch-arrow">←</span> {pr.headBranch}
      </div>
      <CollapsibleSection expanded={expanded}>
        {pr.actionsRuns.length === 0 && (
          <div className="github-panel-empty-row indent-run">No workflow runs for this PR</div>
        )}
        {pr.actionsRuns.map((run) => (
          <WorkflowRunRow key={run.htmlUrl} projectId={projectId} run={run} />
        ))}
      </CollapsibleSection>
    </div>
  );
}

function prSummaryText(summary: GitHubPRsStatus["prSummary"]): string {
  const parts: string[] = [];
  if (summary.pass > 0) parts.push(`${summary.pass}✅`);
  if (summary.fail > 0) parts.push(`${summary.fail}❌`);
  if (summary.pending > 0) parts.push(`${summary.pending}⏳`);
  if (summary.unknown > 0) parts.push(`${summary.unknown}❓`);
  return `${summary.total} PR${summary.total === 1 ? "" : "s"} — ${parts.join(" ") || "no CI data"}`;
}

// #744 — reason→copy for the Release section's Run/Merge refusals. Same
// "a domain refusal is a normal 200, only a real HTTP error throws"
// contract GitPanel's own reasonMessage covers for Pull — see that
// function's own doc comment.
function runReasonMessage(
  reason: ReleaseRunReason | undefined,
  detail: string | undefined,
): string {
  switch (reason) {
    case "no-workflow":
      return "This repo has no release-please workflow configured.";
    case "no-dispatch-trigger":
      return "This repo's release workflow doesn't accept manual runs yet — add workflow_dispatch: to it.";
    case "dispatch-failed":
      return detail ? `Failed to start a release run: ${detail}` : "Failed to start a release run.";
    default:
      return "Failed to start a release run.";
  }
}

function mergeReasonMessage(
  reason: ReleaseMergeReason | undefined,
  detail: string | undefined,
): string {
  switch (reason) {
    case "no-release-pr":
      return "No open release PR to merge.";
    case "draft":
      return "This release PR is still a draft — mark it ready for review before merging.";
    case "computing":
      return "GitHub is still computing mergeability — try again shortly.";
    case "behind":
      // #744's own route doc comment: release-please owns and force-pushes
      // this branch, so the fix is re-running release-please, not updating
      // the branch (which this app never does for a release PR).
      return "This PR is behind the default branch — re-run release-please to regenerate it, rather than updating the branch.";
    case "blocked":
      return "A required check is red or still pending.";
    case "unstable":
      return "A non-required check is failing or still running.";
    case "dirty":
      return "This PR has a merge conflict with the default branch.";
    case "merge-failed":
      return detail ? `Merge failed: ${detail}` : "Merge failed.";
    default:
      return "Merge failed.";
  }
}

function ReleaseSection({
  projectId,
  release,
  onChanged,
}: {
  projectId: number;
  release: ProjectReleaseStatus;
  onChanged: () => void;
}) {
  const [isRunning, setIsRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [isMerging, setIsMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);

  const handleRun = useCallback(async () => {
    setIsRunning(true);
    setRunError(null);
    try {
      const result = await api.postProjectReleaseRun(projectId);
      if (result.dispatched) {
        onChanged();
      } else {
        setRunError(runReasonMessage(result.reason, result.detail));
      }
    } catch (err) {
      setRunError(
        err instanceof Error ? err.message : "Failed to start a release run — try again.",
      );
    } finally {
      setIsRunning(false);
    }
  }, [projectId, onChanged]);

  const handleMerge = useCallback(async () => {
    setIsMerging(true);
    setMergeError(null);
    try {
      const result = await api.postProjectReleaseMerge(projectId);
      if (result.merged) {
        onChanged();
      } else {
        setMergeError(mergeReasonMessage(result.reason, result.detail));
      }
    } catch (err) {
      setMergeError(err instanceof Error ? err.message : "Merge failed — try again.");
    } finally {
      setIsMerging(false);
    }
  }, [projectId, onChanged]);

  // Hidden entirely when this repo isn't a release-please repo — but NOT
  // collapsed together with "the token can't tell" (docs/github-
  // integration.md's Current-limitations section already regrets doing
  // exactly that for the CI dot: "no UI signal distinguishing 'no
  // workflows' from 'no permission'"). "no-actions-scope" gets a small,
  // dismissable-by-just-not-looking note instead of silence, so a repo that
  // DOES use release-please but is missing `Actions: read` doesn't look
  // indistinguishable from one that simply doesn't use it.
  if (release.detection.kind === "not-configured") return null;
  if (release.detection.kind === "no-actions-scope") {
    return (
      <div className="github-panel-section">
        <div className="github-panel-section-title">Release</div>
        <div className="github-panel-empty-row">
          Can't check for a release-please workflow — the connected token lacks{" "}
          <code>Actions: read</code>.
        </div>
      </div>
    );
  }

  const pr = release.pr;
  const canMerge =
    pr !== null && !pr.draft && pr.mergeable === true && pr.mergeableState === "clean";

  return (
    <div className="github-panel-section">
      <div className="github-panel-section-title">Release</div>
      <div className="git-panel-sync-row">
        <span className="git-panel-ahead-behind">
          {pr ? (
            <a
              href={pr.htmlUrl}
              target="_blank"
              rel="noreferrer"
              className="github-panel-row-number"
            >
              #{pr.number}
            </a>
          ) : (
            "No release PR open"
          )}
        </span>
        <span className="git-panel-sync-controls">
          <button
            className="git-panel-fetch-btn"
            onClick={handleRun}
            disabled={isRunning}
            title="Run release-please now, without waiting for the next push to the default branch"
          >
            {isRunning ? "⟳" : "▶"} Run
          </button>
          <button
            className="git-panel-fetch-btn"
            onClick={handleMerge}
            disabled={isMerging || !canMerge}
            title={
              pr === null
                ? "No release PR open"
                : canMerge
                  ? "Merge this release"
                  : `Not ready to merge (${pr.draft ? "draft" : pr.mergeableState})`
            }
          >
            {isMerging ? "⟳" : "✓"} Merge
          </button>
        </span>
      </div>
      {pr && (
        <div className="github-panel-branch-labels">
          <span
            className={`github-panel-ci-dot ${pr.ciStatus ? ciDotClass(pr.ciStatus) : "none"}`}
          />
          {pr.title}
        </div>
      )}
      {runError && <div className="github-panel-empty-row github-panel-conflicts">{runError}</div>}
      {mergeError && (
        <div className="github-panel-empty-row github-panel-conflicts">{mergeError}</div>
      )}
    </div>
  );
}

export function GitHubPanel({ params }: { params: GitHubPanelParams }) {
  const [status, setStatus] = useState<GitHubStatus | null | undefined>(undefined);
  const [prsStatus, setPrsStatus] = useState<GitHubPRsStatus | null | undefined>(undefined);
  const [releaseStatus, setReleaseStatus] = useState<ProjectReleaseStatus | null | undefined>(
    undefined,
  );
  // A dedicated trigger, separate from prsRefreshTrigger below — Run/Merge
  // change release state Mullion itself just caused, which no webhook has
  // pushed yet (a merge's `pull_request: closed` webhook event isn't
  // correlated to anything release-specific — see the #744 plan's
  // "explicitly out of scope" list). Bumping this alone re-fetches only
  // the release section, not the PR/issue lists too.
  const [releaseRefreshTrigger, setReleaseRefreshTrigger] = useState(0);
  const storePrs = useDashboardStore((s) => s.prsByProject[params.projectId]);
  const subscribeToGitHubProject = useDashboardStore((s) => s.subscribeToGitHubProject);
  const unsubscribeFromGitHubProject = useDashboardStore((s) => s.unsubscribeFromGitHubProject);
  const prsRefreshTrigger = useDashboardStore((s) => s.prsRefreshTrigger);

  // Use store's real-time PRs when available (from WS), fall back to fetched data
  const effectivePrs = storePrs ?? prsStatus;

  useAsyncData(
    () => api.getProjectGitHub(params.projectId),
    (s) => setStatus(s ?? null),
    () => setStatus(null),
    [params.projectId, prsRefreshTrigger],
  );

  useAsyncData(
    () => api.getProjectGitHubPRs(params.projectId),
    (s) => setPrsStatus(s ?? null),
    () => setPrsStatus(null),
    [params.projectId, prsRefreshTrigger],
  );

  useAsyncData(
    () => api.getProjectRelease(params.projectId),
    (s) => setReleaseStatus(s ?? null),
    () => setReleaseStatus(null),
    [params.projectId, prsRefreshTrigger, releaseRefreshTrigger],
  );

  // Subscribe to real-time GitHub WS updates for this project
  useEffect(() => {
    subscribeToGitHubProject(params.projectId);
    return () => unsubscribeFromGitHubProject(params.projectId);
  }, [params.projectId, subscribeToGitHubProject, unsubscribeFromGitHubProject]);

  if (status === undefined && prsStatus === undefined) {
    return <EmptyStateNote>Loading…</EmptyStateNote>;
  }

  if (status === null && prsStatus === null) {
    return (
      <EmptyStateNote>
        No GitHub status available for this project. Connect an account in Settings → Integrations,
        and make sure this project's <code>origin</code> remote points at github.com.
      </EmptyStateNote>
    );
  }

  return (
    <div className="github-panel cmux-scroll">
      {status && (
        <a
          className="github-panel-repo"
          href={status.repo.htmlUrl}
          target="_blank"
          rel="noreferrer"
        >
          <GitHubIcon size={14} />
          {status.repo.owner}/{status.repo.repo}
        </a>
      )}

      {releaseStatus && (
        <ReleaseSection
          projectId={params.projectId}
          release={releaseStatus}
          onChanged={() => setReleaseRefreshTrigger((n) => n + 1)}
        />
      )}

      {effectivePrs && effectivePrs.prs.length > 0 && (
        <div className="github-panel-section">
          <div className="github-panel-section-title">
            Pull requests ({prSummaryText(effectivePrs.prSummary)})
          </div>
          {effectivePrs.prs.map((pr) => (
            <PRCard key={pr.number} pr={pr} projectId={params.projectId} />
          ))}
        </div>
      )}

      {/* Fallback when PR poller cache is empty (cold-start, remote-hosted
          Phase 1 skip) but the live /github endpoint has PRs. */}
      {!effectivePrs && status && status.pulls.length > 0 && (
        <div className="github-panel-section">
          <div className="github-panel-section-title">Pull requests ({status.openPRs})</div>
          {status.pulls.map((pr) => (
            <a
              key={pr.number}
              className="github-panel-row"
              href={pr.htmlUrl}
              target="_blank"
              rel="noreferrer"
            >
              <span className="github-panel-row-number">#{pr.number}</span>
              <span className="github-panel-row-title">{pr.title}</span>
            </a>
          ))}
        </div>
      )}

      {status && (
        <div className="github-panel-section">
          <div className="github-panel-section-title">Issues ({status.openIssues})</div>
          {status.issues.length === 0 && (
            <div className="github-panel-empty-row">No open issues</div>
          )}
          {status.issues.map((issue) => (
            <a
              key={issue.number}
              className="github-panel-row"
              href={issue.htmlUrl}
              target="_blank"
              rel="noreferrer"
            >
              <span className="github-panel-row-number">#{issue.number}</span>
              <span className="github-panel-row-title">{issue.title}</span>
            </a>
          ))}
        </div>
      )}

      {((prsStatus && prsStatus.prs.length === 0) || (!prsStatus && status)) &&
        status?.pulls.length === 0 && (
          <div className="github-panel-section">
            <div className="github-panel-section-title">Pull requests (0)</div>
            <div className="github-panel-empty-row">No open pull requests</div>
          </div>
        )}

      {status && status.actionsRuns.length > 0 && (
        <div className="github-panel-section">
          <div className="github-panel-section-title">Default branch CI</div>
          {status.actionsRuns.map((run) => (
            <a
              key={run.htmlUrl}
              className="github-panel-row"
              href={run.htmlUrl}
              target="_blank"
              rel="noreferrer"
            >
              <span className={`github-panel-ci-dot ${runDotClass(run)}`} />
              <span className="github-panel-row-title">{run.name}</span>
              <span className="github-panel-row-number">
                {run.status === "completed" ? (run.conclusion ?? "unknown") : run.status}
              </span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
