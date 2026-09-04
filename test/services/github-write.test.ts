import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  addLabels,
  removeLabel,
  createComment,
  setAssignees,
  closeIssue,
  getIssueState,
  createPullRequest,
  findPullRequestByHead,
  getPullRequestByNumber,
  mergePullRequest,
  updatePullRequestBranch,
  deleteRemoteBranch,
  closePullRequest,
  updatePullRequestTitle,
  markPullRequestReadyForReview,
  createPullRequestReview,
  getPullRequestReviewDecision,
  fetchPullRequestReviewThreads,
  fetchViewerLogin,
  GitHubWriteScopeError,
  listWorkflows,
  findReleasePleaseWorkflow,
  dispatchWorkflow,
  findReleasePullRequest,
  detectReleaseWorkflow,
  clearReleaseWorkflowCacheForTests,
  getCachedReleasePullRequestStatus,
  invalidateReleaseCache,
  clearReleasePrCacheForTests,
} from "../../src/services/github-write.js";
import { GitHubApiError, setRepoPRsStatus, computePRSummary } from "../../src/services/github.js";
import {
  GitHubRateLimitError,
  isGitHubRateLimited,
  resetGitHubRateLimitForTests,
} from "../../src/services/github-fetch.js";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(status: number, body: string, headers?: Record<string, string>) {
  return new Response(body, { status, headers });
}

