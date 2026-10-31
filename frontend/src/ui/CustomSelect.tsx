import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDownIcon } from "./icons.js";
import { menuMaxHeight, visibleViewport } from "../hooks/useVisualViewportChange.js";
import { useDashboardStore } from "../store/index.js";
import { truncateMiddle } from "../lib/truncatePath.js";

export interface CustomSelectOption {
  value: string;
  label: string;
}

// The menu's own minimum width (the `.custom-select-menu` CSS floor). A menu
// narrower than this cannot show a readable label.
const MENU_MIN_WIDTH = 140;
// How far the menu keeps away from the viewport edges.
const MENU_VIEWPORT_MARGIN = 8;
// The option labels are set in a 12px UI font (`.custom-select-item`), so a
// character averages ~6.5px — close enough to turn the menu's pixel width
// into a character budget for the middle-ellipsis. The CSS end-ellipsis
// stays as the fallback for a label that turns out wider than this estimate.
const LABEL_CHAR_WIDTH_PX = 6.5;
// The room the label text gets inside the menu: the option's own 10px
// padding a side, plus the menu's 4px padding and 1px border a side.
const LABEL_CHROME_PX = 30;
// Never truncate a label below this many characters — a stub is worse than a
// label the CSS ellipsis clips a little.
const LABEL_MIN_CHARS = 12;

// Where the menu may sit for a trigger at `rect`, and how wide it may be.
//
// Issue #2495 — the menu used to be sized by its content alone (a long
// branch name made it as wide as the name), so a right-aligned menu ran off
// the LEFT edge of the screen and its labels were clipped on that side.
// Capping the width to the room the menu actually has keeps it on screen;
// when the preferred side cannot even fit the menu's minimum width, the
// alignment flips to the side that has room.
interface MenuGeometry {
  align: "left" | "right";
  maxWidth: number;
}

function computeMenuGeometry(
  rect: DOMRect | null,
  menuAlign: "left" | "right",
): MenuGeometry | null {
  if (!rect) return null;
  const viewportWidth = window.innerWidth;
  // The room on each side of the trigger, measured to the viewport edge: a
  // left-aligned menu grows to the RIGHT of the trigger, a right-aligned one
  // to its LEFT.
  const roomRight = viewportWidth - MENU_VIEWPORT_MARGIN - rect.left;
  const roomLeft = rect.right - MENU_VIEWPORT_MARGIN;
  const preferRight = menuAlign === "right";
  let align: "left" | "right" = preferRight ? "right" : "left";
  let room = preferRight ? roomLeft : roomRight;
  const otherRoom = preferRight ? roomRight : roomLeft;
  if (room < MENU_MIN_WIDTH && otherRoom > room) {
    align = preferRight ? "left" : "right";
    room = otherRoom;
  }
  return {
    align,
    // Never wider than the room it has, so it cannot reach past the
    // viewport edge on the side it opens toward.
    maxWidth: Math.max(0, Math.min(room, viewportWidth - MENU_VIEWPORT_MARGIN * 2)),
  };
}

