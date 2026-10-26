import { useEffect, useState } from "react";
import { api } from "../api/index.js";
import { usePrDetail } from "../hooks/useGitHubData.js";
import type { GitHubPrDetail, GitHubPrDetailThread, RelayReviewState } from "../api/types.js";
import { checkDotClass } from "./checkDot.js";
import { runStatusText } from "../lib/statusTone.js";
import { formatRelativeAge } from "../relativeTime.js";
import { useDashboardStore } from "../store/index.js";
import { ConfirmButton } from "../ui/ConfirmButton.js";
import { EmptyStateNote } from "../ui/EmptyState.js";
import { ErrorText } from "../ui/ErrorText.js";
import { SafeHtml } from "../ui/SafeHtml.js";
import { PHASE_LABEL, phaseTone } from "./prPhase.js";

// The PR drill-in: status at a glance (Reviews / Checks / Merge, in the
// GitHub mobile app's order), the change summary, and the conversation.
// Status rows expand on demand; actions are secondary to the status itself.

function StatusRow({
  tone,
  glyph,
  title,
  summary,
  children,
}: {
  tone: "good" | "bad" | "warn" | "dim";
  glyph: string;
  title: string;
  summary: string;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="gh-status-row">
      <button
        type="button"
        className="gh-status-head"
        aria-expanded={open}
        disabled={!children}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`gh-status-glyph ${tone}`}>{glyph}</span>
        <span className="gh-status-text">
          <span className="gh-status-title">{title}</span>
          <span className="gh-status-summary">{summary}</span>
        </span>
        {children && <span aria-hidden>{open ? "▾" : "▸"}</span>}
      </button>
      {open && children && <div className="gh-status-body">{children}</div>}
    </div>
  );
}

const REVIEW_GLYPH: Record<string, string> = {
  APPROVED: "✓",
  CHANGES_REQUESTED: "✎",
  COMMENTED: "💬",
  DISMISSED: "○",
};

function reviewsSummary(pr: GitHubPrDetail): {
  tone: "good" | "bad" | "warn" | "dim";
  glyph: string;
  text: string;
} {
  const names = (state: string) =>
    pr.reviewers
      .filter((r) => r.state === state)
      .map((r) => r.login)
      .join(", ");
  if (pr.reviewDecision === "CHANGES_REQUESTED" || names("CHANGES_REQUESTED")) {
    return {
      tone: "bad",
      glyph: "✎",
      text: `Changes requested by ${names("CHANGES_REQUESTED") || "a reviewer"}`,
    };
  }
  if (pr.reviewDecision === "APPROVED") {
    return { tone: "good", glyph: "✓", text: `Approved by ${names("APPROVED") || "a reviewer"}` };
  }
  if (pr.requestedReviewers.length > 0) {
    return {
      tone: "warn",
      glyph: "○",
      text: `Awaiting review from ${pr.requestedReviewers.join(", ")}`,
    };
  }
  if (pr.reviewDecision === "REVIEW_REQUIRED") {
    return { tone: "warn", glyph: "○", text: "Review required" };
  }
  return { tone: "dim", glyph: "○", text: pr.reviewers.length > 0 ? "Reviewed" : "No reviews yet" };
}

function checksSummary(pr: GitHubPrDetail): {
  tone: "good" | "bad" | "warn" | "dim";
  glyph: string;
  text: string;
} {
  const classes = pr.actionsRuns.map((r) => checkDotClass(r.status, r.conclusion));
  const failing = classes.filter((c) => c === "bad").length;
  const running = classes.filter((c) => c === "pending").length;
  if (pr.actionsRuns.length === 0) {
    // ciStatus null = the poller has no answer (not yet fetched or failed), as
    // opposed to a PR that genuinely has no runs.
    return {
      tone: "dim",
      glyph: "○",
      text: pr.ciKnown ? "No checks reported" : "Checks unknown",
    };
  }
  if (failing > 0) {
    return {
      tone: "bad",
      glyph: "✗",
      text: [`${failing} failing`, running > 0 ? `${running} in progress` : ""]
        .filter(Boolean)
        .join(", "),
    };
  }
  if (running > 0) return { tone: "warn", glyph: "⋯", text: `${running} in progress` };
  return { tone: "good", glyph: "✓", text: "All checks have passed" };
}

