import type { KeyboardEvent, ReactNode } from "react";

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
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Only the row itself: Enter/Space on a nested action button must not
    // also activate the row.
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick?.();
    }
  };
  const cls = [
    "sb-row",
    lead == null ? "sb-row--nolead" : "",
    selected ? "sb-row--sel" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      className={cls}
      data-compact-row=""
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-current={selected ? "true" : undefined}
      onClick={onClick}
      onKeyDown={onClick ? onKeyDown : undefined}
    >
      {lead != null && <span className="sb-row-lead">{lead}</span>}
      <div className="sb-row-body">
        <div className="sb-row-title">{title}</div>
        {meta != null && <span className="sb-row-meta">{meta}</span>}
        {extra != null && <div className="sb-row-extra">{extra}</div>}
      </div>
      {(trailing != null || actions != null) && (
        <div className="sb-row-trail">
          {actions != null && (
            <span className="sb-row-actions" onClick={(e) => e.stopPropagation()}>
              {actions}
            </span>
          )}
          {trailing}
        </div>
      )}
    </div>
  );
}
