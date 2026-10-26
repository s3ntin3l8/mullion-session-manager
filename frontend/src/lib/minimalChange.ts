/** The smallest single replacement that turns `before` into `after`: what is
 * left once the common prefix and suffix are kept. Applying it instead of
 * replacing the whole document lets the editor carry the cursor, the selection
 * and the scroll position through an external update (a reload from disk after
 * an agent edited the file) — they only move if they sat inside what changed. */
export function minimalChange(
  before: string,
  after: string,
): { from: number; to: number; insert: string } {
  const max = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < max && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  ) {
    suffix++;
  }
  return {
    from: prefix,
    to: before.length - suffix,
    insert: after.slice(prefix, after.length - suffix),
  };
}
