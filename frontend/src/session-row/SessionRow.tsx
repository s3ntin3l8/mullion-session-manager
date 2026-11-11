import { useCallback, useMemo, useState } from "react";
import { useDashboardStore } from "../store/index.js";
import type { Project, Session } from "../api/index.js";
import { deriveNowLine } from "../lib/sessionNowLine.js";
import { describeHostBadge, selectRemoteHost } from "../lib/hostBadge.js";
import { HostStatusLabel } from "../HostStatusLabel.js";
import {
  formatStatusLabel,
  isStatusReachable,
  rowClassNameForSeverity,
  STATUS_PRESENTATION,
} from "../sessionStatus.js";
import { resolveAgentLogo, commandToBinary } from "../cliLogos.js";
import { PromoteDialog } from "../PromoteDialog.js";
import { CloseIcon, HostsIcon } from "../ui/icons.js";
import { useLayoutContext } from "../lib/layoutTier.js";
import { liveChildCount } from "../sidebarHierarchy.js";
import { sessionDisplayTitle } from "../lib/sessionDisplay.js";
import { summarizeFileChanges } from "../lib/sidebarStatus.js";
import { matchSessionPr } from "../github/matchSessionPr.js";
import { sessionIdFromPanelId } from "../panelUtils.js";
import { describeError } from "../lib/describeError.js";
import { sameCwd } from "../lib/sameCwd.js";
import { Header } from "./Header.js";
import { Details } from "./Details.js";
import { QuotaBadge } from "./QuotaBadge.js";
import { useRunwayQuota } from "../hooks/useRunwayQuota.js";
import { expandedSessionRows, setSessionRowExpanded } from "./expandedSessionRows.js";

// The 4 status treatments the redesign's States doc specifies (confirmed
// against the design source — its tab-chrome badge grid has exactly these
// four, no "Killed" badge): attention (prominent, animated, "needs input"),
// working (green pulse), idle (hollow dot), exited (dimmed, program ended
// on its own). A killed session never reaches this component — Sidebar.tsx
// filters `status === "killed"` out of the list before it gets here, since
// the design's kill flow removes the row entirely rather than leaving a
// dimmed tombstone (see Sidebar's own filter comment). Attention takes
// priority over working/idle since it's the highest-value signal for an
// unwatched dashboard.

// describeEvent (the kind/payload interpretation this row's now-line —
// lib/sessionNowLine.ts's deriveNowLine — and the notification panel both
// build on) moved to eventDescriptions.ts for #169, which needed the same
// rules for its own event-feed panel — see that module's own doc comment.

// Row 5 (subagents)/row 6 (background tasks) chips, and row 4's file-change
// chips + expanded diff (SessionFileDiff), all extracted to
// ./Chips.tsx and ./FileChanges.tsx respectively
// (PR 27 phase 2, Wave 5 of .claude/plans/can-we-do-a-warm-cocke.md) — see
// each file's own header comment. That includes the subagent-row
// expand/collapse localStorage persistence helpers (mirrors
// readExpandedSessionRows/setSessionRowExpanded in ./expandedSessionRows.ts, but keyed by
// `${sessionId}:${agentId}` — see Chips.tsx) and isSubagentLive/
// subagentDotClass/backgroundTaskLetter/fileChangeDotClass/fileChangeLetter
// (all pure, moved to lib/sidebarStatus.ts in PR 27 phase 1).
//
// sessionGitDotClass/sessionPrDotClass/summarizeFileChanges (also
// lib/sidebarStatus.ts) power row 3 (git details, ./GitLine.tsx)
// — summarizeFileChanges itself stays called from SessionRow below (its
// input, sessionEvents, is also row 2's eventLine source, so it isn't a
// FileChanges-only concern). ProjectHeader's own gitStatus handling in
// ../sidebar/ProjectHeader.tsx
// stays inlined rather than routed through sessionGitDotClass (matches
// git-refs.ts's own "small guards get duplicated, not shared" precedent
// elsewhere in this codebase).

const FILE_CHANGE_MAX_SHOWN = 5;

