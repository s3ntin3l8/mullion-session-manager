import { useEffect, useRef, useState } from "react";
import { api } from "../api/index.js";
import { useIssue, useIssues } from "../hooks/useGitHubData.js";
import type { GitHubIssueLabel, GitHubIssueListItem, GitHubIssueSort } from "../api/types.js";
import { formatRelativeAge } from "../relativeTime.js";
import { useDashboardStore } from "../store/index.js";
import { issueBranchName, issueSeedPrompt } from "./issueWork.js";
import { EmptyStateNote } from "../ui/EmptyState.js";
import { ErrorText } from "../ui/ErrorText.js";
import { Dropdown } from "../ui/primitives.js";
import { SafeHtml } from "../ui/SafeHtml.js";

// The Issues half of the GitHub sidebar: a filterable list (label chips,
// assignee, sort, title search, paging) and a drill-in detail with the
// actions that turn an issue into work — start a session, queue for Task
// Master, or open on github.com.

const SORT_LABELS: Record<GitHubIssueSort, string> = {
  updated: "Recently updated",
  created: "Newest",
  comments: "Most comments",
};
const SORT_OPTIONS = (Object.keys(SORT_LABELS) as GitHubIssueSort[]).map((value) => ({
  value,
  label: SORT_LABELS[value],
}));

function LabelChip({ label, active, onClick }: LabelChipProps) {
  const style = { borderColor: `#${label.color}` };
  if (!onClick) {
    return (
      <span className="gh-label-chip" style={style}>
        {label.name}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`gh-label-chip gh-label-chip-button${active ? " active" : ""}`}
      style={style}
      aria-pressed={active}
      onClick={onClick}
    >
      {label.name}
    </button>
  );
}

interface LabelChipProps {
  label: GitHubIssueLabel;
  active?: boolean;
  onClick?: () => void;
}

export interface TaskMasterInfo {
  enabled: boolean;
  label: string;
}

