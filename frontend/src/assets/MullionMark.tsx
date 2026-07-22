/**
 * The Mullion brand mark: a 2x2 mosaic tile, one accent tile in emerald.
 * Rendered inline (not as an <img>) so the three neutral tiles pick up
 * `currentColor` from the surrounding text color and stay legible in both
 * the dark and light themes; the accent tile is a fixed brand green.
 */
export function MullionMark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <rect x="1" y="1" width="13.5" height="13.5" rx="2" fill="currentColor" />
      <rect x="17.5" y="1" width="13.5" height="13.5" rx="2" fill="currentColor" />
      <rect x="1" y="17.5" width="13.5" height="13.5" rx="2" fill="currentColor" />
      <rect x="17.5" y="17.5" width="13.5" height="13.5" rx="2" fill="#0e9f6e" />
    </svg>
  );
}
