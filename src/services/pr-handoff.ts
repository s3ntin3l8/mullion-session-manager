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
  // Each reviewer's latest review that is still a request (changes) or a
  // remark (a bot's COMMENTED review is all the feedback it gives): an
  // approval, or a later review, supersedes their earlier text.
  const latestByAuthor = new Map<string, PrDetail["reviews"][number]>();
  for (const r of pr.reviews) latestByAuthor.set(r.author ?? "", r);
  const changes = [...latestByAuthor.values()].filter(
    (r) => (r.state === "CHANGES_REQUESTED" || r.state === "COMMENTED") && r.bodyHtml.trim(),
  );
  for (const r of changes) {
    const verb = r.state === "CHANGES_REQUESTED" ? "Changes requested by" : "Review comments from";
    lines.push(`${verb} ${r.author ?? "a reviewer"}: ${clip(htmlToText(r.bodyHtml))}`, "");
  }
  if (failingChecks.length > 0) {
    lines.push(`Failing checks: ${failingChecks.join(", ")}`, "");
  }
  if (open.length === 0 && changes.length === 0 && failingChecks.length === 0) {
    lines.push("There is nothing outstanding — check the PR for anything left to do.", "");
  }
  lines.push(
    `You are on the PR branch \`${pr.headBranch}\`. Fix what is listed, push, then reply to and resolve each thread.`,
  );
  return lines.join("\n");
}