function mergeSummary(pr: GitHubPrDetail): {
  tone: "good" | "bad" | "warn" | "dim";
  glyph: string;
  text: string;
} {
  if (pr.state === "MERGED") return { tone: "good", glyph: "✓", text: "Merged" };
  if (pr.state === "CLOSED") return { tone: "dim", glyph: "○", text: "Closed" };
  const tone = phaseTone(pr.prPhase);
  if (pr.prPhase === "ready_to_merge") {
    return { tone: "good", glyph: "✓", text: "Ready to merge (squash)" };
  }
  if (pr.prPhase === "conflicts") {
    return { tone: "bad", glyph: "⚠", text: "Conflicts with the base branch" };
  }
  return {
    tone,
    glyph: tone === "bad" ? "✗" : "⋯",
    text: `Blocked: ${PHASE_LABEL[pr.prPhase].toLowerCase()}`,
  };
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

/** What a review that has not landed is doing, in words. */
function pendingLabel(status: string | undefined, landedChecked: boolean | undefined): string {
  switch (status) {
    case "failed":
    case "interrupted":
    case "cancelled":
      return "the review did not finish";
    case "completed":
      // The run finished — but the landed-review lookup is what says whether
      // it posted anything. If that lookup failed, the review may well be on
      // the PR, so this must not claim the bot posted nothing.
      return landedChecked === false
        ? "the review could not be confirmed on the pull request"
        : "the review finished without posting";
    case "stopping":
    case "stopped":
      return "the review is being stopped";
    case "not_found":
      // Hermes no longer knows the run (it expired, or the server restarted
      // and lost it) — nothing is coming.
      return "the review run is no longer known to the relay";
    case "unknown":
    case undefined:
      // No status at all — the run-status read failed, so this says nothing
      // about the review. Claiming it is "waiting" would be an assertion
      // made from no data.
      return "the relay could not read the review run";
    default:
      // The run's status says it is still going. The landed-review lookup is
      // what separates "still waiting" from "we could not confirm it" — a
      // failed lookup must not be read as "no review yet".
      return landedChecked === false
        ? "the review could not be confirmed on the pull request"
        : "waiting for the review bot";
  }
}

/** A review's GitHub state, in words. */
function verdictLabel(verdict: string | undefined): string {
  switch (verdict) {
    case "APPROVED":
      return "Approved";
    case "CHANGES_REQUESTED":
      return "Changes requested";
    case "COMMENTED":
      return "Commented";
    default:
      return verdict ?? "Review posted";
  }
}

/**
 * The review relay's state for this pull request (issue #1630) — the same
 * relay the agent-facing `review_status` reports, seen from the operator's
 * side.
 *
 * `"none"` means no relay run is known for this PR (never requested here, or
 * the server restarted). It does NOT mean "no review is pending" — the relay's
 * run index is in-memory — so this renders nothing at all in that case,
 * rather than claiming there is no review.
 */
function RelayReviewBlock({ state }: { state: RelayReviewState | null }) {
  // Anything but a known state renders nothing: "no relay run is known" and
  // "the server answered with something else" must both look like silence,
  // never like "no review is pending".
  if (!state || (state.state !== "requested" && state.state !== "landed")) return null;
  if (state.state === "requested") {
    return (
      <div className="github-panel-section">
        <div className="github-panel-section-title">Review</div>
        <div className="github-panel-empty-row">
          A review was requested — {pendingLabel(state.status, state.landedChecked)}.
        </div>
      </div>
    );
  }
  return (
    <div className="github-panel-section">
      <div className="github-panel-section-title">Review</div>
      <div className="github-panel-empty-row">
        {verdictLabel(state.verdict)}
        {state.author ? ` by ${state.author}` : ""}
        {state.htmlUrl ? (
          <>
            {" — "}
            <a href={state.htmlUrl} target="_blank" rel="noreferrer" className="gh-link-button">
              open on GitHub
            </a>
          </>
        ) : null}
      </div>
      {state.body && (
        <div className="gh-detail-meta">
          {/* Cut by code point, so an emoji on the boundary is not split. */}
          {[...state.body].length > 600 ? `${[...state.body].slice(0, 600).join("")}…` : state.body}
          {state.bodyTruncated ? " (the review text was cut short)" : ""}
        </div>
      )}
    </div>
  );
}

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
  const [busy, setBusy] = useState<"merge" | "review" | "handoff" | null>(null);
  const [showBody, setShowBody] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [showCommits, setShowCommits] = useState(false);
  const reload = () => {
    setActionError(null);
    void refresh();
  };

  // The GitHub tab this replaces refreshed itself: re-fetch periodically
  // while the view is open (the server caches ~30s, so faster is pointless).
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState !== "hidden") void refresh();
    }, PR_REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const run = async (kind: "merge" | "review" | "handoff", fn: () => Promise<string | void>) => {
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

  if (error && !pr) {
    return (
      <div className="gh-detail">
        <button type="button" className="gh-detail-back" onClick={onBack}>
          ← Back
        </button>
        <ErrorText>{error}</ErrorText>
      </div>
    );
  }
  if (!pr) {
    return (
      <div className="gh-detail">
        <button type="button" className="gh-detail-back" onClick={onBack}>
          ← Back
        </button>
        <EmptyStateNote>Loading…</EmptyStateNote>
      </div>
    );
  }

  const reviews = reviewsSummary(pr);
  const checks = checksSummary(pr);
  const mergeInfo = mergeSummary(pr);
  const openThreads = pr.threads.filter((t) => !t.isResolved);
  const resolvedThreads = pr.threads.filter((t) => t.isResolved);
  const timeline = [
    ...pr.reviews.map((r) => ({ kind: "review" as const, at: r.createdAt, item: r })),
    ...pr.comments.map((c) => ({ kind: "comment" as const, at: c.createdAt, item: c })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  return (
    <div className="gh-detail">
      <div className="gh-detail-actions">
        <button type="button" className="gh-detail-back" onClick={onBack}>
          ← Back
        </button>
        <button type="button" className="gh-link-button" onClick={() => reload()}>
          Refresh
        </button>
      </div>
      {error && <ErrorText>{error}</ErrorText>}
      {notice && <div className="gh-detail-notice">{notice}</div>}

      <div className="gh-detail-title">
        <span className="github-panel-row-number">#{pr.number}</span> {pr.title}
        {pr.isDraft && <span className="gh-task-chip">draft</span>}
      </div>
      <div className="gh-detail-meta">
        {pr.baseBranch} ← {pr.headBranch} · {pr.author ?? "unknown"} · updated{" "}
        {formatRelativeAge(Date.parse(pr.updatedAt))}
      </div>
      <RelayReviewBlock state={relayReview} />
      {pr.bodyHtml && (
        <>
          <SafeHtml className={`gh-html${showBody ? "" : " gh-clamp"}`} html={pr.bodyHtml} />
          <button type="button" className="gh-link-button" onClick={() => setShowBody((s) => !s)}>
            {showBody ? "Show less" : "Read more"}
          </button>
        </>
      )}

      <div className="github-panel-section">
        <div className="github-panel-section-title">Changes</div>
        <button type="button" className="gh-link-button" onClick={() => setShowFiles((s) => !s)}>
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
        <button type="button" className="gh-link-button" onClick={() => setShowCommits((s) => !s)}>
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

      <div className="github-panel-section">
        <div className="github-panel-section-title">Status</div>
        <StatusRow tone={reviews.tone} glyph={reviews.glyph} title="Reviews" summary={reviews.text}>
          {pr.reviewers.map((r) => (
            <div key={r.login} className="github-panel-row">
              <span>{REVIEW_GLYPH[r.state] ?? "○"}</span>
              <span className="github-panel-row-title">{r.login}</span>
              <span className="github-panel-row-number">
                {r.state.toLowerCase().replace(/_/g, " ")}
              </span>
            </div>
          ))}
          {pr.requestedReviewers.map((r) => (
            <div key={`req-${r}`} className="github-panel-row">
              <span>○</span>
              <span className="github-panel-row-title">{r}</span>
              <span className="github-panel-row-number">requested</span>
            </div>
          ))}
          {pr.reviewers.length === 0 && pr.requestedReviewers.length === 0 && (
            <div className="github-panel-empty-row">No reviewers</div>
          )}
        </StatusRow>
        <StatusRow tone={checks.tone} glyph={checks.glyph} title="Checks" summary={checks.text}>
          {pr.actionsRuns.length > 0
            ? pr.actionsRuns.map((r) => (
                <a
                  key={r.htmlUrl}
                  className="github-panel-row"
                  href={r.htmlUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span
                    className={`github-panel-ci-dot ${checkDotClass(r.status, r.conclusion)}`}
                  />
                  <span className="github-panel-row-title">{r.name}</span>
                  <span className="github-panel-row-number">
                    {runStatusText(r.status, r.conclusion)}
                  </span>
                </a>
              ))
            : undefined}
        </StatusRow>
        <StatusRow
          tone={mergeInfo.tone}
          glyph={mergeInfo.glyph}
          title="Merge"
          summary={mergeInfo.text}
        />
        {pr.state === "OPEN" && (
          <div className="gh-detail-actions">
            <ConfirmButton
              variant="neutral"
              title="Squash and merge this pull request"
              armedLabel="Confirm merge"
              disabled={pr.prPhase !== "ready_to_merge" || busy !== null}
              onConfirm={merge}
            >
              Squash and merge
            </ConfirmButton>
            <button type="button" disabled={busy !== null} onClick={reReview}>
              {busy === "review" ? "Requesting…" : "Request re-review"}
            </button>
          </div>
        )}
      </div>

      <div className="github-panel-section">
        <div className="github-panel-section-title">
          Conversation
          <button
            type="button"
            className="gh-link-button"
            disabled={busy !== null}
            onClick={handoff}
          >
            {busy === "handoff" ? "Starting…" : "Hand off to session"}
          </button>
        </div>
        {openThreads.length > 0 && (
          <>
            <div className="gh-detail-meta">Unresolved threads ({openThreads.length})</div>
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
        {timeline.map((entry, i) => (
          <div key={i} className="gh-comment">
            <div className="gh-detail-meta">
              {entry.item.author ?? "unknown"}
              {entry.kind === "review" &&
                ` · ${(entry.item as { state: string }).state.toLowerCase().replace(/_/g, " ")}`}{" "}
              · {formatRelativeAge(Date.parse(entry.at))}
            </div>
            <SafeHtml className="gh-html" html={entry.item.bodyHtml} />
          </div>
        ))}
        {openThreads.length === 0 && resolvedThreads.length === 0 && timeline.length === 0 && (
          <div className="github-panel-empty-row">No conversation yet</div>
        )}
      </div>
    </div>
  );
}
