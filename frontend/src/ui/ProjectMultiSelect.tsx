import { useEffect, useId, useMemo, useRef, useState } from "react";

export interface ProjectOption {
  id: number;
  name: string;
}

/**
 * A drop-down multi-select of projects (issues #2123 / #2124): a button showing what
 * is selected, opening a filterable group of checkboxes. Not a free-text field — the ids
 * it reports are always real projects.
 *
 * A disclosure, not a listbox: the panel holds checkboxes (each one a real, labelled
 * control), so it is announced as a group of them. Escape and a click outside close it,
 * like ui/CustomSelect.
 *
 * `selected` may hold ids of projects that no longer exist; they are not shown and are
 * dropped from the next change.
 *
 * `clearWarning`, when given, makes "Clear selection" a two-step action that shows the
 * warning first: clearing a restriction can widen what something is allowed to do.
 */
export function ProjectMultiSelect({
  options,
  selected,
  onChange,
  emptyLabel,
  ariaLabel,
  clearWarning,
}: {
  options: ProjectOption[];
  selected: number[];
  onChange: (ids: number[]) => void;
  /** What the button says while nothing is selected. */
  emptyLabel: string;
  ariaLabel: string;
  clearWarning?: string;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [confirmingClear, setConfirmingClear] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const clearRef = useRef<HTMLButtonElement>(null);
  // Which control should take focus after the clear control swaps for Confirm/Cancel or
  // back, so a keyboard user is not dropped to <body> (and back to the top of the form).
  const focusAfterSwap = useRef<"confirm" | "clear" | null>(null);
  const panelId = useId();
  const known = useMemo(() => new Set(options.map((o) => o.id)), [options]);
  const live = selected.filter((id) => known.has(id));
  const shown = options.filter((o) => o.name.toLowerCase().includes(filter.trim().toLowerCase()));

  useEffect(() => {
    if (focusAfterSwap.current === "confirm") confirmRef.current?.focus();
    else if (focusAfterSwap.current === "clear") clearRef.current?.focus();
    focusAfterSwap.current = null;
  }, [confirmingClear]);

  const close = () => {
    setOpen(false);
    setConfirmingClear(false);
  };

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) close();
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  const summary =
    live.length === 0
      ? emptyLabel
      : live.length <= 2
        ? options
            .filter((o) => live.includes(o.id))
            .map((o) => o.name)
            .join(", ")
        : `${live.length} projects`;

  const toggle = (id: number) =>
    onChange(live.includes(id) ? live.filter((x) => x !== id) : [...live, id]);

  return (
    <div
      className="project-multiselect"
      ref={rootRef}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          // Close this popup only: the modal's own Escape must not also fire.
          e.stopPropagation();
          close();
          buttonRef.current?.focus();
        }
      }}
    >
      <button
        type="button"
        ref={buttonRef}
        className="project-multiselect-button"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {summary}
      </button>
      {open && (
        <div className="project-multiselect-panel" id={panelId} role="group" aria-label={ariaLabel}>
          {options.length > 8 && (
            <input
              type="text"
              className="project-multiselect-filter"
              placeholder="Filter projects"
              aria-label="Filter projects"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          )}
          {shown.length === 0 ? (
            <span className="create-modal-field-hint">No other projects.</span>
          ) : (
            shown.map((option) => (
              <label key={option.id} className="create-modal-dir-confirm-checkbox">
                <input
                  type="checkbox"
                  checked={live.includes(option.id)}
                  onChange={() => toggle(option.id)}
                />
                {option.name}
              </label>
            ))
          )}
          {live.length > 0 &&
            (confirmingClear ? (
              <span className="create-modal-field-hint" role="alert">
                {clearWarning}{" "}
                <button
                  type="button"
                  ref={confirmRef}
                  className="project-multiselect-clear"
                  onClick={() => {
                    onChange([]);
                    setConfirmingClear(false);
                    focusAfterSwap.current = null;
                    buttonRef.current?.focus();
                  }}
                >
                  Confirm
                </button>{" "}
                <button
                  type="button"
                  className="project-multiselect-clear"
                  onClick={() => {
                    focusAfterSwap.current = "clear";
                    setConfirmingClear(false);
                  }}
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                ref={clearRef}
                className="project-multiselect-clear"
                onClick={() => {
                  if (!clearWarning) {
                    onChange([]);
                    // This control unmounts with the selection; keep focus on the trigger.
                    buttonRef.current?.focus();
                    return;
                  }
                  focusAfterSwap.current = "confirm";
                  setConfirmingClear(true);
                }}
              >
                Clear selection
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
