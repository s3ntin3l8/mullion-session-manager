import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";
import type { GitBranchesResult, GitFileStatus, GitStatus, Session } from "./api.js";
import { GitBranchIcon } from "./icons.js";
import { usePolling } from "./hooks/usePolling.js";
import { LIVE_REFRESH_INTERVAL_MS, useDashboardStore } from "./store.js";
import { Toggle } from "./ui/primitives.js";
import { EmptyStateNote } from "./ui/EmptyState.js";
import { ConfirmButton } from "./ConfirmButton.js";

export interface GitPanelParams {
  projectId: number;
}

// Issue #442 — reasons a branch-delete/worktree-remove refusal is worth
// offering a Force retry for. Every other reason (invalid-name, no-such-
// branch, not-a-repo, delete-failed, current-branch, checked-out, not-
// listed, is-main, remove-failed) is either not fixable by force at all,
// or already prevented client-side by disabling the action outright — see
// the plan's "Errors and force" design.
const FORCEABLE_REASONS = new Set([
  "unmerged",
  "task-branch",
  "dirty",
  "conflicts",
  "sessions-active",
]);

function reasonMessage(reason: string | undefined, detail: string | undefined): string {
  switch (reason) {
    case "current-branch":
      return "This is the current branch.";
    case "checked-out":
      return `Checked out in another worktree${detail ? `: ${detail}` : ""}.`;
    case "unmerged":
      return "This branch has commits not merged into the default base.";
    case "task-branch":
      return `Referenced by task ${detail ?? "?"} — Force will break its Retry.`;
    case "no-such-branch":
      return "Branch no longer exists.";
    case "invalid-name":
      return "Invalid branch name.";
    case "not-a-repo":
      return "Not a git repository.";
    case "delete-failed":
    case "remove-failed":
      // Hermes review on PR #505 — git-branch-delete.ts now includes a
      // truncated stderr in `detail` for this reason rather than
      // discarding it, so an unexpected refusal is diagnosable here too.
      return `The operation failed.${detail ? ` ${detail}` : ""}`;
    case "not-listed":
      return "This worktree is no longer reported by git.";
    case "is-main":
      return "The main worktree can't be removed.";
    case "dirty":
      return "This worktree has uncommitted changes.";
    case "conflicts":
      return "This worktree has unresolved merge conflicts.";
    case "sessions-active":
      return `Active session${detail?.includes(",") ? "s" : ""}: ${detail ?? "?"}.`;
    case "directory-gone":
      // Hermes review on PR #505 — distinct from the generic "not-a-repo",
      // and deliberately not forceable: Prune stale is the correct action
      // here, not a stronger form of Remove.
      return "This worktree's directory no longer exists — use Prune stale instead.";
    default:
      return "Action failed.";
  }
}

