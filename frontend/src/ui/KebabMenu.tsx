import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDashboardStore } from "../store/index.js";
import type { LayoutMode } from "../api/index.js";
import { themeClassName } from "../store/theme.js";
import { OverflowIcon } from "./icons.js";
import { useFocusTrap } from "../hooks/useFocusTrap.js";
import { useArmConfirm } from "../hooks/useArmConfirm.js";
import { useCoarsePointer, useLayoutTier } from "../lib/layoutTier.js";
import { BottomSheet } from "./BottomSheet.js";
import { usePresence } from "../hooks/usePresence.js";
import {
  useVisualViewportChange,
  visibleViewport,
  menuMaxHeight,
} from "../hooks/useVisualViewportChange.js";

// Generic ⋯ trigger + portaled dropdown, extracted from PaneTab.tsx's own
// overflow menu (Phase 4b/4c) so group/workspace/project rows get the same
// pattern instead of three hand-rolled portals: position:fixed computed from
// the trigger's own getBoundingClientRect() (sidesteps whatever ancestor
// clips overflow — dockview's tab strip there, the sidebar's own scroll
// container here), an outside-click listener comparing against both the
// trigger and the menu's own ref, and — the load-bearing detail from the
// Phase 4c follow-up fix — the portaled node reapplies the `cmux-root`/
// `light` theme classes, since portaling to document.body escapes the
// `.cmux-root` subtree where every `--chrome`/`--border`/`--fg` custom
// property is actually defined. Fixing that once here means it can't be
// reintroduced per-consumer the way it originally was in PaneTab alone.
//
// PaneTab.tsx itself is deliberately NOT migrated to this component this
// pass — it already works, no reason to churn it.

export interface KebabMenuItem {
  key: string;
  label: string;
  // Shown in place of `label` once armed (e.g. "Click again to delete").
  // Only meaningful together with `confirm: true`.
  armLabel?: string;
  icon?: ReactNode;
  onClick: () => void;
  danger?: boolean;
  // Requires a first click to arm (matching PaneTab's kill-session /
  // ConfirmButton's own 3s arm window) before a second click fires it.
  confirm?: boolean;
  disabled?: boolean;
  // Rendered as the item button's `title` — meant for explaining WHY a
  // `disabled` item is disabled (issue #1106). Only useful paired with
  // `disabled: true`: see the item render below for why a plain
  // `disabled` attribute can't carry this on its own.
  title?: string;
  // The action opens ANOTHER focus-trapped overlay — the Settings modal,
  // the command palette, the promote dialog. This menu's own focus trap
  // must not restore focus to the trigger once the menu closes, because
  // that would pull focus straight back out of the overlay that just took
  // it.
  //
  // Same escape hatch as PaneActionsMenu's `closeMenuAfterAction`, which
  // calls `useFocusTrap`'s `suppressRestore()` before closing the menu in
  // the same click handler that opens the dialog. There the caller owns
  // that call; here the caller only supplies an `onClick`, so the flag is
  // how a call site says "this action takes focus somewhere else".
  opensOverlay?: boolean;
}

// #3071 — opt-in touch variant. Under a coarse pointer a menu given `sheet`
// opens its items as a bottom sheet (rows of 44px and more, never clipped by
// a dialog or a sheet it sits in), the split PaneActionsMenu.tsx makes; under
// a fine pointer it stays the anchored popover. Menus without it keep the
// popover on every pointer.
export interface KebabMenuSheet {
  // The sheet's visible title (the menu's subject: a project's name).
  title: string;
  // The sheet's close button.
  closeLabel: string;
}

// Anything a press would focus, including a `tabindex="-1"` container (a
// dockview pane activates its group when its content takes focus).
const FOCUSABLE_TARGET =
  "button, [href], input, select, textarea, [tabindex], [contenteditable]:not([contenteditable='false'])";

