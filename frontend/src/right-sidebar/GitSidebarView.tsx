import { useCallback, useEffect, useState } from "react";
import { LOCAL_HOST_ID } from "../../../src/shared/constants.js";
import { api } from "../api/index.js";
import { BranchDetail } from "../git/BranchDetail.js";
import { BranchesSection } from "../git/BranchesSection.js";
import { ChangesSection } from "../git/ChangesSection.js";
import { isDefaultBranchName, pullReasonMessage } from "../git/gitReasons.js";
import { PruneView } from "../git/PruneView.js";
import { healthDot, useBranchData, useCloneHealth } from "../git/useSourceControl.js";
import { useRepoUrl } from "../git/useRepoUrl.js";
import { WorktreesSection } from "../git/WorktreesSection.js";
import { PromoteDialog } from "../PromoteDialog.js";
import { useMullionLinks } from "../hooks/useMullionLinks.js";
import { describeError } from "../lib/describeError.js";
import { useDashboardStore } from "../store/index.js";
import { ConfirmButton } from "../ui/ConfirmButton.js";
import { PullIcon, RefreshIcon, CheckIcon } from "../ui/icons.js";
import { Toggle } from "../ui/primitives.js";
import { Button } from "../ui/sidebar/index.js";
import { SidebarHeader } from "./SidebarHeader.js";
import type { RightSidebarViewProps } from "./views.js";

type Page = { kind: "list" } | { kind: "branch"; name: string } | { kind: "prune" };

