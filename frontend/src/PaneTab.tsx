import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { IDockviewPanel, IDockviewPanelHeaderProps } from "dockview-react";
import type { TerminalPaneParams } from "./TerminalPane.js";
import { eventKey, useDashboardStore } from "./store.js";
import { resolveAgentLogo } from "./cliLogos.js";
import { formatBranchLabel } from "./paneTitle.js";
import {
  BellIcon,
  CheckIcon,
  CloseIcon,
  KillIcon,
  MoveIcon,
  OverflowIcon,
  RenameIcon,
} from "./icons.js";
import { notifyKind } from "./eventDescriptions.js";

// The one distinction the design's States doc (section 1) stresses above
// everything else: closing a pane only detaches the browser's view — the
// session keeps running on the host — while killing ends the actual
// program and is not reversible. They must never look like the same
// action: close is a plain × always visible on the tab; kill lives inside
// the overflow menu, and is armed by a first click before a second click
// actually fires it (matching the design's 3s arm window), so it can't
// happen by reflex the way a single-click × could.
const KILL_ARM_MS = 3000;
const KILL_ARM_SECONDS = KILL_ARM_MS / 1000;

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

// How long the stronger "just fired" burst (issue #98 item 6) plays before
// settling into the steady-state cmuxRing pulse — long enough to catch the
// eye on an unwatched dashboard, short enough not to nag once it has.
const JUST_FIRED_ATTENTION_MS = 1800;

// notifyKind (which of a session's buffered NotificationEvents count
// toward its unread badge) moved to eventDescriptions.ts for #169, which
// needed the identical classification for the notification panel's own
// unread count — see that module's own doc comment.

// A dockview panel's `params` is untyped (Parameters = Record<string,
// unknown> | undefined) from the group's point of view — this tab only
// knows its OWN params are TerminalPaneParams (see props.params above); a
// sibling panel in the same group could in principle be a GitHubPanel/
// GitPanel/BrowserPanel with no sessionId at all, so this must guard rather
// than assume.
function panelSessionId(panel: IDockviewPanel): number | undefined {
  const id = panel.params?.sessionId;
  return typeof id === "number" ? id : undefined;
}

