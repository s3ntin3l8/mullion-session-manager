// `clampToBytes` is shared by project-briefing.ts (a project's own pinned
// operating note) and mullion-scaffold.ts's `upsertMarkedRegion` (writing a
// delimited region into a scaffolded file), so "carry/author a delimited
// slice of a doc" features use exactly one truncation behavior — not two
// independently-drifting implementations of the same idea. `extractMarkedRegion`
// itself has no production caller of its own as of issue #949 (which
// removed agent-guide.ts's `readAgentGuideExcerpt`, the last one) — kept
// here as `upsertMarkedRegion`'s natural read-side counterpart and exercised
// directly by this file's own test suite plus mullion-scaffold.test.ts's
// round-trip assertions against `upsertMarkedRegion`'s output. Any future
// caller reading a marked region should use its own marker-string constant,
// same posture the removed caller and project-briefing.ts's
// `mullion:briefing:*` constants both had — so two features' regions can
// never cross-match each other.

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

/**
 * PR-6 (scaffold Mullion integration as a PR) — the write-side counterpart
 * `extractMarkedRegion` above never needed: every EXISTING caller
 * (agent-guide.ts, project-briefing.ts) only ever READS a region a human
 * already committed by hand. Scaffolding is the first caller that needs to
 * AUTHOR one. Pure string-in, string-out (mullion-scaffold.ts's own
 * "current contents in, target contents out" contract) — no filesystem
 * access here, same posture as extractMarkedRegion/clampToBytes.
 *
 * If both markers are already present (a re-run over a previous scaffold,
 * or a repo that already committed a region by hand), replaces everything
 * from `startMarker` through `endMarker` in place — the surrounding
 * document is left untouched, and a pre-existing region's content is fully
 * superseded, not merged with. If either marker is missing, appends a new
 * region to the end of `text` instead (separated by a blank line from
 * whatever's already there), rather than refusing or guessing where to
 * insert into unfamiliar prose — this mirrors `check-briefing-sync.mjs`'s
 * own byte-identical-region assumption: a fresh region always starts
 * unambiguous only when appended, never spliced mid-paragraph. `body` is
 * trimmed before being placed between the markers, so callers don't need
 * to worry about leading/trailing whitespace producing a visually
 * inconsistent region across repeated calls.
 */
export function upsertMarkedRegion(
  text: string,
  startMarker: string,
  endMarker: string,
  body: string,
): string {
  const region = `${startMarker}\n${body.trim()}\n${endMarker}`;
  const startIdx = text.indexOf(startMarker);
  const endIdx = startIdx === -1 ? -1 : text.indexOf(endMarker, startIdx + startMarker.length);
  if (startIdx !== -1 && endIdx !== -1) {
    const before = text.slice(0, startIdx);
    const after = text.slice(endIdx + endMarker.length);
    return `${before}${region}${after}`;
  }
  const trimmedText = text.trim();
  if (trimmedText.length === 0) return `${region}\n`;
  return `${trimmedText}\n\n${region}\n`;
}
