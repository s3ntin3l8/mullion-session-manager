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
 * insert into unfamiliar prose — this mirrors `check-scaffold-region-sync.mjs`'s
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

/**
 * Per line of a markdown document: true when the line is "top level" prose,
 * false when it sits inside a leading YAML frontmatter block, a fenced code
 * block (matched on fence character and length, at most 3 spaces of indent,
 * as CommonMark does) or a multi-line HTML comment. Used to find structure
 * (a `## ` heading, a bare import line) without being fooled by examples
 * quoted inside code or comments. Deliberately small, not a markdown parser:
 * callers fall back to the safe behavior (append, leave alone) when nothing
 * qualifies.
 */
export function topLevelLines(lines: string[]): boolean[] {
  const out: boolean[] = new Array<boolean>(lines.length).fill(true);
  let i = 0;
  if (/^---\s*$/.test(lines[0] ?? "")) {
    const close = lines.findIndex((l, idx) => idx > 0 && /^(---|\.\.\.)\s*$/.test(l));
    if (close > 0) {
      for (let k = 0; k <= close; k++) out[k] = false;
      i = close + 1;
    }
  }
  let fence: { ch: string; len: number } | null = null;
  let inComment = false;
  for (; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    if (fence) {
      out[i] = false;
      const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len) fence = null;
      continue;
    }
    if (inComment) {
      out[i] = false;
      if (line.includes("-->")) inComment = false;
      continue;
    }
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      fence = { ch: f[1][0], len: f[1].length };
      out[i] = false;
      continue;
    }
    const open = line.lastIndexOf("<!--");
    if (open !== -1 && !line.includes("-->", open)) {
      out[i] = false;
      inComment = true;
    }
  }
  return out;
}

/**
 * Like `upsertMarkedRegion`, but when the markers are absent the new region
 * goes right after the document's leading title/intro (immediately before the
 * first top-level `## ` heading) instead of at the end of the file. A scaffold's
 * conventions are what every agent must read first; appended after a long
 * hand-written file they land below the rules they have to outrank. Whenever
 * EITHER marker is already present (a complete region, or a half-edited one)
 * this is exactly `upsertMarkedRegion`, and a file with no top-level `## `
 * heading also falls back to appending. Headings inside frontmatter, fenced
 * code or HTML comments are skipped. Setext (underlined) headings are not
 * recognised, so a region may land after one; that is cosmetic. A CRLF file
 * gets a CRLF region.
 */
export function upsertMarkedRegionAfterIntro(
  text: string,
  startMarker: string,
  endMarker: string,
  body: string,
): string {
  if (text.includes(startMarker) || text.includes(endMarker)) {
    return upsertMarkedRegion(text, startMarker, endMarker, body);
  }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const region = `${startMarker}\n${body.trim()}\n${endMarker}`.replace(/\n/g, eol);
  const lines = text.split("\n");
  const top = topLevelLines(lines);
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    if (top[i] && /^## /.test(lines[i])) {
      const head = text.slice(0, offset).trimEnd();
      const tail = text.slice(offset);
      return head.length === 0
        ? `${region}${eol}${eol}${tail}`
        : `${head}${eol}${eol}${region}${eol}${eol}${tail}`;
    }
    offset += lines[i].length + 1;
  }
  return upsertMarkedRegion(text, startMarker, endMarker, body);
}
