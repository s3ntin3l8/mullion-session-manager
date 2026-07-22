import { useEffect, useState } from "react";
import { api } from "./api.js";
import type { GitFileStatus, GitStatus } from "./api.js";
import { GitBranchIcon } from "./icons.js";
import { LIVE_REFRESH_INTERVAL_MS } from "./store.js";

export interface GitPanelParams {
  projectId: number;
}

// Maps a file's simplified status code to the same "status dot" language
// GitHubPanel's Actions section and the sidebar badge use — VS Code-style
// single-letter status, colored via the same --g/--r/--o/--dim variables.
function statusDotClass(status: GitFileStatus["status"]): string {
  switch (status) {
    case "A":
      return "good";
    case "D":
      return "bad";
    case "U":
      return "bad";
    default:
      return "pending";
  }
}

// A dockview panel (opened from the CommandPalette's Integrations section —
// see App.tsx/CommandPalette.tsx) showing a project's current git status:
// branch, short hash, ahead/behind vs. upstream, and per-file status (issue
// #76). Same three-state loading/not-applicable/loaded shape as
// GitHubPanel.tsx: `undefined` while loading, `null` for the durable 204
// "not applicable" response (not a git repo), a `GitStatus` once loaded.
//
// Polls on the same cadence as the sidebar's live-refresh (LIVE_REFRESH_
// INTERVAL_MS) rather than fetching once on mount — the original single-
// fetch version got stuck showing "Not a git repository" forever if that one
// mount-time request happened to land on a transient `git status` failure
// (e.g. `.git/index.lock` contention), since nothing ever retried it. Only a
// durable 204 (genuinely not a repo — see git-status.ts's `isGitRepo`/
// `getGitStatus` split) clears the panel to that state; every other outcome
// (the 503 "repo exists but git status itself failed" case, or a raw network
// error) keeps whatever was last successfully shown, exactly like the
// sidebar's own gitStatuses map now does (store.ts's refreshGitStatuses).
export function GitPanel({ params }: { params: GitPanelParams }) {
  const [status, setStatus] = useState<GitStatus | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    const fetchStatus = async () => {
      try {
        const result = await api.getProjectGitStatus(params.projectId);
        if (cancelled) return;
        setStatus(result ?? null);
      } catch {
        // Transient failure (a thrown ApiError for the 503 "unavailable"
        // response, or any other network hiccup) — deliberately a no-op,
        // not `setStatus(null)`. Keeps rendering the last-known-good status
        // (or stays in the initial "Loading…" state if this is the very
        // first attempt) rather than incorrectly claiming "not a git
        // repository".
      }
    };

    void fetchStatus();

    const tick = () => {
      if (document.visibilityState === "visible") void fetchStatus();
    };
    const timer = setInterval(tick, LIVE_REFRESH_INTERVAL_MS);

    // Same reasoning as GitHubPanel's effect for the dep array: this panel
    // is mounted fresh per project (a stable "git-<projectId>" dockview
    // panel id, see App.tsx's onOpenGit), so params.projectId never
    // actually changes under an existing instance.
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [params.projectId]);

  if (status === undefined) {
    return <div className="github-panel-empty">Loading…</div>;
  }

  if (status === null) {
    // Only reached via the durable 204 now — a transient failure (503, or
    // any other fetch error) is handled above by simply not calling
    // setStatus, so it never lands here.
    return <div className="github-panel-empty">Not a git repository.</div>;
  }

  return (
    <div className="github-panel cmux-scroll">
      <div className="github-panel-repo">
        <GitBranchIcon size={14} />
        {status.branch}
        {status.hash && <span className="github-panel-row-number">{status.hash}</span>}
      </div>

      {(status.ahead > 0 || status.behind > 0) && (
        <div className="github-panel-empty-row">
          {status.ahead > 0 && `↑${status.ahead}`}
          {status.ahead > 0 && status.behind > 0 && " "}
          {status.behind > 0 && `↓${status.behind}`}
        </div>
      )}

      <div className="github-panel-section">
        <div className="github-panel-section-title">
          {status.isClean ? "Clean" : `Changes (${status.files.length})`}
        </div>
        {status.isClean && <div className="github-panel-empty-row">Working tree clean</div>}
        {status.files.map((file) => (
          <div key={file.path} className="github-panel-row">
            <span className={`github-panel-ci-dot ${statusDotClass(file.status)}`} />
            <span className="github-panel-row-number">{file.status}</span>
            <span className="github-panel-row-title">{file.path}</span>
          </div>
        ))}
      </div>

      {status.hasConflicts && (
        <div className="github-panel-empty-row github-panel-conflicts">
          This checkout has unresolved merge conflicts.
        </div>
      )}
    </div>
  );
}
