import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useTooltip } from "./useTooltip.js";

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
  // Instant-on-focus, 200ms-on-hover tooltip instead of the native `title`
  // (browser-controlled ~1s delay, no keyboard-focus display). The name for
  // assistive tech stays `aria-label`.
  const { setAnchor, triggerProps, tooltip, tooltipId, open } = useTooltip<HTMLElement>(label);
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
        aria-describedby={open ? tooltipId : undefined}
        ref={setAnchor}
        {...triggerProps}
      >
        {children}
        {dotEl}
        {tooltip}
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
    <button
      type="button"
      {...rest}
      className={cls}
      aria-label={label}
      aria-describedby={open ? tooltipId : undefined}
      ref={setAnchor}
      onPointerEnter={(e) => {
        rest.onPointerEnter?.(e);
        triggerProps.onPointerEnter(e);
      }}
      onPointerLeave={(e) => {
        rest.onPointerLeave?.(e);
        triggerProps.onPointerLeave(e);
      }}
      onPointerDown={(e) => {
        rest.onPointerDown?.(e);
        triggerProps.onPointerDown(e);
      }}
      onFocus={(e) => {
        rest.onFocus?.(e);
        triggerProps.onFocus(e);
      }}
      onBlur={(e) => {
        rest.onBlur?.(e);
        triggerProps.onBlur(e);
      }}
    >
      {children}
      {dotEl}
      {tooltip}
    </button>
  );
}
