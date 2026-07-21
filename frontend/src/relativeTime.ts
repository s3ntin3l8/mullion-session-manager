// Shared "Nm/Nh/Nd ago" formatter — originally lived only in
// NotificationBell.tsx (for attention timestamps); extracted so
// Settings.tsx's "Last checked" staleness indicator (issue #123) can reuse
// the same behavior instead of duplicating it.
export function formatRelativeAge(epochMs: number): string {
  const deltaSec = Math.max(0, Math.round((Date.now() - epochMs) / 1000));
  if (deltaSec < 45) return "just now";
  const deltaMin = Math.round(deltaSec / 60);
  if (deltaMin < 60) return `${deltaMin}m ago`;
  const deltaHour = Math.round(deltaMin / 60);
  if (deltaHour < 24) return `${deltaHour}h ago`;
  const deltaDay = Math.round(deltaHour / 24);
  return `${deltaDay}d ago`;
}
