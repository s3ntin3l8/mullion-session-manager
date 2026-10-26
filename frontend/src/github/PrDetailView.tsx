import { useEffect, useState } from "react";
import { api } from "../api/index.js";
import { usePrDetail, usePrList, useRunJobs } from "../hooks/useGitHubData.js";
import { useMullionLinks, type SessionLink } from "../hooks/useMullionLinks.js";
import type { GitHubPrDetail, GitHubPrDetailThread, ReviewSummaryEntry } from "../api/types.js";
import { describeEvent } from "../eventDescriptions.js";
import { formatRelativeAge } from "../relativeTime.js";
import { useDashboardStore } from "../store/index.js";
import { ConfirmButton } from "../ui/ConfirmButton.js";
import { EmptyStateNote } from "../ui/EmptyState.js";
import { ErrorText } from "../ui/ErrorText.js";
import { RefreshIcon, ThreadIcon } from "../ui/icons.js";
import { SafeHtml } from "../ui/SafeHtml.js";
import {
  Button,
  DetailHeader,
  IconButton,
  SessionPills,
  SidebarSection,
  StatusChip,
  TaskChip,
  decideSessionAction,
} from "../ui/sidebar/index.js";
import type { Tone } from "../lib/statusTone.js";
import { ChecksDrill, MergeDrill, ReviewsDrill } from "./PrStatusViews.js";
import { prStatuses, runIdFromUrl, type DimStatus } from "./prPhase.js";

// The PR drill-in: status first (Checks / Reviews / Merge, each an expandable
// row), then the pinned latest review, the Mullion links, the change summary
// and the conversation. The three status rows are the same drilldowns the PR
// list row opens, built from the same derivation (prPhase.ts), so the two never
// disagree. Actions live in a sticky bar; they are secondary to the status.

type StatusKey = "ci" | "review" | "merge";

function StatusRow({
  dim,
  title,
  open,
  onToggle,
  expandable = true,
}: {
  dim: DimStatus;
  title: string;
  open: boolean;
  onToggle: () => void;
  expandable?: boolean;
}) {
  return (
    <button
      type="button"
      className="pr-status-row"
      aria-expanded={expandable ? open : undefined}
      disabled={!expandable}
      onClick={onToggle}
    >
      <span className={`pr-status-glyph pr-tone-${dim.tone}`}>{dim.glyph}</span>
      <span className="pr-status-text">
        <span className="pr-status-title">{title}</span>
        <span className="pr-status-sum">{dim.text}</span>
      </span>
      {expandable && <span aria-hidden>{open ? "▾" : "▸"}</span>}
    </button>
  );
}

const REVIEW_STATE_TONE: Record<string, Tone> = {
  APPROVED: "success",
  CHANGES_REQUESTED: "danger",
  COMMENTED: "info",
};
const REVIEW_STATE_LABEL: Record<string, string> = {
  APPROVED: "Approved",
  CHANGES_REQUESTED: "Changes requested",
  COMMENTED: "Commented",
};

/** How far the head has moved past the reviewed commit, when the commits show it. */
function staleLabel(entry: ReviewSummaryEntry, commits: GitHubPrDetail["commits"]) {
  const sha = entry.reviewedSha.slice(0, 7);
  const at = entry.reviewedSha
    ? commits.findIndex(
        (c) => c.oid.startsWith(entry.reviewedSha) || entry.reviewedSha.startsWith(c.oid),
      )
    : -1;
  const behind = at >= 0 ? commits.length - 1 - at : null;
  return {
    full: `stale${sha ? ` · on ${sha}` : ""}${behind ? `, head +${behind}` : ""}`,
    short: behind ? `stale +${behind}` : "stale",
  };
}

/**
 * The most recent review (human, bot or relay) with something to read, pinned
 * directly under Status so it is the first thing read after CI / Review / Merge.
 */
