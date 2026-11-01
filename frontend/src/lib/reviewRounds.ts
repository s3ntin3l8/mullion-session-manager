// #2235 — `tasks.reviewFindings` is every review round appended oldest-first,
// each opening with a `## Round N` heading (task-reconciler.ts's ingest; the
// backend splits it with the same regex). The drawer leads with the latest
// round, so it needs the rounds apart and the latest one's verdict and counts.

export interface LatestRound {
  /** The block's `## Round N …` heading line. */
  heading: string;
  round: number;
  /** The `**Verdict:**` line's text (after the label), or null if absent. */
  verdict: string | null;
  /** Non-`- None` bullets per section; null when the block has no such sections. */
  counts: { critical: number; warnings: number; suggestions: number } | null;
  /** The whole block, heading included, for rendering. */
  text: string;
}

export interface ReviewRounds {
  earlier: string[];
  latest: LatestRound;
}

const SECTIONS = {
  critical: "Critical",
  warnings: "Warnings",
  suggestions: "Suggestions",
} as const;

function countBullets(lines: string[], heading: string): number {
  const start = lines.findIndex((l) => l.trim() === `### ${heading}`);
  if (start === -1) return 0;
  let n = 0;
  for (const l of lines.slice(start + 1)) {
    if (/^#{1,3} /.test(l)) break;
    if (l.startsWith("- ") && l.trim() !== "- None") n++;
  }
  return n;
}

/** Null when the text has no `## Round` heading (render it as one block). */
export function parseReviewRounds(text: string | null | undefined): ReviewRounds | null {
  if (!text) return null;
  const blocks = text.split(/\n\n(?=## Round )/);
  const last = blocks[blocks.length - 1];
  const head = /^## Round (\d+)[^\n]*/.exec(last);
  if (!head) return null;
  const verdict = /^\*\*Verdict:\*\*[ \t]*(.*)$/m.exec(last)?.[1].trim() || null;
  const lines = last.split("\n");
  const hasSections = Object.values(SECTIONS).some((h) =>
    lines.some((l) => l.trim() === `### ${h}`),
  );
  return {
    earlier: blocks.slice(0, -1),
    latest: {
      heading: head[0],
      round: Number(head[1]),
      verdict,
      counts: hasSections
        ? {
            critical: countBullets(lines, SECTIONS.critical),
            warnings: countBullets(lines, SECTIONS.warnings),
            suggestions: countBullets(lines, SECTIONS.suggestions),
          }
        : null,
      text: last,
    },
  };
}

/**
 * The `## Round N …` heading a review opens with (task-reconciler.ts writes it
 * into the body it posts), read back out of GitHub's rendered HTML so a
 * collapsed review card can say which round it is. Null for any other comment.
 * Reads the heading's text content from an inert parsed document, so entities
 * (`&mdash;`) and inline markup (`Round 2 — <code>x</code>`) come out as text.
 */
export function roundLabelFromHtml(html: string): string | null {
  if (!html) return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const heading of doc.querySelectorAll("h1, h2, h3")) {
    const text = (heading.textContent ?? "").replace(/\s+/g, " ").trim();
    if (/^Round\s+\d+/i.test(text)) return text;
  }
  return null;
}
