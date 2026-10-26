import type { ReactNode } from "react";

export interface SidebarRowProps {
  /** Status glyph / dot. Moves into the title line in compact density. */
  lead?: ReactNode;
  title: ReactNode;
  /** One ellipsised line under the title. */
  meta?: ReactNode;
  /** Free block under the meta line (pills, triad, drilldown). */
  extra?: ReactNode;
  /** Chips on the title line, right-aligned. */
  trailing?: ReactNode;
  /** Revealed on hover/focus; always visible on touch. */
  actions?: ReactNode;
  selected?: boolean;
  onClick?: () => void;
  className?: string;
}

/**
 * The keyboard/AT target is a real `<button>` around the title, so the nested
 * `actions` buttons are siblings of it, never descendants of a role="button".
 * Clicking anywhere else on the row (mouse only) activates it too.
 */
export function SidebarRow({
  lead,
  title,
  meta,
  extra,
  trailing,
  actions,
  selected,
  onClick,
  className,
}: SidebarRowProps) {
  const cls = [
    "sb-row",
    lead == null ? "sb-row--nolead" : "",
    onClick ? "sb-row--clickable" : "",
    selected ? "sb-row--sel" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    // Mouse convenience only; the title <button> is the keyboard/AT target.
    <div className={cls} onClick={onClick}>
      {lead != null && <span className="sb-row-lead">{lead}</span>}
      <div className="sb-row-body">
        {onClick ? (
          <button
            type="button"
            className="sb-row-title sb-row-title--btn"
            aria-current={selected ? "true" : undefined}
            onClick={(e) => {
              // The row div handles the click; don't run onClick twice.
              e.stopPropagation();
              onClick();
            }}
          >
            {title}
          </button>
        ) : (
          <div className="sb-row-title">{title}</div>
        )}
        {meta != null && <span className="sb-row-meta">{meta}</span>}
        {extra != null && (
          // Drilldowns/triads live here; their clicks are theirs, not the row's.
          <div className="sb-row-extra" onClick={(e) => e.stopPropagation()}>
            {extra}
          </div>
        )}
      </div>
      {(trailing != null || actions != null) && (
        <div className="sb-row-trail" onClick={(e) => e.stopPropagation()}>
          {actions != null && <span className="sb-row-actions">{actions}</span>}
          {trailing}
        </div>
      )}
    </div>
  );
}
