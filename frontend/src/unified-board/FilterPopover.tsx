import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ChevronDownIcon } from "../ui/icons.js";

// A disclosure button with a panel under it, for the board's project picker, Filter
// and Display menus (#2840). Like ui/ProjectMultiSelect: a disclosure, not a menu or
// listbox, since the panels hold checkboxes and inputs that are real, labelled
// controls. Escape and a click outside close it. The panel's content is the same
// component the phone filter sheet renders inline, so the two cannot drift.
export function FilterPopover({
  label,
  ariaLabel,
  active = false,
  className = "",
  children,
}: {
  label: ReactNode;
  /** Names both the button and the panel group. */
  ariaLabel: string;
  /** Something inside is narrowing the board: the button reads as "on". */
  active?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  return (
    <div
      className={`task-pop ${className}`.trim()}
      ref={rootRef}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          // Close this popover only: a drawer or modal's own Escape must not also fire.
          e.stopPropagation();
          setOpen(false);
          buttonRef.current?.focus();
        }
      }}
    >
      <button
        type="button"
        ref={buttonRef}
        className={`task-pop-btn${active ? " active" : ""}`}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
        <ChevronDownIcon size={10} aria-hidden="true" />
      </button>
      {open && (
        <div className="task-pop-panel" id={panelId} role="group" aria-label={ariaLabel}>
          {children}
        </div>
      )}
    </div>
  );
}
