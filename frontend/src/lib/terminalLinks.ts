// Wrap-aware link detection for the terminal pane.
//
// Root cause this module exists to fix, verified against real bytes captured
// from a live Mullion session and replayed through the installed
// @xterm/xterm (v6.0.0): agent CLI TUIs (Claude Code, agy, codex) never let
// the terminal auto-wrap. They hard-position the cursor for every visual
// row instead — so a long URL becomes TWO INDEPENDENT buffer rows with
// `isWrapped === false`, unlike a genuine soft wrap (terminal-width
// reflow), which does set `isWrapped` on the continuation row.
//
// The stock @xterm/addon-web-links only joins rows while `isWrapped` is
// true, so it never sees the second half of a hard-wrapped URL — and worse,
// the first row's fragment still matches the URL regex *on its own*, so
// clicking it silently opens a truncated, WRONG destination
// (`https://github.com/s3ntin3l8/mullion-session` instead of the full PR
// URL). This module replaces that addon with a link provider that also
// reconstructs hard-wrapped URLs, under a heuristic designed so its only
// failure mode is "no link" — never "link to the wrong place". Terminal
// transcripts carry model-generated and remote content, so an over-eager
// join is strictly worse than the bug being fixed.
//
// --- Why the heuristic below is NOT "row ends near term.cols" ---
//
// The first, plan-approved draft of this heuristic gated a hard-wrap join
// on the producing row's content reaching within a few columns of the
// terminal's own width (`term.cols`). Real captured evidence from two live
// Mullion sessions falsifies that as the *only* signal:
//
//   Session A (this bug's own capture), cols ~58: a shell one-liner wraps
//   because it genuinely fills the terminal — row edge 57, i.e. cols-1.
//
//   Session B, cols 87 (a Claude Code diff view rendering a code comment):
//   the row containing `// https://react.dev/learn/you-might-n` ends at
//   column 50 — nowhere near cols-3=84. Confirmed by replaying the session's
//   own scrollback through a real xterm Terminal at its actual width
//   (see this PR's description for the replay). The diff pane wraps prose
//   at its OWN fixed inset width, unrelated to the terminal's.
//
// So "reaches the terminal's right margin" is real but not universal — an
// inset panel (line-numbered diff view, a bordered box) hard-wraps at ITS
// OWN column, which can be far short of `cols`. The fix: also accept a row
// as a plausible wrap point when another NEARBY row (small window — a
// coincidence there is far less likely than across a whole scrollback)
// ends at the exact same column. In session B, the row directly above the
// URL row (an unrelated comment line, "// Adjusting state during render
// (Reac") independently ends at that same column 50 — two rows in the same
// inset block sharing one wrap width is exactly the signal a fixed-width
// panel produces, and exactly what an unrelated coincidence is unlikely to.
//
// This corroboration signal alone is still not enough — in a large window
// two unrelated short lines CAN happen to end at the same column by chance.
// The real safety load is carried by a second, independent check applied to
// the *continuation row's own content*: it must contain a "structural" URL
// character (`/ ? # & =` or `%` — see STRUCTURAL_CHAR_RE's own comment for
// why this set is deliberately narrow) in the portion that would extend the
// match. A plain English continuation ("installed at /usr/lib" → chunk
// "installed" before the regex would stop, "not part of the url" → chunk
// "not", "Note: restart the daemon" → chunk "Note") essentially never has
// one; a URL path/fragment segment (`session-manager/pull/1234`,
// `ot-need-an-effect#adjusting-`) reliably does. Both real captures above
// pass this; the adversarial cases in this module's own tests fail it.
//
// Known, accepted residual gap: this can't distinguish a real URL path
// continuation from an unrelated line that ITSELF happens to open with a
// path-shaped token — an absolute filesystem path on the very next
// terminal row (`/var/log/syslog was rotated`) is lexically identical to a
// wrapped URL path segment, and no check on buffer content alone can tell
// them apart. This is NOT eliminated, only mitigated: by design (see
// TerminalPane.tsx's own `hoverLink`), a hover always shows the full
// reconstructed URL before any click — a link that reads
// "https://example.com/foo/var/log/syslog" is visibly wrong before it's
// ever opened. No heuristic here silently navigates anywhere; the worst
// case is a wrong-looking link the user chooses not to click.
//
// Depends only on this narrow structural slice of xterm's buffer API (not
// on `Terminal` itself) so the joining/matching logic can be unit-tested
// with hand-built fake buffers under the default `node` vitest environment,
// separately from `terminalLinks.xterm.test.ts`, which drives real captured
// byte sequences through a real `@xterm/xterm` Terminal under jsdom — the
// only way either of the two real-world cases above was actually caught.

