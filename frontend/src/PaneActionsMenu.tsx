import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { DockviewApi, DockviewPanelApi } from "dockview";
import type { TerminalPaneParams } from "./TerminalPane.js";
import { useDashboardStore } from "./store/index.js";
import {
  BellIcon,
  BellOffIcon,
  GitBranchIcon,
  GridIcon,
  KillIcon,
  ListIcon,
  MoveIcon,
  OverflowIcon,
  RenameIcon,
  BotIcon,
  SplitDownIcon,
  SplitRightIcon,
} from "./ui/icons.js";
import {
  openTimelinePanel,
  openBrowserPanePanel,
  openOrFocusSessionPanel,
  resetTiledGroupWidths,
  canResetTiledGroupWidths,
} from "./panelUtils.js";
import { liveChildCount } from "./sidebarHierarchy.js";
import { PromoteDialog } from "./PromoteDialog.js";
import { useFocusTrap } from "./hooks/useFocusTrap.js";
import { useLayoutContext } from "./lib/layoutTier.js";

// Mobile UI/UX overhaul, item A.4 (see .claude/plans/we-need-to-work-
// iterative-planet.md) — the kill/rename/timeline/browser/promote overflow
// menu, extracted out of PaneTab.tsx so App.tsx's mobile pane bar can reach
// the same actions dockview's own tab strip offers, instead of stranding
// them behind a header that's now hidden on phone (applyLayoutPresentation,
// panelUtils.ts). PaneTab.tsx keeps its own inline double-click-to-rename
// affordance and its own close (×) button — both are one-liners with no
// shared state — and renders this component for everything else.
//
// Deliberately takes `api`/`params` (what IDockviewPanelHeaderProps already
// hands PaneTab) rather than a resolved IDockviewPanel: DockviewPanelApi
// already exposes everything armOrKill/rename need (`close()`, `setTitle()`,
// `id`/`title`), so there's no reason to round-trip through
// `containerApi.getPanel()` to get a fuller handle. App.tsx's mobile bar
// passes `panel.api`/`panel.params` directly off its own `dockviewApi.panels`
// list — the same shape, no adapter needed.
const KILL_ARM_MS = 3000;
const KILL_ARM_SECONDS = KILL_ARM_MS / 1000;

// A right-anchored fixed menu positioned from the trigger button's own
// getBoundingClientRect() can run off the left edge on a narrow phone —
// PaneTab's desktop tab strip never got close enough to the viewport edge
// for this to matter, but the mobile bar's kebab, anchored near the bar's
// own left edge, can. The re-clamp effect below measures the menu's actual
// rendered width after mount rather than hardcoding it here (Hermes review,
// PR #613) — a hardcoded constant would silently drift out of sync with
// `.pane-tab-overflow-menu`'s CSS width the next time that changes.
const VIEWPORT_MARGIN_PX = 8;

export interface PaneActionsMenuProps {
  api: DockviewPanelApi;
  params: TerminalPaneParams | undefined;
  containerApi: DockviewApi;
  // PaneTab's double-click-on-title and this menu's "Rename" item have
  // always triggered the identical inline-swap (see PaneTab's own
  // renaming/draftName state) — kept that way by having the caller own the
  // actual rename affordance and this component just invoke it, rather than
  // duplicating a second rename UI here.
  onRename: () => void;
  // "pane-tab-btn" (desktop tab strip) vs the mobile bar's own trigger class
  // — both use the same OverflowIcon glyph, only the surrounding button
  // chrome differs by breakpoint.
  triggerClassName: string;
}

