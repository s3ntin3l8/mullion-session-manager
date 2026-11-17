import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDownIcon } from "./icons.js";
import { SelectMenu } from "./SelectMenu.js";

export interface CustomSelectOption {
  value: string;
  label: string;
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
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [triggerRect, setTriggerRect] = useState<DOMRect | null>(null);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
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

  // The filter input takes the focus when a searchable menu opens, so that
  // typing filters the list right away (issue #2495) — the trigger keeps
  // the arrow-key/Enter handling for the NOT-searchable case.
  useEffect(() => {
    if (open && searchable) filterRef.current?.focus();
  }, [open, searchable]);

  function openMenu(focusIndex?: number) {
    setOpen(true);
    setQuery("");
    setFocusedIndex(focusIndex ?? (selectedIndex >= 0 ? selectedIndex : 0));
    setTriggerRect(triggerRef.current?.getBoundingClientRect() ?? null);
  }

  // The list went away on its own (a click outside, a scroll): the focus
  // stays wherever it went.
  function dismissMenu() {
    setOpen(false);
    setFocusedIndex(-1);
    setTriggerRect(null);
    setQuery("");
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
      <SelectMenu
        open={open}
        triggerRect={triggerRect}
        containerRef={ref}
        onDismiss={dismissMenu}
        placement={menuPlacement}
        align={menuAlign}
        listboxId={listboxId}
        optionId={(i) => `custom-select-opt-${i}`}
        options={visibleOptions}
        value={value}
        activeIndex={activeIndex}
        onPick={(i) => selectOption(visibleOptions[i]!.value)}
        header={
          <>
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
          </>
        }
      />
    </div>
  );
}
