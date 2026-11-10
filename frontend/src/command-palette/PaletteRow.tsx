import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";

// One row shell for every `cmd-row` in the command palette (issue #2409).
// The five sites already disagreed — icon size, the background mix, whether
// a subtitle span exists, `type="button"`, and the availability indicator —
// and those differences are kept by the caller. This component only owns
// the shared markup so a sixth copy cannot grow a seventh class name.
export interface PaletteRowProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "className" | "onClick" | "onMouseEnter" | "title"
> {
  selected?: boolean;
  onClick: () => void;
  onMouseEnter?: () => void;
  icon: ReactNode;
  iconStyle?: CSSProperties;
  // Appended after `cmd-row-icon` (the launcher logo's `cmd-row-icon-logo`).
  iconClassName?: string;
  title: ReactNode;
  // `undefined` omits the subtitle span. An empty string keeps an empty
  // span, which is what command rows have always rendered.
  subtitle?: ReactNode;
  trailing?: ReactNode;
  // The tooltip. Named apart from the row's visible title.
  rowTitle?: string;
}

export function PaletteRow({
  selected = false,
  onClick,
  onMouseEnter,
  icon,
  iconStyle,
  iconClassName,
  title,
  subtitle,
  trailing,
  rowTitle,
  type,
  ...buttonProps
}: PaletteRowProps) {
  return (
    <button
      // React omits an attribute whose value is `undefined`, so a caller
      // that leaves `type` unset still renders no attribute. Command rows
      // and the project picker pass "button"; session, workspace and
      // launcher rows do not.
      type={type}
      {...buttonProps}
      className={`cmd-row${selected ? " selected" : ""}`}
      title={rowTitle}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
    >
      <span
        className={iconClassName ? `cmd-row-icon ${iconClassName}` : "cmd-row-icon"}
        style={iconStyle}
      >
        {icon}
      </span>
      <span className="cmd-row-body">
        <span className="cmd-row-title">{title}</span>
        {subtitle !== undefined && <span className="cmd-row-subtitle">{subtitle}</span>}
      </span>
      {trailing}
    </button>
  );
}