export function IssuesSection({
  projectId,
  openIssues,
  issuesHidden,
  onOpenIssue,
  onTaskMaster,
}: {
  projectId: number;
  openIssues: number;
  issuesHidden: boolean;
  onOpenIssue: (number: number) => void;
  /** Reports Task Master availability from the list response, so the detail
   *  view needn't fetch a list page just to learn it. */
  onTaskMaster?: (info: TaskMasterInfo) => void;
}) {
  const [debouncedQuery, setDebouncedQuery] = useState(
    () => useDashboardStore.getState().githubIssueUiByProject[projectId]?.query.trim() ?? "",
  );
  const patchUi = useDashboardStore((s) => s.patchGithubIssueUi);
  const { ui, filterKey, page, data, error, loading } = useIssues(
    projectId,
    debouncedQuery,
    !issuesHidden,
  );
  const onTaskMasterRef = useRef(onTaskMaster);
  useEffect(() => {
    onTaskMasterRef.current = onTaskMaster;
  });
  const { labels: selected, unassigned, sort, query, knownLabels } = ui;

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  // Labels seen across every fetched page/filter, so a chip doesn't vanish
  // the moment it is selected and narrows the list to its own issues; and
  // Task Master availability, so the detail view needn't fetch a page.
  useEffect(() => {
    if (!data) return;
    const current = useDashboardStore.getState().githubIssueUiByProject[projectId];
    const byName = new Map((current?.knownLabels ?? []).map((l) => [l.name, l]));
    for (const l of data.labels) byName.set(l.name, l);
    const labels = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    const taskMaster = { enabled: data.taskMasterEnabled, label: data.taskLabel };
    const sameLabels =
      current?.knownLabels.length === labels.length &&
      current.knownLabels.every((l, i) => l.name === labels[i].name);
    const sameTm =
      current?.taskMaster?.enabled === taskMaster.enabled &&
      current.taskMaster.label === taskMaster.label;
    if (!sameLabels || !sameTm) patchUi(projectId, { knownLabels: labels, taskMaster });
    onTaskMasterRef.current?.(taskMaster);
  }, [data, projectId, patchUi]);

  // Any filter change restarts paging from 1 (the page is tied to the key).
  const setFilter = (patch: Partial<typeof ui>) =>
    patchUi(projectId, { ...patch, pageState: { key: "", page: 1 } });
  const setUnassigned = (v: boolean) => setFilter({ unassigned: v });
  const setSort = (v: GitHubIssueSort) => setFilter({ sort: v });
  const setQuery = (v: string) => setFilter({ query: v });
  const toggleLabel = (name: string) =>
    setFilter({
      labels: selected.includes(name) ? selected.filter((n) => n !== name) : [...selected, name],
    });

  const filtered = selected.length > 0 || unassigned || debouncedQuery !== "";

  return (
    <div className="github-panel-section">
      <div className="github-panel-section-title">Issues ({openIssues})</div>
      {issuesHidden ? (
        <div className="github-panel-empty-row">
          The GitHub token can't list issues — grant it Issues access
        </div>
      ) : (
        <>
          <div className="gh-issue-filters">
            <input
              className="gh-issue-search"
              type="search"
              placeholder="Search titles"
              aria-label="Search issues"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <Dropdown
              small
              ariaLabel="Sort issues"
              value={sort}
              onChange={setSort}
              options={SORT_OPTIONS}
            />
            <label className="gh-issue-unassigned">
              <input
                type="checkbox"
                checked={unassigned}
                onChange={(e) => setUnassigned(e.target.checked)}
              />
              Unassigned
            </label>
          </div>
          {knownLabels.length > 0 && (
            <div className="gh-label-row">
              {knownLabels.map((l) => (
                <LabelChip
                  key={l.name}
                  label={l}
                  active={selected.includes(l.name)}
                  onClick={() => toggleLabel(l.name)}
                />
              ))}
            </div>
          )}
          {error && <ErrorText>{error}</ErrorText>}
          {data && data.issues.length === 0 && !loading && (
            <div className="github-panel-empty-row">
              {data.hasMore
                ? "No matches on this page — load more"
                : filtered
                  ? "No issues match these filters"
                  : "No open issues"}
            </div>
          )}
          {data?.issues.map((issue) => (
            <IssueRow key={issue.number} issue={issue} onOpen={() => onOpenIssue(issue.number)} />
          ))}
          {loading && <div className="github-panel-empty-row">Loading…</div>}
          {data?.hasMore && !loading && (
            <button
              type="button"
              className="gh-issue-more"
              onClick={() => patchUi(projectId, { pageState: { key: filterKey, page: page + 1 } })}
            >
              Load more
            </button>
          )}
        </>
      )}
    </div>
  );
}

function IssueRow({ issue, onOpen }: { issue: GitHubIssueListItem; onOpen: () => void }) {
  return (
    <button type="button" className="github-panel-row gh-issue-row" onClick={onOpen}>
      <span className="github-panel-row-number">#{issue.number}</span>
      <span className="gh-issue-row-main">
        <span className="github-panel-row-title">{issue.title}</span>
        {(issue.labels.length > 0 || issue.taskStatus) && (
          <span className="gh-label-row">
            {issue.labels.map((l) => (
              <LabelChip key={l.name} label={l} />
            ))}
            {issue.taskStatus && <span className="gh-task-chip">Task: {issue.taskStatus}</span>}
          </span>
        )}
      </span>
      {issue.commentCount > 0 && (
        <span className="github-panel-row-number" title={`${issue.commentCount} comments`}>
          💬 {issue.commentCount}
        </span>
      )}
    </button>
  );
}

