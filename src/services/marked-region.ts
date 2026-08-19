// Shared by agent-guide.ts (Mullion's own doc excerpt) and
// project-briefing.ts (a project's own operating instructions), so both
// "carry a delimited slice of a doc into a session's context" features use
// exactly one marker syntax and one truncation behavior — not two
// independently-drifting implementations of the same idea. The two callers
// use DIFFERENT marker strings (`mullion:tier1:*` vs `mullion:briefing:*`,
// each caller's own constant) precisely so they can't cross-match each
// other's regions; only the extraction/clamping logic is shared here.

/**
 * Returns the text strictly between the first `startMarker` and the first
 * `endMarker` that follows it, trimmed. `null` if either marker is absent or
 * the end marker precedes the start — never throws, since "no marked
 * region" is the overwhelmingly common, expected case for both callers.
 * Deliberately first-region-only, not a multi-region concat: one region per
 * file keeps the byte budget predictable and the source easy to reason
 * about at a glance.
 */
export function extractMarkedRegion(
  text: string,
  startMarker: string,
  endMarker: string,
): string | null {
  const startIdx = text.indexOf(startMarker);
  if (startIdx === -1) return null;
  const contentStart = startIdx + startMarker.length;
  const endIdx = text.indexOf(endMarker, contentStart);
  if (endIdx === -1) return null;
  return text.slice(contentStart, endIdx).trim();
}

/**
 * Byte-caps `text` to `maxBytes`, always landing on a UTF-8 code point
 * boundary (never splitting a multibyte character mid-sequence), and
 * appends a truncation marker naming `sourceLabel` when truncation actually
 * happened. Returns `text` unchanged (no marker appended) when it already
 * fits.
 */
export function clampToBytes(text: string, maxBytes: number, sourceLabel: string): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return text;
  // TextDecoder with fatal:false replaces a boundary-split trailing
  // sequence with U+FFFD instead of throwing; strip it so the truncation
  // marker reads cleanly rather than "...word�\n\n[mullion: truncated...".
  const truncated = new TextDecoder("utf-8", { fatal: false })
    .decode(buf.subarray(0, maxBytes))
    .replace(/�+$/, "");
  return `${truncated}\n\n[mullion: truncated at ${maxBytes} bytes — full text at ${sourceLabel}]`;
}