function PinnedReview({
  entry,
  commits,
  unresolved,
  busy,
  onReReview,
  onHandoff,
  onStop,
}: {
  entry: ReviewSummaryEntry;
  commits: GitHubPrDetail["commits"];
  unresolved: number;
  busy: boolean;
  onReReview: () => void;
  onHandoff: () => void;
  onStop: (() => void) | null;
}) {
  const [expanded, setExpanded] = useState(false);
  // Clamped to 6 lines; the toggle only appears when there is more to show.
  const long = entry.body.split("\n").length > 6 || entry.body.length > 420;
  const stale = entry.stale ? staleLabel(entry, commits) : null;
  return (
    <div
      className="pr-card pr-card--pin"
      role="region"
      aria-label={`Latest review by ${entry.author}`}
    >
      <div className="pr-card-h">
        <span>Latest review</span>
        <StatusChip tone={REVIEW_STATE_TONE[entry.state] ?? "neutral"}>
          {REVIEW_STATE_LABEL[entry.state] ?? entry.state.toLowerCase().replace(/_/g, " ")}
        </StatusChip>
        <b>{entry.author}</b>
        {entry.submittedAt && <span>{formatRelativeAge(Date.parse(entry.submittedAt))}</span>}
        {stale && (
          <StatusChip tone="warn" short={stale.short} title="The head moved since this review">
            {stale.full}
          </StatusChip>
        )}
      </div>
      <div className="pr-card-b">
        {entry.body && (
          <>
            <div className={`pr-pin-body${expanded ? "" : " pr-pin-body--clamp"}`}>
              {entry.body}
            </div>
            {long && (
              <button
                type="button"
                className="gh-link-button"
                onClick={() => setExpanded((e) => !e)}
              >
                {expanded ? "Show less" : "Read more"}
              </button>
            )}
          </>
        )}
        <div className="pr-pin-foot">
          {unresolved > 0 && (
            <StatusChip tone="info" title="Unresolved review threads">
              <ThreadIcon size={11} /> {unresolved} unresolved
            </StatusChip>
          )}
          <Button size="sm" disabled={busy} onClick={onReReview}>
            Re-review
          </Button>
          <Button size="sm" disabled={busy} onClick={onHandoff}>
            Hand off comments
          </Button>
          {onStop && (
            <Button size="sm" variant="danger" onClick={onStop}>
              Stop review
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function Thread({ thread }: { thread: GitHubPrDetailThread }) {
  return (
    <div className="gh-thread">
      <div className="gh-detail-meta">
        {thread.path ?? "General"}
        {thread.line ? `:${thread.line}` : ""}
        {thread.isOutdated ? " · outdated" : ""}
      </div>
      {thread.comments.map((c, i) => (
        <div key={i} className="gh-comment">
          <div className="gh-detail-meta">
            {c.author ?? "unknown"} · {formatRelativeAge(Date.parse(c.createdAt))}
          </div>
          <SafeHtml className="gh-html" html={c.bodyHtml} />
        </div>
      ))}
    </div>
  );
}

const PR_REFRESH_MS = 30_000;

export function PrDetailView({
  projectId,
  number,
  onBack,
}: {
  projectId: number;
  number: number;
  onBack: () => void;
}) {
  // Cached (stale-while-revalidate): a PR already seen — or prefetched on row
  // hover — paints immediately instead of "Loading…". The relay's state
  // (issue #1630) rides along; a failure there is not the PR's failure.
  const { pr, error: loadError, review: relayReview, refresh } = usePrDetail(projectId, number);
  const [actionError, setActionError] = useState<string | null>(null);
  const error = actionError ?? loadError;
  const setError = setActionError;
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<"merge" | "review" | "handoff" | "stop" | "task" | null>(null);
  const [openStatus, setOpenStatus] = useState<StatusKey | null>(null);
  const [showBody, setShowBody] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [showCommits, setShowCommits] = useState(false);
  // The same PR list the panel joins on, so the row and the detail agree on
  // linked sessions before the WS push has filled the store.
  const links = useMullionLinks(projectId, { prs: usePrList(projectId)?.prs });
  const events = useDashboardStore((s) => s.events);
  const requestOpenSession = useDashboardStore((s) => s.requestOpenSession);
  const reload = () => {
    setActionError(null);
    void refresh();
  };

  // The CI rows load their jobs once the Checks row is open (cached per run).
  const runIds = (pr?.actionsRuns ?? []).flatMap((r) => {
    const id = runIdFromUrl(r.htmlUrl);
    return id == null ? [] : [id];
  });
  const jobsByRun = useRunJobs(projectId, runIds, openStatus === "ci");

  // The GitHub tab this replaces refreshed itself: re-fetch periodically
  // while the view is open (the server caches ~30s, so faster is pointless).
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState !== "hidden") void refresh();
    }, PR_REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const run = async (
    kind: "merge" | "review" | "handoff" | "stop" | "task",
    fn: () => Promise<string | void>,
  ) => {
    setBusy(kind);
    setNotice(null);
    setError(null);
    try {
      const message = await fn();
      if (message) setNotice(message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(null);
    }
  };

  const merge = () =>
    run("merge", async () => {
      if (!pr) return;
      await api.mergeProjectPr(projectId, number, pr.headSha);
      reload();
      return "Merged (squash)";
    });

  const reReview = () =>
    run("review", async () => {
      const res = await api.reReviewProjectPr(projectId, number);
      // Refetch: the request produced a new run, so the old verdict on screen
      // is stale (the state is memoized per run, so a refetch shows the new
      // one straight away).
      reload();
      // #1790 — the review runs either way; the marker is how the repository's
      // own review workflow sees it, so say when it could not be written.
      return res.marker && !res.marker.written
        ? `Re-review requested — in-flight marker not written: ${res.marker.message}`
        : "Re-review requested";
    });

  const handoff = () =>
    run("handoff", async () => {
      if (!pr) return;
      const { prompt, branch } = await api.getProjectPrHandoff(projectId, number);
      const state = useDashboardStore.getState();
      const launchers = await api.listProjectActions(projectId);
      const launcher =
        launchers.find((l) => l.id === `agent:${state.settings.launchers.defaultAgent}`) ??
        launchers[0];
      if (!launcher) throw new Error("No launcher is configured for this project.");
      const session = await state.createSession(projectId, launcher.command, {
        worktree: { branch },
        seedPrompt: prompt,
      });
      state.requestOpenSession(session.id);
      return "Session started on the PR branch";
    });

  const backHeader = (title: string) => <DetailHeader onBack={onBack} title={title} />;

  if (error && !pr) {
    return (
      <div className="gh-detail">
        {backHeader(`#${number}`)}
        <ErrorText>{error}</ErrorText>
      </div>
    );
  }
  if (!pr) {
    return (
      <div className="gh-detail">
        {backHeader(`#${number}`)}
        <EmptyStateNote>Loading…</EmptyStateNote>
      </div>
    );
  }

  const statuses = prStatuses(pr, relayReview, jobsByRun);
  const entry = links.byPr.get(pr.number) ?? links.byBranch.get(pr.headBranch);
  const sessionAction = decideSessionAction(entry);
  const reviewRun = entry?.reviewRun ?? null;
  const relayActive = reviewRun?.state === "requested" && !reviewRun.unverified;
  const stopReview = () =>
    run("stop", async () => {
      if (!reviewRun) return;
      await api.stopReview(reviewRun.runId);
      reload();
      return "Review stopped";
    });
  // Task Master's own actions on this PR's task (Merge is the sticky bar's).
  const taskStatus = entry?.task?.status;
  const taskId = entry?.task?.id;
  const approveTask = () =>
    run("task", async () => {
      if (taskId == null) return;
      await useDashboardStore.getState().approveTask(taskId);
      return `Task #${taskId} approved`;
    });
  const retryTask = () =>
    run("task", async () => {
      if (taskId == null) return;
      await useDashboardStore.getState().retryTask(taskId);
      return `Task #${taskId} retried`;
    });
  const openThreads = pr.threads.filter((t) => !t.isResolved);
  const resolvedThreads = pr.threads.filter((t) => t.isResolved);
  const unresolved = pr.reviewSummary?.unresolvedThreads ?? openThreads.length;

  // The pinned reviews (A2's `latest`, max 2); a relay review the summary does
  // not carry yet still pins from the relay's own read.
  const pinned: ReviewSummaryEntry[] =
    pr.reviewSummary?.latest && pr.reviewSummary.latest.length > 0
      ? pr.reviewSummary.latest
      : relayReview?.state === "landed" && relayReview.body
        ? [
            {
              author: relayReview.author ?? "review relay",
              isBot: true,
              state: relayReview.verdict ?? "COMMENTED",
              body: relayReview.body,
              submittedAt: null,
              reviewedSha: "",
              stale: false,
            },
          ]
        : [];
  // The timeline marks a pinned review "pinned above" instead of repeating it.
  const pinnedAt = new Set<number>();
  for (const p of pinned) {
    let best = -1;
    pr.reviews.forEach((r, i) => {
      if (r.author !== p.author || r.state !== p.state) return;
      if (best < 0 || Date.parse(r.createdAt) >= Date.parse(pr.reviews[best].createdAt)) best = i;
    });
    if (best >= 0) pinnedAt.add(best);
  }
  const timeline = [
    ...pr.reviews.map((r, i) => ({
      kind: "review" as const,
      at: r.createdAt,
      item: r,
      pinned: pinnedAt.has(i),
    })),
    ...pr.comments.map((c) => ({
      kind: "comment" as const,
      at: c.createdAt,
      item: c,
      pinned: false,
    })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  // Recent PR events (CI failed/passed, conflicts, comments, review) from the
  // linked sessions' own event streams.
  const sessionIds = new Set<number>();
  const collect = (ls: readonly SessionLink[]) => {
    for (const l of ls) {
      sessionIds.add(l.session.id);
      collect(l.children);
    }
  };
  if (entry) collect(entry.sessions);
  const recentEvents = [...sessionIds]
    .flatMap((id) => events[id] ?? [])
    .filter((e) => e.kind.startsWith("pr_") && e.payload.number === pr.number)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 4)
    .flatMap((e) => {
      const d = describeEvent(e);
      return d ? [{ ts: e.ts, seq: e.seq, ...d }] : [];
    });

  const toggleStatus = (k: StatusKey) => setOpenStatus((cur) => (cur === k ? null : k));
  const mergeFix =
    pr.prPhase === "conflicts" || pr.prPhase === "changes_requested" ? (
      <Button size="sm" disabled={busy !== null} onClick={handoff}>
        Hand off to session
      </Button>
    ) : pr.prPhase === "ci_failing" ? (
      <Button size="sm" onClick={() => setOpenStatus("ci")}>
        Show failing checks
      </Button>
    ) : pr.prPhase === "review_pending" || pr.prPhase === "reviewed" ? (
      <Button size="sm" disabled={busy !== null} onClick={reReview}>
        Request re-review
      </Button>
    ) : null;

  return (
    <div className="gh-detail pr-detail">
      <DetailHeader
        onBack={onBack}
        title={
          <>
            <span className="mono">#{pr.number}</span> · {pr.title}
          </>
        }
        subtitle={`${pr.baseBranch} ← ${pr.headBranch}`}
        actions={
          <IconButton label="Refresh" onClick={() => reload()}>
            <RefreshIcon size={14} />
          </IconButton>
        }
        externalUrl={pr.htmlUrl}
        externalLabel={`Open PR #${pr.number} on GitHub`}
      />
      <div className="pr-detail-scroll">
        {error && (
          <div className="pr-detail-pad">
            <ErrorText>{error}</ErrorText>
          </div>
        )}
        {notice && (
          <div className="pr-detail-pad">
            <div className="gh-detail-notice">{notice}</div>
          </div>
        )}
        <div className="pr-detail-pad gh-detail-meta">
          {pr.isDraft && <StatusChip tone="neutral">draft</StatusChip>} {pr.author ?? "unknown"} ·
          updated {formatRelativeAge(Date.parse(pr.updatedAt))}
          {pr.partial && " · reviews and conversation are unavailable right now"}
        </div>

        <div className="pr-card">
          <div className="pr-card-h">Status</div>
          <StatusRow
            dim={statuses.ci}
            title="Checks"
            open={openStatus === "ci"}
            onToggle={() => toggleStatus("ci")}
            expandable={pr.actionsRuns.length > 0 || (pr.otherChecks?.length ?? 0) > 0}
          />
          {openStatus === "ci" && (
            <ChecksDrill
              projectId={projectId}
              runs={pr.actionsRuns}
              otherChecks={pr.otherChecks}
              truncated={pr.checksTruncated}
              jobsByRun={jobsByRun}
              title={`Checks · ${statuses.ci.text}`}
            />
          )}
          <StatusRow
            dim={statuses.review}
            title="Reviews"
            open={openStatus === "review"}
            onToggle={() => toggleStatus("review")}
          />
          {openStatus === "review" && (
            <ReviewsDrill
              reviewers={pr.reviewers}
              requested={pr.requestedReviewers}
              status={statuses.review}
              title={`Reviews · ${statuses.review.text}`}
            />
          )}
          <StatusRow
            dim={statuses.merge}
            title="Merge"
            open={openStatus === "merge"}
            onToggle={() => toggleStatus("merge")}
            expandable={mergeFix !== null}
          />
          {openStatus === "merge" && mergeFix && (
            <MergeDrill text={`Merge · ${statuses.merge.text}`}>{mergeFix}</MergeDrill>
          )}
        </div>

        {pinned.map((p) => (
          <PinnedReview
            key={`${p.author}-${p.state}`}
            entry={p}
            commits={pr.commits}
            unresolved={unresolved}
            busy={busy !== null}
            onReReview={reReview}
            onHandoff={handoff}
            onStop={relayActive ? stopReview : null}
          />
        ))}

        <div className="pr-card" role="region" aria-label="Mullion">
          <div className="pr-card-h">Mullion</div>
          <div className="pr-card-b">
            {entry && entry.sessions.length > 0 && <SessionPills links={entry.sessions} />}
            {entry?.task && (
              <div className="pr-pin-foot">
                <TaskChip task={entry.task} />
                {taskStatus === "reviewing" && (
                  <Button size="sm" disabled={busy !== null} onClick={approveTask}>
                    Approve task
                  </Button>
                )}
                {taskStatus === "failed" && (
                  <Button size="sm" disabled={busy !== null} onClick={retryTask}>
                    Retry task
                  </Button>
                )}
              </div>
            )}
            {reviewRun && (
              <div className="pr-pin-foot">
                <StatusChip
                  tone={reviewRun.state === "landed" ? "success" : "info"}
                  title={`Review run ${reviewRun.runId}`}
                >
                  {reviewRun.state === "landed"
                    ? "review posted"
                    : reviewRun.unverified
                      ? "review unconfirmed"
                      : `review run${reviewRun.status ? ` · ${reviewRun.status}` : ""}`}
                </StatusChip>
                {relayActive && (
                  <Button size="sm" variant="danger" disabled={busy !== null} onClick={stopReview}>
                    Stop
                  </Button>
                )}
              </div>
            )}
            {!entry?.sessions.length && !entry?.task && !reviewRun && (
              <span className="gh-detail-meta">No session, task or review run linked yet.</span>
            )}
            {recentEvents.length > 0 && (
              <ul className="pr-events" aria-label="Recent PR events">
                {recentEvents.map((e) => (
                  <li key={`${e.ts}-${e.seq}`} className={e.attention ? "attn" : undefined}>
                    {e.text} · {formatRelativeAge(e.ts)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {pr.bodyHtml && (
          <div className="pr-detail-pad">
            <SafeHtml className={`gh-html${showBody ? "" : " gh-clamp"}`} html={pr.bodyHtml} />
            <button type="button" className="gh-link-button" onClick={() => setShowBody((s) => !s)}>
              {showBody ? "Show less" : "Read more"}
            </button>
          </div>
        )}

        <SidebarSection title="Changes" persistKey="github-pr-changes">
          <div className="pr-detail-pad">
            <button
              type="button"
              className="gh-link-button"
              onClick={() => setShowFiles((s) => !s)}
            >
              {pr.changedFiles} files changed <span className="gh-add">+{pr.additions}</span>{" "}
              <span className="gh-del">−{pr.deletions}</span>
            </button>
            {showFiles && pr.files.length === 0 && pr.changedFiles > 0 && (
              <div className="github-panel-empty-row">File list unavailable</div>
            )}
            {showFiles && pr.files.length > 0 && pr.files.length < pr.changedFiles && (
              <div className="github-panel-empty-row">
                Showing the first {pr.files.length} of {pr.changedFiles} files
              </div>
            )}
            {showFiles &&
              pr.files.map((f) => (
                <div key={f.filename} className="github-panel-row">
                  <span className="github-panel-row-title" title={f.filename}>
                    {f.filename}
                  </span>
                  <span className="gh-add">+{f.additions}</span>
                  <span className="gh-del">−{f.deletions}</span>
                </div>
              ))}
            <button
              type="button"
              className="gh-link-button"
              onClick={() => setShowCommits((s) => !s)}
            >
              {pr.commitCount} commit{pr.commitCount === 1 ? "" : "s"}
            </button>
            {showCommits &&
              pr.commits.map((c) => (
                <div key={c.oid} className="github-panel-row">
                  <span className="github-panel-row-number">{c.oid.slice(0, 7)}</span>
                  <span className="github-panel-row-title">{c.headline}</span>
                </div>
              ))}
          </div>
        </SidebarSection>

        <SidebarSection title="Conversation" persistKey="github-pr-conversation">
          <div className="pr-detail-pad">
            {openThreads.length > 0 && (
              <>
                <div className="gh-detail-meta">
                  <ThreadIcon size={12} /> Unresolved threads ({openThreads.length})
                </div>
                {openThreads.map((t, i) => (
                  <Thread key={`open-${i}`} thread={t} />
                ))}
              </>
            )}
            {resolvedThreads.length > 0 && (
              <details>
                <summary>Resolved threads ({resolvedThreads.length})</summary>
                {resolvedThreads.map((t, i) => (
                  <Thread key={`resolved-${i}`} thread={t} />
                ))}
              </details>
            )}
            {timeline.map((e, i) =>
              e.pinned ? (
                <div key={i} className="gh-comment pr-pinned-mark">
                  {e.item.author ?? "unknown"} reviewed · {formatRelativeAge(Date.parse(e.at))}{" "}
                  <StatusChip tone="neutral">pinned above</StatusChip>
                </div>
              ) : (
                <div key={i} className="gh-comment">
                  <div className="gh-detail-meta">
                    {e.item.author ?? "unknown"}
                    {e.kind === "review" &&
                      ` · ${(e.item as { state: string }).state.toLowerCase().replace(/_/g, " ")}`}{" "}
                    · {formatRelativeAge(Date.parse(e.at))}
                  </div>
                  <SafeHtml className="gh-html" html={e.item.bodyHtml} />
                </div>
              ),
            )}
            {openThreads.length === 0 && resolvedThreads.length === 0 && timeline.length === 0 && (
              <div className="github-panel-empty-row">No conversation yet</div>
            )}
          </div>
        </SidebarSection>
      </div>

      {pr.state === "OPEN" && (
        <div className="pr-sticky">
          <ConfirmButton
            variant="neutral"
            title="Squash and merge this pull request"
            armedLabel="Confirm merge"
            disabled={pr.prPhase !== "ready_to_merge" || busy !== null}
            onConfirm={merge}
          >
            Squash and merge
          </ConfirmButton>
          {sessionAction.kind === "open-existing" ? (
            <Button
              disabled={busy !== null}
              onClick={() => requestOpenSession(sessionAction.sessionId)}
            >
              Open existing session
            </Button>
          ) : (
            <Button disabled={busy !== null} onClick={handoff}>
              {busy === "handoff" ? "Starting…" : "Open session"}
            </Button>
          )}
          <Button disabled={busy !== null} onClick={reReview}>
            {busy === "review" ? "Requesting…" : "Re-review"}
          </Button>
        </div>
      )}
    </div>
  );
}
