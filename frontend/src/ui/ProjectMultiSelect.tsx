import { useMemo, useState } from "react";

export interface ProjectOption {
  id: number;
  name: string;
}

/**
 * A drop-down multi-select of projects (issues #2123 / #2124): a button showing
 * what is selected, opening a filterable list of checkboxes. Not a free-text
 * field — the ids it reports are always real projects.
 *
 * `selected` may hold ids of projects that no longer exist; they are not shown
 * and are dropped from the next change.
 */
export function ProjectMultiSelect({
  options,
  selected,
  onChange,
  emptyLabel,
  ariaLabel,
}: {
  options: ProjectOption[];
  selected: number[];
  onChange: (ids: number[]) => void;
  /** What the button says while nothing is selected. */
  emptyLabel: string;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const known = useMemo(() => new Set(options.map((o) => o.id)), [options]);
  const live = selected.filter((id) => known.has(id));
  const shown = options.filter((o) => o.name.toLowerCase().includes(filter.trim().toLowerCase()));

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
    <div className="project-multiselect">
      <button
        type="button"
        className="project-multiselect-button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {summary}
      </button>
      {open && (
        <div className="project-multiselect-panel" role="listbox" aria-multiselectable="true">
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
          {live.length > 0 && (
            <button
              type="button"
              className="project-multiselect-clear"
              onClick={() => onChange([])}
            >
              Clear selection
            </button>
          )}
        </div>
      )}
    </div>
  );
}
