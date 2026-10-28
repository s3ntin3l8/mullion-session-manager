import { runStatusText, statusTone } from "./lib/statusTone.js";
import { sortPrsByAttention } from "./github/prPhase.js";
import { PrDetailView } from "./github/PrDetailView.js";
import { PrRow } from "./github/PrRow.js";
import { IssueDetailView, IssuesSection } from "./github/IssuesView.js";
import { useCallback, useEffect, useState } from "react";
import { api } from "./api/index.js";
import type { ProjectReleaseStatus, ReleaseRunReason, ReleaseMergeReason } from "./api/index.js";
import { useAsyncData } from "./hooks/useAsyncData.js";
import { useGitHubStatus, usePrList } from "./hooks/useGitHubData.js";
import { useMullionLinks } from "./hooks/useMullionLinks.js";
import { useDashboardStore } from "./store/index.js";
import { EmptyStateNote } from "./ui/EmptyState.js";
import { Skeleton, SkeletonRegion } from "./ui/Skeleton.js";
import { Button, SidebarRow, SidebarSection, ViewHeader } from "./ui/sidebar/index.js";

export interface GitHubPanelParams {
  projectId: number;
}

// #744 — reason→copy for the Release section's Run/Merge refusals. Same
// "a domain refusal is a normal 200, only a real HTTP error throws"
// contract Source Control's own reasonMessage covers for Pull — see that
// function's own doc comment.
function runReasonMessage(
  reason: ReleaseRunReason | undefined,
  detail: string | undefined,
): string {
  switch (reason) {
    case "no-workflow":
      return "This repo has no release-please workflow configured.";
    case "no-dispatch-trigger":
      return "This repo's release workflow doesn't accept manual runs yet — add workflow_dispatch: to it.";
    case "dispatch-failed":
      return detail ? `Failed to start a release run: ${detail}` : "Failed to start a release run.";
    default:
      return "Failed to start a release run.";
  }
}

function mergeReasonMessage(
  reason: ReleaseMergeReason | undefined,
  detail: string | undefined,
): string {
  switch (reason) {
    case "no-release-pr":
      return "No open release PR to merge.";
    case "draft":
      return "This release PR is still a draft — mark it ready for review before merging.";
    case "computing":
      return "GitHub is still computing mergeability — try again shortly.";
    case "behind":
      // #744's own route doc comment: release-please owns and force-pushes
      // this branch, so the fix is re-running release-please, not updating
      // the branch (which this app never does for a release PR).
      return "This PR is behind the default branch — re-run release-please to regenerate it, rather than updating the branch.";
    case "blocked":
      return "A required check is red or still pending.";
    case "unstable":
      return "A non-required check is failing or still running.";
    case "dirty":
      return "This PR has a merge conflict with the default branch.";
    case "merge-failed":
      return detail ? `Merge failed: ${detail}` : "Merge failed.";
    default:
      return "Merge failed.";
  }
}

// Shared by both ReleaseSection branches below AND the "not-configured"
// sibling block in the main render — a repo can have BOTH a workflow file
// detectReleaseWorkflow recognizes (`detection.kind === "found"`) AND
// release-please config with conventionalCommitTitles off at the same time
// (2 of the 14 release-please repos surveyed for this feature name their
// workflow file `release-please.yml` while also committing
// `release-please-config.json`), so this can't render its own "Release"
// header unconditionally — it has to slot into whichever branch below
// already has one, to avoid two stacked headers for that overlap.
function conventionalTitlesWarningRow() {
  return (
    <div className="github-panel-empty-row github-panel-conflicts">
      This repo has release-please configured, but task PR titles are the raw issue title — an
      unprefixed title is silently dropped from the changelog and no release is cut. Turn on
      "Conventional Commits titles" in this project's settings (kebab menu → Edit).
    </div>
  );
}