/** The Source Control rail view: changes, branches (with drilldown and prune), worktrees. */
export function GitSidebarView({ projectId, actions }: RightSidebarViewProps) {
  // The page is tied to the project it was opened for: this view does not
  // remount on a project switch, and another project's branch is meaningless here.
  const [pageState, setPage] = useState<{ projectId: number; page: Page }>({
    projectId,
    page: { kind: "list" },
  });
  const page: Page = pageState.projectId === projectId ? pageState.page : { kind: "list" };
  const go = useCallback((next: Page) => setPage({ projectId, page: next }), [projectId]);

  // One-shot deep links ("Reveal in Git" on a session row, the palette's
  // Prune command): applied in render keyed on the request's nonce, then
  // cleared — the same shape as the History view's scope request.
  const branchRequest = useDashboardStore((s) => s.rightSidebarBranchRequest);
  const pruneRequest = useDashboardStore((s) => s.rightSidebarPruneRequest);
  const [handledNonce, setHandledNonce] = useState(0);
  const fresh = (r: { projectId: number; nonce: number } | null) =>
    r != null && r.projectId === projectId && r.nonce !== handledNonce;
  const pendingBranch = fresh(branchRequest) ? branchRequest : null;
  const pendingPrune = fresh(pruneRequest) ? pruneRequest : null;
  if (pendingBranch || pendingPrune) {
    const branchWins = pendingBranch != null && pendingBranch.nonce > (pendingPrune?.nonce ?? 0);
    setHandledNonce(Math.max(pendingBranch?.nonce ?? 0, pendingPrune?.nonce ?? 0));
    setPage({
      projectId,
      page: branchWins ? { kind: "branch", name: pendingBranch.branch } : { kind: "prune" },
    });
  }
  useEffect(() => {
    const st = useDashboardStore.getState();
    if (branchRequest) st.clearRightSidebarBranchRequest();
    if (pruneRequest) st.clearRightSidebarPruneRequest();
  }, [branchRequest, pruneRequest]);

  const project = useDashboardStore((s) => s.projects.find((p) => p.id === projectId));
  const hosts = useDashboardStore((s) => s.hosts);
  const status = useDashboardStore((s) => s.gitStatuses[projectId]);
  const sessions = useDashboardStore((s) => s.sessions);
  const requestOpenSession = useDashboardStore((s) => s.requestOpenSession);
  const declinePromote = useDashboardStore((s) => s.declinePromote);
  const fetchProjectGit = useDashboardStore((s) => s.fetchProjectGit);
  const pullProjectGit = useDashboardStore((s) => s.pullProjectGit);
  const toggleAutoFetch = useDashboardStore((s) => s.toggleAutoFetch);
  const autoFetch = useDashboardStore(
    (s) => s.projects.find((p) => p.id === projectId)?.autoFetch ?? null,
  );
  const globalAutoFetch = useDashboardStore(
    (s) => s.settings.sessions.gitAutoFetchIntervalSeconds > 0,
  );
  const repoUrl = useRepoUrl(projectId);
  const links = useMullionLinks(projectId);
  const data = useBranchData(projectId);

  const [fetching, setFetching] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [promoteOpen, setPromoteOpen] = useState(false);

  const writeStatus = async () => {
    const next = await api.getProjectGitStatus(projectId, { fresh: true });
    useDashboardStore.setState((s) => ({
      gitStatuses: { ...s.gitStatuses, [projectId]: next ?? null },
    }));
  };

  const reloadAll = useCallback(() => {
    void useDashboardStore.getState().refreshGitRefs([projectId]);
    data.reload();
  }, [projectId, data]);

  const health = useCloneHealth(projectId, () => {
    // The repair rewrites the index; re-read what is on screen.
    void writeStatus().catch(() => undefined);
    reloadAll();
  });

  const doFetch = async () => {
    setFetching(true);
    setSyncError(null);
    try {
      await fetchProjectGit(projectId);
      await writeStatus();
      reloadAll();
    } catch (err) {
      setSyncError(describeError(err, "Could not fetch — try again."));
    } finally {
      setFetching(false);
    }
  };

  const doPull = async () => {
    setPulling(true);
    setSyncError(null);
    try {
      const result = await pullProjectGit(projectId);
      if (result.pulled) {
        await writeStatus();
        reloadAll();
      } else {
        setSyncError(pullReasonMessage(result.reason, result.detail));
      }
    } catch (err) {
      setSyncError(describeError(err, "Pull request failed — try again."));
    } finally {
      setPulling(false);
    }
  };

  const effectiveAutoFetch = autoFetch ?? globalAutoFetch;
  const isRemote = project != null && project.hostId !== LOCAL_HOST_ID;
  const hostName = isRemote
    ? (hosts.find((h) => h.id === project.hostId)?.name ?? project.hostId)
    : null;
  const pendingPromote = sessions.find(
    (s) => s.projectId === projectId && s.status !== "killed" && s.promoteState === "pending",
  );

  if (page.kind === "branch" && data.kind === "ready") {
    return (
      <div className="git-sidebar-view">
        <BranchDetail
          projectId={projectId}
          name={page.name}
          entry={links.byBranch.get(page.name)}
          isDefault={isDefaultBranchName(page.name, data.data.defaultBranch)}
          onBack={() => go({ kind: "list" })}
          onReload={reloadAll}
        />
      </div>
    );
  }
  if (page.kind === "prune") {
    return (
      <div className="git-sidebar-view">
        <PruneView
          projectId={projectId}
          onBack={() => go({ kind: "list" })}
          onDone={() => {
            reloadAll();
            go({ kind: "list" });
          }}
        />
      </div>
    );
  }

  const busy = fetching || pulling || health.repairing;
  const subtitle = status ? (
    <>
      <span className="mono">{status.branch}</span>
      {(status.ahead > 0 || status.behind > 0) && (
        <>
          {" · "}
          {status.ahead > 0 && <span className="gh-add">↑{status.ahead}</span>}{" "}
          {status.behind > 0 && <span className="gh-del">↓{status.behind}</span>}
        </>
      )}
      {!status.isClean && ` · ${status.files.length} changed`}
      {hostName && ` · on ${hostName}`}
    </>
  ) : hostName ? (
    `on ${hostName}`
  ) : undefined;

  return (
    <div className="git-sidebar-view">
      <SidebarHeader
        label="Source Control"
        context={subtitle}
        actions={[
          {
            key: "fetch",
            label: fetching ? "Fetching…" : "Fetch",
            icon: RefreshIcon,
            onClick: () => void doFetch(),
            disabled: busy,
          },
          {
            key: "pull",
            label:
              status && status.behind === 0
                ? "Pull (already up to date)"
                : "Pull (fast-forward from tracking branch)",
            icon: PullIcon,
            onClick: () => void doPull(),
            disabled: busy || !status || status.behind === 0,
          },
          {
            key: "health",
            label: health.checking
              ? "Checking clone health…"
              : "Check clone health (read-only; looks for damage from a background git gc)",
            icon: CheckIcon,
            onClick: () => void health.check(),
            disabled: health.checking || health.repairing,
            dot: healthDot(health),
          },
        ]}
        overflow={
          repoUrl
            ? [
                {
                  key: "open-repo",
                  label: "Open repository on GitHub",
                  onClick: () => window.open(repoUrl, "_blank", "noopener,noreferrer"),
                },
              ]
            : []
        }
      />
      <div className="sc-scroll">
        <div className="sc-autofetch">
          <Toggle
            size="small"
            on={effectiveAutoFetch}
            ariaLabel="Auto-fetch"
            onChange={(v) => void toggleAutoFetch(projectId, v)}
          />
          <span>Auto-fetch</span>
          {autoFetch === null ? (
            <span className="sc-dim" title="Inherited from global settings">
              (global)
            </span>
          ) : (
            <button
              type="button"
              className="sc-link"
              title="Reset to the global default"
              onClick={() => void toggleAutoFetch(projectId, null)}
            >
              reset
            </button>
          )}
        </div>

        {pendingPromote && project && (
          <div className="sc-callout sc-callout--warn" role="status">
            <b>Promote requested</b> by{" "}
            <span className="mono">{pendingPromote.name ?? `session ${pendingPromote.id}`}</span> —
            move the session into a worktree.
            <div className="sc-callout-cta">
              <Button size="sm" variant="primary" onClick={() => setPromoteOpen(true)}>
                Review…
              </Button>
              <Button size="sm" onClick={() => void declinePromote(pendingPromote.id)}>
                Decline
              </Button>
            </div>
          </div>
        )}
        {promoteOpen && pendingPromote && project && (
          <PromoteDialog
            session={pendingPromote}
            project={project}
            onClose={() => setPromoteOpen(false)}
            onPromoted={(s) => requestOpenSession(s.id)}
          />
        )}

        {syncError && (
          <div className="sc-row-error" role="alert">
            {syncError}
          </div>
        )}
        <CloneHealthNotes health={health} busy={fetching || pulling} />

        <ChangesSection
          projectId={projectId}
          onEditFile={(path) => actions.onOpenFile(projectId, path)}
        />

        {data.kind === "loading" && <div className="sc-empty">Loading branches…</div>}
        {data.kind === "none" && (
          <div className="sc-empty">
            {isRemote ? "Branches are not available for this host." : "Not a git repository."}
          </div>
        )}
        {data.kind === "error" && (
          <div className="sc-unreachable" role="alert">
            <b>{isRemote ? `Host ${hostName} is unreachable` : "Could not load branches"}</b>
            <span>
              {isRemote ? "Branches and worktrees can’t be listed right now." : data.message}
            </span>
            <Button size="sm" onClick={data.reload}>
              Retry
            </Button>
          </div>
        )}
        {data.kind === "ready" && (
          <>
            <BranchesSection
              projectId={projectId}
              branches={data.data.branches}
              worktrees={data.data.worktrees}
              defaultBranch={data.data.defaultBranch}
              links={links}
              onOpenBranch={(name) => go({ kind: "branch", name })}
              onPrune={() => go({ kind: "prune" })}
              onReload={reloadAll}
            />
            <WorktreesSection
              projectId={projectId}
              worktrees={data.data.worktrees}
              branches={data.data.branches}
              links={links}
              onReload={reloadAll}
            />
          </>
        )}
      </div>
    </div>
  );
}

