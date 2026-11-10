import { useState } from "react";
import { useDashboardStore } from "../store/index.js";
import { CreateProjectModal } from "../CreateProjectModal.js";
import { KebabMenu } from "../ui/KebabMenu.js";
import { LOCAL_HOST_ID } from "../api/index.js";
import type { Host, Project, Session } from "../api/index.js";
import { HostStatusLabel } from "../HostStatusLabel.js";
import {
  ChevronDownIcon,
  CloseIcon,
  FolderIcon,
  HostsIcon,
  PlusIcon,
  PullIcon,
  RenameIcon,
  SkillIcon,
} from "../ui/icons.js";

// Above this many commits behind origin, the badge switches to a louder
// color (issue #433 scope A's "color the badge to draw attention" ask) — an
// arbitrary but reasonable line between "you'll want to pull soon" and
// "you're working from a very stale checkout".
const BEHIND_STALE_THRESHOLD = 10;

// Issue #431-adjacent — short, user-facing copy for `git pull` refusal
// reasons. Mirrors the message shape SourceControlSection.tsx already uses
// for the same backend response, but trimmed to the one-line slot the
// kebab-error affordance has. Kept inline here rather than promoted to a
// shared helper because the two surfaces have different copy needs and a
// premature consolidation would just drag them both around.
function formatPullReasonMessage(reason: string | undefined, detail?: string): string {
  switch (reason) {
    case "not-a-repo":
      return "Not a git repository.";
    case "unborn-head":
      return "Cannot pull in an unborn branch.";
    case "detached-head":
      return "Cannot pull in a detached HEAD state.";
    case "no-upstream":
      return "No upstream tracking branch configured.";
    case "dirty-tree":
      return "Working tree has uncommitted changes — commit or stash them first.";
    case "not-fast-forward":
      return "Local branch has diverged from origin — pull cannot fast-forward.";
    case "already-up-to-date":
      return "Already up to date with tracking branch.";
    case "pull-failed":
      return detail ? `Pull failed: ${detail}` : "The pull operation failed.";
    // Issue #1896 — a git operation (a clone repair) holds the clone. Not a
    // failure: the pull was refused, and trying again in a moment works. The
    // default branch would say "Pull failed: …", which is the wrong story.
    case "busy":
      return "A git operation is already running for this repository — try again in a moment.";
    default:
      return detail ? `Pull failed: ${detail}` : "Pull failed — try again.";
  }
}

