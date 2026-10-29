import { useEffect, useRef, useState, type ReactNode } from "react";
import { IconButton } from "./IconButton.js";

/**
 * An icon button that opens a small panel under it: a filter's checkboxes, a
 * sort's choices. `badge` is the count of what is active inside (a filter),
 * shown on the icon so a closed popover still says it is doing something.
 * Click outside or Escape closes it and returns focus to the button.
 */
export function IconPopover({
  label,
  icon,
  badge = 0,
  children,
}: {
  /** The button's name, and the panel's. */
  label: string;
  icon: ReactNode;
  badge?: number;
  children: ReactNode | ((close: () => void) => ReactNode);
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      rootRef.current?.querySelector<HTMLElement>(".sb-ibtn")?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="sb-pop" ref={rootRef}>
      <IconButton
        label={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={badge > 0 || open ? "sb-ibtn--on" : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        {icon}
        {badge > 0 && (
          <span className="sb-pop-badge" aria-hidden="true">
            {badge}
          </span>
        )}
      </IconButton>
      {open && (
        <div className="sb-pop-panel" role="dialog" aria-label={label}>
          {typeof children === "function" ? children(close) : children}
        </div>
      )}
    </div>
  );
}
