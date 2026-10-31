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

// A branch name is the OTHER shape of long text: it starts with a shared
// prefix ("fix(dock): …") and ends with the part that tells two of them
// apart. Cutting only the tail (truncateHead) hides the distinguishing end;
// cutting only the head (CSS text-overflow: ellipsis) hides the fact that
// these are all the same kind of thing. So a label that must show BOTH ends
// gets cut in the middle instead — the start stays readable as a prefix, and
// the distinctive tail survives next to the ellipsis.
//
// Same contract as truncateHead: the RESULT never exceeds `max` (the
// ellipsis is reserved out of the budget), and a text that already fits is
// returned unchanged.
export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = Math.max(0, max - 1);
  // The head gets the extra character when the split is uneven, so the
  // result is exactly `max` characters long.
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}