// Extracted out of ProjectSection so both the plain (below-threshold) and
// virtualized (above-threshold) rendering paths share the exact same header
// markup/behavior instead of two copies drifting apart. Collapse is now
// owned by the CALLER (ProjectSection below, or Sidebar's own flatten step
// reading `projectCollapsedState` directly in the virtualized path) — this
// component is a pure function of `collapsed`/`onToggleCollapsed`, with no
// state of its own for it, so it doesn't matter which path is driving.
//
// P1 perf fix (carried over from ProjectSection's original header comment)
// — every field this component reads is either a prop (never a rendered
// whole-store subscription) or a single fine-grained selector
// (`gitStatuses[project.id]` below), and every write goes through
// `useDashboardStore.getState()` at its own call site rather than a
// destructured store hook — the same "selector or getState(), never a bare
// `useDashboardStore()`" rule this file's other components follow.
export function ProjectHeader({
  project,
  sessions,
  hosts,
  collapsed,
  onToggleCollapsed,
  onOpenLauncher,
  onSessionEnded,
  onOpenProjectSetup,
  bodyId,
}: {
  project: Project;
  sessions: Session[];
  hosts: Host[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onOpenLauncher: () => void;
  onSessionEnded: (session: Session) => void;
  // Phase 4 (Gap F) — "Scaffold Mullion" kebab-menu entry, bound to this
  // project at the call site (ProjectSection/VirtualizedProjectTree),
  // same shape as onOpenLauncher above.
  onOpenProjectSetup: () => void;
  // P10/P11 polish — id of the collapsible region this header's
  // `aria-expanded` governs, for `aria-controls` (the disclosure-button
  // pattern; see UnifiedBoard.tsx's `kanban-lane-body` precedent). Only
  // ProjectSection's plain (below-threshold) rendering path has a single
  // contiguous body element to point at — the virtualized path (Sidebar's
  // own flatten step, above) renders each project's session rows as
  // independent absolutely-positioned siblings within one shared
  // virtualizer container, with no per-project wrapper element to give an
  // id, so that call site leaves this undefined rather than pointing
  // `aria-controls` at a div that doesn't exist.
  bodyId?: string;
}) {
  const [editOpen, setEditOpen] = useState(false);
  // P9 — deleteProject used to be `void deleteProject(...).then(...)` with
  // no `.catch` at all: a failure (a 503 host-unreachable, a locked file on
  // the project's own cwd, ...) left the project sitting in the sidebar
  // with no explanation, indistinguishable from the click never having
  // registered. Local, inline error state — same shape as
  // UnifiedBoard.tsx's TasksToolbar — rendered as a second line under this
  // header, same slot SessionRow's own eventLine/endError use.
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Issue #431-adjacent — Git pull shortcut's own inline error, mirroring
  // deleteError's slot. A pull can fail for visible reasons (dirty tree,
  // detached HEAD, conflicts), and SourceControlSection's Pull button already
  // surfaces the same shape there — keep parity.
  const [pullError, setPullError] = useState<string | null>(null);

  const attentionCount = sessions.filter((s) => s.attention).length;
  // Only a remote project needs a badge at all — the common single-host
  // deployment never shows one, matching CreateProjectModal's own selector
  // only appearing once a remote host exists.
  const host = project.hostId !== LOCAL_HOST_ID ? hosts.find((h) => h.id === project.hostId) : null;

  // Per-project git dirty badge (issue #76) — sourced from the store's
  // gitStatuses map (polled alongside sessions, see store.ts's
  // startLiveRefresh). A missing entry (not fetched yet, right after mount,
  // or a project that's genuinely never been a repo) renders the same as
  // `null` — both read as "nothing to report" rather than a distinct loading
  // state, which would just flicker on every mount. A project that HAS had a
  // successful fetch keeps showing that last-known-good entry through any
  // later transient failure (refreshGitStatuses preserves it rather than
  // overwriting with null) — this is what stops the dot from flickering
  // green→grey on a single flaky poll tick.
  const gitStatus = useDashboardStore((s) => s.gitStatuses[project.id]);
  // Issue #730 — the New-session button is inert in the Task view (no
  // workspace to open a terminal in), so it reads viewMode to disable itself.
  const viewMode = useDashboardStore((s) => s.viewMode);
  const gitDotClass = !gitStatus
    ? "none"
    : gitStatus.hasConflicts
      ? "conflict"
      : gitStatus.isClean
        ? "clean"
        : "dirty";
  const gitDotTitle = !gitStatus
    ? "Not a git repository"
    : gitStatus.hasConflicts
      ? `${gitStatus.branch}: unresolved merge conflicts`
      : gitStatus.isClean
        ? `${gitStatus.branch}: clean`
        : `${gitStatus.branch}: ${gitStatus.files.length} changed file${gitStatus.files.length === 1 ? "" : "s"}`;

  // Ahead/behind sync badge (issue #433 scope A) — `behind` only advances on
  // a `git fetch`, so it's only ever as fresh as the last one (auto-fetch,
  // or a manual Fetch from the Source Control section). The title's
  // "as of last fetch" caveat is what keeps a stale `↓0` (auto-fetch off, or
  // a branch with no upstream, both of which report 0/0 the same way
  // Source Control's own ahead/behind row does) from silently reading as "you are
  // up to date" — see Source Control's own `> 0` guards for the same posture.
  const gitSyncTitle = gitStatus
    ? `${gitStatus.branch}: ` +
      [
        gitStatus.ahead > 0 ? `${gitStatus.ahead} ahead` : null,
        gitStatus.behind > 0 ? `${gitStatus.behind} behind origin` : null,
      ]
        .filter(Boolean)
        .join(", ") +
      " (as of last fetch)"
    : "";

  return (
    <>
      <div
        className="project-row-header"
        onClick={onToggleCollapsed}
        // P10 — same role="button"/tabIndex/Enter-Space pattern as
        // SessionRow above (see that row's own comment for the full
        // rationale), including the `e.target !== e.currentTarget` guard:
        // this header nests its own "+ session" button and a KebabMenu
        // (both already wrapped in `onClick={(e) => e.stopPropagation()}`
        // for the mouse case), and without the guard tabbing to either and
        // pressing Enter/Space would ALSO toggle this row's collapse state.
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        aria-controls={bodyId}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggleCollapsed();
          }
        }}
      >
        <ChevronDownIcon
          size={12}
          className={collapsed ? "ws-group-chevron collapsed" : "ws-group-chevron"}
        />
        <FolderIcon size={15} />
        <span
          className="project-row-name"
          // Sidebar declutter — the agent-rules presence icon (issue #431)
          // used to sit in the header as its own always-on glyph; since it
          // never changes state (it's just "does this project have rule
          // files"), it's folded into this tooltip instead, alongside the
          // cwd. The command palette's "Agent Rules: <project>" entry stays
          // the actual click target — this was never interactive.
          title={
            project.ruleFiles.length > 0
              ? `${project.cwd}\nAgent rules: ${project.ruleFiles.join(", ")}`
              : project.cwd
          }
        >
          {project.name}
        </span>
        <span className={`project-git-dot ${gitDotClass}`} title={gitDotTitle} />
        {/* Issue #433 scope A — ahead/behind vs. origin, already computed
          server-side into gitStatus.ahead/behind and already polled via
          the same gitStatuses map as the dot above; just not surfaced
          here until now. Renders nothing at 0/0 (a synced branch, or one
          with no upstream) — see Source Control's own ahead/behind row for
          the identical guard. */}
        {gitStatus && (gitStatus.ahead > 0 || gitStatus.behind > 0) && (
          <span
            className={`project-git-sync${gitStatus.behind > BEHIND_STALE_THRESHOLD ? " stale" : ""}`}
            title={gitSyncTitle}
          >
            {gitStatus.ahead > 0 && <span className="project-git-ahead">↑{gitStatus.ahead}</span>}
            {gitStatus.behind > 0 && (
              <span className="project-git-behind">↓{gitStatus.behind}</span>
            )}
          </span>
        )}
        {/* Phase 4 (Gap F) — `project.conventionsHash` (Phase 3) is null
          until the first successful Scaffold Mullion apply stamps it
          (schema.ts's own `conventionsHash` column, alongside `slug` in
          the same /setup/apply write), so this needs no new backend
          signal or frontend type change. Same non-interactive posture as
          the rule-files indicator above — the kebab menu's "Scaffold
          Mullion" entry below is the click target. */}
        {project.conventionsHash == null && (
          <span className="project-unscaffolded-indicator" title="Never scaffolded with Mullion">
            <SkillIcon size={11} />
          </span>
        )}
        {host && (
          <span className="project-host-badge" title={`Runs on host: ${host.name}`}>
            <HostsIcon size={10} />
            {host.name}
          </span>
        )}
        {/* Issue #1892 — outside the badge's own max-width, so a long host
            name cannot ellipsis the status words away. */}
        {host && <HostStatusLabel host={host} />}
        {attentionCount > 0 && <span className="project-attn-pill">{attentionCount}</span>}
        {/* Sidebar declutter — a project with no sessions at all doesn't need
          a "0" sitting in its header; the plain count only earns its place
          once there's something to count. */}
        {sessions.length > 0 && <span className="project-session-count">{sessions.length}</span>}
        <button
          className="project-add-session"
          title={
            viewMode === "kanban"
              ? "New session (unavailable in Task view)"
              : "New session in project"
          }
          disabled={viewMode === "kanban"}
          onClick={(e) => {
            e.stopPropagation();
            onOpenLauncher();
          }}
        >
          <PlusIcon size={13} strokeLinecap="round" strokeWidth={2.2} />
        </button>
        <span onClick={(e) => e.stopPropagation()}>
          <KebabMenu
            menuPlacement="auto"
            title="More…"
            items={[
              {
                key: "edit",
                label: "Edit",
                icon: <RenameIcon size={14} style={{ color: "var(--muted)" }} />,
                onClick: () => setEditOpen(true),
                // Opens the Edit-project modal, which traps focus itself.
                opensOverlay: true,
              },
              {
                key: "git-pull",
                // Issue #431-adjacent — sidebar shortcut for `git pull`,
                // mirrors the disabled-gating on SourceControlSection's Pull
                // button (which only enables when behind > 0, i.e. only when
                // the operation would do something). Disabled-state messages
                // route through KebabMenu's `title` field (issue #1106), so a
                // user hovering an inert item sees why it's inert — not the
                // "looks enabled but does nothing" surprise the same issue
                // fixed for the kill-session overflow item.
                label: "Git pull",
                icon: <PullIcon size={14} style={{ color: "var(--muted)" }} />,
                disabled: !gitStatus || gitStatus.behind === 0,
                // gitStatuses[id] === null collapses three distinct states
                // (SourceControlSection.tsx:188-194): durably not a repo,
                // never fetched yet, and — for a remote-hosted project only
                // — the agent host being unreachable. A local project's
                // host is this process itself, so "not a repo" is the
                // honest read there; a remote-hosted project's null is
                // genuinely ambiguous, so its label says so rather than
                // asserting a specific cause that might be wrong (Hermes
                // review, PR #1366). The branch must key on
                // `project.hostId !== LOCAL_HOST_ID`, NOT on the `host`
                // lookup at line 821 — the latter is `hosts.find(...)`,
                // which is `undefined` whenever the hosts list hasn't
                // loaded yet, collapsing the "remote ambiguous" case back
                // to "not a repo" on first mount and defeating the fix
                // (Hermes review, PR #1366, line 1006). SourceControlSection.tsx:193
                // uses the same direct-property check.
                title: !gitStatus
                  ? project.hostId !== LOCAL_HOST_ID
                    ? "Not a git repository, or the host is unreachable."
                    : "Not a git repository"
                  : gitStatus.behind === 0
                    ? "Already up to date with tracking branch"
                    : `Pull ${gitStatus.behind} commit${gitStatus.behind === 1 ? "" : "s"} from tracking branch`,
                onClick: async () => {
                  setPullError(null);
                  try {
                    const result = await useDashboardStore.getState().pullProjectGit(project.id);
                    if (!result.pulled) {
                      // No `&& result.reason` guard — let formatPullReasonMessage's
                      // default branch fire on `{pulled: false}` without a reason,
                      // matching SourceControlSection.tsx's unconditional shape so
                      // a missing-reason response never falls through silently.
                      setPullError(formatPullReasonMessage(result.reason, result.detail));
                    }
                    // Hermes review, PR #1366, line 1023 — other pull
                    // surfaces invalidate refs too (SourceControlSection.tsx:254
                    // and the Source Control view both fire `refreshGitRefs` after a
                    // successful pull). Without this call, branch labels and
                    // diff stats stay stale until their own poll tick lands.
                    // SourceControlSection also writes a fresh status
                    // into the store inline; refreshGitStatuses covers the
                    // same data path here without the per-project round-trip.
                    await Promise.all([
                      useDashboardStore.getState().refreshGitStatuses(),
                      useDashboardStore.getState().refreshGitRefs([project.id]),
                    ]);
                  } catch (err) {
                    setPullError(err instanceof Error ? err.message : "Pull failed — try again.");
                  }
                },
              },
              {
                key: "scaffold-mullion",
                label: "Scaffold Mullion",
                icon: <SkillIcon size={14} style={{ color: "var(--muted)" }} />,
                onClick: onOpenProjectSetup,
              },
              {
                key: "delete",
                label: "Delete project",
                armLabel: "Click again to delete",
                icon: <CloseIcon size={14} />,
                danger: true,
                confirm: true,
                onClick: () => {
                  const endedSessions = sessions;
                  setDeleteError(null);
                  useDashboardStore
                    .getState()
                    .deleteProject(project.id)
                    .then(() => {
                      endedSessions.forEach(onSessionEnded);
                    })
                    .catch((err: unknown) => {
                      console.debug("[Sidebar] deleteProject failed", err);
                      setDeleteError(
                        err instanceof Error
                          ? err.message
                          : "Failed to delete project — try again.",
                      );
                    });
                },
              },
            ]}
          />
        </span>
        {editOpen && (
          <span onClick={(e) => e.stopPropagation()}>
            <CreateProjectModal
              mode="edit"
              initialName={project.name}
              initialPath={project.cwd}
              initialDevServerUrl={project.devServerUrl}
              detectedDevServerPort={project.detectedDevServerPort}
              projectId={project.id}
              initialDefaultAgent={project.defaultAgent}
              initialDefaultReviewAgent={project.defaultReviewAgent}
              initialMergeOnApprove={project.mergeOnApprove}
              initialAutoApprove={project.autoApprove}
              initialAllowCrossProjectSpawn={project.allowCrossProjectSpawn}
              initialCrossProjectTargets={project.crossProjectTargets}
              initialAcceptsChildrenFrom={project.acceptsChildrenFrom}
              initialAcceptsChildrenFromList={project.acceptsChildrenFromList}
              initialAcceptsMessagesFrom={project.acceptsMessagesFrom}
              initialAcceptsMessagesFromList={project.acceptsMessagesFromList}
              initialMaxAutoReturnRounds={project.maxAutoReturnRounds}
              initialConventionalCommitTitles={project.conventionalCommitTitles}
              initialAutoTagRelease={project.autoTagRelease}
              // Issue #1726 / roadmap 8.12 — the project's own placement
              // mode, so the control opens showing what it is today.
              initialPlacement={project.placement}
              // Issue #1951 follow-up — the project's own host and where it
              // lives on the others, so the "Also lives on" rows open filled.
              hosts={hosts}
              projectHostId={project.hostId}
              initialHostCwds={project.hostCwds}
              initialHostCwdsMeta={project.hostCwdsMeta}
              initialPlacementConstraints={project.placementConstraints}
              initialPreProvision={project.preProvision}
              onClose={() => setEditOpen(false)}
              onCreate={({
                name,
                cwd,
                devServerUrl,
                defaultAgent,
                defaultReviewAgent,
                mergeOnApprove,
                autoApprove,
                allowCrossProjectSpawn,
                crossProjectTargets,
                acceptsChildrenFrom,
                acceptsChildrenFromList,
                acceptsMessagesFrom,
                acceptsMessagesFromList,
                maxAutoReturnRounds,
                conventionalCommitTitles,
                autoTagRelease,
                createDir,
                gitInit,
                placement,
                hostCwds,
                placementConstraints,
                preProvision,
                allowDuplicate,
              }) =>
                useDashboardStore.getState().updateProject(project.id, {
                  name,
                  cwd,
                  devServerUrl,
                  defaultAgent,
                  defaultReviewAgent,
                  mergeOnApprove,
                  autoApprove,
                  allowCrossProjectSpawn,
                  crossProjectTargets,
                  acceptsChildrenFrom,
                  acceptsChildrenFromList,
                  acceptsMessagesFrom,
                  acceptsMessagesFromList,
                  maxAutoReturnRounds,
                  conventionalCommitTitles,
                  autoTagRelease,
                  createDir,
                  gitInit,
                  // Issue #1726 / roadmap 8.12 — the placement mode is a
                  // plain patch field (updateProject's Pick union already
                  // accepts it).
                  placement,
                  hostCwds,
                  placementConstraints,
                  preProvision,
                  allowDuplicate,
                })
              }
            />
          </span>
        )}
      </div>
      {deleteError && (
        <div className="project-row-error" title={deleteError}>
          {deleteError}
        </div>
      )}
      {pullError && (
        <div className="project-row-error" title={pullError}>
          {pullError}
        </div>
      )}
    </>
  );
}