export function CustomSelect({
  value,
  onChange,
  options,
  disabled = false,
  className = "",
  placeholder = "",
  label,
  menuPlacement = "bottom",
  menuAlign = "left",
  searchable = false,
  emptyMessage = "No matching options",
}: {
  value: string;
  onChange: (value: string) => void;
  options: CustomSelectOption[];
  disabled?: boolean;
  className?: string;
  placeholder?: string;
  label?: string;
  menuPlacement?: "bottom" | "top";
  menuAlign?: "left" | "right";
  // Opt-in (issue #2495): a filter input at the top of the menu that narrows
  // the options as the user types. Off by default, so every existing caller
  // keeps the plain list it has today.
  searchable?: boolean;
  // What the menu shows when the filter matches nothing (`searchable` only).
  emptyMessage?: string;
}) {
  const theme = useDashboardStore((s) => s.theme);
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [triggerRect, setTriggerRect] = useState<DOMRect | null>(null);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();

  const selectedIndex = useMemo(
    () => options.findIndex((o) => o.value === value),
    [options, value],
  );
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  // The list the menu shows. The filter narrows it by a case-insensitive
  // substring of the LABEL (issue #2495) — the value is an opaque id (a
  // worktree path, a `branch:<name>` marker), so the label is what the user
  // can actually read and search by.
  const visibleOptions = useMemo(() => {
    if (!searchable) return options;
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return options;
    return options.filter((o) => o.label.toLowerCase().includes(needle));
  }, [options, query, searchable]);

  // The focused option's index in the VISIBLE list. Clamped, so a filter
  // that shrinks the list cannot leave the highlight pointing past its end.
  const activeIndex =
    focusedIndex < 0 || visibleOptions.length === 0
      ? -1
      : Math.min(focusedIndex, visibleOptions.length - 1);

  const menuGeometry = computeMenuGeometry(triggerRect, menuAlign);

  // How many characters of a label fit in the menu's capped width. A branch
  // name is the shape that needs a MIDDLE cut (see truncatePath.ts): the
  // start says what kind of thing it is, the tail says which one it is.
  const menuWidth = menuGeometry?.maxWidth ?? 0;
  const labelMaxChars =
    menuWidth <= 0
      ? LABEL_MIN_CHARS
      : Math.max(LABEL_MIN_CHARS, Math.floor((menuWidth - LABEL_CHROME_PX) / LABEL_CHAR_WIDTH_PX));

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Node;
      const outsideContainer = ref.current && !ref.current.contains(target);
      const outsideMenu = menuRef.current && !menuRef.current.contains(target);
      if (outsideContainer && outsideMenu) {
        setOpen(false);
        setFocusedIndex(-1);
        setTriggerRect(null);
        setQuery("");
      }
    }
    if (open) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  useEffect(() => {
    if (open && activeIndex >= 0) {
      const item = menuRef.current?.querySelector(
        `[data-index="${activeIndex}"]`,
      ) as HTMLElement | null;
      item?.scrollIntoView?.({ block: "nearest" });
    }
  }, [open, activeIndex]);

  // The filter input takes the focus when a searchable menu opens, so that
  // typing filters the list right away (issue #2495) — the trigger keeps
  // the arrow-key/Enter handling for the NOT-searchable case.
  useEffect(() => {
    if (open && searchable) filterRef.current?.focus();
  }, [open, searchable]);

  useEffect(() => {
    if (!open) return;
    function handleExternalEvent(e: Event) {
      // `instanceof Node` first: a `resize` targets `window` (and a
      // visual-viewport event the VisualViewport), and Node.contains() throws
      // a TypeError on a non-Node, which used to swallow every resize-close.
      if (e.target instanceof Node && menuRef.current?.contains(e.target)) return;
      setOpen(false);
      setFocusedIndex(-1);
      setTriggerRect(null);
      setQuery("");
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

  function openMenu(focusIndex?: number) {
    setOpen(true);
    setQuery("");
    setFocusedIndex(focusIndex ?? (selectedIndex >= 0 ? selectedIndex : 0));
    setTriggerRect(triggerRef.current?.getBoundingClientRect() ?? null);
  }

  function closeMenu() {
    setOpen(false);
    setFocusedIndex(-1);
    setTriggerRect(null);
    setQuery("");
    triggerRef.current?.focus();
  }

  function moveFocus(delta: number) {
    if (visibleOptions.length === 0) return;
    setFocusedIndex((prev) => {
      if (prev < 0) return 0;
      return (prev + delta + visibleOptions.length) % visibleOptions.length;
    });
  }

  function selectOption(optValue: string) {
    onChange(optValue);
    closeMenu();
  }

  function handleTriggerKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeMenu();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) {
        openMenu();
      } else {
        moveFocus(1);
      }
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        // Same open path as ArrowDown — it captures the trigger's rect, so
        // the menu is positioned against it (issue #2495: the menu's
        // placement is computed from that rect).
        openMenu(selectedIndex >= 0 ? selectedIndex : visibleOptions.length - 1);
      } else {
        moveFocus(-1);
      }
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (open && activeIndex >= 0 && activeIndex < visibleOptions.length) {
        selectOption(visibleOptions[activeIndex].value);
      } else {
        openMenu();
      }
      return;
    }
    if (e.key === "Tab") {
      closeMenu();
      return;
    }
  }

  // The filter input's own keys (issue #2495). Escape clears the filter
  // FIRST and only closes the menu on a second press — losing a typed
  // filter to a stray Escape would be the wrong trade.
  function handleFilterKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (query.length > 0) {
        setQuery("");
        setFocusedIndex(0);
        return;
      }
      closeMenu();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveFocus(1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      moveFocus(-1);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (activeIndex >= 0 && activeIndex < visibleOptions.length) {
        selectOption(visibleOptions[activeIndex].value);
      }
      return;
    }
    if (e.key === "Tab") {
      // Take the portaled menu with the focus, and hand the focus back to
      // the trigger first: the input is about to unmount, and unmounting
      // the FOCUSED element would drop the focus to <body> instead of
      // letting the browser's default Tab continue from the trigger —
      // the same landing spot the non-searchable trigger's own Tab
      // handling produces.
      closeMenu();
      return;
    }
  }

  function handleTriggerClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (open) {
      closeMenu();
    } else {
      openMenu();
    }
  }

  function handleOptionClick(e: React.MouseEvent, optValue: string) {
    e.stopPropagation();
    selectOption(optValue);
  }

  // Both `top`/`bottom` and both `left`/`right` are set explicitly (to
  // `"auto"` on the unused axis) rather than just omitting the one the active
  // placement/align doesn't need — see KebabMenu.tsx's own getMenuStyle doc
  // comment for the bug that omitting one leaked a stylesheet value into.
  // `.custom-select-menu` itself carries no `position`/`top`, so this
  // component was never actually exposed to that bug, but the two are meant
  // to mirror each other.
  function getMenuStyle(): React.CSSProperties {
    const rect = triggerRect;
    if (!rect) return {};
    // Same visible-region cap as KebabMenu (issue #1402). This listbox still
    // closes on a visual-viewport pan; the cap matters when it is opened
    // while the keyboard is already up. `bottom` stays in layout-viewport
    // coordinates — see KebabMenu's getMenuStyle. A trigger flush with the
    // visible edge used to produce max-height 0 (an open, empty listbox);
    // menuMaxHeight keeps the floor for that case only.
    const visible = visibleViewport();
    const style: React.CSSProperties = {
      position: "fixed",
      overflowY: "auto",
    };
    if (menuPlacement === "top") {
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
    const geometry = menuGeometry;
    if (geometry) {
      style.maxWidth = geometry.maxWidth;
      style.minWidth = Math.min(Math.max(MENU_MIN_WIDTH, rect.width), geometry.maxWidth);
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

  return (
    <div ref={ref} className={`custom-select ${className}`}>
      <button
        ref={triggerRef}
        className="custom-select-trigger"
        disabled={disabled}
        onClick={handleTriggerClick}
        onKeyDown={handleTriggerKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-label={label}
        aria-activedescendant={
          open && activeIndex >= 0 ? `custom-select-opt-${activeIndex}` : undefined
        }
        data-selected-value={value}
        type="button"
      >
        <span className="custom-select-label">{selected?.label ?? placeholder}</span>
        <ChevronDownIcon size={11} />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className={`cmux-root${theme === "light" ? " light" : ""} custom-select-menu`}
            style={getMenuStyle()}
            onClick={(e) => e.stopPropagation()}
          >
            {searchable && (
              <div className="custom-select-filter">
                <input
                  ref={filterRef}
                  className="ui-input small custom-select-filter-input"
                  type="text"
                  role="combobox"
                  aria-expanded={open}
                  aria-controls={listboxId}
                  aria-autocomplete="list"
                  aria-activedescendant={
                    activeIndex >= 0 ? `custom-select-opt-${activeIndex}` : undefined
                  }
                  aria-label="Filter options"
                  placeholder="Filter…"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    // The highlight follows the filter: the first match is
                    // the one the user is most likely after.
                    setFocusedIndex(0);
                  }}
                  onKeyDown={handleFilterKeyDown}
                />
              </div>
            )}
            {searchable && visibleOptions.length === 0 && (
              // `role="status"` so the "nothing matched" message is
              // announced as the filter narrows to nothing, rather than
              // being a silent empty box to a screen-reader user.
              <div className="custom-select-empty" role="status">
                {emptyMessage}
              </div>
            )}
            {/* The listbox is a child of the menu, not the menu itself: the
                filter input above it is not an option, and a listbox may
                only contain options. It stays in the tree even when the
                filter matches nothing, so the trigger's and the input's
                `aria-controls` keep pointing at a real element. */}
            <div id={listboxId} role="listbox" className="custom-select-list">
              {visibleOptions.map((opt, i) => (
                <button
                  key={opt.value}
                  id={`custom-select-opt-${i}`}
                  className={`custom-select-item${opt.value === value ? " active" : ""}${i === activeIndex ? " focused" : ""}`}
                  role="option"
                  aria-selected={opt.value === value}
                  // The full name stays in the tooltip and in the accessible
                  // name even when the visible label is middle-truncated
                  // (issue #2495) — nothing is lost, it is just not all
                  // shown inline.
                  title={opt.label}
                  aria-label={opt.label}
                  tabIndex={-1}
                  data-value={opt.value}
                  data-index={i}
                  onClick={(e) => handleOptionClick(e, opt.value)}
                  type="button"
                >
                  {truncateMiddle(opt.label, labelMaxChars)}
                </button>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
