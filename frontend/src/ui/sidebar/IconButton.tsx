import type { ButtonHTMLAttributes, ReactNode } from "react";

interface BaseProps {
  /** Required: an icon-only control must name itself. Also the tooltip. */
  label: string;
  children: ReactNode;
  /** Right-most "open on GitHub" treatment (full-strength glyph). */
  external?: boolean;
  /** Small status dot on the corner (e.g. clone health). */
  dot?: "success" | "warn" | "danger";
  className?: string;
}

type ButtonProps = BaseProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "className" | "aria-label"> & {
    href?: undefined;
  };
type LinkProps = BaseProps & { href: string; onClick?: undefined; disabled?: undefined };

export type IconButtonProps = ButtonProps | LinkProps;

export function IconButton(props: IconButtonProps) {
  const { label, children, external, dot, className } = props;
  const cls = ["sb-ibtn", external ? "sb-ibtn--ext" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  const dotEl = dot ? (
    <span className={`sb-ibtn-dot sb-ibtn-dot--${dot}`} aria-hidden="true" />
  ) : null;
  if (props.href !== undefined) {
    return (
      <a
        className={cls}
        href={props.href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={label}
        title={label}
      >
        {children}
        {dotEl}
      </a>
    );
  }
  const {
    label: _l,
    children: _c,
    external: _e,
    dot: _d,
    className: _cn,
    href: _h,
    ...rest
  } = props;
  return (
    <button type="button" {...rest} className={cls} aria-label={label} title={label}>
      {children}
      {dotEl}
    </button>
  );
}
