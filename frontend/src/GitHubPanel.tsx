import { useEffect, useState } from "react";
import { api } from "./api.js";
import type {
  GitHubActionsRun,
  GitHubPRsStatus,
  GitHubPROrWithChecks,
  GitHubStatus,
} from "./api.js";
import { ChevronDownIcon, GitHubIcon } from "./icons.js";

export interface GitHubPanelParams {
  projectId: number;
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

function PRCard({ pr }: { pr: GitHubPROrWithChecks }) {
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
          <a
            key={run.htmlUrl}
            href={run.htmlUrl}
            target="_blank"
            rel="noreferrer"
            className="github-panel-run-row"
            onClick={(e) => e.stopPropagation()}
          >
            <span className={`github-panel-ci-dot ${runDotClass(run)}`} />
            <span className="github-panel-run-name">{run.name}</span>
            <span className="github-panel-run-status">
              {run.status === "completed" ? (run.conclusion ?? "unknown") : run.status}
            </span>
          </a>
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
  return `${summary.total} PR${summary.total === 1 ? "" : "s"} — ${parts.join(" ") || "no CI data"}`;
}

export function GitHubPanel({ params }: { params: GitHubPanelParams }) {
  const [status, setStatus] = useState<GitHubStatus | null | undefined>(undefined);
  const [prsStatus, setPrsStatus] = useState<GitHubPRsStatus | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    api
      .getProjectGitHub(params.projectId)
      .then((s) => {
        if (!cancelled) setStatus(s ?? null);
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      });

    api
      .getProjectGitHubPRs(params.projectId)
      .then((s) => {
        if (!cancelled) setPrsStatus(s ?? null);
      })
      .catch(() => {
        if (!cancelled) setPrsStatus(null);
      });

    return () => {
      cancelled = true;
    };
  }, [params.projectId]);

  if (status === undefined && prsStatus === undefined) {
    return <div className="github-panel-empty">Loading…</div>;
  }

  if (status === null && prsStatus === null) {
    return (
      <div className="github-panel-empty">
        No GitHub status available for this project. Connect an account in Settings → Integrations,
        and make sure this project's <code>origin</code> remote points at github.com.
      </div>
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

      {prsStatus && prsStatus.prs.length > 0 && (
        <div className="github-panel-section">
          <div className="github-panel-section-title">
            Pull requests ({prSummaryText(prsStatus.prSummary)})
          </div>
          {prsStatus.prs.map((pr) => (
            <PRCard key={pr.number} pr={pr} />
          ))}
        </div>
      )}

      {/* Fallback when PR poller cache is empty (cold-start, remote-hosted
          Phase 1 skip) but the live /github endpoint has PRs. */}
      {!prsStatus && status && status.pulls.length > 0 && (
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
