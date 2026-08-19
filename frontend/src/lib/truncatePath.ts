// Making notifications relevant/scannable — a permission-request summary
// like `external_directory /home/bjoern/.config/superpowers/worktrees/
// branchDAM/feat-sync-status-156/*` is almost entirely a shared prefix
// across every distinct row in a session: the ONLY part that tells two rows
// apart is the tail. CSS text-overflow:ellipsis always cuts the END of a
// string, which is exactly backwards for path-shaped text — every row in
// the bell/timeline rendered as the same-looking truncated prefix, which is
// what made the 20+ opencode permission rows in the motivating case
// indistinguishable from each other at a glance. This truncates the START
// instead, keeping the distinguishing tail visible.

/**
 * Truncates `text` from the head (not the tail) to at most `max` characters,
 * prefixing an ellipsis when truncation happens. Returns `text` unchanged if
 * it already fits. Not path-aware beyond that — a non-path string longer
 * than `max` gets the same head-truncation treatment, which is still the
 * right call for this module's callers (bell/timeline row text is
 * frequently a `describeEvent()` sentence ending in a path or a short
 * identifier, both of which read better from the tail).
 */
export function truncateHead(text: string, max: number): string {
  if (text.length <= max) return text;
  // Reserve one character for the ellipsis itself so the RESULT (not just
  // the kept suffix) never exceeds `max`.
  const keep = Math.max(0, max - 1);
  return `…${text.slice(text.length - keep)}`;
}
