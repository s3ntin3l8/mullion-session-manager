// The issue author's review focus (#2600). A task's issue body may carry an
// optional `## Review focus` section: bullets naming the defects that matter
// for this change (a supersede race, a fail-open gate, ...). The reviewer must
// report on each one in the findings JSON's `focus` array. It is a section, not
// a directive line, so it does not interact with the body directives.

export const MAX_FOCUS_ITEMS = 12;
export const MAX_FOCUS_ITEM_LENGTH = 300;

const FOCUS_HEADING_RE = /^##[ \t]+review focus[ \t]*#*[ \t]*$/i;
const NEXT_HEADING_RE = /^#{1,2}[ \t]/;
const BULLET_RE = /^[ \t]{0,3}(?:[-*+]|\d+[.)])[ \t]+(.*)$/;
const FENCE_RE = /^[ \t]{0,3}(?:```|~~~)/;

/**
 * The bullets of the `## Review focus` section of an issue body, in order:
 * lines after that heading up to the next `#`/`##` heading, at most
 * `MAX_FOCUS_ITEMS` of at most `MAX_FOCUS_ITEM_LENGTH` characters (longer ones
 * are cut with an ellipsis). HTML comments (the blueprint's commented
 * example) and fenced code blocks are ignored; an empty bullet is skipped.
 * Absent or empty section → `[]`.
 */
export function parseReviewFocus(body: string | null | undefined): string[] {
  if (!body) return [];
  const lines = body.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/);
  const out: string[] = [];
  let inSection = false;
  let inFence = false;
  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!inSection) {
      if (FOCUS_HEADING_RE.test(line.trim())) inSection = true;
      continue;
    }
    if (NEXT_HEADING_RE.test(line)) break;
    const text = BULLET_RE.exec(line)?.[1]?.trim();
    if (!text) continue;
    out.push(
      text.length > MAX_FOCUS_ITEM_LENGTH ? `${text.slice(0, MAX_FOCUS_ITEM_LENGTH - 1)}…` : text,
    );
    if (out.length >= MAX_FOCUS_ITEMS) break;
  }
  return out;
}

/** How the reviewer fared on one review-focus item. */
export interface FocusCheck {
  item: string;
  status: "clear" | "finding" | "not-checked";
  evidence: string;
}

/** Tolerant like the other arrays: entries without a string `item` or a known
 * `status` are dropped, a missing `evidence` becomes "". */
export function normalizeFocus(raw: unknown): FocusCheck[] {
  if (!Array.isArray(raw)) return [];
  const out: FocusCheck[] = [];
  for (const c of raw) {
    if (c === null || typeof c !== "object") continue;
    const rec = c as Record<string, unknown>;
    if (typeof rec.item !== "string" || rec.item.length === 0) continue;
    if (rec.status !== "clear" && rec.status !== "finding" && rec.status !== "not-checked") {
      continue;
    }
    out.push({
      item: rec.item,
      status: rec.status,
      evidence: typeof rec.evidence === "string" ? rec.evidence : "",
    });
  }
  return out;
}

/**
 * Notes for `focus` entries the verdict does not act on: a `not-checked` item
 * is surfaced prominently, and a `finding` entry with no finding behind it is
 * flagged. Neither changes the verdict (`deriveVerdict` reads `findings`).
 */
export function focusNotes(focus: FocusCheck[], findingCount: number): string[] {
  const notes: string[] = [];
  for (const c of focus) {
    if (c.status === "not-checked") {
      notes.push(`**Review focus NOT CHECKED:** ${c.item}${c.evidence ? ` — ${c.evidence}` : ""}`);
    }
  }
  if (findingCount === 0 && focus.some((c) => c.status === "finding")) {
    notes.push(
      "A review focus item is reported as `finding`, but no finding was filed for it — the focus entry is not acted on without one.",
    );
  }
  return notes;
}

/** The "Review focus" section: one line per item with its status. */
export function renderFocusSection(focus: FocusCheck[]): string[] {
  if (focus.length === 0) return [];
  return [
    "### Review focus",
    ...focus.map((c) => `- **${c.status}** — ${c.item}${c.evidence ? `: ${c.evidence}` : ""}`),
    "",
  ];
}

/** The review prompt's lines for the focus bullets; empty when there are none. */
export function reviewFocusPromptLines(items: string[]): string[] {
  if (items.length === 0) return [];
  return [
    "The issue author asks you to specifically examine:",
    ...items.map((i) => `- ${i}`),
    "Report each one in `focus`. Do not skip an item because it looks unlikely:",
    "`not-checked` is the honest answer when you did not examine it.",
    "",
  ];
}
