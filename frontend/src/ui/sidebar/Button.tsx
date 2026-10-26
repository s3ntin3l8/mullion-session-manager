import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md";
  /** Full width, centred. */
  block?: boolean;
}

export function Button({
  variant = "secondary",
  size = "md",
  block,
  className,
  type = "button",
  ...rest
}: ButtonProps) {
  const cls = [
    "sb-btn",
    `sb-btn--${variant}`,
    size === "sm" ? "sb-btn--sm" : "",
    block ? "sb-btn--block" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return <button type={type} {...rest} className={cls} />;
}
