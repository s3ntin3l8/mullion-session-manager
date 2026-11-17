import { useId, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { SelectMenu } from "./SelectMenu.js";

// The styled list the shared `Dropdown` opens under a fine pointer (#3245),
// following the WAI-ARIA select-only combobox pattern: the focus stays on the
// trigger (`role="combobox"`), the highlighted option is named by
// `aria-activedescendant`, and the list itself is the Dock's (SelectMenu).
// Under a coarse pointer `Dropdown` stays a native <select>; see primitives.tsx.

export interface DropdownOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

// A command row at the end of the list, set apart from the options ("Add
// project…"). Picking it runs `onSelect`; it never becomes the value.
export interface DropdownAction {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
}

// How long typed characters keep adding to one typeahead search. Browsers
// use about a second (LauncherProjects.tsx's native-select guard uses the
// same window), so a normally paced second letter narrows the search.
const TYPEAHEAD_MS = 1000;
const PAGE_STEP = 10;
// The typeahead's clock. Only ever read from a key handler.
const clock = () => Date.now();

// The option a typeahead run `text` leads to, searching from `current`, or
// -1. The action row is not in `options`, so it is never a match: a letter
// should not run a command (#3245, "Add project…"). Disabled options are
// skipped. One letter repeated ("a", "aa") cycles through the options that
// start with it, as a native select does; more letters narrow to a prefix.
function typeaheadMatch(
  options: ReadonlyArray<{ label: string; disabled?: boolean }>,
  text: string,
  current: number,
): number {
  const lower = text.toLowerCase();
  const repeated = [...lower].every((c) => c === lower[0]);
  const prefix = repeated ? lower[0]! : lower;
  const matches = options
    .map((o, i) => ({ o, i }))
    .filter(({ o }) => !o.disabled && o.label.toLowerCase().startsWith(prefix));
  if (matches.length === 0) return -1;
  const next = repeated
    ? matches.find(({ i }) => i > current)
    : matches.find(({ i }) => i >= current);
  return (next ?? matches[0]!).i;
}

export function DropdownListbox<T extends string>({
  options,
  value,
  onChange,
  action,
  id,
  title,
  disabled,
  ariaLabel,
  ariaLabelledBy,
}: {
  options: Array<DropdownOption<T>>;
  value: T;
  onChange: (v: T) => void;
  action?: DropdownAction;
  id?: string;
  title?: string;
  disabled?: boolean;
  ariaLabel?: string;
  ariaLabelledBy?: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [triggerRect, setTriggerRect] = useState<DOMRect | null>(null);
  const [listLabel, setListLabel] = useState<string | undefined>(undefined);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const typeaheadRef = useRef({ text: "", at: 0 });
  const listboxId = useId();
  const optionId = (i: number) => `${listboxId}-opt-${i}`;

  const selectedIndex = options.findIndex((o) => o.value === value);
  // A native select whose value matches none of its options shows its first
  // option; the trigger does the same, so the two paths read alike.
  const shown = selectedIndex >= 0 ? options[selectedIndex] : options[0];
  const actionIndex = action ? options.length : -1;
  const lastIndex = action ? options.length : options.length - 1;

  const enabled = (i: number) => i === actionIndex || (i >= 0 && !options[i]?.disabled);

  // The nearest enabled row from `from` in `step`'s direction, `from`
  // included; the start index itself when there is none (the list does not
  // wrap, per the pattern).
  function nearestEnabled(from: number, step: 1 | -1, fallback: number): number {
    for (let i = from; i >= 0 && i <= lastIndex; i += step) if (enabled(i)) return i;
    return fallback;
  }

  function openList(index: number) {
    if (disabled) return;
    setTriggerRect(triggerRef.current?.getBoundingClientRect() ?? null);
    setListLabel(readListLabel());
    setActiveIndex(index);
    setOpen(true);
  }

  function closeList() {
    setOpen(false);
    setActiveIndex(-1);
    setTriggerRect(null);
  }

  function initialIndex(): number {
    if (selectedIndex >= 0 && enabled(selectedIndex)) return selectedIndex;
    return nearestEnabled(0, 1, -1);
  }
  // Options that change while the list is open (a project list that loads)
  // move what an index points at, and the action row with them: the
  // highlight goes back to where an opening puts it, so Enter never runs a
  // row other than the one shown highlighted.
  const optionsKey = options.map((o) => o.value).join("\u0000");
  const [seenOptionsKey, setSeenOptionsKey] = useState(optionsKey);
  if (optionsKey !== seenOptionsKey) {
    setSeenOptionsKey(optionsKey);
    if (open) setActiveIndex(initialIndex());
  }

  function commit(index: number) {
    closeList();
    if (index === actionIndex) {
      action?.onSelect();
      return;
    }
    const opt = options[index];
    if (opt && !opt.disabled && opt.value !== value) onChange(opt.value);
  }

  // Adds a typed character to the typeahead run and returns the option it
  // leads to (-1 for none). The clock is read here, in the key handler.
  function typeahead(key: string): number {
    const now = clock();
    const buffer = typeaheadRef.current;
    const text = now - buffer.at < TYPEAHEAD_MS ? buffer.text + key : key;
    typeaheadRef.current = { text, at: now };
    return typeaheadMatch(options, text, open ? activeIndex : selectedIndex);
  }

  function handleKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        openList(initialIndex());
      } else if (e.key === "Home") {
        e.preventDefault();
        openList(nearestEnabled(0, 1, initialIndex()));
      } else if (e.key === "End") {
        e.preventDefault();
        openList(nearestEnabled(lastIndex, -1, initialIndex()));
      } else if (printable) {
        e.preventDefault();
        const match = typeahead(e.key);
        openList(match >= 0 ? match : initialIndex());
      }
      return;
    }
    // Open: every key below is the list's, not the page's or a dialog's.
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    switch (e.key) {
      case "Escape":
        // Closes the list and keeps the value. Stopped here, so a modal
        // around the dropdown does not close on the same press.
        handled();
        closeList();
        return;
      case "ArrowDown":
        handled();
        if (e.altKey) return;
        setActiveIndex(nearestEnabled(activeIndex + 1, 1, activeIndex));
        return;
      case "ArrowUp":
        handled();
        if (e.altKey) {
          commit(activeIndex);
          return;
        }
        setActiveIndex(nearestEnabled(activeIndex - 1, -1, activeIndex));
        return;
      case "Home":
        handled();
        setActiveIndex(nearestEnabled(0, 1, activeIndex));
        return;
      case "End":
        handled();
        setActiveIndex(nearestEnabled(lastIndex, -1, activeIndex));
        return;
      case "PageDown":
        handled();
        setActiveIndex(
          nearestEnabled(Math.min(lastIndex, activeIndex + PAGE_STEP), -1, activeIndex),
        );
        return;
      case "PageUp":
        handled();
        setActiveIndex(nearestEnabled(Math.max(0, activeIndex - PAGE_STEP), 1, activeIndex));
        return;
      case "Enter":
        handled();
        commit(activeIndex);
        return;
      case "Tab":
        // Commits the highlighted option and lets the focus move on. The
        // action row is a command, not a value: Tab only closes past it.
        if (activeIndex === actionIndex) closeList();
        else commit(activeIndex);
        return;
      case " ": {
        handled();
        // A space inside a typeahead run is part of the search ("my app").
        const run = typeaheadRef.current;
        if (run.text !== "" && clock() - run.at < TYPEAHEAD_MS) {
          const match = typeahead(" ");
          if (match >= 0) setActiveIndex(match);
          return;
        }
        commit(activeIndex);
        return;
      }
    }
    if (printable) {
      handled();
      const match = typeahead(e.key);
      if (match >= 0) setActiveIndex(match);
    }
  }

  // The list's name: the control's own, read from what names the trigger
  // (an aria-label, the Row label it points at, or an external <label>).
  function readListLabel(): string | undefined {
    if (ariaLabel) return ariaLabel;
    if (ariaLabelledBy) return document.getElementById(ariaLabelledBy)?.textContent ?? undefined;
    return triggerRef.current?.labels?.[0]?.textContent ?? title;
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        role="combobox"
        className="ui-dropdown-field ui-dropdown-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        // The listbox exists only while the list is open.
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        title={title}
        disabled={disabled}
        value={value}
        data-value={value}
        // A native select opens on the press, not the release. Taking the
        // press here also keeps a click on an external <label htmlFor> (which
        // the browser forwards as a bare `click`) to focusing the field.
        onMouseDown={(e) => {
          if (e.button !== 0 || disabled) return;
          e.preventDefault();
          // Focused by hand (Safari does not focus a pressed button), and
          // without the keyboard focus ring a pressed native select skips.
          triggerRef.current?.focus({ focusVisible: false } as FocusOptions);
          if (open) closeList();
          else openList(initialIndex());
        }}
        onClick={() => triggerRef.current?.focus()}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          if (open) closeList();
        }}
      >
        <span className="ui-dropdown-value">
          <span className="ui-dropdown-current">{shown?.label ?? ""}</span>
          {/* Every label, invisible and stacked in one cell, so the field is
              as wide as its longest option, as a closed native select is,
              and does not change width with the value. The labels are CSS
              content, so they are not text a query or a reader finds. */}
          <span className="ui-dropdown-sizer" aria-hidden="true">
            {options.map((o) => (
              <span key={o.value} data-label={o.label} data-value={o.value} />
            ))}
          </span>
        </span>
      </button>
      <SelectMenu
        open={open}
        triggerRect={triggerRect}
        containerRef={triggerRef}
        onDismiss={closeList}
        placement="auto"
        listboxId={listboxId}
        optionId={optionId}
        options={options}
        value={value}
        activeIndex={activeIndex}
        onPick={(i) => {
          commit(i);
          triggerRef.current?.focus();
        }}
        action={action ? { label: action.label, icon: action.icon } : undefined}
        className="ui-dropdown-menu"
        listLabel={listLabel}
        matchTriggerWidth
      />
    </>
  );
}
