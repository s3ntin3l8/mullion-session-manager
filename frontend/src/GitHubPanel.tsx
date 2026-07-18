import { useEffect, useState } from "react";
import { api } from "./api.js";
import type { GitHubStatus } from "./api.js";
import { GitHubIcon } from "./icons.js";

export interface GitHubPanelParams {
  projectId: number;
}

// A dockview panel (opened from the Dock widget or the CommandPalette's
// Integrations section — see App.tsx/CommandPalette.tsx) listing a
// project's open PRs and issues with quick links (issue #27). `undefined`
// while loading, `null` for the "not applicable" 204 (no github.com remote,
// no account connected, or a GitHub API error) — same three-state shape
// Dock.tsx's own widget uses for the exact same reason.
export function GitHubPanel({ params }: { params: GitHubPanelParams }) {
  const [status, setStatus] = useState<GitHubStatus | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    // No synchronous reset to `undefined` here — this panel is mounted
    // fresh per project (a stable "github-<projectId>" dockview panel id,
    // see App.tsx's onOpenGitHub), so `params.projectId` never actually
    // changes under an existing instance; the initial useState(undefined)
    // above already covers the one real "loading" render.
    api
      .getProjectGitHub(params.projectId)
      .then((s) => {
        if (!cancelled) setStatus(s ?? null);
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [params.projectId]);

  if (status === undefined) {
    return <div className="github-panel-empty">Loading…</div>;
  }

  if (status === null) {
    return (
      <div className="github-panel-empty">
        No GitHub status available for this project. Connect an account in Settings → Integrations,
        and make sure this project's <code>origin</code> remote points at github.com.
      </div>
    );
  }

  return (
    <div className="github-panel cmux-scroll">
      <a className="github-panel-repo" href={status.repo.htmlUrl} target="_blank" rel="noreferrer">
        <GitHubIcon size={14} />
        {status.repo.owner}/{status.repo.repo}
      </a>

      <div className="github-panel-section">
        <div className="github-panel-section-title">Pull requests ({status.openPRs})</div>
        {status.pulls.length === 0 && (
          <div className="github-panel-empty-row">No open pull requests</div>
        )}
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

      <div className="github-panel-section">
        <div className="github-panel-section-title">Issues ({status.openIssues})</div>
        {status.issues.length === 0 && <div className="github-panel-empty-row">No open issues</div>}
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
    </div>
  );
}
