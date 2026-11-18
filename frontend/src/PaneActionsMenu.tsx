import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { DockviewApi, DockviewPanelApi } from "dockview";
import type { TerminalPaneParams } from "./TerminalPane.js";
import { useDashboardStore } from "./store/index.js";
import { themeClassName } from "./store/theme.js";
import {
  BellIcon,
  BellOffIcon,
  GitBranchIcon,
  GridIcon,
  KillIcon,
  ListIcon,
  OverflowIcon,
  RenameIcon,
  BotIcon,
  CloseIcon,
  SplitDownIcon,
  SplitRightIcon,
} from "./ui/icons.js";
import {
  openTimelinePanel,
  openBrowserPanePanel,
  openOrFocusSessionPanel,
  balanceSiblingsOf,
  canBalanceSiblingsOf,
  otherTiledGroups,
} from "./panelUtils.js";
import { liveChildCount } from "./sidebarHierarchy.js";
import { PromoteDialog } from "./PromoteDialog.js";
import { useFocusTrap } from "./hooks/useFocusTrap.js";
import { usePresence } from "./hooks/usePresence.js";
import { useVisualViewportChange, visibleViewport } from "./hooks/useVisualViewportChange.js";
import { agentBrowserIsRailView, useCurrentLayoutBand } from "./right-sidebar/viewBands.js";
import { useCoarsePointer, useLayoutContext, useLayoutPresentationMode } from "./lib/layoutTier.js";
import { isHeaderSplitHidden } from "./lib/paneHeaderSplit.js";
import { selectSessionTitleContexts } from "./lib/sessionDisplay.js";
import { BottomSheet } from "./ui/BottomSheet.js";
import { describeError } from "./lib/describeError.js";

// Mobile UI/UX overhaul, item A.4 (see .claude/plans/we-need-to-work-
// iterative-planet.md) — the kill/rename/timeline/browser/promote overflow
// menu, extracted out of PaneTab.tsx so the phone session switcher
// (MobileSessionBar.tsx) can reach
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
// `containerApi.getPanel()` to get a fuller handle. MobileSessionBar.tsx
// passes `panel.api`/`panel.params` directly off its own `dockviewApi.panels`
// list — the same shape, no adapter needed.
const KILL_ARM_MS = 3000;
const KILL_ARM_SECONDS = KILL_ARM_MS / 1000;

// A right-anchored fixed menu positioned from the trigger button's own
// getBoundingClientRect() can run off the left edge on a narrow phone —
// PaneTab's desktop tab strip never got close enough to the viewport edge
// for this to matter, but a kebab on a phone can. The re-clamp effect below measures the menu's actual
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
  // "pane-tab-btn" (desktop tab strip) vs the phone session sheet's class
  // — both use the same OverflowIcon glyph, only the surrounding button
  // chrome differs by breakpoint.
  triggerClassName: string;
  // #3053 — "Close pane" above Kill, for a surface with no "x" of its own
  // (a fold half's header). Detaches the view; the session keeps running.
  onClose?: () => void;
}

