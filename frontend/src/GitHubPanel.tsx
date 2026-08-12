import { useCallback, useEffect, useState } from "react";
import { api } from "./api/index.js";
import type {
  GitHubActionsRun,
  GitHubJob,
  GitHubLogResponse,
  GitHubPRsStatus,
  GitHubPROrWithChecks,
  GitHubStatus,
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
      {loading && (
        <div className="github-panel-empty-row" style={{ paddingLeft: 32 }}>
          Loading logs…
        </div>
      )}
      {log && log.log && (
        <pre className="github-panel-log" onClick={(e) => e.stopPropagation()}>
          {log.log}
          {log.truncated && (
            <span className="github-panel-log-truncated">… ({log.lineCount} lines shown)</span>
          )}
        </pre>
      )}
      {log && !log.log && (
        <div className="github-panel-empty-row" style={{ paddingLeft: 32 }}>
          No log output
        </div>
      )}
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
        <div className="github-panel-jobs" style={{ paddingLeft: 16 }}>
          {jobs.map((job) => (
            <JobRow key={job.id} projectId={projectId} runId={runId} job={job} />
          ))}
        </div>
      )}
      {expanded && jobs === null && (
        <div className="github-panel-empty-row" style={{ paddingLeft: 16 }}>
          Failed to load jobs
        </div>
      )}
      {expanded && jobs === undefined && (
        <div className="github-panel-empty-row" style={{ paddingLeft: 16 }}>
          Loading jobs…
        </div>
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
          <div className="github-panel-empty-row">No workflow runs for this PR</div>
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

export function GitHubPanel({ params }: { params: GitHubPanelParams }) {
  const [status, setStatus] = useState<GitHubStatus | null | undefined>(undefined);
  const [prsStatus, setPrsStatus] = useState<GitHubPRsStatus | null | undefined>(undefined);
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