export function PaneTab(props: IDockviewPanelHeaderProps<TerminalPaneParams>) {
  const sessionId = props.params.sessionId;
  const session = useDashboardStore((s) => s.sessions.find((sess) => sess.id === sessionId));
  const renameSession = useDashboardStore((s) => s.renameSession);
  const deleteSession = useDashboardStore((s) => s.deleteSession);
  const theme = useDashboardStore((s) => s.theme);
  const agentLogo = session ? resolveAgentLogo(session.command, theme) : null;
  const confirmBeforeKill = useDashboardStore((s) => s.settings.sessions.confirmBeforeKill);
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
  // Full session list (not just this tab's own `session` above) — needed to
  // check sibling panels' attention state for the #98 group-accent
  // underline below, since that's a property of *other* sessions this tab
  // doesn't otherwise subscribe to.
  const sessions = useDashboardStore((s) => s.sessions);
  // Branch sub-label (issue #96) — the project's always-on currentBranch
  // (rides along on GET /api/projects, see api.ts's Project type) plus a
  // dirty ("*") marker sourced from the separately-polled gitStatuses map
  // (issue #76's fuller `git status`).
  const project = useDashboardStore((s) =>
    session ? s.projects.find((p) => p.id === session.projectId) : undefined,
  );
  const gitStatus = useDashboardStore((s) => (session ? s.gitStatuses[session.projectId] : null));
  const branchLabel = project
    ? formatBranchLabel(project.currentBranch, gitStatus ? !gitStatus.isClean : false)
    : null;

  // Unread notification-worthy events (see notifyKind above) newer than the
  // read cursor. Bell wins over check when both are present — attention is
  // the higher-priority signal (matches PaneTab's own status-badge
  // priority further below).
  const unreadKinds = (events ?? [])
    .filter((e) => e.seq > lastSeenSeq && !dismissedEventKeys[eventKey(sessionId, e.seq)])
    .map(notifyKind)
    .filter((k): k is "attention" | "exited" => k !== null);
  const unreadCount = unreadKinds.length;
  const unreadIconKind = unreadKinds.includes("attention")
    ? "attention"
    : unreadCount > 0
      ? "exited"
      : null;

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
  // whichever tab in that group you're looking at gets the cue.
  const groupHasAttention = props.api.group.panels.some((panel) => {
    const sid = panelSessionId(panel);
    return sid !== undefined && sessions.some((s) => s.id === sid && s.attention);
  });

  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(props.api.title ?? "");
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [overflowPos, setOverflowPos] = useState<{ top: number; right: number } | null>(null);
  const [killArmed, setKillArmed] = useState(false);
  const [narrow, setNarrow] = useState(false);
  // Ticks 3 -> 2 -> 1 in the "3s"-style hint below rather than sitting
  // static for the whole arm window — matches KebabMenu's countdown.
  const [killSecondsLeft, setKillSecondsLeft] = useState(KILL_ARM_SECONDS);
  // Mirrors killSecondsLeft so the interval callback below can branch on the
  // current count without reaching into a setState updater — calling
  // setKillArmed/clearInterval (side effects) from inside a
  // setKillSecondsLeft updater function is impure and can warn under
  // StrictMode.
  const killSecondsRef = useRef(KILL_ARM_SECONDS);
  const armTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const overflowBtnRef = useRef<HTMLButtonElement>(null);
  const overflowMenuRef = useRef<HTMLDivElement>(null);
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
      if (width !== undefined) setNarrow(width < NARROW_TAB_BADGE_THRESHOLD_PX);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The callback-ref form (rather than plain useRef + a mount effect) runs
  // during React's commit phase, before the browser paints — measuring here
  // and calling setNarrow synchronously avoids a one-frame flash of the badge
  // on tabs that mount already narrower than the threshold. The ResizeObserver
  // above still owns every resize after mount. Wrapped in useCallback (rather
  // than a plain inline function) so React doesn't treat it as a new ref on
  // every re-render — session status updates re-render this component
  // frequently, and an unmemoized ref callback would detach/reattach (and
  // re-measure) on each one.
  const setTabRef = useCallback((el: HTMLDivElement | null) => {
    tabRef.current = el;
    if (el && el.getBoundingClientRect().width < NARROW_TAB_BADGE_THRESHOLD_PX) {
      setNarrow(true);
    }
  }, []);

  useEffect(
    () => () => {
      if (armTimer.current) clearInterval(armTimer.current);
    },
    [],
  );

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
  // steady-state cmuxRing pulse. Tracked via a ref (not derived from
  // `session.attention` directly) so a session that's *already* in
  // attention on mount/reload doesn't replay the burst — only a real
  // transition this component observes does.
  // Lazily seeded from whatever session.attention already is at mount (not
  // hardcoded false) — a session that's already in attention on first
  // render (e.g. reopening the dashboard) must read as "no transition
  // observed", not a false->true one.
  const wasAttentionRef = useRef(session?.attention === true);
  const [justFired, setJustFired] = useState(false);
  const justFiredTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const isAttention = session?.attention === true;
    if (isAttention && !wasAttentionRef.current) {
      setJustFired(true);
      if (justFiredTimer.current) clearTimeout(justFiredTimer.current);
      justFiredTimer.current = setTimeout(() => setJustFired(false), JUST_FIRED_ATTENTION_MS);
    }
    wasAttentionRef.current = isAttention;
  }, [session?.attention]);
  useEffect(
    () => () => {
      if (justFiredTimer.current) clearTimeout(justFiredTimer.current);
    },
    [],
  );

  // Dockview's own tab-strip container clips overflowing content (confirmed
  // live: the menu rendered in the DOM but was invisible, clipped by an
  // ancestor's `overflow: hidden`) — portaled to document.body with
  // position:fixed computed from the toggle button's own rect sidesteps
  // that entirely, rather than fighting dockview's internal stacking
  // context.
  useEffect(() => {
    if (!overflowOpen) return;
    const onOutsideClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (overflowBtnRef.current?.contains(target)) return;
      if (overflowMenuRef.current?.contains(target)) return;
      setOverflowOpen(false);
    };
    document.addEventListener("mousedown", onOutsideClick);
    return () => document.removeEventListener("mousedown", onOutsideClick);
  }, [overflowOpen]);

  const commitRename = () => {
    const value = draftName.trim();
    setRenaming(false);
    if (!value || !session) return;
    props.api.setTitle(value);
    void renameSession(session.id, value);
  };

  const armOrKill = () => {
    if (!session) return;
    // Settings -> Session management's "Confirm before kill" toggle — off
    // means the first click kills immediately, skipping the arm step below.
    if (killArmed || !confirmBeforeKill) {
      if (armTimer.current) clearInterval(armTimer.current);
      setKillArmed(false);
      setOverflowOpen(false);
      props.api.close();
      void deleteSession(session.id).catch((err) => {
        console.error("Failed to kill session", session.id, err);
      });
    } else {
      setKillArmed(true);
      killSecondsRef.current = KILL_ARM_SECONDS;
      setKillSecondsLeft(KILL_ARM_SECONDS);
      if (armTimer.current) clearInterval(armTimer.current);
      armTimer.current = setInterval(() => {
        killSecondsRef.current -= 1;
        if (killSecondsRef.current <= 0) {
          if (armTimer.current) clearInterval(armTimer.current);
          setKillArmed(false);
          setKillSecondsLeft(KILL_ARM_SECONDS);
        } else {
          setKillSecondsLeft(killSecondsRef.current);
        }
      }, 1000);
    }
  };

  // Status badge — attention takes priority (highest-value signal), then
  // working/idle for a live session, then exited/killed once the program
  // has ended. A session this process hasn't tracked yet (e.g. right after
  // a fresh page load, before the first live-refresh tick) just shows no
  // dot rather than guessing.
  let dot = null;
  let badge = null;
  let ringClass = "";
  if (session) {
    if (session.status === "killed") {
      dot = <CloseIcon size={10} className="pane-tab-dot-exited" style={{ color: "var(--r)" }} />;
    } else if (session.status === "exited") {
      dot = <CloseIcon size={10} className="pane-tab-dot-exited" />;
      badge = <span className="pane-tab-badge exited">Exited</span>;
    } else if (session.attention) {
      dot = <span className="pane-tab-dot-working" style={{ background: "var(--ring)" }} />;
      badge = <span className="pane-tab-badge attention">Attention</span>;
      // attention-just-fired (see the effect above) briefly overrides
      // attention-ring's own `animation`, so both classes are applied
      // together and the CSS itself decides which animation plays.
      ringClass = ` attention-ring${justFired ? " attention-just-fired" : ""}`;
    } else if (session.activity === "working") {
      dot = <span className="pane-tab-dot-working" />;
      badge = <span className="pane-tab-badge working">Working</span>;
    } else {
      dot = <span className="pane-tab-dot-idle" />;
      badge = <span className="pane-tab-badge idle">Idle</span>;
    }
  }

  return (
    <div
      ref={setTabRef}
      className={`pane-tab${ringClass}${groupHasAttention ? " pane-tab-group-attention" : ""}`}
    >
      {dot}
      {agentLogo && (
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
        <span
          className="pane-tab-name"
          title="Double-click to rename"
          onDoubleClick={() => {
            setDraftName(props.api.title ?? "");
            setRenaming(true);
          }}
        >
          {props.api.title}
        </span>
      )}
      {!narrow && branchLabel && <span className="pane-tab-branch">{branchLabel}</span>}
      {!narrow && badge}
      {unreadCount > 0 && unreadIconKind && (
        <span
          className={`pane-tab-unread-badge ${unreadIconKind}`}
          title={`${unreadCount} unread ${unreadIconKind === "attention" ? "attention " : ""}notification${unreadCount === 1 ? "" : "s"}`}
        >
          {unreadIconKind === "attention" ? <BellIcon size={9} /> : <CheckIcon size={9} />}
          {unreadCount}
        </span>
      )}
      <button
        className="pane-tab-btn"
        title="Close pane — detaches your view, session keeps running"
        onClick={() => props.api.close()}
      >
        <CloseIcon size={14} />
      </button>
      <button
        ref={overflowBtnRef}
        className="pane-tab-btn"
        title="More…"
        onClick={() => {
          if (!overflowOpen && overflowBtnRef.current) {
            const rect = overflowBtnRef.current.getBoundingClientRect();
            setOverflowPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
          }
          setOverflowOpen((v) => !v);
        }}
      >
        <OverflowIcon size={16} />
      </button>
      {overflowOpen &&
        overflowPos &&
        createPortal(
          <div
            ref={overflowMenuRef}
            // Portaled to document.body (see the comment above the outside-click
            // effect), which escapes the .cmux-root/.light element in App.tsx
            // where every --chrome/--border/--fg/etc. custom property is actually
            // defined — without reapplying those classes here, var(--chrome) etc.
            // resolve to nothing and the menu renders with a transparent
            // background instead of falling back to the theme.
            className={`cmux-root${theme === "light" ? " light" : ""} pane-tab-overflow-menu`}
            style={{ position: "fixed", top: overflowPos.top, right: overflowPos.right }}
          >
            <button
              className="pane-tab-overflow-item"
              onClick={() => {
                setDraftName(props.api.title ?? "");
                setRenaming(true);
                setOverflowOpen(false);
              }}
            >
              <RenameIcon size={14} style={{ color: "var(--muted)" }} />
              <span style={{ flex: 1 }}>Rename</span>
              <span className="pane-tab-overflow-hint">↵</span>
            </button>
            <button
              className="pane-tab-overflow-item"
              disabled
              title="Drag the tab to move it between panes/workspaces"
            >
              <MoveIcon size={14} style={{ color: "var(--muted)" }} />
              <span style={{ flex: 1 }}>Move (drag tab)</span>
            </button>
            <div className="pane-tab-overflow-divider" />
            <button
              className={`pane-tab-overflow-item danger${killArmed ? " armed" : ""}`}
              onClick={armOrKill}
            >
              <KillIcon size={14} />
              <span style={{ flex: 1 }}>{killArmed ? "Click again to kill" : "Kill session"}</span>
              {killArmed && (
                <span className="pane-tab-overflow-hint" style={{ color: "var(--o)" }}>
                  {killSecondsLeft}s
                </span>
              )}
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}
