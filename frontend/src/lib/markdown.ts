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
  | { type: "paragraph"; lines: MdSpan[][] };

const HEADING_RE = /^(#{2,3})\s+(.*)$/;
const BULLET_RE = /^-\s+(.*)$/;
const INLINE_RE = /\*\*(.+?)\*\*|`([^`]+)`/g;

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

  const flushParagraph = () => {
    if (paragraphLines.length > 0) {
      blocks.push({ type: "paragraph", lines: paragraphLines });
      paragraphLines = [];
    }
  };

  for (const line of src.replace(/\r\n/g, "\n").split("\n")) {
    if (line.trim() === "") {
      flushParagraph();
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
