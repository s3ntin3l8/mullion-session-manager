// The prompt handed to a session working on a PR's branch: what the
// reviewers left open, plus a pointer to anything red in CI. Built from the
// same detail the sidebar shows, as plain text (no HTML) so any agent can
// read it. HTML in thread comments is flattened, not trusted.

import type { PrDetail } from "./github-pr-detail.js";

const MAX_COMMENT_CHARS = 600;

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|pre|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
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
  const changes = pr.reviews.filter((r) => r.state === "CHANGES_REQUESTED" && r.bodyHtml.trim());
  for (const r of changes) {
    lines.push(
      `Changes requested by ${r.author ?? "a reviewer"}: ${clip(htmlToText(r.bodyHtml))}`,
      "",
    );
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