describe("github-write service", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    // #759's rate-limit budget is process-wide module state — reset it so a
    // rate limit recorded by one test never leaks into the next.
    resetGitHubRateLimitForTests();
    clearReleaseWorkflowCacheForTests();
    clearReleasePrCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetGitHubRateLimitForTests();
    clearReleaseWorkflowCacheForTests();
    clearReleasePrCacheForTests();
  });

  it("addLabels POSTs the labels array to the issue's labels endpoint", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, []));
    await addLabels("tok", "owner", "repo", 5, ["mullion-claimed"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/issues/5/labels",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ labels: ["mullion-claimed"] }),
      }),
    );
  });

  it("removeLabel DELETEs the specific label", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, []));
    await removeLabel("tok", "owner", "repo", 5, "mullion-claimed");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/issues/5/labels/mullion-claimed",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("removeLabel swallows a 404 (label already absent) instead of throwing", async () => {
    fetchMock.mockResolvedValueOnce(textResponse(404, "Not Found"));
    await expect(
      removeLabel("tok", "owner", "repo", 5, "mullion-claimed"),
    ).resolves.toBeUndefined();
  });

  it("createComment posts a body and returns id/htmlUrl", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(201, { id: 42, html_url: "https://github.com/owner/repo/issues/5#comment-42" }),
    );
    const result = await createComment("tok", "owner", "repo", 5, "hello");
    expect(result).toEqual({
      id: 42,
      htmlUrl: "https://github.com/owner/repo/issues/5#comment-42",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/issues/5/comments",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ body: "hello" }) }),
    );
  });

  it("setAssignees POSTs the assignees array", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    await setAssignees("tok", "owner", "repo", 5, ["octocat"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/issues/5/assignees",
      expect.objectContaining({ body: JSON.stringify({ assignees: ["octocat"] }) }),
    );
  });

  it("closeIssue PATCHes state: closed", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { state: "closed" }));
    await closeIssue("tok", "owner", "repo", 5);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/issues/5",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ state: "closed" }) }),
    );
  });

  it("getIssueState returns the issue's current state and label names", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        state: "closed",
        labels: [{ name: "mullion-reviewing" }, { name: "bug" }],
      }),
    );
    expect(await getIssueState("tok", "owner", "repo", 5)).toEqual({
      state: "closed",
      labels: ["mullion-reviewing", "bug"],
    });
  });

  it("getIssueState defaults to an empty label list when the issue has none", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { state: "open" }));
    expect(await getIssueState("tok", "owner", "repo", 5)).toEqual({ state: "open", labels: [] });
  });

  it("getIssueState tolerates a bare-string label list, not just label objects", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { state: "open", labels: ["mullion-task", "bug"] }),
    );
    expect(await getIssueState("tok", "owner", "repo", 5)).toEqual({
      state: "open",
      labels: ["mullion-task", "bug"],
    });
  });

  it("getIssueState maps a 404 to a plain GitHubApiError, not a scope error — a GET 404 means the issue doesn't exist, not a permission problem", async () => {
    fetchMock.mockResolvedValue(textResponse(404, "Not Found"));
    try {
      await getIssueState("tok", "owner", "repo", 999);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubApiError);
      expect(err).not.toBeInstanceOf(GitHubWriteScopeError);
    }
  });

  it("createPullRequest posts title/head/base/body/draft and returns number/htmlUrl/nodeId", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(201, {
        number: 7,
        html_url: "https://github.com/owner/repo/pull/7",
        node_id: "PR_node7",
      }),
    );
    const result = await createPullRequest("tok", "owner", "repo", {
      title: "t",
      head: "mullion/task-1",
      base: "main",
      body: "b",
      draft: true,
    });
    expect(result).toEqual({
      number: 7,
      htmlUrl: "https://github.com/owner/repo/pull/7",
      nodeId: "PR_node7",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/pulls",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          title: "t",
          head: "mullion/task-1",
          base: "main",
          body: "b",
          draft: true,
        }),
      }),
    );
  });

  it("getPullRequestByNumber GETs /pulls/:number and returns number/htmlUrl/nodeId/headSha", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        number: 9,
        html_url: "https://github.com/owner/repo/pull/9",
        node_id: "PR_node9",
        head: { sha: "abc123" },
        base: { ref: "main" },
      }),
    );
    const result = await getPullRequestByNumber("tok", "owner", "repo", 9);
    expect(result).toEqual({
      number: 9,
      htmlUrl: "https://github.com/owner/repo/pull/9",
      nodeId: "PR_node9",
      headSha: "abc123",
      baseRef: "main",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/pulls/9",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("getPullRequestByNumber also returns mergeable/mergeableState/state/merged/title/headRef", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        number: 9,
        html_url: "https://github.com/owner/repo/pull/9",
        node_id: "PR_node9",
        draft: false,
        head: { sha: "abc123", ref: "mullion/task-9" },
        base: { ref: "main" },
        title: "feat: do the thing",
        state: "open",
        merged: false,
        mergeable: true,
        mergeable_state: "clean",
      }),
    );
    const result = await getPullRequestByNumber("tok", "owner", "repo", 9);
    expect(result).toEqual({
      number: 9,
      htmlUrl: "https://github.com/owner/repo/pull/9",
      nodeId: "PR_node9",
      draft: false,
      headSha: "abc123",
      headRef: "mullion/task-9",
      baseRef: "main",
      title: "feat: do the thing",
      state: "open",
      merged: false,
      mergeable: true,
      mergeableState: "clean",
    });
  });

  // #1015 (archive), review fix — the archive-merged backfill route prefers
  // this over "whenever the route happened to run."
  it("getPullRequestByNumber passes through merged_at as mergedAt", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        number: 9,
        html_url: "u",
        node_id: "n",
        draft: false,
        head: { sha: "abc123", ref: "mullion/task-9" },
        base: { ref: "main" },
        title: "t",
        state: "closed",
        merged: true,
        merged_at: "2026-01-01T12:00:00Z",
        mergeable: null,
        mergeable_state: "unknown",
      }),
    );
    const result = await getPullRequestByNumber("tok", "owner", "repo", 9);
    expect(result.mergedAt).toBe("2026-01-01T12:00:00Z");
  });

  it("getPullRequestByNumber passes through mergeable: null (GitHub still computing it)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        number: 9,
        html_url: "u",
        node_id: "n",
        draft: false,
        head: { sha: "abc123", ref: "mullion/task-9" },
        base: { ref: "main" },
        title: "t",
        state: "open",
        merged: false,
        mergeable: null,
        mergeable_state: "unknown",
      }),
    );
    const result = await getPullRequestByNumber("tok", "owner", "repo", 9);
    expect(result.mergeable).toBeNull();
    expect(result.mergeableState).toBe("unknown");
  });

  it("mergePullRequest PUTs merge_method/sha/commit_title to the merge endpoint", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { merged: true, sha: "def456" }));
    const result = await mergePullRequest("tok", "owner", "repo", 9, {
      sha: "abc123",
      commitTitle: "feat: do the thing (#9)",
    });
    expect(result).toEqual({ merged: true, sha: "def456" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/pulls/9/merge",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          merge_method: "squash",
          sha: "abc123",
          commit_title: "feat: do the thing (#9)",
        }),
      }),
    );
  });

  it("mergePullRequest maps a 405 (not mergeable) to a plain GitHubApiError, not a scope error", async () => {
    fetchMock.mockResolvedValueOnce(textResponse(405, "Pull Request is not mergeable"));
    try {
      await mergePullRequest("tok", "owner", "repo", 9, { sha: "abc123", commitTitle: "t" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubApiError);
      expect(err).not.toBeInstanceOf(GitHubWriteScopeError);
      expect((err as GitHubApiError).statusCode).toBe(405);
    }
  });

  it("mergePullRequest maps a 409 (head sha moved) to a plain GitHubApiError, not a scope error", async () => {
    fetchMock.mockResolvedValueOnce(textResponse(409, "Head branch was modified"));
    try {
      await mergePullRequest("tok", "owner", "repo", 9, { sha: "abc123", commitTitle: "t" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubApiError);
      expect(err).not.toBeInstanceOf(GitHubWriteScopeError);
      expect((err as GitHubApiError).statusCode).toBe(409);
    }
  });

  it("updatePullRequestBranch PUTs expected_head_sha to the update-branch endpoint", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(202, { message: "Updating pull request branch." }),
    );
    await updatePullRequestBranch("tok", "owner", "repo", 9, "abc123");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/pulls/9/update-branch",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ expected_head_sha: "abc123" }),
      }),
    );
  });

  it("deleteRemoteBranch DELETEs the branch's git ref", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await deleteRemoteBranch("tok", "owner", "repo", "mullion/task-9");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/git/refs/heads/mullion%2Ftask-9",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("deleteRemoteBranch swallows a 404 (branch already gone) instead of throwing", async () => {
    fetchMock.mockResolvedValueOnce(textResponse(404, "Reference does not exist"));
    await expect(
      deleteRemoteBranch("tok", "owner", "repo", "mullion/task-9"),
    ).resolves.toBeUndefined();
  });

  it("deleteRemoteBranch still throws on a real scope problem (403)", async () => {
    fetchMock.mockResolvedValueOnce(textResponse(403, "Resource not accessible by integration"));
    await expect(
      deleteRemoteBranch("tok", "owner", "repo", "mullion/task-9"),
    ).rejects.toBeInstanceOf(GitHubWriteScopeError);
  });

  it("createPullRequestReview POSTs a COMMENT-event review with anchored comments", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(201, {
        id: 555,
        html_url: "https://github.com/owner/repo/pull/9#pullrequestreview-555",
      }),
    );
    const result = await createPullRequestReview("tok", "owner", "repo", 9, {
      body: "## Round 1\n\nOne finding.",
      commitId: "abc123",
      comments: [{ path: "a.go", line: 42, side: "RIGHT", body: "unchecked error" }],
    });
    expect(result).toEqual({
      id: 555,
      htmlUrl: "https://github.com/owner/repo/pull/9#pullrequestreview-555",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/pulls/9/reviews",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          body: "## Round 1\n\nOne finding.",
          commit_id: "abc123",
          event: "COMMENT",
          comments: [{ path: "a.go", line: 42, side: "RIGHT", body: "unchecked error" }],
        }),
      }),
    );
  });

  it("posts undefined comments when none are given", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(201, {
        id: 556,
        html_url: "https://github.com/owner/repo/pull/9#pullrequestreview-556",
      }),
    );
    await createPullRequestReview("tok", "owner", "repo", 9, {
      body: "Review complete — no findings.",
      commitId: "abc123",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/pulls/9/reviews",
      expect.objectContaining({
        body: JSON.stringify({
          body: "Review complete — no findings.",
          commit_id: "abc123",
          event: "COMMENT",
          comments: undefined,
        }),
      }),
    );
  });

  // Hermes review, PR #738 — an empty `comments` array (not `undefined`)
  // survives JSON.stringify (only `undefined` properties are dropped), and
  // GitHub 422s a review whose `comments` key is present but empty.
  it("treats an empty comments array the same as none, not as an empty comments key", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { id: 557, html_url: "u" }));
    await createPullRequestReview("tok", "owner", "repo", 9, {
      body: "b",
      commitId: "abc123",
      comments: [],
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).comments).toBeUndefined();
  });

  // Hermes review, PR #738 — GitHub's own documented default for a review
  // comment's `side` is "RIGHT", so omitting it (rather than us guessing a
  // default) does exactly what a caller who deliberately left it out wants,
  // with no risk of second-guessing a LEFT-only anchor on a deleted line.
  it("omits side entirely when a comment doesn't set one, rather than defaulting it", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { id: 558, html_url: "u" }));
    await createPullRequestReview("tok", "owner", "repo", 9, {
      body: "b",
      commitId: "abc123",
      comments: [{ path: "a.go", line: 1, body: "b" }],
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).comments).toEqual([
      { path: "a.go", line: 1, body: "b" },
    ]);
  });

  // #737 — event defaults to COMMENT (the self-review constraint
  // createPullRequestReview's own doc comment documents: GitHub 422s
  // APPROVE/REQUEST_CHANGES from a PR's own author, so a caller with the
  // primary token must never pass anything else) when the caller doesn't
  // specify one at all.
  it("defaults event to COMMENT when the caller doesn't specify one", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { id: 1, html_url: "u" }));
    await createPullRequestReview("tok", "owner", "repo", 9, { body: "b", commitId: "c" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).event).toBe("COMMENT");
  });

  // #737 — a gating event IS now a valid parameter, for the reviewer
  // identity's own calls (task-github-sync.ts's postReviewFindingsComment).
  // This function has no way to know which identity `token` authenticates
  // as, so it doesn't (and can't) enforce which token pairs with which
  // event — that contract lives at the caller.
  it.each(["APPROVE", "REQUEST_CHANGES"] as const)(
    "sends an explicit %s event through unchanged",
    async (event) => {
      fetchMock.mockResolvedValueOnce(jsonResponse(201, { id: 1, html_url: "u" }));
      await createPullRequestReview("tok", "owner", "repo", 9, { body: "b", commitId: "c", event });
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(init.body as string).event).toBe(event);
    },
  );

  it("createPullRequestReview maps a 422 to a plain GitHubApiError (caller does the retry-without-anchors fallback)", async () => {
    fetchMock.mockResolvedValueOnce(
      textResponse(422, "Validation Failed: line must be part of the diff"),
    );
    await expect(
      createPullRequestReview("tok", "owner", "repo", 9, {
        body: "b",
        commitId: "c",
        comments: [{ path: "a.go", line: 9999, body: "out of diff" }],
      }),
    ).rejects.toThrow(GitHubApiError);
  });

  it("closePullRequest PATCHes state: closed on the pull, not the issue, endpoint", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { number: 9, state: "closed" }));
    await closePullRequest("tok", "owner", "repo", 9);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/pulls/9",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ state: "closed" }) }),
    );
  });

  // #782 — mirrors closePullRequest's own test shape exactly, the same
  // shared PATCH .../pulls/:number endpoint with a different field.
  it("updatePullRequestTitle PATCHes title on the pull endpoint", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { number: 9, title: "feat: new title" }));
    await updatePullRequestTitle("tok", "owner", "repo", 9, "feat: new title");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/pulls/9",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ title: "feat: new title" }),
      }),
    );
  });

  it("markPullRequestReadyForReview posts a GraphQL mutation with the PR node id", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: { markPullRequestReadyForReview: { pullRequest: { id: "PR_node9" } } },
      }),
    );
    await markPullRequestReadyForReview("tok", "PR_node9");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.github.com/graphql");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.query).toContain("markPullRequestReadyForReview");
    expect(body.variables).toEqual({ id: "PR_node9" });
  });

  it("markPullRequestReadyForReview throws on a GraphQL-level error even with HTTP 200", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { errors: [{ message: "Resource not accessible by integration" }] }),
    );
    await expect(markPullRequestReadyForReview("tok", "PR_node9")).rejects.toThrow(
      /Resource not accessible/,
    );
  });

  it("markPullRequestReadyForReview maps a 403 to GitHubWriteScopeError, same as every REST write", async () => {
    fetchMock.mockResolvedValueOnce(textResponse(403, "Resource not accessible by integration"));
    await expect(markPullRequestReadyForReview("tok", "PR_node9")).rejects.toBeInstanceOf(
      GitHubWriteScopeError,
    );
  });

  // #737 — the aggregate verdict `attemptMerge`'s "blocked" arm reads to
  // tell a missing/stale required review apart from a red required check.
  describe("getPullRequestReviewDecision (#737)", () => {
    it.each(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"] as const)(
      "returns %s straight through",
      async (decision) => {
        fetchMock.mockResolvedValueOnce(
          jsonResponse(200, {
            data: { repository: { pullRequest: { reviewDecision: decision } } },
          }),
        );
        const result = await getPullRequestReviewDecision("tok", "owner", "repo", 9);
        expect(result).toBe(decision);
      },
    );

    it("returns null when GitHub reports no review decision at all (no review requirement configured)", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          data: { repository: { pullRequest: { reviewDecision: null } } },
        }),
      );
      const result = await getPullRequestReviewDecision("tok", "owner", "repo", 9);
      expect(result).toBeNull();
    });

    it("returns null (rather than throwing) if GitHub ever adds a value this doesn't recognize", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          data: { repository: { pullRequest: { reviewDecision: "SOME_FUTURE_VALUE" } } },
        }),
      );
      const result = await getPullRequestReviewDecision("tok", "owner", "repo", 9);
      expect(result).toBeNull();
    });

    it("returns null when the PR/repo isn't found, without throwing", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { repository: null } }));
      const result = await getPullRequestReviewDecision("tok", "owner", "repo", 9);
      expect(result).toBeNull();
    });

    it("posts the expected GraphQL query with owner/repo/number as variables", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          data: { repository: { pullRequest: { reviewDecision: "APPROVED" } } },
        }),
      );
      await getPullRequestReviewDecision("tok", "owner", "repo", 9);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.variables).toEqual({ owner: "owner", repo: "repo", number: 9 });
    });

    it("maps a 403 to GitHubWriteScopeError, same as every other GraphQL call", async () => {
      fetchMock.mockResolvedValueOnce(textResponse(403, "Resource not accessible by integration"));
      await expect(getPullRequestReviewDecision("tok", "owner", "repo", 9)).rejects.toBeInstanceOf(
        GitHubWriteScopeError,
      );
    });
  });

  it("fetchPullRequestReviewThreads posts a GraphQL query with owner/repo/number and returns viewerLogin (stripped of its [bot] suffix) plus threads", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: {
          viewer: { login: "mullion-bot[bot]" },
          repository: {
            pullRequest: {
              reviewThreads: {
                totalCount: 1,
                nodes: [
                  {
                    isResolved: false,
                    comments: {
                      totalCount: 1,
                      nodes: [
                        {
                          author: { login: "octocat" },
                          createdAt: "2026-08-20T10:00:00Z",
                          path: "src/foo.ts",
                          line: 42,
                          body: "Please fix this null check.",
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      }),
    );

    const result = await fetchPullRequestReviewThreads("tok", "owner", "repo", 9);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.github.com/graphql");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.query).toContain("reviewThreads");
    expect(body.variables).toEqual({
      owner: "owner",
      repo: "repo",
      number: 9,
      threadsFirst: 100,
      commentsFirst: 50,
    });
    expect(result).toEqual({
      viewerLogin: "mullion-bot",
      truncated: false,
      threads: [
        {
          isResolved: false,
          comments: [
            {
              author: "octocat",
              createdAt: "2026-08-20T10:00:00Z",
              path: "src/foo.ts",
              line: 42,
              body: "Please fix this null check.",
            },
          ],
        },
      ],
    });
  });

  it("fetchPullRequestReviewThreads returns an empty result when the PR/repo isn't found, without throwing", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { data: { viewer: { login: "mullion-bot[bot]" }, repository: null } }),
    );
    const result = await fetchPullRequestReviewThreads("tok", "owner", "repo", 9);
    expect(result).toEqual({ viewerLogin: "mullion-bot", threads: [], truncated: false });
  });

  it("fetchPullRequestReviewThreads sets truncated when a page's totalCount exceeds what was fetched", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: {
          viewer: { login: "mullion-bot[bot]" },
          repository: {
            pullRequest: {
              reviewThreads: {
                totalCount: 200,
                nodes: [
                  {
                    isResolved: false,
                    comments: { totalCount: 1, nodes: [] },
                  },
                ],
              },
            },
          },
        },
      }),
    );
    const result = await fetchPullRequestReviewThreads("tok", "owner", "repo", 9);
    expect(result.truncated).toBe(true);
  });

  it("fetchPullRequestReviewThreads maps a 403 to GitHubWriteScopeError, same as every REST write", async () => {
    fetchMock.mockResolvedValueOnce(textResponse(403, "Resource not accessible by integration"));
    await expect(fetchPullRequestReviewThreads("tok", "owner", "repo", 9)).rejects.toBeInstanceOf(
      GitHubWriteScopeError,
    );
  });

  describe("fetchViewerLogin", () => {
    it("strips a GitHub App installation token's [bot] suffix so the result matches author.login elsewhere", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, { data: { viewer: { login: "mullion-reviewer[bot]" } } }),
      );
      await expect(fetchViewerLogin("tok")).resolves.toBe("mullion-reviewer");
    });

    it("leaves a PAT/OAuth human login untouched", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, { data: { viewer: { login: "octocat" } } }),
      );
      await expect(fetchViewerLogin("tok")).resolves.toBe("octocat");
    });

    it("returns null when GitHub reports no viewer", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { viewer: null } }));
      await expect(fetchViewerLogin("tok")).resolves.toBeNull();
    });
  });

  it("findPullRequestByHead GETs /pulls?head=... and returns the first match's number/htmlUrl", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, [{ number: 9, html_url: "https://github.com/owner/repo/pull/9" }]),
    );
    const result = await findPullRequestByHead("tok", "owner", "repo", "owner:mullion/task-1");
    expect(result).toEqual({ number: 9, htmlUrl: "https://github.com/owner/repo/pull/9" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/pulls?head=owner%3Amullion%2Ftask-1&state=open&sort=created&direction=desc",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("findPullRequestByHead returns null when no PR matches the head", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, []));
    expect(await findPullRequestByHead("tok", "owner", "repo", "owner:no-such-branch")).toBeNull();
  });

  it("findPullRequestByHead takes the first match when GitHub returns more than one", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, [
        { number: 3, html_url: "https://github.com/owner/repo/pull/3" },
        { number: 4, html_url: "https://github.com/owner/repo/pull/4" },
      ]),
    );
    const result = await findPullRequestByHead("tok", "owner", "repo", "owner:mullion/task-1");
    expect(result).toEqual({ number: 3, htmlUrl: "https://github.com/owner/repo/pull/3" });
  });

  it("listWorkflows GETs /actions/workflows and maps snake_case fields", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        total_count: 2,
        workflows: [
          { id: 1, name: "CI/CD", path: ".github/workflows/ci-cd.yml" },
          { id: 2, name: "Release Please", path: ".github/workflows/release-please.yml" },
        ],
      }),
    );
    const result = await listWorkflows("tok", "owner", "repo");
    expect(result).toEqual([
      { id: 1, name: "CI/CD", path: ".github/workflows/ci-cd.yml" },
      { id: 2, name: "Release Please", path: ".github/workflows/release-please.yml" },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/actions/workflows?per_page=100",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("findReleasePleaseWorkflow matches by path basename against known release-please filenames", () => {
    const workflows = [
      { id: 1, name: "CI/CD", path: ".github/workflows/ci-cd.yml" },
      { id: 2, name: "Release Please", path: ".github/workflows/release-please.yml" },
    ];
    expect(findReleasePleaseWorkflow(workflows)).toEqual({
      id: 2,
      name: "Release Please",
      path: ".github/workflows/release-please.yml",
    });
  });

  it("findReleasePleaseWorkflow returns null when no workflow matches a known filename", () => {
    const workflows = [{ id: 1, name: "CI/CD", path: ".github/workflows/ci-cd.yml" }];
    expect(findReleasePleaseWorkflow(workflows)).toBeNull();
  });

  it("findReleasePleaseWorkflow does NOT match the generic release.yml/.yaml filenames", () => {
    // Regression test for the deliberate narrowing documented on
    // RELEASE_WORKFLOW_FILENAMES: release.yml/.yaml are common names for
    // workflows unrelated to release-please (goreleaser, npm publish,
    // semantic-release). Matching them would let the Run button dispatch
    // an arbitrary outward-facing workflow under a "release-please" label.
    const workflows = [
      { id: 1, name: "Release", path: ".github/workflows/release.yml" },
      { id: 2, name: "Release", path: ".github/workflows/release.yaml" },
    ];
    expect(findReleasePleaseWorkflow(workflows)).toBeNull();
  });

  it("dispatchWorkflow POSTs ref to the workflow's dispatches endpoint", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await dispatchWorkflow("tok", "owner", "repo", 2, "main");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/actions/workflows/2/dispatches",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ ref: "main" }),
      }),
    );
  });

  it("dispatchWorkflow maps a 422 (no workflow_dispatch trigger) to a plain GitHubApiError, not a scope error", async () => {
    fetchMock.mockResolvedValue(
      textResponse(422, "Workflow does not have 'workflow_dispatch' trigger"),
    );
    await expect(dispatchWorkflow("tok", "owner", "repo", 2, "main")).rejects.toMatchObject({
      name: "GitHubApiError",
      statusCode: 422,
    });
  });

  it("dispatchWorkflow maps a 403 to GitHubWriteScopeError, same as every REST write", async () => {
    fetchMock.mockResolvedValue(textResponse(403, "Resource not accessible by integration"));
    await expect(dispatchWorkflow("tok", "owner", "repo", 2, "main")).rejects.toBeInstanceOf(
      GitHubWriteScopeError,
    );
  });

  it("findReleasePullRequest GETs open PRs against base and filters to the release-please branch prefix", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, [
        {
          number: 11,
          html_url: "https://github.com/owner/repo/pull/11",
          head: { ref: "some-human-branch" },
          title: "unrelated PR",
        },
        {
          number: 12,
          html_url: "https://github.com/owner/repo/pull/12",
          head: { ref: "release-please--branches--main--components--repo" },
          title: "chore(main): release 0.2.45",
        },
      ]),
    );
    const result = await findReleasePullRequest("tok", "owner", "repo", "main");
    expect(result).toEqual({
      number: 12,
      htmlUrl: "https://github.com/owner/repo/pull/12",
      headRef: "release-please--branches--main--components--repo",
      title: "chore(main): release 0.2.45",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/pulls?state=open&base=main&sort=created&direction=desc",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("findReleasePullRequest returns null when no open PR has a release-please head branch", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, [
        {
          number: 11,
          html_url: "https://github.com/owner/repo/pull/11",
          head: { ref: "some-human-branch" },
          title: "unrelated PR",
        },
      ]),
    );
    expect(await findReleasePullRequest("tok", "owner", "repo", "main")).toBeNull();
  });

  describe("detectReleaseWorkflow", () => {
    it("returns 'found' with the matching workflow", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          workflows: [
            { id: 2, name: "Release Please", path: ".github/workflows/release-please.yml" },
          ],
        }),
      );
      expect(await detectReleaseWorkflow("tok", "owner", "repo")).toEqual({
        kind: "found",
        workflow: { id: 2, name: "Release Please", path: ".github/workflows/release-please.yml" },
      });
    });

    it("returns 'not-configured' when the list succeeds but nothing matches", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          workflows: [{ id: 1, name: "CI/CD", path: ".github/workflows/ci-cd.yml" }],
        }),
      );
      expect(await detectReleaseWorkflow("tok", "owner", "repo")).toEqual({
        kind: "not-configured",
      });
    });

    it("returns 'no-actions-scope' — not a thrown error — when the token can't list workflows", async () => {
      fetchMock.mockResolvedValue(textResponse(403, "Resource not accessible by integration"));
      expect(await detectReleaseWorkflow("tok", "owner", "repo")).toEqual({
        kind: "no-actions-scope",
      });
    });

    // Regression: a rate-limited 429 (or a 403 that's actually a rate limit,
    // classified before the write-scope branch — see githubRequest's own
    // doc comment) must NOT collapse to "no-actions-scope". Doing so is
    // exactly the misdiagnosis #759 exists to prevent, one layer up — a
    // process-wide rate limit the PR poller opened would otherwise make the
    // Release section silently vanish for every project, for a token that
    // actually has every scope it needs.
    it("rethrows a rate limit rather than reporting it as no-actions-scope", async () => {
      fetchMock.mockResolvedValue(textResponse(429, "rate limited", { "retry-after": "30" }));
      await expect(detectReleaseWorkflow("tok", "owner", "repo")).rejects.toBeInstanceOf(
        GitHubRateLimitError,
      );
    });

    it("rethrows a plain 5xx rather than reporting it as no-actions-scope", async () => {
      fetchMock.mockResolvedValue(textResponse(500, "server error"));
      await expect(detectReleaseWorkflow("tok", "owner", "repo")).rejects.toMatchObject({
        name: "GitHubApiError",
        statusCode: 500,
      });
    });

    it("caches a 'found' result — a second call within the TTL makes no new request", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          workflows: [
            { id: 2, name: "Release Please", path: ".github/workflows/release-please.yml" },
          ],
        }),
      );
      await detectReleaseWorkflow("tok", "owner", "repo");
      const callsAfterFirst = fetchMock.mock.calls.length;
      await detectReleaseWorkflow("tok", "owner", "repo");
      expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
    });

    it("does NOT cache a 'no-actions-scope' result — the very next call retries", async () => {
      fetchMock.mockResolvedValue(textResponse(403, "Resource not accessible by integration"));
      await detectReleaseWorkflow("tok", "owner", "repo");
      const callsAfterFirst = fetchMock.mock.calls.length;
      await detectReleaseWorkflow("tok", "owner", "repo");
      expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    });
  });

  describe("getCachedReleasePullRequestStatus", () => {
    // getDefaultBranch -> findReleasePullRequest -> getPullRequestByNumber,
    // in that fixed order — three sequential mocks matching the call order.
    function mockAssemblySequence() {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { default_branch: "main" }));
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, [
          {
            number: 12,
            html_url: "https://github.com/owner/repo/pull/12",
            head: { ref: "release-please--branches--main--components--repo" },
            title: "chore(main): release 0.2.46",
          },
        ]),
      );
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          number: 12,
          html_url: "https://github.com/owner/repo/pull/12",
          node_id: "PR_release",
          draft: false,
          head: { sha: "deadbeef", ref: "release-please--branches--main--components--repo" },
          base: { ref: "main" },
          title: "chore(main): release 0.2.46",
          state: "open",
          merged: false,
          mergeable: true,
          mergeable_state: "clean",
        }),
      );
    }

    it("assembles the release PR's full status, merging in the poller's cached ciStatus", async () => {
      mockAssemblySequence();
      const cachedPr = {
        number: 12,
        title: "chore(main): release 0.2.46",
        htmlUrl: "https://github.com/owner/repo/pull/12",
        author: null,
        headSha: "deadbeef",
        headBranch: "release-please--branches--main--components--repo",
        baseBranch: "main",
        ciStatus: "success" as const,
        actionsRuns: [],
      };
      setRepoPRsStatus("owner", "repo", {
        prs: [cachedPr],
        prSummary: computePRSummary([cachedPr]),
      });

      const result = await getCachedReleasePullRequestStatus("tok", "owner", "repo");
      expect(result).toEqual({
        number: 12,
        htmlUrl: "https://github.com/owner/repo/pull/12",
        title: "chore(main): release 0.2.46",
        headRef: "release-please--branches--main--components--repo",
        headSha: "deadbeef",
        draft: false,
        mergeable: true,
        mergeableState: "clean",
        ciStatus: "success",
      });
    });

    it("returns null when no release PR is open, without a fourth request", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { default_branch: "main" }));
      fetchMock.mockResolvedValueOnce(jsonResponse(200, []));
      expect(await getCachedReleasePullRequestStatus("tok", "owner", "repo")).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("caches the result — a second call within the TTL makes no new requests", async () => {
      mockAssemblySequence();
      await getCachedReleasePullRequestStatus("tok", "owner", "repo");
      const callsAfterFirst = fetchMock.mock.calls.length;
      await getCachedReleasePullRequestStatus("tok", "owner", "repo");
      expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
    });

    it("invalidateReleaseCache drops the cache — the next call re-fetches", async () => {
      mockAssemblySequence();
      await getCachedReleasePullRequestStatus("tok", "owner", "repo");
      const callsAfterFirst = fetchMock.mock.calls.length;

      invalidateReleaseCache("owner", "repo");
      mockAssemblySequence();
      await getCachedReleasePullRequestStatus("tok", "owner", "repo");
      expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    });
  });

  it("a 403 throws GitHubWriteScopeError naming the missing scope", async () => {
    fetchMock.mockResolvedValue(textResponse(403, "Resource not accessible by integration"));
    await expect(addLabels("tok", "owner", "repo", 5, ["x"])).rejects.toThrow(
      GitHubWriteScopeError,
    );
    try {
      await addLabels("tok", "owner", "repo", 5, ["x"]);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubWriteScopeError);
      expect((err as GitHubWriteScopeError).statusCode).toBe(403);
      expect((err as Error).message).toContain("docs/github-integration.md");
    }
  });

  it("GitHubWriteScopeError is also a GitHubApiError (same catch-by-base-class shape as GitHubApiError elsewhere)", async () => {
    fetchMock.mockResolvedValueOnce(textResponse(403, "nope"));
    await expect(addLabels("tok", "owner", "repo", 5, ["x"])).rejects.toBeInstanceOf(
      GitHubApiError,
    );
  });

  it("a 500 throws a plain GitHubApiError, not GitHubWriteScopeError", async () => {
    fetchMock.mockResolvedValue(textResponse(500, "server error"));
    await expect(addLabels("tok", "owner", "repo", 5, ["x"])).rejects.toThrow(GitHubApiError);
    try {
      await addLabels("tok", "owner", "repo", 5, ["x"]);
      expect.unreachable();
    } catch (err) {
      expect(err).not.toBeInstanceOf(GitHubWriteScopeError);
      expect(err).toBeInstanceOf(GitHubApiError);
    }
  });

  it("removeLabel still throws on a 403 (a real scope problem, not an already-absent label)", async () => {
    fetchMock.mockResolvedValueOnce(textResponse(403, "no access"));
    await expect(removeLabel("tok", "owner", "repo", 5, "x")).rejects.toThrow(
      GitHubWriteScopeError,
    );
  });

  it("a network failure throws GitHubApiError with statusCode 0", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    try {
      await addLabels("tok", "owner", "repo", 5, ["x"]);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubApiError);
      expect((err as GitHubApiError).statusCode).toBe(0);
    }
  });

  it("rejects an invalid owner/repo before ever calling fetch", async () => {
    await expect(addLabels("tok", "bad owner", "repo", 5, ["x"])).rejects.toThrow(GitHubApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe("#759 — rate limiting", () => {
    it("a 429 throws GitHubRateLimitError with retryAfterMs from Retry-After (seconds)", async () => {
      fetchMock.mockResolvedValueOnce(textResponse(429, "rate limited", { "retry-after": "30" }));
      try {
        await addLabels("tok", "owner", "repo", 5, ["x"]);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(GitHubRateLimitError);
        expect((err as GitHubRateLimitError).statusCode).toBe(429);
        expect((err as GitHubRateLimitError).retryAfterMs).toBe(30_000);
      }
    });

    it("a 403 with X-RateLimit-Remaining: 0 and a future X-RateLimit-Reset classifies as a rate limit, not GitHubWriteScopeError", async () => {
      const resetAt = Math.floor(Date.now() / 1000) + 120;
      fetchMock.mockResolvedValueOnce(
        textResponse(403, "nope", {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(resetAt),
        }),
      );
      await expect(addLabels("tok", "owner", "repo", 5, ["x"])).rejects.toBeInstanceOf(
        GitHubRateLimitError,
      );
    });

    it("a 403 with X-RateLimit-Remaining: 0 but no X-RateLimit-Reset still throws GitHubWriteScopeError — reset-in-the-future is required, not remaining alone", async () => {
      fetchMock.mockResolvedValueOnce(
        textResponse(403, "no access", { "x-ratelimit-remaining": "0" }),
      );
      await expect(addLabels("tok", "owner", "repo", 5, ["x"])).rejects.toBeInstanceOf(
        GitHubWriteScopeError,
      );
    });

    it("a 403 with Retry-After classifies as a rate limit even without X-RateLimit-Remaining", async () => {
      fetchMock.mockResolvedValueOnce(textResponse(403, "nope", { "retry-after": "5" }));
      await expect(addLabels("tok", "owner", "repo", 5, ["x"])).rejects.toBeInstanceOf(
        GitHubRateLimitError,
      );
    });

    it("GitHubRateLimitError is also a GitHubApiError (same catch-by-base-class shape as GitHubWriteScopeError)", async () => {
      fetchMock.mockResolvedValueOnce(textResponse(429, "rate limited"));
      await expect(addLabels("tok", "owner", "repo", 5, ["x"])).rejects.toBeInstanceOf(
        GitHubApiError,
      );
    });

    it("records the rate limit into the shared budget, short-circuiting a later call without hitting fetch again", async () => {
      fetchMock.mockResolvedValueOnce(textResponse(429, "rate limited", { "retry-after": "60" }));
      await expect(addLabels("tok", "owner", "repo", 5, ["x"])).rejects.toBeInstanceOf(
        GitHubRateLimitError,
      );
      expect(isGitHubRateLimited()).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await expect(removeLabel("tok", "owner", "repo", 5, "x")).rejects.toBeInstanceOf(
        GitHubRateLimitError,
      );
      // The second call never reached fetch — short-circuited at the top of
      // githubRequest before doing any network work.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("a default backoff applies when a 429 carries no Retry-After header at all", async () => {
      fetchMock.mockResolvedValueOnce(textResponse(429, "rate limited"));
      try {
        await addLabels("tok", "owner", "repo", 5, ["x"]);
        expect.unreachable();
      } catch (err) {
        expect((err as GitHubRateLimitError).retryAfterMs).toBe(60_000);
      }
    });

    it("the GraphQL path (markPullRequestReadyForReview) also classifies a 429 as GitHubRateLimitError, not falling through to GitHubApiError", async () => {
      fetchMock.mockResolvedValueOnce(textResponse(429, "rate limited", { "retry-after": "10" }));
      await expect(markPullRequestReadyForReview("tok", "PR_node9")).rejects.toBeInstanceOf(
        GitHubRateLimitError,
      );
    });

    it("the GraphQL path's own transport (githubApiFetch) also short-circuits once the budget is set by a REST call", async () => {
      fetchMock.mockResolvedValueOnce(textResponse(429, "rate limited", { "retry-after": "60" }));
      await expect(addLabels("tok", "owner", "repo", 5, ["x"])).rejects.toBeInstanceOf(
        GitHubRateLimitError,
      );
      await expect(markPullRequestReadyForReview("tok", "PR_node9")).rejects.toBeInstanceOf(
        GitHubRateLimitError,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