export function IssueDetailView({
  projectId,
  number,
  onBack,
  taskMaster,
}: {
  projectId: number;
  number: number;
  onBack: () => void;
  taskMaster?: TaskMasterInfo | null;
}) {
  const { data: issue, error: loadError } = useIssue(projectId, number);
  const [actionError, setActionError] = useState<string | null>(null);
  const error = actionError ?? loadError;
  const setError = setActionError;
  const [busy, setBusy] = useState<"session" | "queue" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const startSession = async () => {
    if (!issue) return;
    setBusy("session");
    setNotice(null);
    try {
      const state = useDashboardStore.getState();
      const launchers = await api.listProjectActions(projectId);
      const launcher =
        launchers.find((l) => l.id === `agent:${state.settings.launchers.defaultAgent}`) ??
        launchers[0];
      if (!launcher) throw new Error("No launcher is configured for this project.");
      const branches = state.gitBranchesByProject[projectId];
      const project = state.projects.find((p) => p.id === projectId);
      const baseRef = branches?.defaultBranch ?? project?.currentBranch ?? "origin/main";
      const session = await state.createSession(projectId, launcher.command, {
        worktree: { baseRef, branchName: issueBranchName(issue) },
        seedPrompt: issueSeedPrompt(issue),
      });
      state.requestOpenSession(session.id);
      setNotice("Session started in a new worktree");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start a session");
    } finally {
      setBusy(null);
    }
  };

  const queue = async () => {
    setBusy("queue");
    setNotice(null);
    try {
      const res = await api.queueProjectIssue(projectId, number);
      setNotice(`Queued — added the “${res.label}” label`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not queue the issue");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="gh-detail">
      <button type="button" className="gh-detail-back" onClick={onBack}>
        ← Back
      </button>
      {error && <ErrorText>{error}</ErrorText>}
      {!issue && !error && <EmptyStateNote>Loading…</EmptyStateNote>}
      {issue && (
        <>
          <div className="gh-detail-title">
            <span className="github-panel-row-number">#{issue.number}</span> {issue.title}
            {issue.state === "closed" && <span className="gh-task-chip">closed</span>}
          </div>
          <div className="gh-detail-meta">
            {issue.author ?? "unknown"} · updated {formatRelativeAge(Date.parse(issue.updatedAt))}
            {issue.milestone ? ` · ${issue.milestone}` : ""}
            {issue.assignees.length > 0 ? ` · assigned to ${issue.assignees.join(", ")}` : ""}
          </div>
          {issue.labels.length > 0 && (
            <div className="gh-label-row">
              {issue.labels.map((l) => (
                <LabelChip key={l.name} label={l} />
              ))}
            </div>
          )}
          <div className="gh-detail-actions">
            <button type="button" disabled={busy !== null} onClick={startSession}>
              {busy === "session" ? "Starting…" : "Start session"}
            </button>
            {taskMaster?.enabled && (
              <button type="button" disabled={busy !== null} onClick={queue}>
                {busy === "queue" ? "Queueing…" : "Queue for Task Master"}
              </button>
            )}
            <a href={issue.htmlUrl} target="_blank" rel="noreferrer">
              Open on GitHub
            </a>
          </div>
          {notice && <div className="gh-detail-notice">{notice}</div>}
          {issue.bodyHtml ? (
            <SafeHtml className="gh-html" html={issue.bodyHtml} />
          ) : (
            <div className="github-panel-empty-row">No description provided</div>
          )}
          {issue.comments.length > 0 && (
            <div className="github-panel-section">
              <div className="github-panel-section-title">
                Comments ({issue.comments.length}
                {issue.commentCount > issue.comments.length ? ` of ${issue.commentCount}` : ""})
              </div>
              {issue.commentCount > issue.comments.length && (
                <div className="github-panel-empty-row">
                  Showing the first {issue.comments.length} —{" "}
                  <a href={issue.htmlUrl} target="_blank" rel="noreferrer">
                    open on GitHub
                  </a>{" "}
                  for the rest
                </div>
              )}
              {issue.comments.map((c) => (
                <div key={c.id} className="gh-comment">
                  <div className="gh-detail-meta">
                    {c.author ?? "unknown"} · {formatRelativeAge(Date.parse(c.createdAt))}
                  </div>
                  <SafeHtml className="gh-html" html={c.bodyHtml} />
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
