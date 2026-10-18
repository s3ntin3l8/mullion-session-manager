import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/index.js";
import type { GitCommitDetail, GitLogCommit } from "../api/types.js";
import { parseUnifiedDiff, type DiffLine } from "../diffUtils.js";
import { formatRelativeAge } from "../relativeTime.js";
import { useDashboardStore } from "../store/index.js";
import { ErrorText } from "../ui/ErrorText.js";
import { PHASE_LABEL, phaseTone } from "../github/prPhase.js";
import { computeGraphLayout } from "./graphLayout.js";
import { HistoryGraph } from "./HistoryGraph.js";

const PAGE = 100;

function refKind(ref: string, remotes: ReadonlySet<string>): "head" | "tag" | "remote" | "branch" {
  if (ref.startsWith("HEAD")) return "head";
  if (ref.startsWith("tag: ")) return "tag";
  // A bare slash isn't enough ("feature/x" is a local branch): a remote ref is
  // one the repo lists as remote-tracking, or the conventional origin/ prefix.
  if (remotes.has(ref) || ref.startsWith("origin/")) return "remote";
  return "branch";
}

function cleanRef(ref: string): string {
  return ref.replace(/^HEAD -> /, "").replace(/^tag: /, "");
}

function CommitFiles({ projectId, sha, cwd }: { projectId: number; sha: string; cwd?: string }) {
  const [detail, setDetail] = useState<GitCommitDetail | null | undefined>(undefined);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffLine[] | null | undefined>(undefined);
  // The file whose diff is currently wanted; a response for an earlier click
  // must not land under a different open row.
  const openFileRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getProjectGitCommit(projectId, sha, cwd)
      .then((d) => !cancelled && setDetail(d ?? null))
      .catch(() => !cancelled && setDetail(null));
    return () => {
      cancelled = true;
    };
  }, [projectId, sha, cwd]);

  const toggleFile = (path: string) => {
    if (openFile === path) {
      openFileRef.current = null;
      setOpenFile(null);
      return;
    }
    openFileRef.current = path;
    setOpenFile(path);
    setDiff(undefined);
    api
      .getProjectGitCommitFile(projectId, sha, path, cwd)
      .then((r) => {
        if (openFileRef.current === path) setDiff(r?.patch ? parseUnifiedDiff(r.patch) : null);
      })
      .catch(() => {
        if (openFileRef.current === path) setDiff(null);
      });
  };

  if (detail === undefined) return <div className="github-panel-empty-row">Loading…</div>;
  if (detail === null) return <div className="github-panel-empty-row">Commit unavailable</div>;
  return (
    <div className="gh-commit-detail">
      {detail.message.includes("\n") && (
        <pre className="gh-commit-message">
          {detail.message.split("\n").slice(1).join("\n").trim()}
        </pre>
      )}
      {detail.files.map((f) => (
        <div key={f.path}>
          <button type="button" className="github-panel-row" onClick={() => toggleFile(f.path)}>
            <span className="github-panel-row-title" title={f.path}>
              {f.path}
            </span>
            <span className="gh-add">{f.additions === null ? "bin" : `+${f.additions}`}</span>
            <span className="gh-del">{f.deletions === null ? "" : `−${f.deletions}`}</span>
          </button>
          {openFile === f.path && (
            <div className="session-file-change-diff">
              {diff === undefined && <span className="session-diff-spinner">…</span>}
              {diff === null && <span className="session-diff-empty">No diff</span>}
              {diff?.map((line, i) => (
                <span key={i} className={`session-diff-line session-diff-${line.type}`}>
                  {line.text}
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function GitHistorySection({
  projectId,
  cwd,
}: {
  projectId: number;
  /** A worktree path to scope the history to; omitted = the project root. */
  cwd?: string;
}) {
  const [scope, setScope] = useState<"all" | "head">("all");
  const [commits, setCommits] = useState<GitLogCommit[] | null | undefined>(undefined);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const prs = useDashboardStore((s) => s.prsByProject[projectId]);
  const remoteBranches = useDashboardStore(
    (s) => s.gitBranchesByProject[projectId]?.remoteBranches,
  );
  const remotes = useMemo(() => new Set(remoteBranches ?? []), [remoteBranches]);
  // The scope/worktree the list currently shows; a page that was already in
  // flight for an earlier selection must not be merged into the new list.
  const viewKey = `${projectId}|${scope}|${cwd ?? ""}`;
  const viewKeyRef = useRef(viewKey);
  useEffect(() => {
    viewKeyRef.current = viewKey;
  }, [viewKey]);

  useEffect(() => {
    let cancelled = false;
    api
      .getProjectGitLog(projectId, { limit: PAGE, scope, cwd })
      .then((r) => {
        if (cancelled) return;
        setError(null);
        setCommits(r ? r.commits : null);
        setHasMore(r?.hasMore ?? false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Could not load history");
        setCommits(null);
        setHasMore(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, scope, cwd]);

  const layout = useMemo(() => computeGraphLayout(commits ?? []), [commits]);
  const prByBranch = useMemo(() => {
    const map = new Map<
      string,
      { number: number; phase: NonNullable<typeof prs>["prs"][number]["prPhase"] }
    >();
    for (const pr of prs?.prs ?? [])
      map.set(pr.headBranch, { number: pr.number, phase: pr.prPhase });
    return map;
  }, [prs]);

  const loadMore = () => {
    if (!commits) return;
    setLoadingMore(true);
    const requestedFor = viewKey;
    api
      .getProjectGitLog(projectId, { skip: commits.length, limit: PAGE, scope, cwd })
      .then((r) => {
        if (!r || viewKeyRef.current !== requestedFor) return;
        // skip-based paging over a live repo can return a commit twice if one
        // landed in between; keep the first occurrence of each sha.
        setCommits((prev) => {
          const seen = new Set((prev ?? []).map((c) => c.sha));
          return [...(prev ?? []), ...r.commits.filter((c) => !seen.has(c.sha))];
        });
        setHasMore(r.hasMore);
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Could not load more history"),
      )
      .finally(() => setLoadingMore(false));
  };

  return (
    <div className="gh-history">
      <div className="gh-issue-filters">
        <select
          aria-label="History scope"
          className="gh-issue-sort"
          value={scope}
          onChange={(e) => setScope(e.target.value as "all" | "head")}
        >
          <option value="all">All branches</option>
          <option value="head">Current branch</option>
        </select>
      </div>
      {error && <ErrorText>{error}</ErrorText>}
      {commits === undefined && <div className="github-panel-empty-row">Loading…</div>}
      {commits === null && !error && (
        <div className="github-panel-empty-row">No history available</div>
      )}
      {commits?.length === 0 && <div className="github-panel-empty-row">No commits yet</div>}
      {commits?.map((commit, i) => {
        const row = layout.rows[i];
        const open = expanded === commit.sha;
        return (
          <div key={commit.sha} className="gh-commit">
            <button
              type="button"
              className="gh-commit-row"
              aria-expanded={open}
              onClick={() => setExpanded(open ? null : commit.sha)}
            >
              <HistoryGraph row={row} columns={layout.width} />
              <span className="gh-commit-main">
                <span className="github-panel-row-title">{commit.subject}</span>
                <span className="gh-commit-refs">
                  {commit.refs.map((ref) => {
                    const pr = prByBranch.get(cleanRef(ref));
                    return (
                      <span key={ref} className={`gh-ref gh-ref-${refKind(ref, remotes)}`}>
                        {cleanRef(ref)}
                        {pr && (
                          <span
                            className={`gh-phase-pill ${pr.phase ? phaseTone(pr.phase) : "dim"}`}
                            title={pr.phase ? PHASE_LABEL[pr.phase] : undefined}
                          >
                            #{pr.number}
                          </span>
                        )}
                      </span>
                    );
                  })}
                </span>
              </span>
              <span className="github-panel-row-number" title={commit.author}>
                {commit.sha.slice(0, 7)} · {formatRelativeAge(commit.time * 1000)}
              </span>
            </button>
            {open && <CommitFiles projectId={projectId} sha={commit.sha} cwd={cwd} />}
          </div>
        );
      })}
      {hasMore && (
        <button type="button" className="gh-issue-more" disabled={loadingMore} onClick={loadMore}>
          {loadingMore ? "Loading…" : "Load more"}
        </button>
      )}
    </div>
  );
}