export function PaneActionsMenu({
  api,
  params,
  containerApi,
  onRename,
  triggerClassName,
}: PaneActionsMenuProps) {
  const sessionId = params?.sessionId;
  const session = useDashboardStore((s) => s.sessions.find((sess) => sess.id === sessionId));
  const deleteSession = useDashboardStore((s) => s.deleteSession);
  const theme = useDashboardStore((s) => s.theme);
  const confirmBeforeKill = useDashboardStore((s) => s.settings.sessions.confirmBeforeKill);
  // Phase 5 (Track B, issue #196 5.6) — against the stable `sessionId` prop
  // directly rather than gating on `session` being found first, since
  // sessionId never changes across a render where session hasn't loaded yet.
  const childCount = useDashboardStore((s) =>
    sessionId === undefined ? 0 : liveChildCount(s.sessions, sessionId),
  );
  const project = useDashboardStore((s) =>
    session ? s.projects.find((p) => p.id === session.projectId) : undefined,
  );
  const projects = useDashboardStore((s) => s.projects);
  const layout = useLayoutContext();
  // #719 — per-session mute toggle. `muted` is derived from the store's
  // mutedSessionIds (not a local state) so the menu item's label/icon reflect
  // the live state and the toolbar bell + tab badge stay in sync.
  const toggleSessionMute = useDashboardStore((s) => s.toggleSessionMute);
  const muted = useDashboardStore((s) =>
    sessionId === undefined ? false : s.mutedSessionIds.includes(sessionId),
  );
  // Issue: narrow headers overflow — PaneHeaderActions.tsx's own
  // split-right/split-down buttons hide below a certain group width, and
  // this is where they're still reachable from once they do (same
  // `requestSplit(referencePanelId, direction)` store action, this tab's own
  // `api.id` as the reference panel rather than the group's active one).
  const requestSplit = useDashboardStore((s) => s.requestSplit);

  const [overflowOpen, setOverflowOpen] = useState(false);
  const [overflowPos, setOverflowPos] = useState<{ top: number; right: number } | null>(null);
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [killArmed, setKillArmed] = useState(false);
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
  const overflowBtnRef = useRef<HTMLButtonElement>(null);
  const overflowMenuRef = useRef<HTMLDivElement>(null);

  useEffect(
    () => () => {
      if (armTimer.current) clearInterval(armTimer.current);
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
      // P11 — a plain mousedown's default action shifts focus to whatever
      // was clicked (or document.body, for a non-focusable target); without
      // suppressing it, that default focus shift wins the race against
      // useFocusTrap's own restore-on-close cleanup (triggered by
      // setOverflowOpen(false) below), leaving focus on <body> instead of
      // back on the toggle button.
      e.preventDefault();
      setOverflowOpen(false);
    };
    document.addEventListener("mousedown", onOutsideClick);
    return () => document.removeEventListener("mousedown", onOutsideClick);
  }, [overflowOpen]);

  // P11 — same shared hook as Settings/CommandPalette/NotificationBell/the
  // original PaneTab menu. No `aria-modal`: there's no backdrop and the rest
  // of whatever hosts this trigger stays fully interactive while open.
  const { onKeyDown: onTrapKeyDown, suppressRestore } = useFocusTrap({
    active: overflowOpen,
    containerRef: overflowMenuRef,
  });
  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      setOverflowOpen(false);
      return;
    }
    // APG menu pattern — ArrowUp/ArrowDown (and Home/End) move focus among
    // `role="menuitem"` children; the shared hook's Tab-trap alone doesn't
    // provide that (Tab/Shift+Tab still work as the fallback a non-menu-
    // savvy keyboard user relies on — this is additive, not a replacement).
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
      const items = overflowMenuRef.current
        ? Array.from(
            overflowMenuRef.current.querySelectorAll<HTMLElement>(
              '[role="menuitem"]:not([disabled])',
            ),
          )
        : [];
      if (items.length === 0) return;
      e.preventDefault();
      const currentIndex = items.indexOf(document.activeElement as HTMLElement);
      const nextIndex =
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? items.length - 1
            : e.key === "ArrowDown"
              ? currentIndex < 0
                ? 0
                : (currentIndex + 1) % items.length
              : currentIndex < 0
                ? items.length - 1
                : (currentIndex - 1 + items.length) % items.length;
      items[nextIndex]?.focus();
      return;
    }
    onTrapKeyDown(e);
  };
  // Every menu item action below already closes the menu by ALSO doing
  // something else (rename, opening a timeline/browser panel, opening the
  // promote dialog, or killing the session) — same "closing by opening
  // something else must not fight the restore-on-close effect" reasoning as
  // CommandPalette's closeAfterAction. `armOrKill`'s FIRST click (arming,
  // not killing) is the one path that closes nothing, so it's excluded — see
  // its own call site below.
  const closeMenuAfterAction = (action: () => void) => {
    suppressRestore();
    setOverflowOpen(false);
    action();
  };

  const armOrKill = () => {
    if (!session) return;
    // Settings -> Session management's "Confirm before kill" toggle — off
    // means the first click kills immediately, skipping the arm step below.
    // Phase 5 (Track B, issue #196 5.6) — except when this session has live
    // children: ending it always defaults to detach (never a silent
    // cascade-kill — see killSession), but that consequence still needs an
    // explicit confirm even with the global setting off.
    if (killArmed || (!confirmBeforeKill && childCount === 0)) {
      if (armTimer.current) clearInterval(armTimer.current);
      setKillArmed(false);
      // api.close() below tears down this whole pane — nothing left to
      // restore focus to on this side, and the trap's own restore would
      // otherwise try to focus the (about-to-be-removed) overflow toggle
      // button right as dockview tears down the pane around it.
      suppressRestore();
      setOverflowOpen(false);
      api.close();
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

  const openMenu = useCallback(() => {
    const btn = overflowBtnRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    // Anchored to the trigger button's own right edge — correct whenever the
    // menu fits; the layout effect below nudges this inward on the rare
    // narrow-viewport case where it doesn't.
    setOverflowPos({
      top: rect.bottom + 4,
      right: Math.max(window.innerWidth - rect.right, VIEWPORT_MARGIN_PX),
    });
    setOverflowOpen(true);
  }, []);

  // Hermes review, PR #613 — re-clamps against the menu's real rendered
  // width instead of a hardcoded constant. useLayoutEffect (not useEffect)
  // so a correction lands before the browser paints — no visible flash of
  // the menu at its wrong position first. Only nudges `right` when the
  // menu's own left edge has actually run past the viewport; a menu that
  // already fits (the common case) is left untouched.
  useLayoutEffect(() => {
    if (!overflowOpen) return;
    const menu = overflowMenuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    if (rect.left >= VIEWPORT_MARGIN_PX) return;
    const overflowBy = VIEWPORT_MARGIN_PX - rect.left;
    setOverflowPos((pos) => (pos ? { ...pos, right: pos.right + overflowBy } : pos));
  }, [overflowOpen]);

  // Read fresh on every open, not memoized — dockview's own group layout is
  // live state this component doesn't own, so a value computed once and
  // cached could disable/enable the "Reset pane sizes" item below against a
  // layout that's since changed underneath it. Skipped while the menu is
  // closed since it's only ever read from the (conditionally rendered) menu
  // content — `canResetTiledGroupWidths` is cheap and pure either way, but
  // there's no reason to call it on every render of the trigger button.
  const canReset = overflowOpen && canResetTiledGroupWidths(containerApi);

  return (
    <>
      <button
        ref={overflowBtnRef}
        className={triggerClassName}
        title="More…"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={overflowOpen}
        onClick={() => {
          if (overflowOpen) setOverflowOpen(false);
          else openMenu();
        }}
      >
        <OverflowIcon size={16} />
      </button>
      {overflowOpen &&
        overflowPos &&
        createPortal(
          <div
            ref={overflowMenuRef}
            // Portaled to document.body (see the comment above the outside-
            // click effect), which escapes the .cmux-root/.light element in
            // App.tsx where every --chrome/--border/--fg/etc. custom
            // property is actually defined — without reapplying those
            // classes here, var(--chrome) etc. resolve to nothing and the
            // menu renders with a transparent background instead of falling
            // back to the theme.
            className={`cmux-root${theme === "light" ? " light" : ""} pane-tab-overflow-menu`}
            style={{ position: "fixed", top: overflowPos.top, right: overflowPos.right }}
            role="menu"
            aria-label={`${api.title ?? "Pane"} actions`}
            onKeyDown={onMenuKeyDown}
          >
            {/* Hermes review, PR #613 — gated on `session`, not rendered
                unconditionally like "Move" below. On desktop this component
                only ever mounted for terminal panels (PaneTab.tsx's
                tabComponents mapping), so `session` was always present and
                this never mattered; App.tsx's mobile bar now renders this
                menu for every panel type, including timeline/Agent-Browser/
                task-detail panels whose params carry no plain `sessionId`
                (timeline's is `sessionIds`, plural). Ungated, Rename opened
                an input whose commit silently discarded the typed name
                (commitMobileRename's own `sessionId === undefined` guard),
                and Kill was a no-op button that looked destructive but did
                nothing (armOrKill's `if (!session) return`). Keyed on the
                `session` store lookup, not the stable `sessionId` prop
                childCount above deliberately uses — intentional: a pane
                restored before its session row lands in the store briefly
                renders without Rename/Kill, which is the correct fail-safe
                direction (matches the non-terminal-panel case above) rather
                than offering actions against a session that doesn't exist
                in the store yet. */}
            {session && (
              <button
                className="pane-tab-overflow-item"
                role="menuitem"
                onClick={() => closeMenuAfterAction(onRename)}
              >
                <RenameIcon size={14} style={{ color: "var(--muted)" }} />
                <span style={{ flex: 1 }}>Rename</span>
                <span className="pane-tab-overflow-hint">↵</span>
              </button>
            )}
            {/* Issue: narrow headers overflow — PaneHeaderActions.tsx's
                header-level split buttons hide once their group gets too
                narrow; this is the fallback entry point for a TERMINAL
                pane that's cramped enough to need it (independent code
                review, PR #709 — this menu only ever renders for terminal
                panels, tabComponents in panels/registry.tsx, so a narrow
                group made up of non-terminal panels — github/git/timeline/
                browser — has no such fallback once its header buttons
                hide; that's a pre-existing gap in this menu's own
                coverage, not something this change introduces or closes).
                Gated on `session`, same as Rename above: splitting is
                meaningless for a pane whose session hasn't loaded yet.
                Reference panel is THIS tab's own `api.id`, not the group's
                active one — this menu is opened from a specific tab, so
                split acts relative to that tab regardless of which one in
                the group happens to be active. */}
            {session && (
              <button
                className="pane-tab-overflow-item"
                role="menuitem"
                onClick={() => closeMenuAfterAction(() => requestSplit(api.id, "right"))}
              >
                <SplitRightIcon size={14} style={{ color: "var(--muted)" }} />
                <span style={{ flex: 1 }}>Split right</span>
              </button>
            )}
            {session && (
              <button
                className="pane-tab-overflow-item"
                role="menuitem"
                onClick={() => closeMenuAfterAction(() => requestSplit(api.id, "below"))}
              >
                <SplitDownIcon size={14} style={{ color: "var(--muted)" }} />
                <span style={{ flex: 1 }}>Split down</span>
              </button>
            )}
            <button
              className="pane-tab-overflow-item"
              role="menuitem"
              disabled
              title="Drag the tab to move it between panes/workspaces"
            >
              <MoveIcon size={14} style={{ color: "var(--muted)" }} />
              <span style={{ flex: 1 }}>Move (drag tab)</span>
            </button>
            {/* Manual repair for the fold/unfold pane-skew bug
                (snapshotTiledGroupWidths/restoreTiledGroupWidths's own header
                comment in panelUtils.ts) — dockview's own maximize/exit cache
                can freeze a tiled group at its 100px minimum, which the fix
                itself now prevents going forward but can't retroactively
                repair a workspace that was already skewed before it shipped.
                No `session` gate — this acts on the whole tiled grid, not
                this pane specifically, so it's offered from every panel type
                (including non-terminal ones), same as it's a layout action
                rather than a session one.

                Disabled (not just a silent no-op click) whenever
                resetTiledGroupWidths itself has nothing eligible to
                redistribute — fewer than two tiled groups, or a multi-row
                grid the same-row heuristic rejects — same
                disabled+explanatory-title pattern as "Move (drag tab)"
                above, rather than leaving a user-invoked "repair my layout"
                action clickable with no way to tell whether it did
                anything. `canReset` (computed above, once, only while the
                menu is open) rather than re-deriving it here twice. */}
            <button
              className="pane-tab-overflow-item"
              role="menuitem"
              disabled={!canReset}
              title={canReset ? undefined : "No skewed row of tiled panes to reset"}
              onClick={() => closeMenuAfterAction(() => resetTiledGroupWidths(containerApi))}
            >
              <GridIcon size={14} style={{ color: "var(--muted)" }} />
              <span style={{ flex: 1 }}>Reset pane sizes</span>
            </button>
            {session && (
              <button
                className="pane-tab-overflow-item"
                role="menuitem"
                onClick={() => {
                  closeMenuAfterAction(() => openTimelinePanel(containerApi, session, layout));
                }}
              >
                <ListIcon size={14} style={{ color: "var(--muted)" }} />
                <span style={{ flex: 1 }}>View timeline</span>
              </button>
            )}
            {session && (
              <button
                className="pane-tab-overflow-item"
                role="menuitem"
                onClick={() => {
                  closeMenuAfterAction(() => openBrowserPanePanel(containerApi, session, layout));
                }}
              >
                <BotIcon size={14} style={{ color: "var(--muted)" }} />
                <span style={{ flex: 1 }}>Open Agent Browser</span>
              </button>
            )}
            {session && project && (
              <button
                className="pane-tab-overflow-item"
                role="menuitem"
                onClick={() => {
                  closeMenuAfterAction(() => setPromoteOpen(true));
                }}
              >
                <GitBranchIcon size={14} style={{ color: "var(--muted)" }} />
                <span style={{ flex: 1 }}>Promote to worktree…</span>
              </button>
            )}
            {session && <div className="pane-tab-overflow-divider" />}
            {session && (
              <button
                className="pane-tab-overflow-item"
                role="menuitem"
                onClick={() => closeMenuAfterAction(() => toggleSessionMute(session.id))}
                title={
                  muted
                    ? "Notifications for this session are muted — click to unmute"
                    : "Silence notifications for this session (OS popup, sound, and unread badge)"
                }
              >
                {muted ? (
                  <BellIcon size={14} style={{ color: "var(--muted)" }} />
                ) : (
                  <BellOffIcon size={14} style={{ color: "var(--muted)" }} />
                )}
                <span style={{ flex: 1 }}>
                  {muted ? "Unmute notifications" : "Mute notifications"}
                </span>
              </button>
            )}
            {session && (
              <button
                className={`pane-tab-overflow-item danger${killArmed ? " armed" : ""}`}
                role="menuitem"
                onClick={armOrKill}
                title={
                  childCount > 0
                    ? `${childCount} running child session${childCount === 1 ? "" : "s"} will keep running independently`
                    : undefined
                }
              >
                <KillIcon size={14} />
                <span style={{ flex: 1 }}>
                  {killArmed
                    ? "Click again to kill"
                    : childCount > 0
                      ? `Kill session (${childCount} child${childCount === 1 ? "" : "ren"} will detach)`
                      : "Kill session"}
                </span>
                {killArmed && (
                  <span className="pane-tab-overflow-hint" style={{ color: "var(--o)" }}>
                    {killSecondsLeft}s
                  </span>
                )}
              </button>
            )}
          </div>,
          document.body,
        )}
      {promoteOpen && session && project && (
        <PromoteDialog
          session={session}
          project={project}
          onClose={() => setPromoteOpen(false)}
          onPromoted={(newSession) => {
            // This pane's own session is the one that just got killed by
            // promote — close it, then open/focus the replacement, so the
            // pane visibly hands off rather than just going dead.
            api.close();
            openOrFocusSessionPanel(containerApi, newSession, layout, projects);
          }}
        />
      )}
    </>
  );
}
