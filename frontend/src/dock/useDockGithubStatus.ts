import { useEffect, useState } from "react";
import { api } from "../api/index.js";
import type { GitHubPRsStatus, GitHubStatus } from "../api/index.js";

// DockColumn's GitHub status widget fetch — extracted alongside
// dock/DockGithubRow.tsx (Wave 5 / PR 28 of
// .claude/plans/can-we-do-a-warm-cocke.md). `null` covers both "still
// loading" and the 204 "not applicable" case (no github.com remote, no
// account connected, a GitHub API error) — the widget just renders nothing
// either way, same degrade-to-nothing rule GitHubPanel.tsx follows for the
// same endpoint.
export function useDockGithubStatus(projectId: number, prsRefreshTrigger: number) {
  const [githubStatus, setGithubStatus] = useState<GitHubStatus | null>(null);
  const [prsStatus, setPrsStatus] = useState<GitHubPRsStatus | null>(null);

  useEffect(() => {
    // Guards against a stale response on a fast project switch — same
    // `cancelled` pattern GitHubPanel.tsx uses for the same endpoint
    // (Hermes review, PR #40).
    let cancelled = false;
    api
      .getProjectGitHub(projectId)
      .then((status) => {
        if (!cancelled) setGithubStatus(status ?? null);
      })
      .catch(() => {
        if (!cancelled) setGithubStatus(null);
      });

    api
      .getProjectGitHubPRs(projectId)
      .then((s) => {
        if (!cancelled) setPrsStatus(s ?? null);
      })
      .catch(() => {
        if (!cancelled) setPrsStatus(null);
      });

    return () => {
      cancelled = true;
    };
    // P12 — prsRefreshTrigger in the deps means a live `/ws/github` push for
    // this project (a check completing, a new PR) re-fetches immediately,
    // exactly matching GitHubPanel.tsx's own identical effect — before this
    // fix the dock widget only ever fetched once per projectId and showed
    // stale CI/PR counts frozen at whatever they were when the column first
    // mounted, even while GitHubPanel elsewhere on the same page updated
    // live off the same push.
  }, [projectId, prsRefreshTrigger]);

  return { githubStatus, prsStatus };
}
