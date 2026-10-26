import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/index.js";
import type { GitCommitDetail, GitHubPrPhase, GitLogCommit } from "../api/types.js";
import { parseUnifiedDiff, type DiffLine } from "../diffUtils.js";
import { formatRelativeAge } from "../relativeTime.js";
import { useDashboardStore } from "../store/index.js";
import { ErrorText } from "../ui/ErrorText.js";
import { Dropdown } from "../ui/primitives.js";
import { StatusChip } from "../ui/sidebar/index.js";
import { PHASE_LABEL } from "../github/prPhase.js";
import { statusTone } from "../lib/statusTone.js";
import { computeGraphLayout } from "./graphLayout.js";
import { HistoryGraph } from "./HistoryGraph.js";
import { buildRefChips, type RefChip } from "./historyRefs.js";

/** `head` = current branch, `all` = every ref, `branch:<name>` = one branch. */
export type HistoryScope = string;

const PAGE = 100;
/** Ref chips shown inline at normal density; the rest fold into "+N". */
const MAX_INLINE_REFS = 2;

type PrInfo = { number: number; phase: GitHubPrPhase | null | undefined };

function RefChipView({ chip, pr }: { chip: RefChip; pr: PrInfo | undefined }) {
  const title = [chip.raw.join(", "), chip.synced ? "in sync with the remote" : ""]
    .filter(Boolean)
    .join(" · ");
  return (
    <>
      <StatusChip tone={chip.tone} mono title={title} className={`gh-ref gh-ref-${chip.kind}`}>
        {chip.label}
        {chip.synced && (
          <span className="gh-ref-synced" aria-label="synced with remote">
            {" "}
            ✓
          </span>
        )}
      </StatusChip>
      {pr && (
        <StatusChip
          tone={pr.phase ? statusTone({ phase: pr.phase }) : "neutral"}
          mono
          title={pr.phase ? PHASE_LABEL[pr.phase] : undefined}
          className="gh-ref-pr"
        >
          #{pr.number}
        </StatusChip>
      )}
    </>
  );
}

function CommitFiles({ projectId, sha, cwd }: { projectId: number; sha: string; cwd?: string }) {
  const [detail, setDetail] = useState<GitCommitDetail | null | undefined>(undefined);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffLine[] | null | undefined>(undefined);
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
        <div key={f.path} className="gh-commit-file-card">
          <button
            type="button"
            className="github-panel-row gh-commit-file-row"
            onClick={() => toggleFile(f.path)}
          >
            <span className="github-panel-row-title gh-commit-file-path" title={f.path}>
              {f.path}
            </span>
            <span className="gh-file-stats">
              {f.additions !== null && <span className="gh-add">+{f.additions}</span>}
              {f.deletions !== null && <span className="gh-del">−{f.deletions}</span>}
              {f.additions === null && f.deletions === null && <span className="gh-bin">bin</span>}
            </span>
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
  scope: scopeProp,
  onScopeChange,
}: {
  projectId: number;
  /** A worktree path to scope the history to; omitted = the project root. */
  cwd?: string;
  /** Controlled scope (the History rail view's "View in History" hand-off). */
  scope?: HistoryScope;
  onScopeChange?: (scope: HistoryScope) => void;
}) {
  const [scopeState, setScopeState] = useState<HistoryScope>("head");
  const scope = scopeProp ?? scopeState;
  const setScope = (next: HistoryScope) => {
    setScopeState(next);
    onScopeChange?.(next);
  };
  const [commits, setCommits] = useState<GitLogCommit[] | null | undefined>(undefined);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const prs = useDashboardStore((s) => s.prsByProject[projectId]);
  const branches = useDashboardStore((s) => s.gitBranchesByProject[projectId]?.branches);
  const remoteBranches = useDashboardStore(
    (s) => s.gitBranchesByProject[projectId]?.remoteBranches,
  );
  const gitRefreshTrigger = useDashboardStore((s) => s.gitRefreshTrigger);
  const remotes = useMemo(() => new Set(remoteBranches ?? []), [remoteBranches]);

  const scopeOptions = useMemo(() => {
    const opts: Array<{ value: HistoryScope; label: string }> = [
      { value: "head", label: "Current branch" },
      { value: "all", label: "All branches" },
    ];
    for (const b of branches ?? []) opts.push({ value: `branch:${b.name}`, label: b.name });
    // A scope handed in for a branch the list does not (yet) know still shows.
    if (!opts.some((o) => o.value === scope)) {
      opts.push({ value: scope, label: scope.replace(/^branch:/, "") });
    }
    return opts;
  }, [branches, scope]);

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
  }, [projectId, scope, cwd, gitRefreshTrigger]);

  const layout = useMemo(() => computeGraphLayout(commits ?? []), [commits]);
  const prByBranch = useMemo(() => {
    const map = new Map<string, PrInfo>();
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
      <div className="gh-history-toolbar">
        <Dropdown
          small
          ariaLabel="History scope"
          value={scope}
          onChange={setScope}
          options={scopeOptions}
        />
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
        const chips = buildRefChips(commit.refs, remotes);
        const shown = chips.slice(0, MAX_INLINE_REFS);
        const more = chips.length - shown.length;
        const age = formatRelativeAge(commit.time * 1000);
        return (
          <div key={commit.sha} className="gh-commit">
            <button
              type="button"
              className="gh-commit-row"
              aria-expanded={open}
              title={`${commit.sha.slice(0, 7)} · ${commit.author}`}
              onClick={() => setExpanded(open ? null : commit.sha)}
            >
              <HistoryGraph row={row} />
              <span className="gh-commit-subject">{commit.subject}</span>
              {chips.length > 0 && (
                <>
                  <span className="gh-commit-refs gh-commit-refs--inline">
                    {shown.map((chip) => (
                      <RefChipView
                        key={chip.key}
                        chip={chip}
                        pr={chip.prBranch ? prByBranch.get(chip.prBranch) : undefined}
                      />
                    ))}
                    {more > 0 && (
                      <StatusChip
                        tone="neutral"
                        title={chips
                          .slice(MAX_INLINE_REFS)
                          .map((c) => c.label)
                          .join(", ")}
                      >
                        +{more}
                      </StatusChip>
                    )}
                  </span>
                  <span className="gh-commit-refs gh-commit-refs--count">
                    <StatusChip tone={chips[0].tone} title={chips.map((c) => c.label).join(", ")}>
                      {chips.length}
                    </StatusChip>
                  </span>
                </>
              )}
              <span className="gh-commit-when">{age}</span>
            </button>
            {open && (
              <>
                <div className="gh-commit-expanded">
                  <span className="gh-commit-sha">{commit.sha.slice(0, 7)}</span> · {commit.author}{" "}
                  · {age}
                  {chips.length > 0 && (
                    <div className="gh-commit-expanded-refs">{commit.refs.join(", ")}</div>
                  )}
                </div>
                <CommitFiles projectId={projectId} sha={commit.sha} cwd={cwd} />
              </>
            )}
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