export function KebabMenu({
  items,
  title = "More…",
  trigger,
  menuPlacement = "bottom",
  menuAlign = "right",
  triggerClassName = "kebab-trigger-btn",
  menuLabel,
  menuClassName,
  sheet,
}: {
  items: KebabMenuItem[];
  title?: string;
  trigger?: ReactNode;
  // Replaces the trigger's default chrome (a launcher-sized "⋯").
  triggerClassName?: string;
  // The menu's accessible name; defaults to `title`.
  menuLabel?: string;
  // Extra class on the portaled popover (not the sheet), e.g. to stack it
  // above the popover its trigger sits in.
  menuClassName?: string;
  sheet?: KebabMenuSheet;
  // "top" grows the portaled menu upward from the trigger instead of
  // dropping it down — for a trigger pinned near the bottom of the
  // viewport (the Dock), a downward menu can run off-screen with no way to
  // scroll to its lower items. "auto" measures the rendered menu and opens
  // upward when it cannot fit below and there is more room above — useful
  // for sidebar rows whose position changes as the user scrolls. "side"
  // (#3073) opens it beside the trigger, to its right (to its left when the
  // right has no room), top-aligned with it and kept on screen: for a
  // trigger inside a popover, whose list a dropped-down menu would cover.
  menuPlacement?: "bottom" | "top" | "auto" | "side";
  menuAlign?: "left" | "right";
}) {
  const theme = useDashboardStore((s) => s.theme);
  const coarse = useCoarsePointer();
  // The sheet's width modifier only. Read defensively: KebabMenu renders in
  // plenty of places (and tests) whose store carries no settings, and only a
  // `sheet` menu needs the tier at all.
  const tier = useLayoutTier(
    useDashboardStore(
      (s) => (s as { settings?: { layoutMode?: LayoutMode } }).settings?.layoutMode,
    ) ?? "auto",
  );
  const asSheet = sheet !== undefined && coarse;
  const [open, setOpen] = useState(false);
  const popoverOpen = open && !asSheet;
  // The sheet's own focus-restore suppressor (BottomSheet owns that trap).
  const sheetSuppressRestoreRef = useRef<(() => void) | null>(null);
  // DOMRect (not just {top,right}) to mirror CustomSelect's own triggerRect
  // — getMenuStyle below needs rect.top for the "top" placement's `bottom:`
  // calc, which the old {top,right} shape didn't carry.
  const [triggerRect, setTriggerRect] = useState<DOMRect | null>(null);
  const [menuHeight, setMenuHeight] = useState(0);
  const [menuWidth, setMenuWidth] = useState(0);
  const {
    armedKey,
    secondsLeft: armSecondsLeft,
    arm: armItem,
    disarm: disarmItem,
    confirm: confirmItem,
  } = useArmConfirm();
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // The menu is a portaled `role="menu"` widget: focus moves into it on
  // open, Tab is trapped inside it, Escape closes it and puts focus back on
  // the trigger, and the arrow keys move between items. This used to be
  // mouse-only — the trigger was an icon button with no accessible name,
  // the menu had no `role`, the items had no `role="menuitem"`, and there
  // was no key handling at all, so a keyboard user could not open the menu
  // or reach any of its actions.
  //
  // `useFocusTrap` is the same shared primitive PaneActionsMenu uses for
  // its overflow menu — see that component for why Escape is scoped to the
  // menu's own `onKeyDown` rather than a window listener.
  const { onKeyDown: onTrapKeyDown, suppressRestore: suppressPopoverRestore } = useFocusTrap({
    active: popoverOpen,
    containerRef: menuRef,
  });
  const suppressRestore = () => {
    if (asSheet) sheetSuppressRestoreRef.current?.();
    else suppressPopoverRestore();
  };
  // #3015 — stays mounted while it leaves (styles/motion.css plays the exit).
  const { present, state: presence } = usePresence(popoverOpen, menuRef);

  const close = () => {
    disarmItem();
    setOpen(false);
  };

  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
      return;
    }
    if (onMenuArrowKeys(e)) return;
    onTrapKeyDown(e);
  };
  // Arrows only — in the sheet, BottomSheet owns Escape and the Tab trap.
  // Returns whether it handled the key.
  const onMenuArrowKeys = (e: ReactKeyboardEvent<HTMLDivElement>): boolean => {
    // APG menu pattern — ArrowUp/ArrowDown (and Home/End) move focus among
    // the `role="menuitem"` children. The shared hook's Tab-trap alone
    // doesn't provide that.
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
      const items = menuRef.current
        ? Array.from(menuRef.current.querySelectorAll<HTMLElement>('[role="menuitem"]'))
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

  useEffect(() => {
    if (!popoverOpen) return;
    const onOutsideClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (btnRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      // #3071 — a press on nothing focusable would move focus to <body> as
      // its default action, after the trap has put it back on the trigger.
      // Keep it on the trigger. A press on a control still focuses that
      // control: that is where the user meant to go.
      if (!(target instanceof Element && target.closest(FOCUSABLE_TARGET))) e.preventDefault();
      disarmItem();
      setOpen(false);
    };
    document.addEventListener("mousedown", onOutsideClick);
    return () => document.removeEventListener("mousedown", onOutsideClick);
  }, [popoverOpen, disarmItem]);

  // Issue #1399 — re-read the trigger's rect when the iOS visual viewport
  // pans/resizes while open: `.app` (and this trigger with it) moves with the
  // visual viewport since #1398, and getMenuStyle below derives everything
  // from `triggerRect`, so refreshing it is enough to keep the menu attached.
  useVisualViewportChange(popoverOpen, () => {
    if (btnRef.current) setTriggerRect(btnRef.current.getBoundingClientRect());
  });
  // A "side" menu belongs to a row inside a scrolling list (the workspace
  // picker, #3073): follow the row when that list scrolls.
  useEffect(() => {
    if (!popoverOpen || menuPlacement !== "side") return;
    const onScroll = (e: Event) => {
      // The menu's own scrolling moves nothing it is anchored to.
      if (menuRef.current?.contains(e.target as Node) || !btnRef.current) return;
      const next = btnRef.current.getBoundingClientRect();
      // Most scrolls (a terminal behind the menu) move nothing: returning the
      // same rect skips the re-render and the layout effect's measurement.
      setTriggerRect((prev) =>
        prev &&
        prev.top === next.top &&
        prev.left === next.left &&
        prev.bottom === next.bottom &&
        prev.right === next.right
          ? prev
          : next,
      );
    };
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, [popoverOpen, menuPlacement]);

  // Re-clamp after rendering, as PaneActionsMenu does for its measured
  // width. scrollHeight includes content hidden by maxHeight; measuring the
  // capped bounding rect would mistake a tiny scroll box for a menu that fits.
  // A layout effect corrects the first placement before the browser paints.
  useLayoutEffect(() => {
    if (popoverOpen && (menuPlacement === "auto" || menuPlacement === "side") && menuRef.current) {
      setMenuHeight(menuRef.current.scrollHeight);
      setMenuWidth(menuRef.current.offsetWidth);
    }
  }, [popoverOpen, menuPlacement, triggerRect, items, armedKey, armSecondsLeft]);

  const handleItemClick = (item: KebabMenuItem, e?: React.MouseEvent) => {
    if (item.disabled) return;
    // The action is about to take focus somewhere else (another overlay).
    // Tell the focus trap not to pull it back to this menu's trigger when
    // the menu closes — see `opensOverlay` on KebabMenuItem. Only on the
    // click that runs the action: an arming click that is then cancelled
    // (Escape, a press outside) must still return focus to the trigger.
    if (item.confirm) {
      if (armedKey === item.key) {
        if (!confirmItem(item.key, e)) return;
        if (item.opensOverlay) suppressRestore();
        setOpen(false);
        item.onClick();
      } else {
        armItem(item.key);
      }
      return;
    }
    if (item.opensOverlay) suppressRestore();
    setOpen(false);
    item.onClick();
  };

  // Matches CustomSelect.tsx's own getMenuStyle. Both `top` and `bottom` are
  // always set explicitly (to `"auto"` on the unused axis) rather than just
  // omitting the one the active placement doesn't need — the portaled node
  // carries `.pane-tab-overflow-menu` (terminal.css), which hard-codes its own
  // `top: 31px`, and an unset `style.top` here used to let that leak through
  // underneath an inline `bottom`. With both offsets resolved and `height:
  // auto`, CSS solved `height = triggerTop − 35`: a kebab near the bottom of
  // the viewport (the Dock) rendered a menu over a thousand pixels tall. Also
  // caps `maxHeight` to the space actually free on the side the menu opens
  // toward, measured against the visible viewport (issue #1402) rather than
  // `innerHeight` — on iOS the layout viewport does not shrink when the
  // keyboard is open, so a cap against `innerHeight` extends behind it.
  // The "top" placement's `bottom` offset stays in layout-viewport
  // coordinates (`innerHeight`): `position: fixed; bottom` is distance from
  // the layout viewport's bottom edge, and the trigger's rect is already in
  // those coordinates. A non-positive max-height is an invalid CSS length
  // (the browser drops it and the menu goes uncapped), so `menuMaxHeight`
  // falls back to MENU_MAX_HEIGHT_FLOOR only then. A small *positive* gap is
  // used as-is: flooring it back up to 120px hid the menu behind the
  // keyboard, which is the bug this cap exists to fix.
  const getMenuStyle = (): React.CSSProperties | null => {
    const rect = triggerRect;
    if (!rect) return null;
    if (menuPlacement === "side") return getSideMenuStyle(rect);
    const style: React.CSSProperties = {
      position: "fixed",
      right: menuAlign === "left" ? "auto" : window.innerWidth - rect.right,
      left:
        menuAlign === "left" ? Math.max(8, Math.min(rect.left, window.innerWidth - 222)) : "auto",
      maxWidth: window.innerWidth - 16,
      overflowY: "auto",
    };
    const visible = visibleViewport();
    const spaceAbove = rect.top - visible.top - 8;
    const spaceBelow = visible.bottom - rect.bottom - 8;
    const opensUpward =
      menuPlacement === "top" ||
      (menuPlacement === "auto" && menuHeight > spaceBelow && spaceAbove > spaceBelow);
    if (opensUpward) {
      style.bottom = window.innerHeight - rect.top + 4;
      style.top = "auto";
      style.maxHeight = menuMaxHeight(spaceAbove);
    } else {
      style.top = rect.bottom + 4;
      style.bottom = "auto";
      style.maxHeight = menuMaxHeight(spaceBelow);
    }
    return style;
  };
  // "side": beside the trigger rather than under it. Before the first
  // measurement the width is unknown (0), which reads as "fits on the right";
  // the layout effect above corrects it before paint.
  const getSideMenuStyle = (rect: DOMRect): React.CSSProperties => {
    // The visible viewport's right edge (a panned or zoomed iOS visual
    // viewport), not the layout viewport's.
    const visible = visibleViewport();
    const gap = 4;
    const fitsRight = rect.right + gap + menuWidth <= visible.right - 8;
    const top = Math.max(
      visible.top + 8,
      Math.min(rect.top - gap, visible.bottom - 8 - menuHeight),
    );
    return {
      position: "fixed",
      left: fitsRight ? rect.right + gap : "auto",
      right: fitsRight ? "auto" : window.innerWidth - rect.left + gap,
      top,
      bottom: "auto",
      maxWidth: window.innerWidth - 16,
      maxHeight: menuMaxHeight(visible.bottom - top - 8),
      overflowY: "auto",
    };
  };
  const menuStyle = asSheet ? null : getMenuStyle();
  const menuItems = (
    <>
      {items.map((item) => (
        <button
          key={item.key}
          className={`pane-tab-overflow-item${item.danger ? " danger" : ""}${
            armedKey === item.key ? " armed" : ""
          }`}
          role="menuitem"
          // Issue #1106 — `aria-disabled`, not the native `disabled`
          // attribute: a disabled button doesn't receive pointer
          // events, which is exactly what makes a `title` on it
          // unreliable across engines. handleItemClick's own
          // `if (item.disabled) return` above is what actually keeps
          // this inert; aria-disabled is presentation + a11y only.
          aria-disabled={item.disabled || undefined}
          title={item.title}
          onClick={(e) => handleItemClick(item, e)}
        >
          {item.icon}
          <span style={{ flex: 1 }}>
            {armedKey === item.key && item.armLabel ? item.armLabel : item.label}
          </span>
          {armedKey === item.key && (
            <span className="pane-tab-overflow-hint" style={{ color: "var(--o)" }}>
              {armSecondsLeft}s
            </span>
          )}
        </button>
      ))}
    </>
  );
  // An upward menu has its `top` resolved to "auto" (see getMenuStyle).
  const opensUpward = menuStyle?.top === "auto";

  return (
    <>
      <button
        ref={btnRef}
        className={triggerClassName}
        title={title}
        // The trigger is an icon-only button, so `title` alone would be its
        // only accessible name — and a tooltip is not a reliable one. The
        // label states what the menu does for this row.
        aria-label={title}
        // Under a coarse pointer a sheet menu opens in a dialog.
        aria-haspopup={asSheet ? "dialog" : "menu"}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          if (!open && btnRef.current) {
            // Focus the trigger BEFORE opening: the focus trap captures
            // `document.activeElement` on activation to restore it on
            // close, and Safari does not focus a button on click, so
            // without this the "restore" target would be <body>.
            btnRef.current.focus();
            setTriggerRect(btnRef.current.getBoundingClientRect());
          }
          setOpen((v) => !v);
          disarmItem();
        }}
        onKeyDown={(e) => {
          // APG: Down Arrow opens the menu and lands on its first item
          // (the focus trap's own focus-in does the landing). Enter and
          // Space are the button's native activation, handled by onClick.
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            if (btnRef.current) {
              btnRef.current.focus();
              setTriggerRect(btnRef.current.getBoundingClientRect());
            }
            setOpen(true);
          }
        }}
      >
        {trigger ?? <OverflowIcon size={15} />}
      </button>
      {present &&
        menuStyle &&
        createPortal(
          <div
            ref={menuRef}
            className={themeClassName(theme, "pane-tab-overflow-menu", menuClassName)}
            style={menuStyle}
            data-presence={presence}
            data-placement={
              menuPlacement === "side"
                ? menuStyle.left === "auto"
                  ? "side-left"
                  : "side"
                : opensUpward
                  ? "top"
                  : "bottom"
            }
            inert={presence === "leaving"}
            role="menu"
            aria-label={menuLabel ?? title}
            onKeyDown={onMenuKeyDown}
            onClick={(e) => e.stopPropagation()}
          >
            {menuItems}
          </div>,
          document.body,
        )}
      {asSheet && sheet && (
        <BottomSheet
          open={open}
          onClose={close}
          label={menuLabel ?? title}
          closeLabel={sheet.closeLabel}
          title={sheet.title}
          backStack
          sheetClassName={`pane-actions-sheet${tier === "phone" ? "" : " mobile-session-sheet--tablet"}`}
          suppressRestoreRef={sheetSuppressRestoreRef}
        >
          <div
            ref={menuRef}
            className="pane-actions-sheet-menu"
            role="menu"
            aria-label={menuLabel ?? title}
            onKeyDown={(e) => void onMenuArrowKeys(e)}
            onClick={(e) => e.stopPropagation()}
          >
            {menuItems}
          </div>
        </BottomSheet>
      )}
    </>
  );
}