// Client-side mirror of git-worktree.ts's DOCK_PREVIEW_PREFIX naming
// convention (same technique as Dock.tsx's own isDockPreviewPath) — a
// worktree path this basename-startsWith check matches was auto-created for
// a dock branch preview, not by a task, agent, or hand-run `git worktree
// add`.
function basename(worktreePath: string): string {
  return worktreePath.split("/").pop() || worktreePath;
}
function isDockPreviewWorktreePath(worktreePath: string): boolean {
  return basename(worktreePath).startsWith("dock-preview-");
}

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
export function GitPanel({
  params,
  onOpenSession,
}: {
  params: GitPanelParams;
  // U6 — a plain React prop, deliberately NOT a `GitPanelParams` field:
  // `params` is exactly what dockview's autosave serializes into
  // `workspaces.layout` and rehydrates from raw JSON on restore (App.tsx's
  // own restore effect) — a function stashed in there would silently come
  // back `undefined` after any reload. Mirrors TaskDetailWrapper (App.tsx),
  // which resolves the identical "open a session pane" callback via
  // `props.containerApi` in the wrapper rather than handing this component
  // dockview access directly. Optional so every existing test render of
  // `<GitPanel params={...} />` (no onOpenSession) keeps working — a real
  // mount always comes through GitPanelWrapper, which always provides it.
  onOpenSession?: (session: Session) => void;
}) {
  const [status, setStatus] = useState<GitStatus | null | undefined>(undefined);
  // Branches + worktrees (issue #162's "worktree awareness") — fetched once
  // when the panel opens, deliberately NOT polled: unlike working-tree
  // status, a branch/worktree list changes rarely and costs more to
  // enumerate, so there's no live-refresh tick for it (git-refs.ts's own doc
  // comment on why). `undefined` while loading, `null` for the 204 "not
  // applicable" response — same three-state shape as `status` above, kept as
  // a separate piece of state since it loads independently.
  const [branchesResult, setBranchesResult] = useState<GitBranchesResult | null | undefined>(
    undefined,
  );
  const [isFetching, setIsFetching] = useState(false);
  // Issue #442 — per-row refusal state for branch delete / worktree remove,
  // keyed by `branch:<name>` / `worktree:<path>`. Cleared on a successful
  // mutation for that row; left in place across an unrelated refresh.
  const [rowErrors, setRowErrors] = useState<Record<string, { message: string; reason?: string }>>(
    {},
  );
  const [isPruning, setIsPruning] = useState(false);
  // Issue #442, independent review on PR #505 — a thrown request failure
  // (a 503 host-unreachable, or a 429 off this route's 10/min rate limit —
  // plausible in a refusal-then-force cycle across several rows) used to be
  // swallowed into console.debug only, the exact "transient failure looks
  // like nothing happened" bug class this PR's refreshBranches fix already
  // addresses on the read path. Panel-level since Prune stale has no
  // per-row slot to render into.
  const [pruneError, setPruneError] = useState<string | null>(null);
  // Issue #442, Hermes review on PR #505 — "Open session here" had no
  // in-flight guard; a double-click could create two sessions before the
  // first `createSession` call resolves.
  const [openingSessionFor, setOpeningSessionFor] = useState<Set<string>>(new Set());

  const autoFetch = useDashboardStore(
    (s) => s.projects.find((p) => p.id === params.projectId)?.autoFetch ?? null,
  );
  const globalEnabled = useDashboardStore(
    (s) => s.settings.sessions.gitAutoFetchIntervalSeconds > 0,
  );
  const fetchProjectGit = useDashboardStore((s) => s.fetchProjectGit);
  const effectiveAutoFetch = autoFetch ?? globalEnabled;
  const isInherited = autoFetch === null;

  const fetchStatus = useCallback(
    async (cancelledRef?: { current: boolean }) => {
      try {
        const result = await api.getProjectGitStatus(params.projectId);
        if (cancelledRef?.current) return;
        setStatus(result ?? null);
      } catch (err) {
        // Transient failure (a thrown ApiError for the 503 "unavailable"
        // response, or any other network hiccup) — deliberately a no-op on
        // `status`, not `setStatus(null)`. Keeps rendering the last-known-good
        // status (or stays in the initial "Loading…" state if this is the
        // very first attempt) rather than incorrectly claiming "not a git
        // repository". Logged at debug level (same pattern as git-status.ts's
        // own stderr logging) so a *persistent* failure is still observable,
        // even though a single one is intentionally invisible to the user.
        console.debug("[GitPanel] getProjectGitStatus failed", err);
      }
    },
    [params.projectId],
  );

  // Same reasoning as GitHubPanel's effect for the dep array: this panel is
  // mounted fresh per project (a stable "git-<projectId>" dockview panel
  // id, see App.tsx' onOpenGit), so params.projectId never actually
  // changes under an existing instance — the `cancelledRef` param
  // fetchStatus accepts is otherwise unused here (still passed by its two
  // other, non-polling call sites below), since that guard only mattered
  // for a stale in-flight request from a torn-down effect instance, which
  // this panel's fresh-mount-per-project invariant means never happens in
  // practice.
  usePolling(() => void fetchStatus(), LIVE_REFRESH_INTERVAL_MS, {
    pauseWhenHidden: true,
    deps: [fetchStatus],
  });

  // Issue #442 — extracted out of the mount-time effect so mutation
  // handlers can re-run it too. `?detail=1` (the `true` argument) requests
  // the isMerged enrichment — worth paying for once the panel is actually
  // open and a human is looking at it, unlike store.ts's 60s background
  // poll, which calls getProjectGitBranches with no detail flag.
  //
  // Given the SAME last-known-good posture `fetchStatus` above already has:
  // only a genuine 204 (`result` resolves `undefined`) sets `null`. Any
  // other outcome (a thrown ApiError for a transient failure, or any other
  // network hiccup) is a no-op, not `setBranchesResult(null)` — the
  // previous `.catch(() => setBranchesResult(null))` made a transient error
  // visually identical to a durable "not applicable" response, which fired
  // immediately after a Delete/Remove click would read as "my action
  // destroyed the panel" (see the plan's own framing of this as a real bug
  // fix, not just a refactor).
  const refreshBranches = useCallback(
    async (cancelledRef?: { current: boolean }) => {
      try {
        const result = await api.getProjectGitBranches(params.projectId, true);
        if (cancelledRef?.current) return;
        setBranchesResult(result ?? null);
      } catch (err) {
        console.debug("[GitPanel] getProjectGitBranches failed", err);
      }
    },
    [params.projectId],
  );

  useEffect(() => {
    // Wait for `status` to resolve before firing the branches/worktrees
    // fetch — a durable "not a git repo" (status === null) means there's
    // nothing to enumerate either, so this skips a pointless network call
    // (and the wasted re-render it would otherwise cause once the panel has
    // already committed to rendering the "not a git repository" state;
    // Hermes review, PR #165) rather than firing both requests in parallel
    // from mount. This gate stays here, in the effect — refreshBranches
    // itself is also called directly by the mutation handlers below, once
    // `status` is already loaded, so gating inside refreshBranches would
    // make a post-mutation refresh a no-op.
    if (status === undefined || status === null) return;
    const cancelledRef = { current: false };
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshBranches(cancelledRef);
    return () => {
      cancelledRef.current = true;
    };
  }, [status, refreshBranches]);

  // Issue #442 — run after every branch/worktree mutation: re-fetches this
  // panel's own branches/worktrees + status, and separately invalidates
  // store.ts's independent `gitBranchesByProject` cache (what SessionRow's
  // sidebar branch display reads) so a delete/remove is reflected there too
  // without waiting for its own ~60s poll tick.
  const refreshAll = useCallback(async () => {
    await refreshBranches();
    await fetchStatus();
    void useDashboardStore.getState().refreshGitRefs();
  }, [refreshBranches, fetchStatus]);

  const setRowError = useCallback(
    (key: string, reason: string | undefined, detail: string | undefined) => {
      setRowErrors((prev) => ({
        ...prev,
        [key]: { message: reasonMessage(reason, detail), reason },
      }));
    },
    [],
  );

  const clearRowError = useCallback((key: string) => {
    setRowErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  // Issue #442, independent review on PR #505 — a THROWN failure (503 host-
  // unreachable, 429 rate-limited) is not a git-level refusal, so it has no
  // `reason` for `reasonMessage` to classify and never a Force button (force
  // can't fix an unreachable host or a rate limit — retrying the same
  // request is the correct next step, not a different one). `err instanceof
  // Error` (not just ApiError, Hermes review round 3) also covers
  // handleOpenSessionHere's own "no launcher configured" Error and a raw
  // network TypeError, both of which have a real, more useful message than
  // the generic fallback.
  const setRowRequestError = useCallback((key: string, err: unknown) => {
    const message = err instanceof Error ? err.message : "Request failed — try again.";
    setRowErrors((prev) => ({ ...prev, [key]: { message } }));
  }, []);

  const handleDeleteBranch = useCallback(
    async (name: string, force = false) => {
      const key = `branch:${name}`;
      try {
        const result = await api.deleteProjectGitBranch(params.projectId, name, force);
        if (result.deleted) {
          clearRowError(key);
          await refreshAll();
          return;
        }
        setRowError(key, result.reason, result.detail);
      } catch (err) {
        console.debug("[GitPanel] deleteProjectGitBranch failed", err);
        setRowRequestError(key, err);
      }
    },
    [params.projectId, refreshAll, setRowError, clearRowError, setRowRequestError],
  );

  const handleRemoveWorktree = useCallback(
    async (worktreePath: string, force = false) => {
      const key = `worktree:${worktreePath}`;
      try {
        const result = await api.removeProjectGitWorktree(params.projectId, worktreePath, force);
        if (result.removed) {
          clearRowError(key);
          await refreshAll();
          return;
        }
        setRowError(key, result.reason, result.detail);
      } catch (err) {
        console.debug("[GitPanel] removeProjectGitWorktree failed", err);
        setRowRequestError(key, err);
      }
    },
    [params.projectId, refreshAll, setRowError, clearRowError, setRowRequestError],
  );

  // Issue #442 — clears administrative metadata only; never removes a
  // worktree still on disk (git-worktree.ts's pruneWorktreeMetadata).
  const handlePruneStale = useCallback(async () => {
    setIsPruning(true);
    try {
      await api.pruneProjectGitWorktrees(params.projectId);
      setPruneError(null);
      await refreshAll();
    } catch (err) {
      console.debug("[GitPanel] pruneProjectGitWorktrees failed", err);
      setPruneError(err instanceof Error ? err.message : "Request failed — try again.");
    } finally {
      setIsPruning(false);
    }
  }, [params.projectId, refreshAll]);

  // Issue #442's selected "extra": open a session directly in a worktree,
  // reusing the existing createSession cwd override — no new backend.
  // Deliberately worktree-rows-only (not offered for a bare branch — that
  // would mean creating a worktree or checking out, a different feature).
  // Resolves the same default-agent launcher CommandPalette.tsx pre-selects
  // (`agent:${settings.launchers.defaultAgent}`), falling back to whatever
  // GET .../actions lists first.
  //
  // U6 — goes through the STORE action, not `api.createSession` directly:
  // `store.createSession` also awaits `refreshSessions()` before resolving,
  // which is what makes the new row show up in the sidebar/tab strip right
  // away instead of silently waiting out the next ~4s poll tick (the
  // previous version discarded the created session entirely, so nothing
  // ever opened — this button's whole point). Passing the resolved session
  // to `onOpenSession` is what actually opens a pane for it, the same
  // "resolve via a threaded callback, not by reaching for dockview
  // directly" shape TaskDetailWrapper (App.tsx) already uses.
  const handleOpenSessionHere = useCallback(
    async (worktreePath: string) => {
      if (openingSessionFor.has(worktreePath)) return;
      const key = `worktree:${worktreePath}`;
      setOpeningSessionFor((prev) => new Set(prev).add(worktreePath));
      try {
        const launchers = await api.listProjectActions(params.projectId);
        const defaultAgent = useDashboardStore.getState().settings.launchers.defaultAgent;
        const launcher = launchers.find((l) => l.id === `agent:${defaultAgent}`) ?? launchers[0];
        if (!launcher) {
          // Hermes review on PR #505 — unlike Delete/Remove, there's no
          // git-level "reason" here (no launcher configured for this
          // project at all), so this is a request-style message, not a
          // reasonMessage-classified one.
          setRowRequestError(key, new Error("No launcher is configured for this project."));
          return;
        }
        const session = await useDashboardStore
          .getState()
          .createSession(params.projectId, launcher.command, { cwd: worktreePath });
        clearRowError(key);
        onOpenSession?.(session);
      } catch (err) {
        console.debug("[GitPanel] open session here failed", err);
        setRowRequestError(key, err);
      } finally {
        setOpeningSessionFor((prev) => {
          const next = new Set(prev);
          next.delete(worktreePath);
          return next;
        });
      }
    },
    [params.projectId, openingSessionFor, setRowRequestError, clearRowError, onOpenSession],
  );

  const handleFetch = useCallback(async () => {
    setIsFetching(true);
    try {
      await fetchProjectGit(params.projectId);
      await fetchStatus();
    } catch (err) {
      console.debug("[GitPanel] fetchProjectGit failed", err);
    } finally {
      setIsFetching(false);
    }
  }, [params.projectId, fetchProjectGit, fetchStatus]);

  const handleToggleAutoFetch = useCallback(async () => {
    const store = useDashboardStore.getState();
    const p = store.projects.find((p) => p.id === params.projectId);
    const currentAutoFetch = p?.autoFetch ?? null;
    const currentGlobalEnabled = store.settings.sessions.gitAutoFetchIntervalSeconds > 0;
    const currentEffective = currentAutoFetch ?? currentGlobalEnabled;
    await store.toggleAutoFetch(params.projectId, !currentEffective);
  }, [params.projectId]);

  const handleResetAutoFetch = useCallback(async () => {
    const store = useDashboardStore.getState();
    await store.toggleAutoFetch(params.projectId, null);
  }, [params.projectId]);

  if (status === undefined) {
    return <EmptyStateNote>Loading…</EmptyStateNote>;
  }

  if (status === null) {
    // Only reached via the durable 204 now — a transient failure (503, or
    // any other fetch error) is handled above by simply not calling
    // setStatus, so it never lands here.
    return <EmptyStateNote>Not a git repository.</EmptyStateNote>;
  }

  return (
    <div className="github-panel cmux-scroll">
      <div className="github-panel-repo">
        <GitBranchIcon size={14} />
        {status.branch}
        {status.hash && <span className="github-panel-row-number">{status.hash}</span>}
      </div>

      <div className="git-panel-sync-row">
        <span className="git-panel-ahead-behind">
          {(status.ahead > 0 || status.behind > 0) && (
            <>
              {status.ahead > 0 && `↑${status.ahead}`}
              {status.ahead > 0 && status.behind > 0 && " "}
              {status.behind > 0 && `↓${status.behind}`}
            </>
          )}
        </span>
        <span className="git-panel-sync-controls">
          <button className="git-panel-fetch-btn" onClick={handleFetch} disabled={isFetching}>
            {isFetching ? "⟳" : "↻"} Fetch
          </button>
          <span className="git-panel-toggle-wrapper">
            <Toggle
              size="small"
              on={effectiveAutoFetch}
              onChange={handleToggleAutoFetch}
              ariaLabel="Auto-fetch"
            />
            {isInherited ? (
              <span className="git-panel-toggle-inherited" title="Inherited from global settings">
                auto
              </span>
            ) : (
              <>
                <span className="git-panel-toggle-label">auto</span>
                <button
                  className="git-panel-toggle-reset"
                  onClick={handleResetAutoFetch}
                  title="Reset to global default"
                >
                  ×
                </button>
              </>
            )}
          </span>
        </span>
      </div>

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

      {branchesResult && branchesResult.branches.length > 0 && (
        <div className="github-panel-section">
          <div className="github-panel-section-title">
            Branches ({branchesResult.branches.length})
          </div>
          {branchesResult.branches.map((branch) => {
            // A worktree checked out in some OTHER (non-main) worktree —
            // the main worktree's own checked-out branch is always this
            // branch's own `isCurrent`, so surfacing it again here would be
            // redundant with the "current" tag right next to it.
            const checkedOutElsewhere = branchesResult.worktrees.find(
              (w) => w.branch === branch.name && !w.isMain,
            );
            const deleteDisabled = branch.isCurrent || Boolean(checkedOutElsewhere);
            const hints: string[] = [];
            if (branch.isMerged) hints.push("merged");
            if (branch.ahead || branch.behind) {
              hints.push(
                `${branch.ahead ? `↑${branch.ahead}` : ""}${
                  branch.ahead && branch.behind ? " " : ""
                }${branch.behind ? `↓${branch.behind}` : ""}`,
              );
            }
            if (branch.upstreamGone) hints.push("gone");
            if (branch.lastCommitRelative) hints.push(branch.lastCommitRelative);
            if (checkedOutElsewhere) hints.push(`in ${basename(checkedOutElsewhere.path)}`);
            const rowError = rowErrors[`branch:${branch.name}`];
            return (
              <div key={branch.name}>
                <div className="github-panel-row">
                  <span
                    className={`github-panel-ci-dot ${branch.isCurrent ? "good" : "pending"}`}
                  />
                  <span className="github-panel-row-title">{branch.name}</span>
                  {branch.isCurrent && <span className="github-panel-row-number">current</span>}
                  {hints.length > 0 && (
                    <span className="github-panel-row-number">{hints.join(" · ")}</span>
                  )}
                  <span className="git-panel-row-actions">
                    <ConfirmButton
                      title="Delete branch"
                      onConfirm={() => handleDeleteBranch(branch.name)}
                      disabled={deleteDisabled}
                    >
                      Delete
                    </ConfirmButton>
                  </span>
                </div>
                {rowError && (
                  <div className="github-panel-empty-row github-panel-conflicts">
                    {rowError.message}
                    {rowError.reason && FORCEABLE_REASONS.has(rowError.reason) && (
                      <span className="git-panel-row-actions">
                        <ConfirmButton
                          title="Force delete"
                          onConfirm={() => handleDeleteBranch(branch.name, true)}
                        >
                          Force
                        </ConfirmButton>
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Hermes review on PR #505 — rendered outside the worktrees.length > 0
          gate below: a failed prune whose follow-up state change (a later,
          unrelated refresh) drops the list to empty would otherwise make
          this error silently vanish along with the whole section. */}
      {branchesResult && pruneError && (
        <div className="github-panel-empty-row github-panel-conflicts">{pruneError}</div>
      )}

      {branchesResult && branchesResult.worktrees.length > 0 && (
        <div className="github-panel-section">
          <div
            className="github-panel-section-title"
            style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
          >
            <span>Worktrees ({branchesResult.worktrees.length})</span>
            <button
              className="git-panel-fetch-btn"
              onClick={handlePruneStale}
              disabled={isPruning}
              title="Clears administrative metadata for worktrees whose directory is already gone — never removes one that still exists on disk."
            >
              Prune stale
            </button>
          </div>
          {branchesResult.worktrees.map((worktree) => {
            const rowError = rowErrors[`worktree:${worktree.path}`];
            return (
              <div key={worktree.path}>
                <div className="github-panel-row">
                  <span className="github-panel-row-title">{worktree.path}</span>
                  <span className="github-panel-row-number">
                    {worktree.branch ?? "detached"}
                    {worktree.isMain ? " (main)" : ""}
                    {isDockPreviewWorktreePath(worktree.path) ? " auto" : ""}
                  </span>
                  <span className="git-panel-row-actions">
                    {!worktree.isMain && (
                      <button
                        className="git-panel-fetch-btn"
                        onClick={() => handleOpenSessionHere(worktree.path)}
                        disabled={openingSessionFor.has(worktree.path)}
                      >
                        Open session here
                      </button>
                    )}
                    <ConfirmButton
                      title="Remove worktree"
                      onConfirm={() => handleRemoveWorktree(worktree.path)}
                      disabled={worktree.isMain}
                    >
                      Remove
                    </ConfirmButton>
                  </span>
                </div>
                {rowError && (
                  <div className="github-panel-empty-row github-panel-conflicts">
                    {rowError.message}
                    {rowError.reason && FORCEABLE_REASONS.has(rowError.reason) && (
                      <span className="git-panel-row-actions">
                        <ConfirmButton
                          title="Force remove"
                          onConfirm={() => handleRemoveWorktree(worktree.path, true)}
                        >
                          Force
                        </ConfirmButton>
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
