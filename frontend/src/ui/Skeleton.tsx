import { useSyncExternalStore } from "react";
import type { CSSProperties, ReactNode } from "react";

// Issue #1885 — twenty-plus panels used to print the word "Loading…" while
// data was in flight. A word has no shape, so the panel jumps when the real
// content lands, and a screen reader hears nothing but that word. This is
// the shared bone those surfaces compose into the layout they are standing
// in for. Adopting it everywhere else is a follow-up; each surface's shape
// differs.

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void): () => void {
  // A non-browser host (or a test that tore matchMedia down) has nothing to
  // subscribe to. The bone then stays on the snapshot it already took.
  // `typeof window.matchMedia` still evaluates `window`, which throws
  // ReferenceError when the host is undefined (SSR). Check the host first.
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const media = window.matchMedia(REDUCED_MOTION_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

function usePrefersReducedMotion(): boolean {
  // Server snapshot is "no preference": there is no window during SSR, and
  // a static bone is the safe first paint either way.
  return useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion, () => false);
}

function cssLength(value: number | string): string {
  return typeof value === "number" ? `${value}px` : value;
}

function cx(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export interface SkeletonProps {
  /** CSS length. A number is pixels. Defaults to filling the row. */
  width?: number | string;
  /** CSS length. A number is pixels. Defaults to a text-line height. */
  height?: number | string;
  /** Corner radius. A number is pixels. */
  radius?: number | string;
  className?: string;
  style?: CSSProperties;
}

/** One shape-preserving placeholder bone.
 *
 * Always `aria-hidden`: a shimmering block is not content, and announcing
 * each bone would be noise. The surrounding region carries the loading
 * state (`SkeletonRegion`: a visually-hidden status, with `aria-busy` on
 * the bones and not on an ancestor of that status).
 *
 * The shimmer is motion for its own sake — it only says "still working".
 * When the user has asked the OS to stop moving things, the bone is a
 * static block. tokens.css's universal reduced-motion reset only shortens
 * an animation to one 0.01ms iteration; it does not remove the sweep. The
 * class is omitted entirely so there is no shimmer to shorten. */
export function Skeleton({ width, height, radius, className, style }: SkeletonProps) {
  const reducedMotion = usePrefersReducedMotion();
  return (
    <div
      aria-hidden="true"
      className={cx("ui-skeleton", !reducedMotion && "ui-skeleton-shimmer", className)}
      style={{
        ...(width !== undefined ? { width: cssLength(width) } : null),
        ...(height !== undefined ? { height: cssLength(height) } : null),
        ...(radius !== undefined ? { borderRadius: cssLength(radius) } : null),
        ...style,
      }}
    />
  );
}

/** The loading region around a group of bones.
 *
 * The visually-hidden status is what a screen reader actually announces —
 * `aria-busy` alone is not reliably spoken, and a second visible "Loading…"
 * would put the word this primitive exists to retire back on screen.
 * `aria-busy` sits on the bones, not around the status: ARIA tells
 * assistive technology to defer announcements inside a busy subtree, so a
 * status nested under `aria-busy` would never be spoken. The bones are
 * `aria-hidden` so the status text is the only accessible content. */
export function SkeletonRegion({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className}>
      <span className="visually-hidden" role="status">
        {label}
      </span>
      <div className="ui-skeleton-bones" aria-hidden="true" aria-busy="true">
        {children}
      </div>
    </div>
  );
}
