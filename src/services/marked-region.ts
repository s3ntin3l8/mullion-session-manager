// `clampToBytes` is shared by project-briefing.ts (a project's own pinned
// operating note) and mullion-scaffold.ts's `upsertMarkedRegion` (writing a
// delimited region into a scaffolded file), so "carry/author a delimited
// slice of a doc" features use exactly one truncation behavior — not two
// independently-drifting implementations of the same idea. `extractMarkedRegion`
// is `upsertMarkedRegion`'s read-side counterpart (used by mullion-scaffold.ts
// to read back an existing `mullion:moved` region in CONTRIBUTING.md, and by
// the test suites for round-trip assertions against `upsertMarkedRegion`'s
// output). Every caller reading or writing a marked region uses its own
// marker-string constant (`mullion:briefing:*`, `mullion:pointer:*`,
// `mullion:moved:*`, `mullion:worktrees:*`) so two features' regions can
// never cross-match each other.

/**
 * Returns the text strictly between the first top-level standalone
 * `startMarker` line and the first `endMarker` line that closes it, trimmed.
 * `null` if either marker is absent or the end marker precedes the start —
 * never throws, since "no marked region" is the overwhelmingly common,
 * expected case for both callers. Only markers standing alone on a top-level
 * line count. Occurrences inside a longer token, inline prose or code spans,
 * or frontmatter are ignored; a fenced code block only hides marker lines
 * when it directly wraps a quoted marker example (the pair alone, or on the
 * first and last lines inside the fence), while a fence whose pair has
 * surrounding lines leaves those markers top-level; and because a stray
 * `<!--` must not swallow a region marker, a standalone marker line aborts a
 * multi-line HTML comment search so it is treated as top-level rather than
 * hidden. Deliberately first-region-only, not a multi-region concat: one
 * region per file keeps the byte budget predictable and the source easy to
 * reason about at a glance.
 */
export function extractMarkedRegion(
  text: string,
  startMarker: string,
  endMarker: string,
): string | null {
  const { pairs } = findMarkedRegions(text, startMarker, endMarker);
  if (pairs.length === 0) return null;
  return text.slice(pairs[0].start.lineEndWithoutEol, pairs[0].end.lineStart).trim();
}

/**
 * Returns `text` with the first complete top-level marked region (from its
 * `startMarker` line through the end of its `endMarker` line, without
 * consuming the `endMarker` line's trailing newline) removed. Returns `text`
 * unchanged when no complete pair is present. Uses the same standalone
 * top-level line matching as `extractMarkedRegion` and `upsertMarkedRegion`,
 * so a marker embedded in a longer token, inline code/prose, frontmatter, or
 * a fence directly wrapping a quoted marker example is never mistaken for a
 * region boundary, while markers inside a multi-line comment or a fence with
 * surrounding lines stay top-level.
 */