/** Minimal structural slice of xterm's `IBufferCell`. */
export interface LinkBufferCell {
  getChars(): string;
}

/** Minimal structural slice of xterm's `IBufferLine`. */
export interface LinkBufferLine {
  readonly isWrapped: boolean;
  readonly length: number;
  translateToString(trimRight?: boolean): string;
  getCell(x: number): LinkBufferCell | undefined;
}

/** Minimal structural slice of xterm's `Terminal.buffer.active` + `cols`. */
export interface LinkBufferSource {
  readonly cols: number;
  getLine(y: number): LinkBufferLine | undefined;
}

// Copied verbatim from the installed @xterm/addon-web-links@0.12.0 bundle
// (`node_modules/@xterm/addon-web-links/lib/addon-web-links.js`) rather than
// reinvented — it's the addon's own proven, scheme-required URL pattern.
export const URL_REGEX =
  // eslint-disable-next-line no-useless-escape
  /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\\^<>`]*[^\s"':,.!?{}|\\\^~\[\]`()<>]/;

/** How close to the right margin a row's content must reach to be treated
 * as "hard-wrapped by the full terminal width". Slack absorbs a single
 * trailing box-border glyph, a double-width cell, or a stray padding
 * column. Not the only way a row can qualify — see `isEligibleWrapRow`. */
export const RIGHT_EDGE_SLACK = 3;

/** How many rows on either side of a candidate wrap row are searched for
 * another row ending at the exact same column (the "inset panel" signal —
 * see the module header). Deliberately small: a coincidental match becomes
 * likelier, not less likely, as the window grows. */
export const CORROBORATION_WINDOW = 6;

/** A row's content edge must reach at least this column before a nearby
 * matching edge is treated as corroboration at all — guards against short,
 * unrelated lines coincidentally ending at the same (small) column. */
export const MIN_CORROBORATION_EDGE = 16;

/** Cap on how many extra rows a single hard-wrap chain may pull in, mirrors
 * the spirit of the addon's own soft-wrap length cap below. */
export const MAX_HARD_WRAP_ROWS = 4;

/** Cap on total joined string length, matching the addon's own `i<2048`
 * guard in `LinkComputer._getWindowedLineStrings`. */
export const MAX_JOINED_LENGTH = 2048;

/** Cap on how many leading columns of plain whitespace (with or without a
 * gutter glyph) are stripped from a continuation row before treating it as
 * body text. Bounds a pathological "URL fragment appears after a huge,
 * unexplained blank run" case; sized to comfortably fit a line-numbered
 * diff view's gutter (~10 columns in the real capture above). */
export const MAX_GUTTER_COLUMNS = 16;

// A leading "gutter" a TUI commonly prefixes a continuation row with: plain
// indentation (Claude Code's own Ink renderer routinely re-indents wrapped
// text to align under its parent block, with NO glyph at all — confirmed
// against real captured bytes, where the indent is genuinely a run of
// space characters, not just unwritten cells) and/or a single box-drawing
// border, blockquote bar, "⎿" sub-result marker, ">"/"•" list marker.
const GUTTER_GLYPHS = "│┃║▏▕|⎿>•┆┊";
const GUTTER_RE = new RegExp(`^\\s*(?:[${GUTTER_GLYPHS}]\\s*)?`);

// A single trailing box-border glyph (and the whitespace immediately before
// it) that can sit just past a URL inside a bordered TUI panel.
const TRAILING_BORDER_RE = /[│┃║▏▕|]\s*$/;

