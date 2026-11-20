import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import { menuMaxHeight, visibleViewport } from "../hooks/useVisualViewportChange.js";
import {
  LABEL_CHAR_WIDTH_PX,
  LABEL_CHROME_PX,
  LABEL_MIN_CHARS,
  MENU_MIN_WIDTH,
  computeMenuGeometry,
  resolvePlacement,
} from "./selectMenuGeometry.js";
import { useDashboardStore } from "../store/index.js";
import { themeClassName } from "../store/theme.js";
import { truncateMiddle } from "../lib/truncatePath.js";
import { usePresence } from "../hooks/usePresence.js";

// The styled option list both select-like controls open (#3245): the Dock's
// CustomSelect and the shared Dropdown primitive. It owns the list's look,
// where it sits (portaled to <body> as `position: fixed`, so no scrolling or
// `overflow: hidden` ancestor clips it), and when it goes away on its own
// (a click outside, a scroll or resize). The keyboard, and which option is
// active, stay with the control that opens it: the two follow different
// patterns (the Dock's filterable list, the select-only combobox).

export interface SelectMenuOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export function SelectMenu({
  open,
  triggerRect,
  containerRef,
  onDismiss,
  placement = "bottom",
  align = "left",
  listboxId,
  optionId,
  options,
  value,
  activeIndex,
  onPick,
  header,
  action,
  className,
  listLabel,
  matchTriggerWidth = false,
}: {
  open: boolean;
  // The trigger's rect, read when the menu opened. The menu is placed
  // against it and is not drawn without it.
  triggerRect: DOMRect | null;
  // The control the menu belongs to: a mousedown inside it is not "outside".
  containerRef: RefObject<HTMLElement | null>;
  // A click outside, or a scroll or resize anywhere but inside the menu.
  onDismiss: () => void;
  placement?: "top" | "bottom" | "auto";
  align?: "left" | "right";
  listboxId: string;
  optionId: (index: number) => string;
  options: SelectMenuOption[];
  value: string;
  // Index into `options`, or `options.length` for the action row.
  activeIndex: number;
  onPick: (index: number) => void;
  // Rendered above the listbox (the Dock's filter input and its empty note).
  header?: ReactNode;
  // A command row after the options, set apart from them (#3245: the
  // launcher's "Add project…"). It is the listbox's last option, so the
  // arrow keys reach it, but it is never selected and never the value.
  action?: { label: string; icon?: ReactNode };
  className?: string;
  // The listbox's accessible name.
  listLabel?: string;
  // The list is at least as wide as its trigger and no wider unless an
  // option needs it (#3245), with no floor of its own. Off, a narrow
  // trigger still gets a readable `MENU_MIN_WIDTH` list (the Dock).
  matchTriggerWidth?: boolean;
}) {
  const theme = useDashboardStore((s) => s.theme);
  const menuRef = useRef<HTMLDivElement>(null);
  // #3015 — stays mounted while it leaves (styles/motion.css plays the exit).
  const { present, state: presence } = usePresence(open, menuRef);
  // The latest `onDismiss`, for the listeners below, which are attached
  // once per opening rather than on every render.
  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  });

  // The rect the menu was last placed against. Both controls clear theirs on
  // close, but the menu stays mounted while its exit plays, and must leave
  // from where it was (its fixed position and its side, which motion.css
  // reads for the exit's origin).
  const [lastRect, setLastRect] = useState(triggerRect);
  if (triggerRect && triggerRect !== lastRect) setLastRect(triggerRect);
  const rect = triggerRect ?? lastRect;

  const geometry = computeMenuGeometry(rect, align);
  const rowCount = options.length + (action ? 1 : 0);
  const side = rect ? resolvePlacement(rect, placement, rowCount) : "bottom";

  // How many characters of a label fit in the menu's capped width. A branch
  // name is the shape that needs a MIDDLE cut (see truncatePath.ts): the
  // start says what kind of thing it is, the tail says which one it is.
  const menuWidth = geometry?.maxWidth ?? 0;
  const labelMaxChars =
    menuWidth <= 0
      ? LABEL_MIN_CHARS
      : Math.max(LABEL_MIN_CHARS, Math.floor((menuWidth - LABEL_CHROME_PX) / LABEL_CHAR_WIDTH_PX));

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Node;
      const outsideContainer = containerRef.current && !containerRef.current.contains(target);
      const outsideMenu = menuRef.current && !menuRef.current.contains(target);
      if (outsideContainer && outsideMenu) onDismissRef.current();
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open, containerRef]);

  useEffect(() => {
    if (open && activeIndex >= 0) {
      const item = menuRef.current?.querySelector(
        `[data-index="${activeIndex}"]`,
      ) as HTMLElement | null;
      item?.scrollIntoView?.({ block: "nearest" });
    }
  }, [open, activeIndex]);

  useEffect(() => {
    if (!open) return;
    function handleExternalEvent(e: Event) {
      // `instanceof Node` first: a `resize` targets `window` (and a
      // visual-viewport event the VisualViewport), and Node.contains() throws
      // a TypeError on a non-Node, which used to swallow every resize-close.
      if (e.target instanceof Node && menuRef.current?.contains(e.target)) return;
      onDismissRef.current();
    }
    // Issue #1399 — an iOS visual-viewport pan (keyboard open) moves `.app`,
    // and this trigger with it, without reliably firing a window
    // `scroll`/`resize`, so close on the visual viewport's own events too.
    const vv = window.visualViewport;
    window.addEventListener("scroll", handleExternalEvent, true);
    window.addEventListener("resize", handleExternalEvent);
    vv?.addEventListener("scroll", handleExternalEvent);
    vv?.addEventListener("resize", handleExternalEvent);
    return () => {
      window.removeEventListener("scroll", handleExternalEvent, true);
      window.removeEventListener("resize", handleExternalEvent);
      vv?.removeEventListener("scroll", handleExternalEvent);
      vv?.removeEventListener("resize", handleExternalEvent);
    };
  }, [open]);

  // Both `top`/`bottom` and both `left`/`right` are set explicitly (to
  // `"auto"` on the unused axis) rather than just omitting the one the active
  // placement/align doesn't need — see KebabMenu.tsx's own getMenuStyle doc
  // comment for the bug that omitting one leaked a stylesheet value into.
  function getMenuStyle(): CSSProperties {
    if (!rect) return {};
    // Same visible-region cap as KebabMenu (issue #1402). This listbox still
    // closes on a visual-viewport pan; the cap matters when it is opened
    // while the keyboard is already up. `bottom` stays in layout-viewport
    // coordinates — see KebabMenu's getMenuStyle. A trigger flush with the
    // visible edge used to produce max-height 0 (an open, empty listbox);
    // menuMaxHeight keeps the floor for that case only.
    const visible = visibleViewport();
    const style: CSSProperties = {
      position: "fixed",
      overflowY: "auto",
    };
    if (side === "top") {
      style.bottom = window.innerHeight - rect.top + 4;
      style.top = "auto";
      style.maxHeight = menuMaxHeight(rect.top - visible.top - 8);
    } else {
      style.top = rect.bottom + 4;
      style.bottom = "auto";
      style.maxHeight = menuMaxHeight(visible.bottom - rect.bottom - 8);
    }
    // The horizontal counterpart of the cap above (issue #2495): the menu is
    // never wider than the room it has, and it flips to the other side of
    // the trigger when the side it was asked for cannot fit it.
    if (geometry) {
      style.maxWidth = geometry.maxWidth;
      const floor = matchTriggerWidth ? rect.width : Math.max(MENU_MIN_WIDTH, rect.width);
      style.minWidth = Math.min(floor, geometry.maxWidth);
      if (geometry.align === "right") {
        style.right = window.innerWidth - rect.right;
        style.left = "auto";
      } else {
        style.left = rect.left;
        style.right = "auto";
      }
    }
    return style;
  }

  if (!present) return null;
  const actionIndex = options.length;
  return createPortal(
    <div
      ref={menuRef}
      className={themeClassName(theme, `custom-select-menu${className ? ` ${className}` : ""}`)}
      style={getMenuStyle()}
      data-presence={presence}
      data-placement={side}
      inert={presence === "leaving"}
      onClick={(e) => e.stopPropagation()}
      // A press on an option, or on the list's scrollbar, must not take the
      // focus off the control that opened the list: it keeps
      // `aria-activedescendant`, and the keyboard, while the list is open.
      // The Dock's filter input is the exception: a press there focuses it.
      onMouseDown={(e) => {
        if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
      }}
    >
      {header}
      {/* The listbox is a child of the menu, not the menu itself: the
          filter input above it is not an option, and a listbox may only
          contain options. It stays in the tree even when the filter matches
          nothing, so the trigger's and the input's `aria-controls` keep
          pointing at a real element. */}
      <div id={listboxId} role="listbox" className="custom-select-list" aria-label={listLabel}>
        {options.map((opt, i) => (
          <button
            key={opt.value}
            id={optionId(i)}
            className={`custom-select-item${opt.value === value ? " active" : ""}${i === activeIndex ? " focused" : ""}`}
            role="option"
            aria-selected={opt.value === value}
            aria-disabled={opt.disabled || undefined}
            // The full name stays in the tooltip and in the accessible
            // name even when the visible label is middle-truncated
            // (issue #2495) — nothing is lost, it is just not all
            // shown inline.
            title={opt.label}
            aria-label={opt.label}
            tabIndex={-1}
            data-value={opt.value}
            data-index={i}
            onClick={(e) => {
              e.stopPropagation();
              if (!opt.disabled) onPick(i);
            }}
            type="button"
          >
            {truncateMiddle(opt.label, labelMaxChars)}
          </button>
        ))}
        {action && (
          <button
            id={optionId(actionIndex)}
            className={`custom-select-item custom-select-action${actionIndex === activeIndex ? " focused" : ""}`}
            role="option"
            aria-selected={false}
            tabIndex={-1}
            data-index={actionIndex}
            data-action=""
            onClick={(e) => {
              e.stopPropagation();
              onPick(actionIndex);
            }}
            type="button"
          >
            {action.icon}
            <span>{action.label}</span>
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}
