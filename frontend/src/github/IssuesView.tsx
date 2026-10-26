import { useEffect, useRef, useState, type CSSProperties } from "react";
import { api } from "../api/index.js";
import { useIssue, useIssues } from "../hooks/useGitHubData.js";
import { useMullionLinks, type MullionLinkEntry } from "../hooks/useMullionLinks.js";
import { useStartSessionFrom } from "../hooks/useStartSessionFrom.js";
import type { GitHubIssueLabel, GitHubIssueListItem, GitHubIssueSort } from "../api/types.js";
import { formatRelativeAge } from "../relativeTime.js";
import { useDashboardStore } from "../store/index.js";
import { issueBranchName, issueSeedPrompt } from "./issueWork.js";
import { EmptyStateNote } from "../ui/EmptyState.js";
import { ErrorText } from "../ui/ErrorText.js";
import { BoltIcon, MessageIcon, PlayTriangleIcon } from "../ui/icons.js";
import { Dropdown } from "../ui/primitives.js";
import { SafeHtml } from "../ui/SafeHtml.js";
import { Button, DetailHeader, IconButton, SidebarRow, StatusChip } from "../ui/sidebar/index.js";
import { decideSessionAction, taskTone } from "../ui/sidebar/linkDecisions.js";
import { SessionPills } from "../ui/sidebar/SessionPills.js";
import { TaskChip } from "../ui/sidebar/TaskChip.js";

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
  const style = { "--label-c": `#${label.color}` } as CSSProperties;
  if (!onClick) {
    return (
      <StatusChip tone="neutral" className="sb-chip--label" style={style}>
        {label.name}
      </StatusChip>
    );
  }
  return (
    <button
      type="button"
      className="sb-chip sb-chip--neutral sb-chip--label"
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

  const links = useMullionLinks(projectId, { issues: data?.issues });
  const [starting, setStarting] = useState<ReadonlySet<number>>(new Set());
  const startSessionFrom = useStartSessionFrom(projectId);
  const [queued, setQueued] = useState<ReadonlySet<number>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);

  const startIssueSession = async (issue: GitHubIssueListItem) => {
    if (starting.has(issue.number)) return;
    setStarting((st) => new Set(st).add(issue.number));
    setActionError(null);
    try {
      await startSessionFrom({
        worktree: { branchName: issueBranchName(issue) },
        seedPrompt: issueSeedPrompt(issue),
      });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not start a session");
    } finally {
      setStarting((st) => {
        const next = new Set(st);
        next.delete(issue.number);
        return next;
      });
    }
  };
  const queueIssue = async (issue: GitHubIssueListItem) => {
    setActionError(null);
    try {
      await api.queueProjectIssue(projectId, issue.number);
      setQueued((q) => new Set(q).add(issue.number));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not queue the issue");
    }
  };

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
          <div className="gh-issue-bar">
            <input
              className="gh-issue-search"
              type="search"
              placeholder="Search issues…"
              aria-label="Search issues"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="gh-issue-bar-row">
              <Dropdown
                small
                ariaLabel="Sort issues"
                value={sort}
                onChange={setSort}
                options={SORT_OPTIONS}
              />
              <button
                type="button"
                className="sb-chip sb-chip--neutral"
                aria-pressed={unassigned}
                onClick={() => setUnassigned(!unassigned)}
              >
                Unassigned
              </button>
              {knownLabels.map((l) => (
                <LabelChip
                  key={l.name}
                  label={l}
                  active={selected.includes(l.name)}
                  onClick={() => toggleLabel(l.name)}
                />
              ))}
            </div>
          </div>
          {(actionError ?? error) && <ErrorText>{actionError ?? error}</ErrorText>}
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
            <IssueRow
              key={issue.number}
              issue={issue}
              link={links.byIssue.get(issue.number)}
              canQueue={ui.taskMaster?.enabled ?? data.taskMasterEnabled}
              queued={queued.has(issue.number)}
              onOpen={() => onOpenIssue(issue.number)}
              onStart={() => startIssueSession(issue)}
              onQueue={() => queueIssue(issue)}
            />
          ))}
          {loading && <div className="github-panel-empty-row">Loading…</div>}
          {data?.hasMore && !loading && (
            <button
              type="button"
              className="sb-btn sb-btn--secondary sb-btn--block gh-issue-more"
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

function IssueRow({
  issue,
  link,
  canQueue,
  queued,
  onOpen,
  onStart,
  onQueue,
}: {
  issue: GitHubIssueListItem;
  link: MullionLinkEntry | undefined;
  canQueue: boolean;
  queued: boolean;
  onOpen: () => void;
  onStart: () => void;
  onQueue: () => void;
}) {
  const done = issue.taskStatus === "done";
  const showQueue = canQueue && !issue.taskStatus && !queued;
  const action = decideSessionAction(link);
  const task = link?.task;
  const hasChips =
    issue.labels.length > 0 ||
    issue.taskStatus ||
    task ||
    issue.triage ||
    link?.sessions.length ||
    queued;
  return (
    <SidebarRow
      lead={<span className={`gh-issue-glyph${done ? " gh-issue-glyph--done" : ""}`} aria-hidden />}
      title={issue.title}
      meta={
        <>
          <span className="mono">#{issue.number}</span> · {issue.author ?? "unknown"} ·{" "}
          {formatRelativeAge(Date.parse(issue.updatedAt))}
        </>
      }
      trailing={
        issue.commentCount > 0 ? (
          <span className="gh-issue-count" title={`${issue.commentCount} comments`}>
            <MessageIcon size={12} />
            {issue.commentCount}
          </span>
        ) : undefined
      }
      extra={
        hasChips ? (
          <div className="sb-triad">
            {issue.labels.map((l) => (
              <LabelChip key={l.name} label={l} />
            ))}
            {task ? (
              <TaskChip task={task} />
            ) : (
              issue.taskStatus && (
                <StatusChip tone={taskTone(issue.taskStatus)}>Task: {issue.taskStatus}</StatusChip>
              )
            )}
            {queued && !issue.taskStatus && !task && <StatusChip tone="info">Queued</StatusChip>}
            {issue.triage && (
              <StatusChip tone="info" title={`Triage run ${issue.triage.runId}`}>
                Triage
              </StatusChip>
            )}
            <SessionPills links={link?.sessions ?? []} />
          </div>
        ) : undefined
      }
      actions={
        <>
          {showQueue && (
            <IconButton label="Queue for Task Master" onClick={onQueue}>
              <BoltIcon size={14} />
            </IconButton>
          )}
          <IconButton
            label={action.kind === "open-existing" ? "Open session" : "Start session"}
            onClick={
              action.kind === "open-existing"
                ? () => useDashboardStore.getState().requestOpenSession(action.sessionId)
                : onStart
            }
          >
            <PlayTriangleIcon size={14} />
          </IconButton>
        </>
      }
      onClick={onOpen}
    />
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
  const [busy, setBusy] = useState<"session" | "queue" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);
  const startSessionFrom = useStartSessionFrom(projectId);
  const link = useMullionLinks(projectId).byIssue.get(number);
  const action = decideSessionAction(link);
  // A linked task means it is already queued (survives a remount).
  const isQueued = queued || !!link?.task;

  const startSession = async () => {
    if (!issue) return;
    if (action.kind === "open-existing") {
      useDashboardStore.getState().requestOpenSession(action.sessionId);
      return;
    }
    setBusy("session");
    setNotice(null);
    try {
      await startSessionFrom({
        worktree: { branchName: issueBranchName(issue) },
        seedPrompt: issueSeedPrompt(issue),
      });
      setNotice("Session started in a new worktree");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not start a session");
    } finally {
      setBusy(null);
    }
  };

  const queue = async () => {
    setBusy("queue");
    setNotice(null);
    try {
      const res = await api.queueProjectIssue(projectId, number);
      setQueued(true);
      setNotice(`Queued — added the “${res.label}” label`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not queue the issue");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="gh-detail">
      <DetailHeader
        onBack={onBack}
        title={issue ? `#${issue.number} · ${issue.title}` : `#${number}`}
        subtitle={
          issue
            ? `${issue.state === "closed" ? "Closed" : "Open"} · ${issue.author ?? "unknown"} · updated ${formatRelativeAge(Date.parse(issue.updatedAt))}`
            : undefined
        }
        externalUrl={issue?.htmlUrl}
        externalLabel={`Open issue #${number} on GitHub`}
      />
      {error && <ErrorText>{error}</ErrorText>}
      {!issue && !error && <EmptyStateNote>Loading…</EmptyStateNote>}
      {issue && (
        <>
          <div className="gh-detail-meta">
            {issue.milestone ? `${issue.milestone}` : ""}
            {issue.assignees.length > 0
              ? `${issue.milestone ? " · " : ""}assigned to ${issue.assignees.join(", ")}`
              : ""}
          </div>
          {issue.labels.length > 0 && (
            <div className="gh-issue-card">
              {issue.labels.map((l) => (
                <LabelChip key={l.name} label={l} />
              ))}
            </div>
          )}
          <div className="gh-detail-actions">
            <Button variant="primary" disabled={busy !== null} onClick={startSession}>
              {busy === "session"
                ? "Starting…"
                : action.kind === "open-existing"
                  ? "Open session"
                  : "Start session"}
            </Button>
            {taskMaster?.enabled && (
              <Button disabled={busy !== null || isQueued} onClick={queue}>
                {busy === "queue" ? "Queueing…" : isQueued ? "Queued" : "Queue for Task Master"}
              </Button>
            )}
          </div>
          {link && (link.sessions.length > 0 || link.task) && (
            <div className="gh-issue-card">
              {link.task && <TaskChip task={link.task} />}
              <SessionPills links={link.sessions} />
            </div>
          )}
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
                  Showing the first {issue.comments.length} — open on GitHub for the rest
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
