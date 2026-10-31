// The prompt handed to a session working on a PR's branch: what the
// reviewers left open, plus a pointer to anything red in CI. Built from the
// same detail the sidebar shows, as plain text (no HTML) so any agent can
// read it. HTML in thread comments is flattened, not trusted.

import type { PrDetail } from "./github-pr-detail.js";

const MAX_COMMENT_CHARS = 600;

/** Applies `pattern` until it stops matching, so removing one tag can't splice a new one together. */
function stripRepeatedly(text: string, pattern: RegExp): string {
  let prev: string;
  let out = text;
  do {
    prev = out;
    out = out.replace(pattern, "");
  } while (out !== prev);
  return out;
}

function htmlToText(html: string): string {
  const withoutBlocks = stripRepeatedly(html, /<(script|style)\b[\s\S]*?<\/\1\s*>/gi);
  const withBreaks = withoutBlocks
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|pre|h[1-6])>/gi, "\n");
  return stripRepeatedly(withBreaks, /<[^>]*>/g)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function clip(text: string): string {
  return text.length > MAX_COMMENT_CHARS ? `${text.slice(0, MAX_COMMENT_CHARS)}…` : text;
}

/** A latest review in one of these states lifted the reviewer's earlier request. */
const SUPERSEDING = new Set(["APPROVED", "DISMISSED"]);

export function buildHandoffPrompt(
  pr: Pick<PrDetail, "number" | "title" | "htmlUrl" | "headBranch" | "threads" | "reviews">,
  failingChecks: string[],
): string {
  const lines = [`Address the open feedback on PR #${pr.number}: ${pr.title}`, pr.htmlUrl, ""];
  const open = pr.threads.filter((t) => !t.isResolved && !t.isOutdated);
  if (open.length > 0) {
    lines.push(`Unresolved review threads (${open.length}):`);
    for (const t of open) {
      const where = t.path ? `${t.path}${t.line ? `:${t.line}` : ""}` : "(general)";
      const first = t.comments[0];
      lines.push(
        `- ${where} — ${first?.author ?? "reviewer"}: ${clip(htmlToText(first?.bodyHtml ?? ""))}`,
      );
    }
    lines.push("");
  }
  // Per reviewer: their newest request/remark that has text — unless their
  // latest review is an approval or a dismissal, which lifts what they said before. An
  // inline-only review (no text, its threads are listed above) must not hide
  // the earlier review that did carry the text.
  const latestByAuthor = new Map<string, PrDetail["reviews"][number]>();
  const textByAuthor = new Map<string, PrDetail["reviews"][number]>();
  for (const r of pr.reviews) {
    const who = r.author ?? "";
    latestByAuthor.set(who, r);
    if ((r.state === "CHANGES_REQUESTED" || r.state === "COMMENTED") && r.bodyHtml.trim()) {
      textByAuthor.set(who, r);
    }
  }
  const changes = [...textByAuthor]
    .filter(([who]) => !SUPERSEDING.has(latestByAuthor.get(who)?.state ?? ""))
    .map(([, r]) => r);
  for (const r of changes) {
    const verb = r.state === "CHANGES_REQUESTED" ? "Changes requested by" : "Review comments from";
    lines.push(`${verb} ${r.author ?? "a reviewer"}: ${clip(htmlToText(r.bodyHtml))}`, "");
  }
  if (failingChecks.length > 0) {
    lines.push(
      `Failing checks: ${failingChecks.join(", ")}`,
      "A check that is not required for merging still counts — a red one holds the merge, so fix it too (for a coverage check, add tests for the uncovered lines).",
      "",
    );
  }
  if (open.length === 0 && changes.length === 0 && failingChecks.length === 0) {
    lines.push("There is nothing outstanding — check the PR for anything left to do.", "");
  }
  lines.push(
    `You are on the PR branch \`${pr.headBranch}\`. Fix what is listed, push, then reply to and resolve each thread.`,
  );
  return lines.join("\n");
}