/** The health verdict, the repair plan with its confirmed action, and the outcome. */
function CloneHealthNotes({
  health,
  busy,
}: {
  health: ReturnType<typeof useCloneHealth>;
  busy: boolean;
}) {
  const { health: h, repairPlan, repairOutcome } = health;
  return (
    <>
      {health.healthError && (
        <div className="sc-row-error" role="alert">
          {health.healthError}
        </div>
      )}
      {h && (
        // Danger styling is for REAL damage only; "not a repo" and "did not
        // finish" are not findings, and only damage deserves an alert.
        <div
          className={h.healthy || h.gitDir === null || h.timedOut ? "sc-note" : "sc-row-error"}
          role={h.healthy ? undefined : h.timedOut || h.gitDir === null ? "status" : "alert"}
        >
          {h.healthy ? (
            "This repository is healthy."
          ) : h.gitDir === null ? (
            "This project is not a git repository, so there is no clone to check."
          ) : h.timedOut ? (
            <>
              The health check did not finish — <code>git fsck</code> timed out. Nothing was
              changed, and this is NOT a verdict: the clone may well be fine. Try again when the
              machine is less busy.
            </>
          ) : (
            <>
              This repository looks damaged
              {h.zeroByteObjects.length > 0 && `: ${h.zeroByteObjects.length} zero-byte object(s)`}
              {h.otherZeroByteFiles.length > 0 &&
                `: ${h.otherZeroByteFiles.length} other zero-byte file(s)`}
              {h.fsckErrors.length > 0 && `: ${h.fsckErrors.length} fsck error(s)`}. A background
              git gc can do this — the Repair button below fixes it, or run{" "}
              <code>make git-doctor APPLY=1 DIR=&lt;path&gt;</code> on the machine that holds the
              clone.
            </>
          )}
        </div>
      )}
      {/* The plan is on screen before the button is armed (#1896). */}
      {repairPlan && !repairOutcome && (
        <div className="sc-note">
          <div>
            Repair will {health.planText}. Damaged objects are MOVED into a quarantine directory
            inside the git directory — nothing is deleted.
          </div>
          {repairPlan.indexesToSkip.map((skip) => (
            <div key={skip.path}>
              {skip.path}: left alone — staged content not in the working tree (
              {skip.paths.join(", ")})
            </div>
          ))}
          <ConfirmButton
            title={`Repair this clone: ${health.planText}. Damaged objects are moved into a quarantine directory inside the git directory — nothing is deleted.`}
            onConfirm={() => void health.repair()}
            disabled={health.repairing || busy}
            armedLabel="Repair now"
          >
            Repair
          </ConfirmButton>
        </div>
      )}
      {repairOutcome && (
        <div
          className={repairOutcome.whole ? "sc-note" : "sc-row-error"}
          role={repairOutcome.whole ? "status" : "alert"}
        >
          {repairOutcome.whole
            ? "Repair finished — the clone is whole again."
            : "Repair finished, but the clone is NOT whole."}{" "}
          {health.outcomeText}.
          {repairOutcome.indexesSkipped.map((skipped) => (
            <div key={skipped}>{skipped}</div>
          ))}
        </div>
      )}
      {health.repairError && (
        <div className="sc-row-error" role="alert">
          {health.repairError}
        </div>
      )}
    </>
  );
}