export function PaneActionsMenu({
  api,
  params,
  containerApi,
  onRename,
  triggerClassName,
  onClose,
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
  // #3214 — the two halves and the phone have no grid: no split, no moving
  // between panes, no reset of pane sizes. (The Agent Browser entry also follows the
  // band, below.)
  const hasGrid = useLayoutPresentationMode() === "grid";
  // #3370 — the agent's browser entry follows the band, as the palette does:
  // below 1100px it is a rail view (rails-full too, whose presentation is the
  // grid), so the menu offers no entry there.
  const layoutBand = useCurrentLayoutBand();
  const showAgentBrowser = hasGrid && !agentBrowserIsRailView(layoutBand);

  const [overflowOpen, setOverflowOpen] = useState(false);
  // #3054 — under a coarse pointer the menu is a bottom sheet (rows of 44px
  // and more, never clipped by the tab strip or the phone's session sheet);
  // under a fine pointer it stays the popover anchored to its trigger.
  const coarse = useCoarsePointer();
  const popoverOpen = overflowOpen && !coarse;
  // The sheet's own focus-restore suppressor (BottomSheet owns that trap).
  const sheetSuppressRestoreRef = useRef<(() => void) | null>(null);
  const [overflowPos, setOverflowPos] = useState<{ top: number; right: number } | null>(null);
  // Bumped by positionMenu() so the clamp/flip layout effect below re-runs
  // after a reposition (issue #1399), not only when the menu first opens.
  const [repositionTick, setRepositionTick] = useState(0);
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
    if (!popoverOpen) return;
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
  }, [popoverOpen]);

  // P11 — same shared hook as Settings/CommandPalette/NotificationBell/the
  // original PaneTab menu. No `aria-modal`: there's no backdrop and the rest
  // of whatever hosts this trigger stays fully interactive while open.
  const { onKeyDown: onTrapKeyDown, suppressRestore: suppressPopoverRestore } = useFocusTrap({
    active: popoverOpen,
    containerRef: overflowMenuRef,
  });
  const suppressRestore = () => {
    if (coarse) sheetSuppressRestoreRef.current?.();
    else suppressPopoverRestore();
  };
  // #3015 — stays mounted while it leaves (styles/motion.css plays the exit).
  const { present: overflowPresent, state: overflowPresence } = usePresence(
    popoverOpen,
    overflowMenuRef,
  );
  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      setOverflowOpen(false);
      return;
    }
    if (onMenuArrowKeys(e)) return;
    onTrapKeyDown(e);
  };
  // The sheet's menu: arrows only — BottomSheet owns Escape and the Tab trap.
  // Returns whether it handled the key.
  const onMenuArrowKeys = (e: ReactKeyboardEvent<HTMLDivElement>): boolean => {
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
      if (items.length === 0) return false;
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
      return true;
    }
    return false;
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
        // The pane is already closed by this point, so the ONLY place the
        // failure can surface is outside it — the console was the only
        // place it surfaced, which made a failed kill completely silent
        // (audit finding 11). The session is still running on the host;
        // the user has to know that.
        console.error("Failed to kill session", session.id, err);
        useDashboardStore.getState().reportError("Could not kill the session.", describeError(err));
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

  const positionMenu = useCallback(() => {
    const btn = overflowBtnRef.current;
    if (!btn) return false;
    const rect = btn.getBoundingClientRect();
    // Anchored to the trigger button's own right edge — correct whenever the
    // menu fits; the layout effect below nudges this inward on the rare
    // narrow-viewport case where it doesn't.
    setOverflowPos({
      top: rect.bottom + 4,
      right: Math.max(window.innerWidth - rect.right, VIEWPORT_MARGIN_PX),
    });
    setRepositionTick((t) => t + 1);
    return true;
  }, []);

  const openMenu = useCallback(() => {
    if (coarse || positionMenu()) setOverflowOpen(true);
  }, [coarse, positionMenu]);

  // Issue #1399 — since #1398 `.app` (and this trigger with it) moves with the
  // iOS visual viewport when it pans with the keyboard open; re-anchor the
  // portaled menu to the trigger's new rect rather than leaving it behind.
  useVisualViewportChange(popoverOpen, positionMenu);

  // Hermes review, PR #613 — re-clamps against the menu's real rendered
  // width instead of a hardcoded constant. useLayoutEffect (not useEffect)
  // so a correction lands before the browser paints — no visible flash of
  // the menu at its wrong position first. Only nudges `right` when the
  // menu's own left edge has actually run past the viewport; a menu that
  // already fits (the common case) is left untouched.
  useLayoutEffect(() => {
    if (!popoverOpen) return;
    const menu = overflowMenuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const visible = visibleViewport();
    const overflowBy = rect.left < VIEWPORT_MARGIN_PX ? VIEWPORT_MARGIN_PX - rect.left : 0;
    // A trigger near the bottom of the *visible* region (the phone session
    // sheet's active row, or a toolbar with the iOS keyboard open — issue
    // #1402) would drop the menu behind the keyboard. `innerHeight` does not
    // shrink then. Flip above the trigger, clamped to the visible top.
    let flippedTop: number | null = null;
    if (rect.bottom > visible.bottom - VIEWPORT_MARGIN_PX) {
      const trigger = overflowBtnRef.current?.getBoundingClientRect();
      if (trigger) {
        flippedTop = Math.max(visible.top + VIEWPORT_MARGIN_PX, trigger.top - 4 - rect.height);
      }
    }
    if (overflowBy === 0 && flippedTop === null) return;
    setOverflowPos((pos) =>
      pos ? { top: flippedTop ?? pos.top, right: pos.right + overflowBy } : pos,
    );
  }, [popoverOpen, repositionTick]);

  // Read fresh on every open, not memoized — dockview's own group layout is
  // live state this component doesn't own, so a value computed once and
  // cached could disable/enable the "Reset pane sizes" item below against a
  // layout that's since changed underneath it. Skipped while the menu is
  // closed since it's only ever read from the (conditionally rendered) menu
  // content — `canBalanceSiblingsOf` serializes the layout (`toJSON()`), so it
  // must not run on every render of the trigger button.
  // Where there is no grid the item is not rendered at all (`hasGrid` on it
  // below), so that is the one gate for #3214.
  const canReset = overflowOpen && !!api.group && canBalanceSiblingsOf(containerApi, api.group.id);
  // #3214 — Split right/down only while this pane's header is hiding its own
  // split buttons, by the header's own width measurement
  // (PaneHeaderActions.tsx publishes it per group in lib/paneHeaderSplit.ts),
  // read fresh on every open like `canReset`.
  const showSplit = overflowOpen && hasGrid && !!session && isHeaderSplitHidden(api.group?.id);

  // Tablet only: touch can't drag a tab between columns (the strip pans
  // instead — xterm.css), so offer the move as menu actions. Read fresh on
  // every open, like `canReset` above, since the group layout is live state.
  const ownGroup = api.group;
  const moveTargets =
    overflowOpen && hasGrid && layout.tier === "tablet" && ownGroup
      ? otherTiledGroups(containerApi, ownGroup)
      : [];
  const canSplitOut =
    overflowOpen &&
    hasGrid &&
    layout.tier === "tablet" &&
    !!ownGroup &&
    ownGroup.api.location.type === "grid" &&
    ownGroup.panels.length > 1;

  // The items, the same in the popover and in the sheet.
  const menuItems = (
    <>
      {/* Hermes review, PR #613 — gated on `session`, not rendered
            unconditionally like "Reset pane sizes" below. On desktop this component
            only ever mounted for terminal panels (PaneTab.tsx's
            tabComponents mapping), so `session` was always present and
            this never mattered; the phone session switcher now renders this
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
      {session?.model && (
        <div
          className="pane-tab-overflow-item"
          role="menuitem"
          aria-disabled="true"
          aria-label={`Model: ${session.model}`}
          style={{ opacity: 0.6, cursor: "default" }}
        >
          <BotIcon size={14} style={{ color: "var(--muted)" }} />
          <span style={{ flex: 1 }}>Model</span>
          <span className="pane-tab-overflow-hint">{session.model}</span>
        </div>
      )}
      {session?.smallModel && (
        <div
          className="pane-tab-overflow-item"
          role="menuitem"
          aria-disabled="true"
          aria-label={`Small model: ${session.smallModel}`}
          style={{ opacity: 0.45, cursor: "default" }}
        >
          <BotIcon size={14} style={{ color: "var(--muted)" }} />
          <span style={{ flex: 1 }}>Small model</span>
          <span className="pane-tab-overflow-hint">{session.smallModel}</span>
        </div>
      )}
      {/* Issue: narrow headers overflow — PaneHeaderActions.tsx's
            header-level split buttons hide once their group gets too
            narrow; these two are the fallback, listed only then
            (`showSplit`, #3214) so the menu does not repeat buttons the
            header already shows. Gated on `session`, same as Rename above.
            Reference panel is THIS tab's own `api.id`, not the group's
            active one — this menu is opened from a specific tab, so split
            acts relative to that tab regardless of which one in the group
            happens to be active. */}
      {showSplit && session && (
        <button
          className="pane-tab-overflow-item"
          role="menuitem"
          onClick={() =>
            closeMenuAfterAction(() => requestSplit(api.id, "right", session.projectId))
          }
        >
          <SplitRightIcon size={14} style={{ color: "var(--muted)" }} />
          <span style={{ flex: 1 }}>Split right</span>
        </button>
      )}
      {showSplit && session && (
        <button
          className="pane-tab-overflow-item"
          role="menuitem"
          onClick={() =>
            closeMenuAfterAction(() => requestSplit(api.id, "below", session.projectId))
          }
        >
          <SplitDownIcon size={14} style={{ color: "var(--muted)" }} />
          <span style={{ flex: 1 }}>Split down</span>
        </button>
      )}
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
            balanceSiblingsOf itself has nothing to balance — this
            pane has no siblings in its row or column, or the layout is
            maximized — aria-disabled with an explanatory title, rather
            than leaving a user-invoked "repair my layout" action
            clickable with no way to tell whether it did anything. `canReset` (computed above, once, only while the
            menu is open) rather than re-deriving it here twice.
            aria-disabled, not `disabled` (issue #1106) — a disabled
            button doesn't reliably carry the explanatory `title`, so
            the guard against firing when `!canReset` moves into the
            onClick handler itself instead. Not offered at all where there
            is no grid (#3214: the two halves and the phone). */}
      {moveTargets.map(({ group, number }) => (
        <button
          key={group.id}
          className="pane-tab-overflow-item"
          role="menuitem"
          onClick={() => closeMenuAfterAction(() => api.moveTo({ group }))}
        >
          <GridIcon size={14} style={{ color: "var(--muted)" }} />
          <span style={{ flex: 1 }}>
            {moveTargets.length === 1 ? "Move to other pane" : `Move to pane ${number}`}
          </span>
        </button>
      ))}
      {canSplitOut && ownGroup && (
        <button
          className="pane-tab-overflow-item"
          role="menuitem"
          onClick={() =>
            closeMenuAfterAction(() => api.moveTo({ group: ownGroup, position: "right" }))
          }
        >
          <GridIcon size={14} style={{ color: "var(--muted)" }} />
          <span style={{ flex: 1 }}>Move to new pane</span>
        </button>
      )}
      {hasGrid && (
        <button
          className="pane-tab-overflow-item"
          role="menuitem"
          aria-disabled={!canReset || undefined}
          title={canReset ? undefined : "No neighbouring panes in this row or column to balance"}
          onClick={() => {
            if (!canReset) return;
            const groupId = api.group?.id;
            if (groupId) closeMenuAfterAction(() => balanceSiblingsOf(containerApi, groupId));
          }}
        >
          <GridIcon size={14} style={{ color: "var(--muted)" }} />
          <span style={{ flex: 1 }}>Reset pane sizes</span>
        </button>
      )}
      {session && (
        <button
          className="pane-tab-overflow-item"
          role="menuitem"
          onClick={() => {
            closeMenuAfterAction(() =>
              openTimelinePanel(
                containerApi,
                session,
                layout,
                selectSessionTitleContexts(useDashboardStore.getState()).get(session.id),
              ),
            );
          }}
        >
          <ListIcon size={14} style={{ color: "var(--muted)" }} />
          <span style={{ flex: 1 }}>View timeline</span>
        </button>
      )}
      {/* #3214/#3370 — below 1100px the Agent Browser is the right rail's
            Browser view, which follows the active session. */}
      {session && showAgentBrowser && (
        <button
          className="pane-tab-overflow-item"
          role="menuitem"
          onClick={() => {
            closeMenuAfterAction(() =>
              openBrowserPanePanel(
                containerApi,
                session,
                layout,
                selectSessionTitleContexts(useDashboardStore.getState()).get(session.id),
              ),
            );
          }}
        >
          <BotIcon size={14} style={{ color: "var(--muted)" }} />
          <span style={{ flex: 1 }}>Open browser</span>
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
            <BellOffIcon size={14} style={{ color: "var(--muted)" }} />
          ) : (
            <BellIcon size={14} style={{ color: "var(--muted)" }} />
          )}
          <span style={{ flex: 1 }}>{muted ? "Unmute notifications" : "Mute notifications"}</span>
        </button>
      )}
      {onClose && (
        <button
          className="pane-tab-overflow-item"
          role="menuitem"
          onClick={() => closeMenuAfterAction(onClose)}
        >
          <CloseIcon size={14} style={{ color: "var(--muted)" }} />
          <span style={{ flex: 1 }}>Close pane</span>
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
    </>
  );
  const menuLabel = `${api.title ?? "Pane"} actions`;

  return (
    <>
      <button
        ref={overflowBtnRef}
        className={triggerClassName}
        title="More…"
        aria-label="More actions"
        // Under a coarse pointer the items open in a sheet (a dialog).
        aria-haspopup={coarse ? "dialog" : "menu"}
        aria-expanded={overflowOpen}
        onClick={() => {
          if (overflowOpen) setOverflowOpen(false);
          else openMenu();
        }}
      >
        <OverflowIcon size={16} />
      </button>
      {!coarse &&
        overflowPresent &&
        overflowPos &&
        createPortal(
          <div
            ref={overflowMenuRef}
            data-presence={overflowPresence}
            inert={overflowPresence === "leaving"}
            // Portaled to document.body (see the comment above the outside-
            // click effect), which escapes the .cmux-root/.light element in
            // App.tsx where every --chrome/--border/--fg/etc. custom
            // property is actually defined — without reapplying those
            // classes here, var(--chrome) etc. resolve to nothing and the
            // menu renders with a transparent background instead of falling
            // back to the theme.
            className={themeClassName(theme, "pane-tab-overflow-menu")}
            style={{
              position: "fixed",
              top: overflowPos.top,
              right: overflowPos.right,
              maxHeight: `${Math.max(0, visibleViewport().bottom - overflowPos.top - VIEWPORT_MARGIN_PX)}px`,
              overflowY: "auto",
            }}
            role="menu"
            aria-label={menuLabel}
            onKeyDown={onMenuKeyDown}
          >
            {menuItems}
          </div>,
          document.body,
        )}
      {coarse && (
        <BottomSheet
          open={overflowOpen}
          onClose={() => setOverflowOpen(false)}
          label={menuLabel}
          closeLabel="Close pane actions"
          title={api.title ?? "Pane"}
          backStack
          sheetClassName={`pane-actions-sheet${layout.tier === "phone" ? "" : " mobile-session-sheet--tablet"}`}
          suppressRestoreRef={sheetSuppressRestoreRef}
        >
          <div
            ref={overflowMenuRef}
            className="pane-actions-sheet-menu"
            role="menu"
            aria-label={menuLabel}
            onKeyDown={(e) => void onMenuArrowKeys(e)}
          >
            {menuItems}
          </div>
        </BottomSheet>
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
