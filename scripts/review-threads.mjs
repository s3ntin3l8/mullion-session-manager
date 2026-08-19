#!/usr/bin/env node
// Encodes CLAUDE.md's "Addressing Review Feedback" recipe as a runnable
// command instead of prose every agent has to re-derive: fixing the code a
// reviewer flagged is not enough to close the loop — the reply and the
// GraphQL-only thread resolution are two separate API calls, and the
// resolution needs a GraphQL node ID that the REST comment ID doesn't give
// you. Shells out to `gh` rather than hand-rolling auth, matching every
// other script/recipe in this repo that talks to GitHub.
//
// Usage:
//   node scripts/review-threads.mjs list [<pr-number>]
//   node scripts/review-threads.mjs reply <comment-id> <body>
//   node scripts/review-threads.mjs resolve <thread-id>
import { execFileSync } from "node:child_process";

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8" });
}

function currentRepo() {
  return gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).trim();
}

function currentPrNumber() {
  const out = gh(["pr", "view", "--json", "number", "-q", ".number"]).trim();
  if (!out) {
    throw new Error("No PR found for the current branch — pass a PR number explicitly.");
  }
  return out;
}

function listThreads(prNumber) {
  const [owner, repo] = currentRepo().split("/");
  const query = `
    query($owner: String!, $repo: String!, $pr: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $pr) {
          reviewThreads(first: 100) {
            nodes {
              id
              isResolved
              comments(first: 1) {
                nodes { databaseId path line body }
              }
            }
          }
        }
      }
    }
  `;
  const out = gh([
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `repo=${repo}`,
    "-F",
    `pr=${prNumber}`,
  ]);
  const data = JSON.parse(out);
  const threads = data.data.repository.pullRequest.reviewThreads.nodes;
  const unresolved = threads.filter((t) => !t.isResolved);
  if (unresolved.length === 0) {
    console.log("No unresolved review threads.");
    return;
  }
  for (const t of unresolved) {
    const c = t.comments.nodes[0];
    const snippet = (c?.body ?? "").replace(/\s+/g, " ").slice(0, 100);
    console.log(`${t.id}`);
    console.log(`  ${c?.path ?? "?"}:${c?.line ?? "?"} (comment ${c?.databaseId ?? "?"})`);
    console.log(`  ${snippet}${snippet.length === 100 ? "…" : ""}`);
  }
}

function resolveThread(threadId) {
  const mutation = `mutation($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread { isResolved }
    }
  }`;
  const out = gh(["api", "graphql", "-f", `query=${mutation}`, "-f", `threadId=${threadId}`]);
  const data = JSON.parse(out);
  console.log(
    data.data.resolveReviewThread.thread.isResolved
      ? `Resolved ${threadId}.`
      : `Thread ${threadId} did not resolve — check the response.`,
  );
}

function replyToComment(commentId, body, prNumber) {
  const repo = currentRepo();
  gh([
    "api",
    `repos/${repo}/pulls/${prNumber}/comments/${commentId}/replies`,
    "-f",
    `body=${body}`,
  ]);
  console.log(`Replied to comment ${commentId}.`);
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "list") {
  const pr = rest[0] ?? currentPrNumber();
  listThreads(pr);
} else if (cmd === "reply") {
  const [commentId, body] = rest;
  if (!commentId || !body) {
    console.error("Usage: node scripts/review-threads.mjs reply <comment-id> <body>");
    process.exit(1);
  }
  replyToComment(commentId, body, currentPrNumber());
} else if (cmd === "resolve") {
  const [threadId] = rest;
  if (!threadId) {
    console.error("Usage: node scripts/review-threads.mjs resolve <thread-id>");
    process.exit(1);
  }
  resolveThread(threadId);
} else {
  console.error(
    [
      "Usage:",
      "  node scripts/review-threads.mjs list [<pr-number>]",
      "  node scripts/review-threads.mjs reply <comment-id> <body>",
      "  node scripts/review-threads.mjs resolve <thread-id>",
      "",
      "Reply first (with the comment's databaseId from `list`), then resolve",
      "(with the thread's GraphQL id, also from `list`) — see CLAUDE.md's",
      "'Addressing Review Feedback' section for why both steps are required.",
    ].join("\n"),
  );
  process.exit(1);
}
