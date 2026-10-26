import type { ReactNode } from "react";
import type { Tone } from "../../lib/statusTone.js";

export interface StatusChipProps {
  tone: Tone;
  /** Full text; hidden in compact density when `short` is given. */
  children: ReactNode;
  /** Compact-density replacement text (`✗1`, an icon, ...). */
  short?: ReactNode;
  mono?: boolean;
  /** Makes the chip a button (used by StatusTriad). */
  onClick?: () => void;
  pressed?: boolean;
  title?: string;
  className?: string;
}

export function StatusChip({
  tone,
  children,
  short,
  mono,
  onClick,
  pressed,
  title,
  className,
}: StatusChipProps) {
  const cls = ["sb-chip", `sb-chip--${tone}`, mono ? "sb-chip--mono" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  const body =
    short === undefined ? (
      children
    ) : (
      <>
        <span className="sb-chip-full">{children}</span>
        <span className="sb-chip-short">{short}</span>
      </>
    );
  if (onClick) {
    return (
      <button type="button" className={cls} onClick={onClick} aria-expanded={pressed} title={title}>
        {body}
      </button>
    );
  }
  return (
    <span className={cls} title={title}>
      {body}
    </span>
  );
}
