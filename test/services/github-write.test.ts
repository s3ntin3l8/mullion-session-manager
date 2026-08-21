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
  markPullRequestReadyForReview,
  createPullRequestReview,
  GitHubWriteScopeError,
} from "../../src/services/github-write.js";
import { GitHubApiError } from "../../src/services/github.js";
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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetGitHubRateLimitForTests();
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
      }),
    );
    const result = await getPullRequestByNumber("tok", "owner", "repo", 9);
    expect(result).toEqual({
      number: 9,
      htmlUrl: "https://github.com/owner/repo/pull/9",
      nodeId: "PR_node9",
      headSha: "abc123",
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
      title: "feat: do the thing",
      state: "open",
      merged: false,
      mergeable: true,
      mergeableState: "clean",
    });
  });

  it("getPullRequestByNumber passes through mergeable: null (GitHub still computing it)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        number: 9,
        html_url: "u",
        node_id: "n",
        draft: false,
        head: { sha: "abc123", ref: "mullion/task-9" },
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

  // The self-review constraint createPullRequestReview's own doc comment
  // documents: only COMMENT is ever sent, since GitHub 422s APPROVE/
  // REQUEST_CHANGES from a PR's own author. This test just pins that no
  // caller can accidentally widen `event` — there's no parameter for it.
  it("never sends an event other than COMMENT", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { id: 1, html_url: "u" }));
    await createPullRequestReview("tok", "owner", "repo", 9, { body: "b", commitId: "c" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).event).toBe("COMMENT");
  });

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