export function stripMarkedRegion(text: string, startMarker: string, endMarker: string): string {
  const { pairs } = findMarkedRegions(text, startMarker, endMarker);
  if (pairs.length === 0) return text;
  const first = pairs[0];
  return text.slice(0, first.start.lineStart) + text.slice(first.end.lineEndWithoutEol);
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

/** The marked region as it is written into a file whose line endings are
 * `eol`. The body's own endings are normalized first so a CRLF body never
 * becomes `\r\r\n`. */
function buildRegion(startMarker: string, endMarker: string, body: string, eol: string): string {
  return `${startMarker}\n${body.trim().replace(/\r\n/g, "\n")}\n${endMarker}`.replace(/\n/g, eol);
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
 * Only markers standing alone on a top-level line count; a marker that is
 * part of a longer token (e.g. `# mullion:worktrees:started-by-hand`),
 * mentioned inline in prose or an inline code span, inside YAML frontmatter,
 * or inside a fenced code block directly wrapping a quoted marker example
 * (the pair alone, or on the first and last lines inside the fence) is left
 * untouched and ignored when locating a region (a fence whose pair has
 * surrounding lines leaves those markers top-level; and because a stray
 * `<!--` must not swallow a region marker, a standalone marker line aborts a
 * multi-line HTML comment search so it is treated as top-level rather than
 * hidden).
 *
 * If a complete, correctly ordered marker pair is already present (a re-run
 * over a previous scaffold, or a repo that already committed a region by
 * hand), replaces everything from `startMarker` through `endMarker` in
 * place — a pre-existing region's content is fully superseded, not merged
 * with — and strips any unmatched (orphan) standalone marker lines outside
 * complete pairs (e.g. a stray start before or after the region), while
 * leaving any subsequent complete pair intact. If there is no complete pair,
 * any orphan standalone marker line (a lone one, or an end before the start)
 * is first removed, keeping the text around it, so a half-edited file never
 * ends up with two start markers; then a new region is appended to the end
 * of `text` instead (separated by a blank line from whatever's already
 * there), rather than refusing or guessing where to insert into unfamiliar
 * prose — this mirrors `check-scaffold-region-sync.mjs`'s own
 * byte-identical-region assumption: a fresh region always starts unambiguous
 * only when appended, never spliced mid-paragraph. `body` is trimmed before
 * being placed between the markers, so callers don't need to worry about
 * leading/trailing whitespace producing a visually inconsistent region
 * across repeated calls. A CRLF file (one containing `\r\n`) gets a CRLF
 * region on every path, with `body`'s own line endings normalized first, so
 * a re-run writes back the same bytes.
 */
export function upsertMarkedRegion(
  text: string,
  startMarker: string,
  endMarker: string,
  body: string,
): string {
  // A CRLF file gets a CRLF region on every path, so a re-run replacing it in
  // place writes back the same bytes instead of flipping the endings.
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const region = buildRegion(startMarker, endMarker, body, eol);
  const { pairs, orphans } = findMarkedRegions(text, startMarker, endMarker);
  if (pairs.length > 0) {
    const first = pairs[0];
    const before = dropMarkerLines(
      text,
      orphans.filter((m) => m.lineEnd <= first.start.lineStart),
      0,
      first.start.lineStart,
    );
    const after = dropMarkerLines(
      text,
      orphans.filter((m) => m.lineStart >= first.end.lineEndWithoutEol),
      first.end.lineEndWithoutEol,
      text.length,
    );
    return `${before}${region}${after}`;
  }
  // No complete, correctly ordered pair: a lone marker (or an end before the
  // start) is a half-edited region. Drop it, keeping the text around it, or
  // the appended region would sit next to it and leave two start markers.
  const trimmedText = dropMarkerLines(text, orphans).trim();
  if (trimmedText.length === 0) return `${region}${eol}`;
  return `${trimmedText}${eol}${eol}${region}${eol}`;
}

const DEFAULT_START_MARKER_RE = /^[ \t]*<!--\s*mullion:[\w-]+:start\s*-->[ \t]*$/;
const DEFAULT_END_MARKER_RE = /^[ \t]*<!--\s*mullion:[\w-]+:end\s*-->[ \t]*$/;

/**
 * Per line of a markdown document: true when the line is "top level" prose,
 * false when it sits inside a closed leading YAML frontmatter block, a closed
 * fenced code block (matched on fence character and length, at most 3 spaces
 * of indent, as CommonMark does), or a closed multi-line HTML comment. Only
 * balanced constructs hide the lines inside them — an unclosed fence opener or
 * stray `<!--` leaves the rest of the document top-level so a broken snippet
 * cannot swallow a marked region or heading further down. A fence span may not
 * extend across a region boundary (only a fence that directly wraps a quoted
 * marker example hides its marker lines). Used to find structure (a `## `
 * heading, a bare import line, a standalone region marker) without being
 * fooled by examples quoted inside code or comments. Deliberately small, not a
 * markdown parser: callers fall back to the safe behavior (append, leave
 * alone) when nothing qualifies.
 */
export function topLevelLines(
  lines: string[],
  startMarker?: string,
  endMarker?: string,
): boolean[] {
  const out: boolean[] = new Array<boolean>(lines.length).fill(true);
  const startRe =
    startMarker !== undefined
      ? new RegExp(`^[ \\t]*${escapeRegExp(startMarker)}[ \\t]*$`)
      : DEFAULT_START_MARKER_RE;
  const endRe =
    endMarker !== undefined
      ? new RegExp(`^[ \\t]*${escapeRegExp(endMarker)}[ \\t]*$`)
      : DEFAULT_END_MARKER_RE;
  let i = 0;
  if (/^---\s*$/.test(lines[0] ?? "")) {
    const close = lines.findIndex((l, idx) => idx > 0 && /^(---|\.\.\.)\s*$/.test(l));
    // A `---` first line is frontmatter only if what follows looks like YAML
    // (empty, or the first non-blank line is `key:`, a list item or a
    // comment). Otherwise it is a thematic break, and a second `---` further
    // down would wrongly hide every heading in between.
    const firstBody = lines.slice(1, close === -1 ? 1 : close).find((l) => l.trim() !== "");
    const looksYaml = firstBody === undefined || /^([\w.-]+\s*:|- |#)/.test(firstBody.trim());
    if (close > 0 && looksYaml) {
      for (let k = 0; k <= close; k++) out[k] = false;
      i = close + 1;
    }
  }
  for (; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (f) {
      const close = findClosingFenceLine(
        lines,
        i,
        f[1][0],
        f[1].length,
        f[2].trim() !== "",
        startRe,
        endRe,
      );
      if (close !== -1) {
        for (let k = i; k <= close; k++) out[k] = false;
        i = close;
        continue;
      }
    }
    const open = line.lastIndexOf("<!--");
    if (open !== -1 && !line.includes("-->", open)) {
      const close = findClosingCommentLine(lines, i + 1);
      if (close !== -1) {
        for (let k = i; k <= close; k++) out[k] = false;
        i = close;
        continue;
      }
    }
  }
  return out;
}

function findClosingFenceLine(
  lines: string[],
  openLine: number,
  ch: string,
  len: number,
  openerHasInfo: boolean,
  startRe: RegExp,
  endRe: RegExp,
): number {
  let close = -1;
  let bareCount = 0;
  for (let k = openLine + 1; k < lines.length; k++) {
    const line = lines[k].replace(/\r$/, "");
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!m || m[1][0] !== ch || m[1].length < len) continue;
    if (m[2].trim() === "") {
      if (close === -1) close = k;
      bareCount++;
      if (!openerHasInfo) break;
      continue;
    }
    // A fence of the same char and length with an info string cannot be nested
    // inside an outer fence of the same char and length (its closing fence
    // would close the outer one first), so seeing one before any closer means
    // the earlier opener was left unclosed.
    if (m[1].length === len) {
      if (close === -1) return -1;
      break;
    }
  }
  if (close === -1) return -1;
  // An info-string opener (` ```bash `) followed by an even number of bare
  // fences before the next info-string opener was left unclosed: the bare
  // fences pair with each other (` ```\nplain\n``` `), and stealing the first
  // one as a closer here would leave the last one dangling.
  if (openerHasInfo && bareCount % 2 === 0) return -1;
  if (fenceSwallowsMarker(lines, openLine, close, startRe, endRe)) {
    return -1;
  }
  return close;
}

function fenceSwallowsMarker(
  lines: string[],
  openLine: number,
  closeLine: number,
  startRe: RegExp,
  endRe: RegExp,
): boolean {
  const isMarker = (idx: number): boolean => {
    const raw = lines[idx].replace(/\r$/, "");
    return startRe.test(raw) || endRe.test(raw);
  };
  let hasMarker = false;
  for (let k = openLine + 1; k < closeLine; k++) {
    if (isMarker(k)) {
      hasMarker = true;
      break;
    }
  }
  if (!hasMarker) return false;
  // A fence may only contain a marker line when the fence directly wraps a
  // quoted marker example: either a single marker line
  // (` ```html\n<!-- start -->\n``` `) or a `startMarker ... endMarker` block
  // with the markers on the first and last lines inside the fence. A pair with
  // surrounding lines inside the fence is deliberately treated as a real
  // region swallowed by an unclosed fence rather than a quoted example, so an
  // unclosed bare fence before the region cannot hide it.
  if (closeLine === openLine + 2) return false;
  const first = lines[openLine + 1].replace(/\r$/, "");
  const last = lines[closeLine - 1].replace(/\r$/, "");
  if (!startRe.test(first) || !endRe.test(last)) return true;
  for (let k = openLine + 2; k < closeLine - 1; k++) {
    if (isMarker(k)) return true;
  }
  return false;
}

function findClosingCommentLine(lines: string[], from: number): number {
  for (let k = from; k < lines.length; k++) {
    const closeIdx = lines[k].indexOf("-->");
    const openIdx = lines[k].indexOf("<!--");
    // HTML comments do not nest: a new `<!--` before any `-->` (including a
    // standalone `<!-- mullion:...:start -->` marker line) means the earlier
    // `<!--` was left unclosed rather than wrapping this line.
    if (openIdx !== -1 && (closeIdx === -1 || openIdx < closeIdx)) return -1;
    if (closeIdx !== -1) return k;
  }
  return -1;
}

interface MarkerLine {
  lineStart: number;
  lineEndWithoutEol: number;
  lineEnd: number;
}

interface MarkedRegionPair {
  start: MarkerLine;
  end: MarkerLine;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Pairs standalone top-level `startMarker` and `endMarker` lines and reports
 * any unmatched ones as `orphans`. A marker embedded in a longer token, in
 * inline code or prose, in frontmatter, or inside a fenced code block directly
 * wrapping a quoted marker example (the pair alone, or on the first and last
 * lines inside the fence) is ignored so it is neither mistaken for a region
 * boundary nor stripped as an orphan. A fence whose pair has surrounding lines
 * leaves those markers top-level; and because a stray `<!--` must not swallow a
 * region marker, a standalone marker line aborts a multi-line HTML comment
 * search so it is treated as top-level rather than hidden.
 */
function findMarkedRegions(
  text: string,
  startMarker: string,
  endMarker: string,
): { pairs: MarkedRegionPair[]; orphans: MarkerLine[] } {
  const startRe = new RegExp(`^[ \\t]*${escapeRegExp(startMarker)}[ \\t]*$`);
  const endRe = new RegExp(`^[ \\t]*${escapeRegExp(endMarker)}[ \\t]*$`);
  const lines = text.split("\n");
  const top = topLevelLines(lines, startMarker, endMarker);
  const pairs: MarkedRegionPair[] = [];
  const orphans: MarkerLine[] = [];
  let openStart: MarkerLine | null = null;
  let offset = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\r$/, "");
    const lineStart = offset;
    const lineEndWithoutEol = offset + raw.length;
    const lineEnd = i < lines.length - 1 ? offset + lines[i].length + 1 : text.length;
    offset = lineEnd;

    if (!top[i]) continue;
    if (startRe.test(raw)) {
      const m: MarkerLine = { lineStart, lineEndWithoutEol, lineEnd };
      if (openStart) orphans.push(openStart);
      openStart = m;
    } else if (endRe.test(raw)) {
      const m: MarkerLine = { lineStart, lineEndWithoutEol, lineEnd };
      if (openStart) {
        pairs.push({ start: openStart, end: m });
        openStart = null;
      } else {
        orphans.push(m);
      }
    }
  }
  if (openStart) orphans.push(openStart);
  return { pairs, orphans };
}

/** Returns `text.slice(from, to)` with each line in `toDrop` removed whole. */
function dropMarkerLines(text: string, toDrop: MarkerLine[], from = 0, to = text.length): string {
  let out = "";
  let cursor = from;
  for (const m of toDrop) {
    out += text.slice(cursor, m.lineStart);
    cursor = m.lineEnd;
  }
  out += text.slice(cursor, to);
  return out;
}

/**
 * Like `upsertMarkedRegion`, but when the markers are absent the new region
 * goes right after the document's leading title/intro (immediately before the
 * first top-level `## ` heading) instead of at the end of the file. A scaffold's
 * conventions are what every agent must read first; appended after a long
 * hand-written file they land below the rules they have to outrank. A complete
 * region already in the file is replaced IN PLACE, exactly as
 * `upsertMarkedRegion` does, so a repo scaffolded before this placement
 * existed keeps its region where it is (moving it would make a re-scaffold's
 * diff noisy for no benefit). A half-edited file (one marker, or the end
 * before the start) has its orphan marker removed, keeping the text around
 * it, and then gets a fresh region placed as for a new file; appending a
 * second region next to the orphan would leave two start markers, and the
 * next run would then replace everything between them. A file with no
 * top-level `## ` heading falls back to appending. Headings inside
 * frontmatter, fenced code or HTML comments are skipped. Setext (underlined) headings are not
 * recognised, so a region may land after one; that is cosmetic. A CRLF file
 * gets a CRLF region.
 */
export function upsertMarkedRegionAfterIntro(
  text: string,
  startMarker: string,
  endMarker: string,
  body: string,
): string {
  const { pairs, orphans } = findMarkedRegions(text, startMarker, endMarker);
  if (pairs.length > 0) {
    return upsertMarkedRegion(text, startMarker, endMarker, body);
  }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  // upsertMarkedRegion drops orphan markers too, but the heading search below
  // must run on the cleaned text, so the strip happens here first.
  text = dropMarkerLines(text, orphans);
  const region = buildRegion(startMarker, endMarker, body, eol);
  const lines = text.split("\n");
  const top = topLevelLines(lines, startMarker, endMarker);
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
