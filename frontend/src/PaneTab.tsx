import { useCallback, useEffect, useRef, useState } from "react";
import type { IDockviewPanelHeaderProps } from "dockview-react";
import type { TerminalPaneParams } from "./TerminalPane.js";
import { useDashboardStore } from "./store/index.js";
import { resolveAgentLogo } from "./cliLogos.js";
import { formatBranchLabel } from "./paneTitle.js";
import { BellIcon, CheckIcon, CloseIcon } from "./ui/icons.js";
import { unreadEventSummary } from "./eventDescriptions.js";
import { formatStatusLabel, STATUS_PRESENTATION } from "./sessionStatus.js";
import { PaneActionsMenu } from "./PaneActionsMenu.js";
import { panelSessionId } from "./panelUtils.js";

// Below this tab width the status badge ("Working"/"Idle"/"Attention") no
// longer fits alongside the dot, name, and the two action buttons, and would
// spill into the neighboring tab (.pane-tab has no overflow:hidden — see
// issue #103). The status dot alone still conveys the same state, so hiding
// the badge here loses little. Calibrated against the widest badge,
// "Attention" (~90px of content width): at 190px total, the fixed-width
// items (dot + gaps + two buttons, ~87px) leave ~13px for the name once the
// badge is showing — comfortably above the badge's own width, so it's the
// badge that gives way first, not the name.
const NARROW_TAB_BADGE_THRESHOLD_PX = 190;

// Issue: narrow headers overflow — below this, drop the agent logo (14px)
// and collapse the unread badge (`.pane-tab-unread-badge`, min-width 15px —
// unlike the status badge/branch label above, it isn't gated by `narrow` at
// all today) down to a bare dot, on top of everything NARROW_TAB_BADGE_
// THRESHOLD_PX already hides. Calibrated against the worst case that can
// still be showing at this width — dot(~10px) + name + close(24px) +
// kebab(24px) + 3 gaps(8px each) = ~82px fixed, plus the collapsed unread
// dot(~15px) + one more gap(8px) when present = ~105px — leaving a little
// headroom above that for the name to still show a character or two rather
// than being squeezed to nothing the instant this mode kicks in.
const TIGHT_TAB_THRESHOLD_PX = 150;

// How long the stronger "just fired" burst (issue #98 item 6) plays before
// settling into the steady-state cmuxRingHeader pulse — long enough to catch
// the eye on an unwatched dashboard, short enough not to nag once it has.
const JUST_FIRED_ATTENTION_MS = 1800;