function ReleaseSection({
  projectId,
  release,
  onChanged,
  onOpenPr,
}: {
  projectId: number;
  release: ProjectReleaseStatus;
  onChanged: () => void;
  onOpenPr: (number: number) => void;
}) {
  const [isRunning, setIsRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [isMerging, setIsMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);

  const handleRun = useCallback(async () => {
    setIsRunning(true);
    setRunError(null);
    try {
      const result = await api.postProjectReleaseRun(projectId);
      if (result.dispatched) {
        onChanged();
      } else {
        setRunError(runReasonMessage(result.reason, result.detail));
        // A 422 means the cached detection was stale; refetch so Run reflects it.
        if (result.reason === "no-dispatch-trigger") onChanged();
      }
    } catch (err) {
      setRunError(
        err instanceof Error ? err.message : "Failed to start a release run — try again.",
      );
    } finally {
      setIsRunning(false);
    }
  }, [projectId, onChanged]);

  const handleMerge = useCallback(async () => {
    setIsMerging(true);
    setMergeError(null);
    try {
      const result = await api.postProjectReleaseMerge(projectId);
      if (result.merged) {
        onChanged();
      } else {
        setMergeError(mergeReasonMessage(result.reason, result.detail));
      }
    } catch (err) {
      setMergeError(err instanceof Error ? err.message : "Merge failed — try again.");
    } finally {
      setIsMerging(false);
    }
  }, [projectId, onChanged]);

  // Hidden entirely when this repo isn't a release-please repo — but NOT
  // collapsed together with "the token can't tell" (docs/github-
  // integration.md's Current-limitations section already regrets doing
  // exactly that for the CI dot): "no-actions-scope" gets a small note
  // instead of silence.
  if (release.detection.kind === "not-configured") return null;
  if (release.detection.kind === "no-actions-scope") {
    return (
      <SidebarSection title="Release" persistKey="github-release">
        {release.conventionalTitlesWarning && conventionalTitlesWarningRow()}
        <div className="github-panel-empty-row">
          Can't check for a release-please workflow — the connected token lacks{" "}
          <code>Actions: read</code>.
        </div>
      </SidebarSection>
    );
  }

  const pr = release.pr;
  // GitHub 422s a manual run of a workflow with no `workflow_dispatch:`;
  // `null` (file unreadable) stays enabled and lets the real dispatch decide.
  const workflowPath = release.detection.kind === "found" ? release.detection.workflow.path : "";
  const notDispatchable =
    release.detection.kind === "found" && release.detection.workflow.dispatchable === false;
  const canMerge =
    pr !== null && !pr.draft && pr.mergeable === true && pr.mergeableState === "clean";

  return (
    <SidebarSection title="Release" persistKey="github-release">
      {release.conventionalTitlesWarning && conventionalTitlesWarningRow()}
      <SidebarRow
        lead={
          pr ? (
            <span
              className={`sb-dot sb-dot--${statusTone({ ci: pr.ciStatus })}`}
              aria-hidden="true"
            />
          ) : undefined
        }
        title={pr ? pr.title : "No release PR open"}
        onClick={pr ? () => onOpenPr(pr.number) : undefined}
        meta={
          pr ? (
            <a
              href={pr.htmlUrl}
              target="_blank"
              rel="noreferrer"
              className="mono"
              onClick={(e) => e.stopPropagation()}
            >
              #{pr.number}
            </a>
          ) : undefined
        }
        extra={
          <div className="pr-dr-actions">
            <Button
              size="sm"
              onClick={handleRun}
              disabled={isRunning || notDispatchable}
              title={
                notDispatchable
                  ? `Add workflow_dispatch: to ${workflowPath} to run releases from here`
                  : "Run release-please now, without waiting for the next push to the default branch"
              }
            >
              {isRunning ? "Running…" : "Run"}
            </Button>
            <Button
              size="sm"
              onClick={handleMerge}
              disabled={isMerging || !canMerge}
              title={
                pr === null
                  ? "No release PR open"
                  : canMerge
                    ? "Merge this release"
                    : `Not ready to merge (${pr.draft ? "draft" : pr.mergeableState})`
              }
            >
              {isMerging ? "Merging…" : "Merge"}
            </Button>
          </div>
        }
      />
      {notDispatchable && (
        <div className="github-panel-empty-row">
          Run is unavailable: add <code>workflow_dispatch:</code> to <code>{workflowPath}</code>.
        </div>
      )}
      {runError && <div className="github-panel-empty-row github-panel-conflicts">{runError}</div>}
      {mergeError && (
        <div className="github-panel-empty-row github-panel-conflicts">{mergeError}</div>
      )}
    </SidebarSection>
  );
}

export function GitHubPanel({
  params,
  embedded = false,
  onExternalLink,
}: {
  params: GitHubPanelParams;
  // Rendered inside the right sidebar: the drawer owns scrolling and padding.
  embedded?: boolean;
  // Reports where "open on GitHub" should go for whatever is showing (the
  // repo, or the open PR / issue), for a host that renders that link itself.
  onExternalLink?: (link: { url: string; label: string } | null) => void;
}) {
  const [releaseStatus, setReleaseStatus] = useState<ProjectReleaseStatus | null | undefined>(
    undefined,
  );
  // A dedicated trigger, separate from the per-project prsRefreshTrigger —
  // Run/Merge change release state Mullion itself just caused, which no
  // webhook has pushed yet (a merge's `pull_request: closed` webhook event
  // isn't correlated to anything release-specific — see the #744 plan's
  // "explicitly out of scope" list). Bumping this alone re-fetches only
  // the release section, not the PR/issue lists too.
  const [releaseRefreshTrigger, setReleaseRefreshTrigger] = useState(0);
  // Drill-in: an open PR replaces the list until the user goes back.
  const openPr = useDashboardStore((s) => s.githubOpenPrByProject[params.projectId] ?? null);
  const setGithubOpenPr = useDashboardStore((s) => s.setGithubOpenPr);
  const setOpenPr = (n: number | null) => setGithubOpenPr(params.projectId, n);
  // Drill-in: an open issue replaces the list until the user goes back. Kept
  // in the store (like the open PR) so it survives the panel remounting.
  const openIssue = useDashboardStore((s) => s.githubOpenIssueByProject[params.projectId] ?? null);
  const setGithubOpenIssue = useDashboardStore((s) => s.setGithubOpenIssue);
  const setOpenIssue = (n: number | null) => setGithubOpenIssue(params.projectId, n);
  const taskMaster = useDashboardStore(
    (s) => s.githubIssueUiByProject[params.projectId]?.taskMaster ?? null,
  );
  const subscribeToGitHubProject = useDashboardStore((s) => s.subscribeToGitHubProject);
  const unsubscribeFromGitHubProject = useDashboardStore((s) => s.unsubscribeFromGitHubProject);
  const prsRefreshTrigger = useDashboardStore(
    (s) => s.prsRefreshTriggerByProject[params.projectId] ?? 0,
  );
  const prefetchGithubProject = useDashboardStore((s) => s.prefetchGithubProject);

  // Status, PRs and the first issues page start together, not one after the
  // other; the hooks below then join the same in-flight requests.
  useEffect(() => {
    prefetchGithubProject(params.projectId);
  }, [params.projectId, prefetchGithubProject]);

  // The store's live PRs (kept fresh by the WS) win over the cached fetch.
  const status = useGitHubStatus(params.projectId);
  const effectivePrs = usePrList(params.projectId);
  // Sessions / task / review run per PR (B7); the list's own PRs feed the join.
  const links = useMullionLinks(params.projectId, { prs: effectivePrs?.prs });

  useAsyncData(
    () => api.getProjectRelease(params.projectId),
    (s) => setReleaseStatus(s ?? null),
    () => setReleaseStatus(null),
    [params.projectId, prsRefreshTrigger, releaseRefreshTrigger],
  );

  const repoUrl = status?.repo.htmlUrl ?? null;
  const externalUrl =
    repoUrl === null
      ? null
      : openPr !== null
        ? `${repoUrl}/pull/${openPr}`
        : openIssue !== null
          ? `${repoUrl}/issues/${openIssue}`
          : repoUrl;
  const externalLabel =
    openPr !== null
      ? `Open PR #${openPr} on GitHub`
      : openIssue !== null
        ? `Open issue #${openIssue} on GitHub`
        : "Open repository on GitHub";
  useEffect(() => {
    onExternalLink?.(externalUrl === null ? null : { url: externalUrl, label: externalLabel });
  }, [onExternalLink, externalUrl, externalLabel]);

  // Subscribe to real-time GitHub WS updates for this project
  useEffect(() => {
    subscribeToGitHubProject(params.projectId);
    return () => unsubscribeFromGitHubProject(params.projectId);
  }, [params.projectId, subscribeToGitHubProject, unsubscribeFromGitHubProject]);

  if (status === undefined && effectivePrs === undefined) {
    // The loaded panel leads with a repo title, a section label, and rows.
    // Bones in that order keep the shape so the list doesn't jump in from
    // a single word. The region announces loading; the bones are hidden.
    return (
      <SkeletonRegion
        className={embedded ? "github-panel embedded" : "github-panel cmux-scroll"}
        label="Loading GitHub"
      >
        <div className="ui-skeleton-stack">
          <Skeleton width={168} height={14} />
          <Skeleton width={88} height={10} />
          <Skeleton height={34} radius={8} />
          <Skeleton height={34} radius={8} />
          <Skeleton height={34} radius={8} />
        </div>
      </SkeletonRegion>
    );
  }

  if (status === null && effectivePrs === null) {
    return (
      <EmptyStateNote>
        No GitHub status available for this project. Connect an account in Settings → GitHub, and
        make sure this project's <code>origin</code> remote points at github.com.
      </EmptyStateNote>
    );
  }

  if (openPr !== null) {
    return (
      <div className={embedded ? "github-panel embedded" : "github-panel cmux-scroll"}>
        <PrDetailView projectId={params.projectId} number={openPr} onBack={() => setOpenPr(null)} />
      </div>
    );
  }

  if (openIssue !== null) {
    return (
      <div className={embedded ? "github-panel embedded" : "github-panel cmux-scroll"}>
        <IssueDetailView
          projectId={params.projectId}
          number={openIssue}
          onBack={() => setOpenIssue(null)}
          taskMaster={taskMaster}
        />
      </div>
    );
  }

  // The open release PR belongs to the Release section, not this list.
  const releasePrNumber = releaseStatus?.pr?.number ?? null;
  const prs = (effectivePrs?.prs ?? []).filter((pr) => pr.number !== releasePrNumber);
  const statusPulls = (status?.pulls ?? []).filter((pr) => pr.number !== releasePrNumber);
  const showEmptyPrs =
    ((effectivePrs && prs.length === 0) || (!effectivePrs && status)) && statusPulls.length === 0;

  return (
    <div className={embedded ? "github-panel embedded" : "github-panel cmux-scroll"}>
      {status && (
        // The repo's own open-on-GitHub icon; a PR's detail view owns its header
        // (and the PR's URL) while it is open, an issue's does the same.
        <ViewHeader
          title={`${status.repo.owner}/${status.repo.repo}`}
          subtitle={`${status.openPRs} open PR${status.openPRs === 1 ? "" : "s"}`}
          externalUrl={status.repo.htmlUrl}
          externalLabel="Open repository on GitHub"
        />
      )}

      {releaseStatus && (
        <ReleaseSection
          projectId={params.projectId}
          release={releaseStatus}
          onChanged={() => setReleaseRefreshTrigger((n) => n + 1)}
          onOpenPr={setOpenPr}
        />
      )}
      {/* Deliberately a SIBLING of ReleaseSection, only for the
          "not-configured" case — that's the ONE branch ReleaseSection
          returns null for with no header of its own (precisely the
          branchdam-mobile incident's own shape; see RELEASE_WORKFLOW_FILENAMES's
          own doc comment, github-write.ts, for why a real release-please repo
          routinely fails THAT detection). Every other detection kind renders
          this same warning row INSIDE ReleaseSection itself, right under
          its own "Release" header — see conventionalTitlesWarningRow's own
          doc comment for why a second copy here would double up. */}
      {releaseStatus?.conventionalTitlesWarning &&
        releaseStatus.detection.kind === "not-configured" && (
          <SidebarSection title="Release" persistKey="github-release">
            {conventionalTitlesWarningRow()}
          </SidebarSection>
        )}

      {prs.length > 0 && (
        <SidebarSection title="Pull requests" count={prs.length} persistKey="github-prs">
          {sortPrsByAttention(prs).map((pr) => (
            <PrRow
              key={pr.number}
              pr={pr}
              projectId={params.projectId}
              links={links.byPr.get(pr.number)}
              onOpen={setOpenPr}
            />
          ))}
        </SidebarSection>
      )}

      {/* Fallback when PR poller cache is empty (cold-start, remote-hosted
          Phase 1 skip) but the live /github endpoint has PRs. A row drills in
          like any other: the detail loads on its own. */}
      {!effectivePrs && status && statusPulls.length > 0 && (
        <SidebarSection title="Pull requests" count={statusPulls.length} persistKey="github-prs">
          {statusPulls.map((pr) => (
            <SidebarRow
              key={pr.number}
              title={pr.title}
              meta={
                <>
                  <span className="mono">#{pr.number}</span>
                  {pr.author ? ` · ${pr.author}` : ""}
                </>
              }
              onClick={() => setOpenPr(pr.number)}
            />
          ))}
        </SidebarSection>
      )}

      {status && (
        <IssuesSection
          projectId={params.projectId}
          openIssues={status.openIssues}
          issuesHidden={status.issuesHidden}
          onOpenIssue={setOpenIssue}
        />
      )}

      {showEmptyPrs && (
        <SidebarSection title="Pull requests" persistKey="github-prs">
          <div className="github-panel-empty-row">No open pull requests</div>
        </SidebarSection>
      )}

      {status && status.actionsRuns.length > 0 && (
        <SidebarSection
          title="Default branch CI"
          persistKey="github-default-ci"
          defaultOpen={false}
        >
          {status.actionsRuns.map((run) => (
            <SidebarRow
              key={run.htmlUrl}
              lead={
                <span
                  className={`sb-dot sb-dot--${statusTone({ status: run.status, conclusion: run.conclusion })}`}
                  aria-hidden="true"
                />
              }
              title={
                <a href={run.htmlUrl} target="_blank" rel="noreferrer" className="pr-run-link">
                  {run.name}
                </a>
              }
              trailing={
                <span className="pr-dr-end">{runStatusText(run.status, run.conclusion)}</span>
              }
            />
          ))}
        </SidebarSection>
      )}
    </div>
  );
}
