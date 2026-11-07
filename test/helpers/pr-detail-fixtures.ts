// The PR-detail route fixtures: connectedProject, gqlPr, warmCiCache and
// mockGithub, shared by test/routes/project-github-pr-detail.test.ts (the
// read side of the PR-detail describe) and
// test/routes/project-github-pr-merge.test.ts (the merge gate). Issue #2671.
//
// Shared rather than duplicated per file (settling #2476's open bullet): the
// two files carried these four byte-for-byte, and a fixture changed in one
// but not the other would make the read and write sides disagree about what a
// PR looks like. The module holds only these four — no general fixture
// framework — in the same shape as pr-review-defaults.ts and merge-fixtures.ts.
//
// mockGithub installs its handler on whatever `globalThis.fetch` currently
// is, so the caller must have stubbed it with a vi.fn() first
// (vi.stubGlobal("fetch", vi.fn()) in beforeEach), as both files do.

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { PR_REVIEW_DEFAULTS } from "./pr-review-defaults.js";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function connectedProject(app: FastifyInstance) {
  const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-github-prdetail-"));
  fs.mkdirSync(path.join(projectCwd, ".git"));
  fs.writeFileSync(
    path.join(projectCwd, ".git", "config"),
    '[remote "origin"]\n\turl = git@github.com:acme/widgets.git\n',
  );
  await app.inject({
    method: "PUT",
    url: "/api/integrations/github/token",
    payload: { token: "ghp_connected" },
  });
  const created = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { createDir: true, allowDuplicate: true, name: "pr-detail", cwd: projectCwd },
  });
  return { projectCwd, id: created.json().id as number };
}

export const gqlPr = (number: number, over: Record<string, unknown> = {}) => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/acme/widgets/pull/${number}`,
  bodyHTML: "<p>b</p>",
  state: "OPEN",
  isDraft: false,
  baseRefName: "main",
  headRefName: "feat",
  headRefOid: `sha${number}`,
  additions: 1,
  deletions: 1,
  changedFiles: 1,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  author: { login: "me" },
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: "APPROVED",
  commits: { totalCount: 0, nodes: [] },
  reviewRequests: { nodes: [] },
  latestOpinionatedReviews: { nodes: [{ author: { login: "bob" }, state: "APPROVED" }] },
  latestReviews: { nodes: [{ author: { login: "bob" }, state: "APPROVED" }] },
  reviews: { nodes: [] },
  reviewThreads: {
    nodes: [
      {
        isResolved: false,
        isOutdated: false,
        path: "a.ts",
        line: 2,
        comments: {
          nodes: [{ author: { login: "bob" }, bodyHTML: "<p>fix</p>", createdAt: "t" }],
        },
      },
    ],
  },
  comments: { nodes: [] },
  ...over,
});

// The poller's CI view for a PR; without it the phase can't be "ready".
export async function warmCiCache(
  number: number,
  ciStatus: "success" | "failure" | null,
  // Whether the head-run lookup answered. Independent of ciStatus: an
  // answered-but-empty lookup is { ciStatus: null, ciFetched: true }, and
  // a failed one is { ciStatus: null, ciFetched: false }. Always explicit.
  ciFetched: boolean,
  headSha: string = `sha${number}`,
  actionsRuns: Array<{
    name: string;
    status: string;
    conclusion: string | null;
    htmlUrl: string;
    headSha: string;
  }> = [],
) {
  const { setRepoPRsStatus } = await import("../../src/services/github.js");
  setRepoPRsStatus("acme", "widgets", {
    prs: [
      {
        ...PR_REVIEW_DEFAULTS,
        number,
        title: `PR ${number}`,
        htmlUrl: `https://github.com/acme/widgets/pull/${number}`,
        author: "me",
        headSha,
        headBranch: "feat",
        baseBranch: "main",
        ciStatus,
        ciFetched,
        actionsRuns,
      },
    ],
    prSummary: { total: 1, pass: 1, fail: 0, pending: 0, unknown: 0 },
  });
}

export function mockGithub(
  pr: Record<string, unknown>,
  extra?: (url: string, init?: RequestInit) => Response | null,
) {
  vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const custom = extra?.(url, init);
    if (custom) return Promise.resolve(custom);
    if (url === "https://api.github.com/user") {
      return Promise.resolve(jsonResponse(200, { login: "octocat" }));
    }
    if (url.endsWith("/graphql")) {
      return Promise.resolve(jsonResponse(200, { data: { repository: { pullRequest: pr } } }));
    }
    if (url.includes("/pulls/") && url.includes("/files")) {
      return Promise.resolve(jsonResponse(200, []));
    }
    return Promise.reject(new Error(`unexpected fetch in test: ${url}`));
  });
}
