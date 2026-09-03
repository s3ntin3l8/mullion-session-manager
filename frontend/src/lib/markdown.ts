// Issue #990 — `tasks.reviewFindings` is markdown (renderReviewFindingsMarkdown,
// src/services/task-prompt.ts): `##`/`###` headings, flat `-` bullets, `**bold**`,
// inline `` `code` ``. Three escape hatches (unstructured agent output, an
// over-long summary, an inconclusive review — see that function's own doc
// comment) can also put arbitrary raw text in the same field, so anything
// this parser doesn't recognize must fall through as literal paragraph text,
// never be mangled or dropped. Mirrors diffUtils.ts's shape: a pure parser,
// no DOM/React here.

export type MdSpan =
  { type: "text"; text: string } | { type: "bold"; text: string } | { type: "code"; text: string };

export type MdBlock =
  | { type: "heading"; level: 2 | 3; spans: MdSpan[] }
  | { type: "bullet"; spans: MdSpan[] }
  | { type: "paragraph"; lines: MdSpan[][] }
  // A blank line that split two bullet runs apart in the source — CommonMark
  // would close/reopen the list there rather than merging them into one.
  // Renders as nothing; its only job is stopping the renderer's own
  // consecutive-bullet grouping from re-joining them into a single <ul>.
  | { type: "break" };

const HEADING_RE = /^(#{2,3})\s+(.*)$/;
const BULLET_RE = /^-\s+(.*)$/;
const INLINE_RE = /\*\*(.+?)\*\*|`([^`]+)`/g;
// Hermes review, PR #1000 — fence content must never reach the
// heading/bullet matchers below: an unstructured escape-hatch value (see
// this file's own header) can legitimately contain a fenced reproduction
// snippet with lines like "## config" or "- run --flag" that are code, not
// markdown structure. Deliberately not a real fence-language/attribute
// parser — just the open/close toggle needed to suspend structural
// matching for everything between a pair of these.
const FENCE_RE = /^```/;

function parseInlineSpans(text: string): MdSpan[] {
  const spans: MdSpan[] = [];
  let lastIndex = 0;
  INLINE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      spans.push({ type: "text", text: text.slice(lastIndex, match.index) });
    }
    if (match[1] !== undefined) {
      spans.push({ type: "bold", text: match[1] });
    } else {
      spans.push({ type: "code", text: match[2] });
    }
    lastIndex = INLINE_RE.lastIndex;
  }
  if (lastIndex < text.length) {
    spans.push({ type: "text", text: text.slice(lastIndex) });
  }
  return spans;
}

export function parseSimpleMarkdown(src: string): MdBlock[] {
  if (!src) return [];
  const blocks: MdBlock[] = [];
  let paragraphLines: MdSpan[][] = [];
  let inFence = false;

  const flushParagraph = () => {
    if (paragraphLines.length > 0) {
      blocks.push({ type: "paragraph", lines: paragraphLines });
      paragraphLines = [];
    }
  };

  for (const line of src.replace(/\r\n/g, "\n").split("\n")) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      // The fence delimiter itself is also just literal text here — this
      // parser never renders a distinct code-block element, it only stops
      // treating the lines between a pair of these as markdown structure.
      paragraphLines.push([{ type: "text", text: line }]);
      continue;
    }
    if (inFence) {
      // Verbatim, not parseInlineSpans(line) — an unclosed fence's content
      // could itself contain "**"/"`" sequences that have nothing to do
      // with this app's own bold/code syntax.
      paragraphLines.push([{ type: "text", text: line }]);
      continue;
    }
    if (line.trim() === "") {
      if (paragraphLines.length > 0) {
        flushParagraph();
      } else if (blocks.length > 0 && blocks[blocks.length - 1].type === "bullet") {
        blocks.push({ type: "break" });
      }
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({
        type: "heading",
        level: heading[1].length === 2 ? 2 : 3,
        spans: parseInlineSpans(heading[2]),
      });
      continue;
    }
    const bullet = BULLET_RE.exec(line);
    if (bullet) {
      flushParagraph();
      blocks.push({ type: "bullet", spans: parseInlineSpans(bullet[1]) });
      continue;
    }
    paragraphLines.push(parseInlineSpans(line));
  }
  flushParagraph();
  return blocks;
}