export function SessionRow({
  session,
  project,
  onOpen,
  onOpenAsFloat,
  onEnd,
  onPromoted,
  alwaysExpandGit = false,
  showSubagents = true,
  foldDetails = true,
  depth = 0,
  openInWorkspace = false,
  spansHosts = false,
}: {
  session: Session;
  project: Project;
  // Issue #2238 — computed once per project by Sidebar; unset (every other
  // caller, including the Kanban/board lanes, which are out of scope) keeps
  // today's rows.
  spansHosts?: boolean;
  onOpen: () => void;
  onOpenAsFloat?: () => void;
  // Passed straight through to PromoteDialog (see that prop's own doc
  // comment) — optional so UnifiedBoard.tsx's ad-hoc session lane and
  // existing tests that don't exercise promote need no change.
  onPromoted?: (newSession: Session) => void;
  // P9 — every caller (ProjectSection's plain rendering path and
  // VirtualizedProjectTree's above-threshold path, both in Sidebar.tsx, plus
  // UnifiedBoard.tsx's ad-hoc session lane) builds this from
  // `deleteSession(...).then(...)`; a failure used to vanish into an
  // unhandled rejection with the session still sitting right there in the
  // list. `void | Promise<void>` (not a bare `Promise<void>`) so the ~80
  // existing `onEnd={vi.fn()}` test doubles across this file's own test
  // suite keep type-checking unchanged — this component wraps the call in
  // `Promise.resolve(...)` below specifically so a caller that still
  // returns nothing (a test mock, or any future caller) degrades to
  // exactly today's silent-success behavior instead of throwing on
  // `.catch` of a non-Promise.
  onEnd: () => void | Promise<void>;
  // A caller with room to always show git details can skip the
  // collapse-by-default toggle this row uses everywhere else (the sidebar's
  // own narrow, scrollable tree) — originally added for issue #211's
  // KanbanBoard.tsx; UnifiedBoard.tsx's ad-hoc session lane leaves this
  // unset (the per-row toggle stays available) rather than always expanding,
  // since a horizontal lane of cards has less room than that board did.
  alwaysExpandGit?: boolean;
  // UnifiedBoard.tsx's ad-hoc session lane passes `false` — its cards are
  // meant to stay flat (issue #195/5.5a), same opt-out shape as
  // alwaysExpandGit above, not a new mechanism.
  showSubagents?: boolean;
  // Sidebar declutter — whether session-row/Details.tsx's files/background-
  // tasks rows render only behind the details chevron (the sidebar's
  // default) or always (LaneCard.tsx passes `false` to keep its own
  // pre-existing "files and outstanding background tasks are always
  // visible" kanban-card behavior — unlike git and agents, which were
  // already gated behind their own toggle/showSubagents opt-out before this
  // change, so they aren't affected by this flag).
  foldDetails?: boolean;
  // Phase 5 (Track B, issue #195 5.5b) — how many levels deep this row
  // renders (project → session → child session, so only 0 or 1 is possible
  // today: nesting is capped at one level server-side, see
  // createSessionRecord's "parent-is-child" rejection). An explicit prop
  // rather than recursion: SessionRow (now this orchestrator plus its
  // Header/GitLine/FileChanges/Chips sub-components beside this file,
  // split in PR 27 phase 2) is shared verbatim by UnifiedBoard.tsx's ad-hoc
  // lane (which never passes this, so its cards stay flat for free) —
  // recursing here would force that lane to opt out of a second thing
  // instead of just not knowing this prop exists at all.
  depth?: number;
  // Issue #1877 — this session's terminal pane is already in the current
  // workspace layout. The row says so in words; the click is still `onOpen`,
  // which is App's onOpenSession and focuses that pane instead of adding
  // another. Optional so the board's session lane (which has no workspace
  // layout of its own) stays unmarked.
  openInWorkspace?: boolean;
}) {
  const isTerminal = session.status === "killed";
  const confirmBeforeKill = useDashboardStore((s) => s.settings.sessions.confirmBeforeKill);
  // #719 — per-session mute, read from the store so the sidebar kebab's label
  // stays in sync with the tab overflow menu / toolbar bell.
  const isMuted = useDashboardStore((s) => s.mutedSessionIds.includes(session.id));
  // Phase 5 (Track B, issue #196 5.6) — killSession's default is "detach"
  // (a live child becomes an independent top-level session, never
  // silently killed), but that consequence still needs to be visible in
  // the UI before the DELETE fires rather than happening invisibly. Full
  // session list (not whatever's already filtered into this project
  // section) so the count is correct regardless of "hide ended sessions".
  const allSessions = useDashboardStore((s) => s.sessions);
  const childCount = useMemo(
    () => liveChildCount(allSessions, session.id),
    [allSessions, session.id],
  );
  const theme = useDashboardStore((s) => s.theme);
  // Issue #167 — the 1.1 events store slice (store.ts's `events`, fed by
  // eventsClient.ts), scoped to just this session's list. Selector-based so
  // a live event for a DIFFERENT session's list doesn't re-render this row.
  const sessionEvents = useDashboardStore((s) => s.events[session.id]);
  // Which session is currently open in a pane. `aria-current` marks it for a
  // screen reader ("you are here"), and the `.active` class gives the row
  // the visual state it never had — before this, the sidebar showed no
  // indication at all of which session you were looking at.
  const isActiveSession = useDashboardStore(
    (s) => sessionIdFromPanelId(s.activePanelId) === session.id,
  );
  const agentLogo = resolveAgentLogo(session.command, theme);
  const agentBinary = commandToBinary(session.command);
  // Issue #29 — the Runway quota chip. The snapshot is fetched ONCE for the
  // whole app (hooks/useRunwayQuota.ts's shared cache) and every row reads
  // it, so a sidebar full of sessions still makes a single request. The
  // agent is derived from the session's own command (the same value the
  // row's logo and name come from), so the badge names the same agent the
  // rest of the row names.
  const runwayQuota = useRunwayQuota();
  const renameSession = useDashboardStore((s) => s.renameSession);

  // Row 4 (issue #177) — recent file changes, derived from the same
  // sessionEvents slice the now-line (below) also reads. Passed down to
  // ./Details.tsx as a prop rather than computed there — it
  // stays here because sessionEvents (its input) is ALSO the now-line's own
  // fallback-context source, so this can't become a Details-only concern
  // without either re-subscribing to the same store slice twice or
  // splitting sessionEvents itself across two components. `hiddenFileChanges`
  // (sidebar declutter) is what's left over past FILE_CHANGE_MAX_SHOWN —
  // Details.tsx renders it as a trailing "+N" so a session that touched more
  // files than the cap says so instead of silently clipping.
  const allFileChanges = useMemo(() => summarizeFileChanges(sessionEvents), [sessionEvents]);
  const fileChanges = useMemo(
    () => allFileChanges.slice(0, FILE_CHANGE_MAX_SHOWN),
    [allFileChanges],
  );
  const hiddenFileChanges = useMemo(
    () => allFileChanges.slice(FILE_CHANGE_MAX_SHOWN),
    [allFileChanges],
  );

  // Row 3's data (issue #202) — worktree/branch/PR/diff-stats. Selector-based
  // per field (not one selector returning an object) so a live update to a
  // DIFFERENT session's — or a different project's — slice doesn't re-render
  // this row, same reasoning as sessionEvents above.
  const gitStatus = useDashboardStore((s) => s.sessionGitStatuses[session.id]);
  // Issue: sidebar worktree detection — for sessions in a worktree, prefer
  // the poll-derived git status over hook-reported liveBranch: opencode's
  // vcs.branch.updated always reports the main checkout's branch, while the
  // per-session git status correctly resolves against the worktree cwd via
  // resolveSessionCwdTargets + OSC 7 liveCwd tracking. Outside a worktree,
  // liveBranch still takes priority. Falls back to project.currentBranch.
  const effectiveCwd = session.liveCwd ?? session.cwd ?? project.cwd;
  const inWorktree = !sameCwd(effectiveCwd, project.cwd);
  const displayBranch = inWorktree
    ? (gitStatus?.branch ?? session.liveBranch ?? project.currentBranch)
    : (session.liveBranch ?? gitStatus?.branch ?? project.currentBranch);
  const diffStats = useDashboardStore((s) => s.gitDiffStats[session.id]);
  const branchesResult = useDashboardStore((s) => s.gitBranchesByProject[project.id]);
  const prsStatus = useDashboardStore((s) => s.prsByProject[project.id]);

  // Issue #271 — auto-opens for an agent-triggered `promote_request` (the
  // model's tool call is blocked until this dialog resolves it, one way or
  // another — see PromoteDialog's own header comment) and stays available
  // via the kebab menu below for a human-initiated promote otherwise.
  // Adjusts state during render (React's own recommended pattern for
  // "reopen when a prop transitions", not an Effect — see
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes)
  // rather than a `useEffect` + setState, which the project's lint config
  // (react-hooks/set-state-in-effect) rejects as a cascading-render risk.
  // Initializer covers a row that mounts already "pending" (e.g. a page
  // refresh while a request is mid-flight); the render-time check below
  // covers a later transition into "pending" on an already-mounted row.
  //
  // Stays here (not pushed into Header, where the "promote" kebab item
  // lives) because PromoteDialog itself renders as a SIBLING of the
  // `.session-item` div below, not inside Header's own region — Header only
  // gets a bound `onPromote` callback to open it.
  const [promoteOpen, setPromoteOpen] = useState(() => session.promoteState === "pending");
  const [prevPromoteState, setPrevPromoteState] = useState(session.promoteState);
  if (session.promoteState !== prevPromoteState) {
    setPrevPromoteState(session.promoteState);
    if (session.promoteState === "pending") setPromoteOpen(true);
  }

  // Stays here (not pushed into Header) because it gates whether GitLine
  // renders at all, below — Header only owns the toggle *button*, not the
  // line it controls.
  const [gitLineExpanded, setGitLineExpanded] = useState(() => expandedSessionRows.has(session.id));
  const toggleGitLineExpanded = useCallback(() => {
    setGitLineExpanded((prev) => {
      const next = !prev;
      setSessionRowExpanded(session.id, next);
      return next;
    });
  }, [session.id]);
  const gitExpanded = alwaysExpandGit || gitLineExpanded;

  // P9 — surfaces a failed `onEnd()` inline (see that prop's own doc
  // comment for why the type stays `void | Promise<void>`) instead of the
  // rejection just vanishing, same "an inline error near the control that
  // triggered the request" shape as ProjectHeader's deleteError above.
  // Stays here (not pushed into Header) because the error line itself
  // renders as a sibling of Header below, not inside it.
  const [endError, setEndError] = useState<string | null>(null);
  const handleEnd = () => {
    setEndError(null);
    Promise.resolve(onEnd()).catch((err: unknown) => {
      console.debug("[Sidebar] end session failed", err);
      setEndError(err instanceof Error ? err.message : "Failed to end session — try again.");
    });
  };

  // Matched against this project's own worktree list — `undefined`/no match
  // (the common case: most sessions just run at the project's own cwd, which
  // is always the *main* worktree) means no worktree label, not an error.
  const worktree = branchesResult?.worktrees.find((w) => w.path === effectiveCwd && !w.isMain);
  const worktreeLabel = worktree ? (worktree.path.split("/").filter(Boolean).pop() ?? null) : null;

  // The open PR (if any) for this session's own branch — matched
  // client-side against the project's unfiltered PR list rather than
  // firing a `?branch=` request per session (api.ts's getProjectGitHubPRs
  // doc comment). Uses displayBranch (which inverts precedence for worktree
  // sessions — preferring poll-derived git status over hook-reported
  // liveBranch) so branches from worktree sessions still match their PRs.
  const taskPrNumber = useDashboardStore(
    (s) => s.tasks.find((t) => t.sessionId === session.id)?.prNumber ?? null,
  );
  const matchedPr = matchSessionPr(prsStatus?.prs, { branch: displayBranch, taskPrNumber });
  const openRightSidebarPr = useDashboardStore((s) => s.openRightSidebarPr);
  const layoutTier = useLayoutContext().tier;

  // U3 — factored into sessionDisplayTitle (module scope, top of file) so
  // the sidebar's new search filter matches against exactly this same
  // precedence rather than drifting from it.
  const title = sessionDisplayTitle(session);

  const showCommand = title === session.command;
  // Suppress the agent binary label when the title already starts with it
  // (e.g. command fallback "npm run build" already includes "npm") to avoid
  // redundant "npm npm run build" rendering.
  const showAgentFallback =
    !agentLogo && !(title === agentBinary || title.startsWith(agentBinary + " "));

  // Issue #351 — the matched hook adapter's emits are surfaced directly on
  // each session (computed once at launch from adapter.matches()), so a
  // wrapped/aliased command correctly gets its real adapter's capability list
  // rather than silently falling back to empty (the old binary->agent lookup
  // could only match on the unparsed binary, not the full command string).
  const agentEmits: readonly string[] = session.hookEmits;
  const statusReachable = isStatusReachable(session.sessionStatus, agentEmits);
  const statusEstimated = !statusReachable;

  // Row 5 (Phase 5 Track A, #195/5.5a) — same hookEmits-gating precedent as
  // statusReachable above: a codex/agy session can never emit "subagent" (see
  // sessionStatus.ts's EMITS_REQUIREMENTS), so this must not render an empty
  // "Subagents" affordance for them. Also suppressed once there's nothing to
  // show, and by KanbanBoard's showSubagents={false} opt-out.
  const subagentsReachable = isStatusReachable("subagent", agentEmits);
  const showSubagentsRow = showSubagents && subagentsReachable && session.subagents.length > 0;

  // Row 6 (issue #428) — same hookEmits-gating precedent as Row 5 above,
  // against the "background" status's own EMITS_REQUIREMENTS entry. Data is
  // already filtered to outstanding-only server-side (SessionInfo.
  // outstandingBackgroundTasks — see pty-manager.ts's toInfo()), so no
  // further filtering is needed here, same "presentation only" posture as
  // everything else this component reads off `session`.
  const backgroundTasksReachable = isStatusReachable("background", agentEmits);
  const showBackgroundTasksRow =
    backgroundTasksReachable && session.outstandingBackgroundTasks.length > 0;

  // Sidebar declutter — the folded-state "now" line, replacing the old
  // always-on eventLine (the latest describable NotificationEvent, however
  // stale or content-free — "No longer needs attention" being the worst
  // offender). See lib/sessionNowLine.ts for the full priority chain.
  const nowLine = useMemo(
    () => deriveNowLine(session, sessionEvents, title),
    [session, sessionEvents, title],
  );

  // Sidebar declutter — whether the details chevron (Header.tsx's
  // `hasDetails`) renders at all: is there ANYTHING session-row/Details.tsx
  // would show. Files/background-tasks only count here when `foldDetails`
  // (the sidebar's default) actually hides them behind the toggle — when a
  // caller sets `foldDetails={false}` (LaneCard.tsx), those two already
  // render unconditionally, so they shouldn't also make an otherwise-empty
  // toggle appear.
  const showSaidRow = session.lastAssistantMessage != null;
  const detailsAvailable =
    gitStatus != null ||
    displayBranch != null ||
    showSubagentsRow ||
    showSaidRow ||
    (foldDetails && (fileChanges.length > 0 || showBackgroundTasksRow));

  const presentation = STATUS_PRESENTATION[session.sessionStatus];
  const statusClass = rowClassNameForSeverity(session.sessionStatusSeverity);
  const dot = (
    <span
      className="session-dot-wrap"
      title={
        statusEstimated
          ? "Estimated status — this agent doesn't report this state directly"
          : undefined
      }
    >
      {session.sessionStatus === "exited" ? (
        <CloseIcon size={10} style={{ color: "var(--dim)" }} />
      ) : (
        <span
          className={`session-dot-${presentation.tone}${statusEstimated ? " estimated" : ""}`}
        />
      )}
    </span>
  );
  // Issue #323: state-restored and stale-hooks indicators.
  const showUnknownIndicator = !session.stateRestored && session.alive;
  const showStaleIndicator = session.staleHooks;
  const statusLabelText = formatStatusLabel(presentation, session.sessionStatusDetail);
  // Issue #1727 / roadmap 8.13 — the host THIS session runs on.
  //
  // Quiet by design: a small icon and the host's name, in --dim, and not
  // shown at all for a local session (the overwhelmingly common case — the
  // sidebar already carries a per-PROJECT host badge for that). It exists
  // for the case that matters: one project's sessions on DIFFERENT hosts,
  // which is what automatic placement produces.
  //
  // The host's NAME comes from the store's hosts list, read non-reactively
  // (getState). A name does not change when the heartbeat does, and a local
  // row never reads the fleet list. A REMOTE row subscribes to its own host
  // below, so that row re-renders when that host's health changes. A local
  // row's selector stays null and does not track the fleet, so a health-dot
  // refresh still does not re-render it — the row re-renders on session
  // refresh, which is often enough for the name.
  // Issue #1852 — the host badge AND its tooltip (the placement
  // decision's own words) are computed together, in one place: see
  // lib/hostBadge.ts's own comment for why the two disagree about how to
  // name a host.
  const hostBadge = describeHostBadge(session, () => useDashboardStore.getState().hosts ?? [], {
    spansHosts,
  });
  // Issue #1892 — the badge above names the host and deliberately does not
  // subscribe (a name does not change when the heartbeat does). The status
  // does, so this row subscribes to that one host. Local sessions have no
  // badge and get no status.
  const remoteHost = useDashboardStore((s) => selectRemoteHost(s.hosts, session.resolvedHostId));
  const statusLabel = (
    <span className="session-status-group">
      <span className={`session-status-label ${presentation.tone}`} title={statusLabelText}>
        {showUnknownIndicator && (
          <span title="Awaiting data… — session state not yet restored after restart">?</span>
        )}
        {statusLabelText}
        {showStaleIndicator && (
          <span
            className="session-stale-icon"
            title={`Session launched with Mullion ${session.restoredVersion ?? "unknown"}, restart to pick up new capabilities`}
          >
            &#9201;
          </span>
        )}
      </span>
      {/* The host badge is a SIBLING of the status label, not a child of it:
          the label ellipsis-overflows its own box (overflow: hidden), so a
          badge inside it would be clipped by a long status detail. */}
      {hostBadge && (
        <span className="session-host-badge" title={hostBadge.title}>
          <HostsIcon size={10} />
          <span className="session-host-badge-name">{hostBadge.name}</span>
        </span>
      )}
      {remoteHost && <HostStatusLabel host={remoteHost} />}
      {openInWorkspace && (
        // The word is the signal — a colour on the row would not say
        // "this pane is already open". aria-label below repeats it: that
        // attribute replaces the row's contents for a screen reader.
        <span className="session-open-label">open</span>
      )}
    </span>
  );

  const onDragStart = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.dataTransfer.setData("application/x-mullion-session", String(session.id));
      e.dataTransfer.setData("text/plain", title);
      e.dataTransfer.effectAllowed = "move";
    },
    [session.id, title],
  );

  return (
    <>
      <div
        className={`session-item ${statusClass}${statusEstimated ? " status-estimated" : ""}${
          isActiveSession ? " active" : ""
        }`}
        aria-current={isActiveSession ? "true" : undefined}
        // CSS custom property, not a computed inline margin — styles.css
        // owns the actual indent math (base + depth * step), same "component
        // supplies data, CSS supplies presentation" split as every other
        // status-driven class on this row.
        style={depth > 0 ? ({ "--session-depth": depth } as React.CSSProperties) : undefined}
        onClick={onOpen}
        draggable={true}
        onDragStart={onDragStart}
        // P10 — this is the single most-used control in the app ("opening a
        // session is mouse-only" before this fix), so it gets the same
        // role="button"/tabIndex/Enter-Space pattern as UnifiedBoard.tsx's
        // TaskCard and NotificationBell.tsx's EventRow. Unlike either of
        // those two, this row nests a REAL focusable rename `<input>` plus
        // several of its own buttons (git-details toggle, kebab menu, end
        // session) — every one of those already stops click propagation
        // (the `onClick={(e) => e.stopPropagation()}` wrapper spans below),
        // which keeps a mouse click on any of them from also opening the
        // session. That alone doesn't cover keyboard: a nested `<button>`'s
        // native Enter/Space activation dispatches its own click AND a raw
        // keydown that bubbles here independently of that click's
        // stopPropagation (a different event entirely) — so tabbing to,
        // say, the kebab menu and pressing Enter would fire this row's
        // onOpen too without a guard. `e.target !== e.currentTarget` is that
        // guard: it only treats Enter/Space as "open" when the KEYDOWN's own
        // target is the row itself (i.e. the row, not some focused
        // descendant, has focus), which also covers typing Enter into the
        // rename input for free — no per-descendant stopPropagation needed,
        // unlike NotificationBell's GateActions, which has to do that by
        // hand for its nested reason field.
        role="button"
        tabIndex={0}
        aria-label={
          openInWorkspace
            ? `Open session ${title}, already open in this workspace`
            : `Open session ${title}`
        }
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen();
          }
        }}
      >
        <Header
          title={title}
          showCommand={showCommand}
          agentLogo={agentLogo}
          showAgentFallback={showAgentFallback}
          agentBinary={agentBinary}
          dot={dot}
          statusLabel={statusLabel}
          quotaBadge={
            <QuotaBadge quota={runwayQuota} command={session.command} model={session.model} />
          }
          hasDetails={detailsAvailable}
          alwaysExpandGit={alwaysExpandGit}
          gitLineExpanded={gitLineExpanded}
          onToggleGitLineExpanded={toggleGitLineExpanded}
          isTerminal={isTerminal}
          isMuted={isMuted}
          onToggleMute={() => useDashboardStore.getState().toggleSessionMute(session.id)}
          onOpenAsFloat={onOpenAsFloat}
          onRevealInGit={
            // No right sidebar on phone — the request would never be applied.
            layoutTier === "phone"
              ? undefined
              : () => {
                  const st = useDashboardStore.getState();
                  if (displayBranch) st.openRightSidebarBranch(project.id, displayBranch);
                  else st.openRightSidebarView("git", project.id);
                }
          }
          onPromote={() => setPromoteOpen(true)}
          onRename={(value) => {
            // The store rolls the optimistic rename back on a rejected
            // PATCH (see slices/sessions.ts's renameSession), so the row
            // stops showing a name the server never accepted. The user
            // still has to be TOLD — that rejection used to be dropped
            // here, silently, at all three rename call sites.
            void renameSession(session.id, value).catch((err) => {
              useDashboardStore
                .getState()
                .reportError("Could not rename the session.", describeError(err));
            });
          }}
          childCount={childCount}
          confirmBeforeKill={confirmBeforeKill}
          onConfirmEnd={handleEnd}
        />
        {/* Sidebar declutter — replaces the old always-on eventLine (the
          latest describable NotificationEvent, however stale/content-free)
          with the single most relevant "what is this session doing right
          now" line. See lib/sessionNowLine.ts. */}
        {nowLine && (
          <span className={`session-now-line ${nowLine.tone}`} title={nowLine.text}>
            {nowLine.text}
            {nowLine.suffix && <span className="session-now-suffix"> · {nowLine.suffix}</span>}
          </span>
        )}
        {endError && (
          <span className="session-end-error" title={endError}>
            {endError}
          </span>
        )}
        {/* Sidebar declutter — history (git/files/agents/last message), all
          folded behind the row's details chevron by default (see
          `detailsAvailable`/`gitExpanded` above and Header.tsx's toggle).
          `foldDetails` is LaneCard.tsx's escape hatch to keep its own files/
          background-tasks rows unconditionally visible, matching their
          pre-existing kanban-card behavior. See session-row/Details.tsx. */}
        <Details
          open={gitExpanded}
          sessionId={session.id}
          gitStatus={gitStatus}
          displayBranch={displayBranch}
          worktreeLabel={worktreeLabel}
          effectiveCwd={effectiveCwd}
          matchedPr={matchedPr}
          onOpenPr={(n) => openRightSidebarPr(project.id, n)}
          diffStats={diffStats}
          foldDetails={foldDetails}
          fileChanges={fileChanges}
          hiddenFileChanges={hiddenFileChanges}
          showSubagentsRow={showSubagentsRow}
          subagents={session.subagents}
          showBackgroundTasksRow={showBackgroundTasksRow}
          outstandingBackgroundTasks={session.outstandingBackgroundTasks}
          lastAssistantMessage={session.lastAssistantMessage}
        />
      </div>
      {promoteOpen && (
        <PromoteDialog
          session={session}
          project={project}
          onClose={() => setPromoteOpen(false)}
          onPromoted={onPromoted}
        />
      )}
    </>
  );
}