// The addon's own "middle" character class (everything a URL body may
// contain except its final character, which excludes a few more
// punctuation marks that usually terminate a sentence rather than a URL).
// Used here only to find how much of a continuation row *could* extend a
// match, so the structural-character check below inspects the right slice.
const URL_MIDDLE_CHAR_RE = /[^\s"'!*(){}|\\^<>`]/;

// The character class that distinguishes "a URL path/query/fragment
// segment" from "the next word of an unrelated sentence". See the module
// header for why this — not the edge/corroboration check — carries the
// real safety weight for the hard-wrap case, and for why this set is
// deliberately narrow: `/ ? # & = %` are true URL path/query/fragment
// syntax, essentially never appearing in ordinary unpunctuated prose. An
// earlier, wider draft also accepted `. _ ~ : @ + -` and digits — all
// common in ordinary English ("Note:", "well-known", a date, a version
// number) — which a review caught wrongly joining unrelated lines like
// "Note: restart the daemon" onto a complete URL, appending "Note" to it.
// Verified: dropping those characters stops that specific class outright,
// including a real captured chunk ("hen-a-prop-changes", hyphens only)
// that now correctly fails to extend — a link stopping one row short of a
// non-essential trailing fragment segment is the safe direction, not a
// regression.
const STRUCTURAL_CHAR_RE = /[/?#&=%]/;

// A continuation row that itself starts a brand new http(s) URL is a
// second, distinct link, not a continuation of the first — never merge the
// two into one nonsensical string.
const NEW_SCHEME_RE = /^https?:\/\//i;

/** A contiguous slice of one buffer row contributing to a joined logical
 * line: `text` starts at buffer column `startCol` on `row`. */
export interface LinkSegment {
  row: number;
  startCol: number;
  text: string;
}

interface ContentEdge {
  stripped: string;
  edge: number;
}

// `translateToString(true)` only trims cells that were never written
// (null cells) — NOT written spaces. A real captured row came back as
// `"…2>&1; ls "` (length 57, trailing space real). So the row's true content
// edge needs its own trailing-whitespace trim on top of that, plus an
// optional single trailing border glyph. Do not replace this with
// `line.translateToString(true).length` — that silently accepts rows ending
// in written whitespace as "reaching the edge", which is exactly the kind
// of over-eager join this module exists to avoid.
function contentEdge(rawText: string): ContentEdge {
  const withoutBorder = rawText.replace(TRAILING_BORDER_RE, "");
  const stripped = withoutBorder.replace(/\s+$/, "");
  return { stripped, edge: stripped.length };
}

function stripGutter(rawText: string): { stripped: string; skipped: number } {
  const match = rawText.match(GUTTER_RE);
  const raw = match ? match[0].length : 0;
  // A leading run this long is more likely a genuinely blank/unrelated row
  // than a deliberate continuation indent — leave it unstripped, which
  // means the row's own first character stays whitespace and naturally
  // fails the "starts immediately" checks below (the safe direction).
  const skipped = raw > MAX_GUTTER_COLUMNS ? 0 : raw;
  return { stripped: rawText.slice(skipped), skipped };
}

function urlEligiblePrefix(text: string): string {
  let i = 0;
  while (i < text.length && URL_MIDDLE_CHAR_RE.test(text[i]!)) i += 1;
  return text.slice(0, i);
}

/** Whether `y`'s content edge looks like a genuine wrap point: either it
 * reaches the terminal's own right margin, or another nearby row
 * independently ends at the exact same column (see module header). */
function isEligibleWrapRow(buf: LinkBufferSource, y: number, rawText: string): boolean {
  const { edge } = contentEdge(rawText);
  if (edge === 0) return false;
  if (edge >= buf.cols - RIGHT_EDGE_SLACK) return true;
  if (edge < MIN_CORROBORATION_EDGE) return false;

  for (let dy = -CORROBORATION_WINDOW; dy <= CORROBORATION_WINDOW; dy++) {
    if (dy === 0) continue;
    const other = buf.getLine(y + dy);
    if (!other) continue;
    const otherRaw = other.translateToString(true);
    if (otherRaw.length === 0) continue;
    if (contentEdge(otherRaw).edge === edge) return true;
  }
  return false;
}

interface ExtendCheck {
  ok: boolean;
  /** Continuation row's body text with its gutter already stripped —
   * only meaningful when `ok`. */
  strippedNext: string;
  skipped: number;
}

/**
 * Whether row `producerY` (raw text `producerRaw`) can hard-wrap-extend
 * into the next row (raw text `nextRaw`). Symmetric input shape so the
 * forward (`buildWindow`) and backward (`findWindowStart`) walks apply
 * identical rules — a user hovering a continuation row directly must
 * resolve to the same link as hovering the row the link visually starts
 * on.
 */
function canExtend(
  buf: LinkBufferSource,
  producerY: number,
  producerRaw: string,
  nextRaw: string,
): ExtendCheck {
  const fail: ExtendCheck = { ok: false, strippedNext: "", skipped: 0 };
  if (!isEligibleWrapRow(buf, producerY, producerRaw)) return fail;

  const { stripped: nextBody, skipped } = stripGutter(nextRaw);
  if (nextBody.length === 0) return fail;
  if (NEW_SCHEME_RE.test(nextBody)) return fail;

  const prefix = urlEligiblePrefix(nextBody);
  if (prefix.length === 0) return fail;
  if (!STRUCTURAL_CHAR_RE.test(prefix)) return fail;

  return { ok: true, strippedNext: nextBody, skipped };
}

/**
 * Walk backward from anchor row `y` to find the first row of its logical
 * line, following soft wraps (`isWrapped`) unconditionally and hard wraps
 * under the exact same `canExtend` rule `buildWindow` uses going forward.
 * Backward hard-wrap detection matters: xterm queries `provideLinks`
 * independently per hovered row, so a user hovering directly over a
 * hard-wrap *continuation* row (never touching the row the URL visually
 * starts on) must still resolve to the full joined link, not nothing.
 */
function findWindowStart(buf: LinkBufferSource, y: number): number {
  let startY = y;
  let guardLen = 0;
  let hardWrapCount = 0;

  while (guardLen < MAX_JOINED_LENGTH) {
    const cur = buf.getLine(startY);
    if (!cur) break;
    const prev = buf.getLine(startY - 1);
    if (!prev) break;

    if (cur.isWrapped) {
      startY -= 1;
      guardLen += prev.translateToString(true).length;
      continue;
    }

    if (hardWrapCount >= MAX_HARD_WRAP_ROWS) break;
    const prevRaw = prev.translateToString(true);
    const curRaw = cur.translateToString(true);
    const ext = canExtend(buf, startY - 1, prevRaw, curRaw);
    if (!ext.ok) break;

    startY -= 1;
    hardWrapCount += 1;
    guardLen += prevRaw.length;
  }

  return startY;
}

/**
 * Build the full logical line containing row `y`: the joined text plus the
 * per-row segments needed to map regex match offsets back to buffer
 * coordinates. Single forward pass from the window's start row, deciding
 * one row at a time whether the *next* row continues it (soft wrap, hard
 * wrap, or neither) — never pre-committing two rows at once, so a hard-wrap
 * chain of 3+ rows re-evaluates `canExtend` against each newly appended row
 * in turn, not just the first.
 */
export function buildWindow(
  buf: LinkBufferSource,
  y: number,
): { text: string; segments: LinkSegment[] } {
  const anchor = buf.getLine(y);
  if (!anchor) return { text: "", segments: [] };

  const startY = findWindowStart(buf, y);
  const segments: LinkSegment[] = [];
  let text = "";
  let curY = startY;
  let gutterSkip = 0;
  let hardWrapRowCount = 0;

  while (true) {
    const line = buf.getLine(curY);
    if (!line) break;
    const raw = line.translateToString(true);
    const body = gutterSkip > 0 ? raw.slice(gutterSkip) : raw;

    if (body.length === 0 && gutterSkip > 0) {
      // A hard-wrap continuation row that turned out to be blank once its
      // gutter is stripped — nothing to gain, and nothing was consumed, so
      // stop without appending it (it gets its own provideLinks call if
      // hovered directly).
      break;
    }

    const nextLine = buf.getLine(curY + 1);

    if (nextLine?.isWrapped) {
      segments.push({ row: curY, startCol: gutterSkip, text: body });
      text += body;
      if (text.length >= MAX_JOINED_LENGTH) break;
      curY += 1;
      gutterSkip = 0;
      continue;
    }

    if (nextLine && hardWrapRowCount < MAX_HARD_WRAP_ROWS && text.length < MAX_JOINED_LENGTH) {
      // Eligibility is measured against this row's own FULL raw text (not
      // `body`), since a leading gutter strip doesn't move the row's
      // trailing content edge or the true buffer column other rows are
      // compared against.
      const ext = canExtend(buf, curY, raw, nextLine.translateToString(true));
      if (ext.ok) {
        const { stripped } = contentEdge(body);
        segments.push({ row: curY, startCol: gutterSkip, text: stripped });
        text += stripped;
        hardWrapRowCount += 1;
        curY += 1;
        gutterSkip = ext.skipped;
        continue;
      }
    }

    // Plain, unremarkable last row of the window: nothing extends past it.
    segments.push({ row: curY, startCol: gutterSkip, text: body });
    text += body;
    break;
  }

  return { text, segments };
}

function stringOffsetToColumn(line: LinkBufferLine, fromCol: number, charOffset: number): number {
  // Mirrors the addon's own `_mapStrIdx`: a double-width character's first
  // cell holds its chars (consumes budget), its second, zero-width
  // continuation cell holds "" and is purely skipped over — NOT charged a
  // budget unit. Charging it (e.g. via a naive `chars.length || 1`
  // fallback) would silently overcount by one column for any row
  // containing a wide character before a match's start, since
  // `translateToString` doesn't charge that continuation cell any string
  // offset either.
  let col = fromCol;
  let remaining = charOffset;
  while (remaining > 0 && col < line.length) {
    const cell = line.getCell(col);
    const chars = cell ? cell.getChars() : "";
    if (chars.length > 0) remaining -= chars.length;
    col += 1;
  }
  return col;
}

export interface MappedRange {
  row: number;
  /** 0-indexed buffer column, inclusive start. */
  startCol: number;
  /** 0-indexed buffer column, exclusive end (one past the last matched cell). */
  endCol: number;
}

/** Map a [startOffset, endOffset) character range in a window's joined
 * `text` back to per-row buffer column ranges, using `segments`' own
 * left-to-right order to track each segment's offset within `text`. */
export function mapOffsetsToRows(
  buf: LinkBufferSource,
  segments: LinkSegment[],
  startOffset: number,
  endOffset: number,
): MappedRange[] {
  const ranges: MappedRange[] = [];
  let cursor = 0;
  for (const seg of segments) {
    const segStart = cursor;
    const segEnd = cursor + seg.text.length;
    cursor = segEnd;
    const lo = Math.max(startOffset, segStart);
    const hi = Math.min(endOffset, segEnd);
    if (lo >= hi) continue;
    const line = buf.getLine(seg.row);
    if (!line) continue;
    const startCol = stringOffsetToColumn(line, seg.startCol, lo - segStart);
    const endCol = stringOffsetToColumn(line, seg.startCol, hi - segStart);
    ranges.push({ row: seg.row, startCol, endCol });
  }
  return ranges;
}

export interface ComputedLink {
  /** 0-indexed buffer row — the row this link was requested for. */
  row: number;
  /** 0-indexed inclusive start column, clipped to `row`. */
  startCol: number;
  /** 0-indexed exclusive end column, clipped to `row`. */
  endCol: number;
  /** The full reconstructed URL, even when this link represents only one
   * row's slice of a multi-row join. */
  text: string;
  /** How many buffer rows this link's full match was reconstructed from. */
  rowCount: number;
}

/**
 * Compute the links intersecting buffer row `y` (0-indexed), clipped to
 * that row. Never returns a link for a *different* row, even when the
 * match spans several: xterm's `Linkifier._removeIntersectingLinks` shares
 * one column `Set` across every provider's reply and maps any link whose
 * range crosses the queried row onto a bogus full-width span on that row
 * (`start.y < y → column 0`, `end.y > y → cols`), and it only ever
 * decorates a single `_currentLink` — so returning sibling-row segments
 * could only cannibalize the real link, never usefully render as more than
 * one. Each row of a multi-row match gets its own link when *it* is
 * queried instead.
 */
/**
 * Scheme allowlist shared by the link provider's `activate` and the
 * `linkHandler` used for OSC 8 hyperlinks. Required, not defense-in-depth,
 * for the OSC 8 path: xterm core's `Linkifier._handleMouseUp` calls
 * `link.activate(event, link.text)` with no filtering of its own — the
 * `allowNonHttpProtocols` constructor option only gates which links
 * `OscLinkProvider.provideLinks` constructs in the first place, not what
 * `activate` is willing to open. Redundant for our own regex-based
 * provider (`URL_REGEX` is scheme-required to `https?` already), kept here
 * so both callers share one check rather than two copies drifting apart.
 */
export function isSafeLinkUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function computeLinksForRow(buf: LinkBufferSource, y: number): ComputedLink[] {
  const { text, segments } = buildWindow(buf, y);
  if (!text) return [];

  const links: ComputedLink[] = [];
  const re = new RegExp(URL_REGEX.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const matchText = match[0];
    const startOffset = match.index;
    const endOffset = startOffset + matchText.length;
    if (matchText.length === 0) {
      re.lastIndex += 1;
      continue;
    }
    const rowRanges = mapOffsetsToRows(buf, segments, startOffset, endOffset);
    const forThisRow = rowRanges.find((r) => r.row === y);
    if (!forThisRow) continue;
    links.push({
      row: y,
      startCol: forThisRow.startCol,
      endCol: forThisRow.endCol,
      text: matchText,
      rowCount: rowRanges.length,
    });
  }
  return links;
}