export function PaneTab(props: IDockviewPanelHeaderProps<TerminalPaneParams>) {
  const sessionId = props.params.sessionId;
  const session = useDashboardStore((s) => s.sessions.find((sess) => sess.id === sessionId));
  const renameSession = useDashboardStore((s) => s.renameSession);
  const theme = useDashboardStore((s) => s.theme);
  const agentLogo = session ? resolveAgentLogo(session.command, theme) : null;
  // Issue #168's unread badge — this session's buffered events plus the
  // client half of the 1.1 read cursor (store.ts's lastSeenSeq). Re-derived
  // on every events/lastSeenSeq change; markEventSeen (called below, on
  // focus) is what advances the cursor.
  const events = useDashboardStore((s) => s.events[sessionId]);
  const lastSeenSeq = useDashboardStore((s) => s.lastSeenSeq[sessionId] ?? 0);
  // Issue #169 — an event dismissed from the notification panel shouldn't
  // keep inflating this tab's own badge; without this a dismissed event
  // would vanish from the panel yet still count here, which is exactly the
  // "don't break tab-badge/panel agreement" case #169 has to avoid.
  const dismissedEventKeys = useDashboardStore((s) => s.dismissedEventKeys);
  // #719 — a muted session shows no unread tab badge (the disturbance is
  // silenced); the events still surface in the timeline/feed when opened.
  const muted = useDashboardStore((s) => s.mutedSessionIds.includes(sessionId));
  // Full session list (not just this tab's own `session` above) — needed to
  // check sibling panels' attention state for the #98 group-accent
  // underline below, since that's a property of *other* sessions this tab
  // doesn't otherwise subscribe to.
  const sessions = useDashboardStore((s) => s.sessions);
  const highlightedPanelId = useDashboardStore((s) => s.highlightedPanelId);
  const highlightFlash = highlightedPanelId === `session-${sessionId}`;
  // Branch sub-label (issue #96) — the session's best-known branch; see the
  // displayBranch precedence comment below. Dirty marker from the
  // separately-polled gitStatuses.
  const project = useDashboardStore((s) =>
    session ? s.projects.find((p) => p.id === session.projectId) : undefined,
  );
  const sessionGitStatus = useDashboardStore((s) =>
    session ? s.sessionGitStatuses[session.id] : null,
  );
  const gitStatus = useDashboardStore((s) => (session ? s.gitStatuses[session.projectId] : null));
  // For sessions in a worktree, prefer the per-session git status over
  // hook-reported liveBranch: opencode's vcs.branch.updated always reports
  // the main checkout's branch, while git status correctly resolves against
  // the worktree cwd via resolveSessionCwdTargets + OSC 7 liveCwd tracking.
  const effectiveCwd = session?.liveCwd ?? session?.cwd ?? project?.cwd;
  const inWorktree = effectiveCwd !== project?.cwd && project?.cwd !== undefined;
  const displayBranch = inWorktree
    ? (sessionGitStatus?.branch ?? session?.liveBranch ?? project?.currentBranch ?? null)
    : (session?.liveBranch ?? sessionGitStatus?.branch ?? project?.currentBranch ?? null);
  const branchLabel =
    displayBranch !== null
      ? formatBranchLabel(displayBranch, gitStatus ? !gitStatus.isClean : false)
      : null;

  // Unread notification-worthy events (issue #168) — shared with App.tsx's
  // mobile pane bar via eventDescriptions.ts's unreadEventSummary (Hermes
  // review, PR #613), which is where the "bell wins over check when both are
  // present" note now lives.
  // #719 — when muted, suppress the tab's unread badge entirely (mirrors the
  // toolbar bell's own muted skip in NotificationBell.tsx's countUnread).
  const { count: rawUnreadCount, kind: unreadIconKind } = unreadEventSummary(
    sessionId,
    events,
    lastSeenSeq,
    dismissedEventKeys,
  );
  const unreadCount = muted ? 0 : rawUnreadCount;

  // #98 item 1 — tab-group underline accent. dockview 7.0.2's own
  // `tabGroupAccent`/`--dv-tab-group-color` (what the issue's proposed code
  // sample assumed) turned out, on inspection of the installed package, to
  // be a different feature entirely: an opt-in "cluster tabs with a
  // labelled chip" mechanism (createTabGroup/addPanelToTabGroup, a whole
  // browser-tab-groups-style UI with its own context-menu color picker) —
  // adopting it just for a color cue would be a much larger, mismatched
  // surface change. This instead reads `props.api.group.panels` (a
  // documented, typed part of DockviewPanelApi) directly: every panel in
  // this tab's own dockview *group* (split region) that resolves to a
  // session with `attention` true. Since dockview always renders every
  // panel's tab header in a group's strip (only the *content* of a
  // background tab is hidden, not its header), giving every tab in the
  // group this treatment — not just the attention one — is what actually
  // makes it "visible even when the flagged tab isn't the active one":
  // whichever tab in that group you're looking at gets the cue. Rich
  // statuses (issue: extend surfaced session statuses) — reads
  // `sessionStatusAttentionRequired`, the broadened derived flag, not the
  // old byte-heuristic `attention` boolean alone.
  const groupHasAttention = props.api.group.panels.some((panel) => {
    const sid = panelSessionId(panel);
    return (
      sid !== undefined && sessions.some((s) => s.id === sid && s.sessionStatusAttentionRequired)
    );
  });

  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(props.api.title ?? "");
  const [narrow, setNarrow] = useState(false);
  // Issue: narrow headers overflow — see TIGHT_TAB_THRESHOLD_PX's own
  // comment. A second, tighter threshold off the exact same measurement
  // `narrow` already uses, not a second ResizeObserver.
  const [tight, setTight] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const tabRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (renaming) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renaming]);

  // Tracks the tab's own rendered width (not the group's) so the badge hides
  // exactly when it would otherwise overflow — dockview resizes .dv-tab via
  // flex, not a prop this component receives, so a ResizeObserver is the only
  // way to see it.
  useEffect(() => {
    const el = tabRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width !== undefined) {
        setNarrow(width < NARROW_TAB_BADGE_THRESHOLD_PX);
        setTight(width < TIGHT_TAB_THRESHOLD_PX);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The callback-ref form (rather than plain useRef + a mount effect) runs
  // during React's commit phase, before the browser paints — measuring here
  // and calling setNarrow/setTight synchronously avoids a one-frame flash of
  // the badge/logo on tabs that mount already narrower than either
  // threshold. The ResizeObserver above still owns every resize after mount.
  // Wrapped in useCallback (rather than a plain inline function) so React
  // doesn't treat it as a new ref on every re-render — session status
  // updates re-render this component frequently, and an unmemoized ref
  // callback would detach/reattach (and re-measure) on each one.
  const setTabRef = useCallback((el: HTMLDivElement | null) => {
    tabRef.current = el;
    if (!el) return;
    const width = el.getBoundingClientRect().width;
    if (width < NARROW_TAB_BADGE_THRESHOLD_PX) setNarrow(true);
    if (width < TIGHT_TAB_THRESHOLD_PX) setTight(true);
  }, []);

  // Sync the dockview tab title when the store's session name changes
  // (e.g. from a sidebar rename). The tab's own commitRename (below) calls
  // setTitle() before renameSession(), so by the time this effect fires the
  // titles already match and the guard below is a no-op for the tab-rename
  // path — only external renames (sidebar, API) trigger the actual sync.
  useEffect(() => {
    if (session?.nameLocked && session?.name && props.api.title !== session.name) {
      props.api.setTitle(session.name);
    }
  }, [session?.name, session?.nameLocked, props.api]);

  // Issue #168 — tracks whether this tab is dockview's currently active one.
  // The `useState(props.api.isActive)` initializer (only ever read on this
  // component's very first render) is what makes an already-active tab at
  // mount — e.g. the default tab on first load — read correctly without
  // waiting for a transition; the effect below only needs to subscribe for
  // *changes* after that, not re-assert the mount-time value (doing so
  // synchronously in the effect body is a redundant, lint-flagged extra
  // render). Deliberately its own effect/state (not folded into the
  // mark-seen effect below): this subscription must NOT depend on `events`
  // (it would re-subscribe on every new event), but marking seen DOES need
  // to re-run on every new event while active — see that effect's own
  // comment.
  const [isActive, setIsActive] = useState(props.api.isActive);
  useEffect(() => {
    const disposable = props.api.onDidActiveChange((e) => setIsActive(e.isActive));
    return () => disposable.dispose();
  }, [sessionId, props.api]);

  // Clears the unread badge by advancing the read cursor (store.ts's
  // markEventSeen, which updates the local lastSeenSeq and sends the "seen"
  // WS message) whenever this tab is active — re-runs on every new `events`
  // arrival too, not just the activation transition above, so a
  // notification that arrives *while* the tab is already the one on screen
  // doesn't linger on it until the user clicks away and back.
  useEffect(() => {
    if (!isActive) return;
    if (!events || events.length === 0) return;
    // addEvent (store.ts) keeps each session's list sorted ascending by seq,
    // so the last entry is always the highest.
    const maxSeq = events[events.length - 1].seq;
    useDashboardStore.getState().markEventSeen(sessionId, maxSeq);
  }, [isActive, events, sessionId]);

  // #98 item 6 — a brief stronger "just fired" burst on the false->true
  // attention transition (see JUST_FIRED_ATTENTION_MS), settling into the
  // steady-state cmuxRingHeader pulse. Tracked via a ref (not derived from
  // `session.sessionStatusAttentionRequired` directly) so a session that's
  // *already* attention-requiring on mount/reload doesn't replay the burst —
  // only a real transition this component observes does. Rich statuses
  // (issue: extend surfaced session statuses) — tracks the broader
  // `sessionStatusAttentionRequired` derived flag, not the old byte-
  // heuristic `attention` boolean alone, so the burst plays for every
  // status this tab now rings for (permission/plan/error/finished/etc.),
  // not just the ones the old boolean covered.
  // Lazily seeded from whatever it already is at mount (not hardcoded
  // false) — a session that's already attention-requiring on first render
  // (e.g. reopening the dashboard) must read as "no transition observed",
  // not a false->true one.
  const wasAttentionRef = useRef(session?.sessionStatusAttentionRequired === true);
  const [justFired, setJustFired] = useState(false);
  const justFiredTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const isAttention = session?.sessionStatusAttentionRequired === true;
    if (isAttention && !wasAttentionRef.current) {
      setJustFired(true);
      if (justFiredTimer.current) clearTimeout(justFiredTimer.current);
      justFiredTimer.current = setTimeout(() => setJustFired(false), JUST_FIRED_ATTENTION_MS);
    }
    wasAttentionRef.current = isAttention;
  }, [session?.sessionStatusAttentionRequired]);
  useEffect(
    () => () => {
      if (justFiredTimer.current) clearTimeout(justFiredTimer.current);
    },
    [],
  );

  const commitRename = () => {
    const value = draftName.trim();
    setRenaming(false);
    if (!value || !session) return;
    props.api.setTitle(value);
    void renameSession(session.id, value);
  };

  // Both the tab title's double-click and PaneActionsMenu's "Rename" item
  // trigger this identical inline-swap — see PaneActionsMenu's own comment
  // on why the actual rename UI stays here rather than moving with the menu.
  const beginRename = () => {
    setDraftName(props.api.title ?? "");
    setRenaming(true);
  };

  // Status badge — rich statuses (issue: extend surfaced session statuses):
  // one lookup into the shared presentation table (sessionStatus.ts) instead
  // of a re-implemented precedence chain — see that file's own header
  // comment. `killed` is the one case that stays a raw-field check: it's a
  // DB-intent distinction (explicit user kill vs. the program exiting on its
  // own) sessionStatus's derivation deliberately collapses into one
  // "exited" status (see session-status.ts's own doc comment for why), but
  // this tab still wants killed's own red-X treatment, same as before. A
  // session this process hasn't tracked yet (e.g. right after a fresh page
  // load, before the first live-refresh tick) just shows no dot rather than
  // guessing.
  let dot = null;
  let badge = null;
  let ringClass = "";
  if (session) {
    if (session.status === "killed") {
      dot = <CloseIcon size={10} className="pane-tab-dot-exited" style={{ color: "var(--r)" }} />;
    } else {
      const presentation = STATUS_PRESENTATION[session.sessionStatus];
      const label = formatStatusLabel(presentation, session.sessionStatusDetail);
      if (session.sessionStatus === "exited") {
        dot = <CloseIcon size={10} className="pane-tab-dot-exited" />;
        badge = <span className="pane-tab-badge exited">{label}</span>;
      } else if (session.sessionStatusAttentionRequired) {
        dot = (
          <span
            className="pane-tab-dot-working"
            style={{ background: `var(${presentation.colorToken})` }}
          />
        );
        badge = <span className={`pane-tab-badge ${presentation.tone}`}>{label}</span>;
        // attention-just-fired (see the effect above) briefly overrides
        // attention-ring's own `animation`, so both classes are applied
        // together and the CSS itself decides which animation plays.
        ringClass = ` attention-ring${justFired ? " attention-just-fired" : ""}`;
      } else if (presentation.tone === "working") {
        dot = <span className="pane-tab-dot-working" />;
        badge = <span className="pane-tab-badge working">{label}</span>;
      } else {
        dot = <span className="pane-tab-dot-idle" />;
        badge = <span className="pane-tab-badge idle">{label}</span>;
      }
    }
  }

  return (
    <div
      ref={setTabRef}
      className={`pane-tab${ringClass}${groupHasAttention ? " pane-tab-group-attention" : ""}${highlightFlash ? " highlight-flash" : ""}`}
    >
      {dot}
      {!tight && agentLogo && (
        <img src={agentLogo} alt="" width={14} height={14} className="pane-tab-agent-logo" />
      )}
      {renaming ? (
        <input
          ref={renameInputRef}
          className="pane-tab-rename-input"
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            else if (e.key === "Escape") setRenaming(false);
          }}
          onBlur={commitRename}
        />
      ) : (
        <span className="pane-tab-name" title="Double-click to rename" onDoubleClick={beginRename}>
          {props.api.title}
        </span>
      )}
      {!narrow && branchLabel && <span className="pane-tab-branch">{branchLabel}</span>}
      {!narrow && badge}
      {unreadCount > 0 && unreadIconKind && (
        <span
          className={`pane-tab-unread-badge ${unreadIconKind}${tight ? " compact" : ""}`}
          title={`${unreadCount} unread ${unreadIconKind === "attention" ? "attention " : ""}notification${unreadCount === 1 ? "" : "s"}`}
        >
          {unreadIconKind === "attention" ? <BellIcon size={9} /> : <CheckIcon size={9} />}
          {/* Issue: narrow headers overflow — this badge (unlike the branch
              label/status badge above) was never gated by `narrow` at all,
              so it stayed at full pill width (icon + count digits) all the
              way down to .dv-tab's own min-width. Below TIGHT_TAB_
              THRESHOLD_PX, drop the count text and let the `.compact`
              modifier (terminal.css) shrink the pill to a bare dot around
              the icon — the tooltip above still carries the actual count. */}
          {!tight && unreadCount}
        </span>
      )}
      <button
        className="pane-tab-btn"
        title="Close pane — detaches your view, session keeps running"
        aria-label="Close pane"
        onClick={() => props.api.close()}
      >
        <CloseIcon size={14} />
      </button>
      <PaneActionsMenu
        api={props.api}
        params={props.params}
        containerApi={props.containerApi}
        onRename={beginRename}
        triggerClassName="pane-tab-btn"
      />
    </div>
  );
}
