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
  closePullRequest,
  markPullRequestReadyForReview,
  createPullRequestReview,
  GitHubWriteScopeError,
} from "../../src/services/github-write.js";
import { GitHubApiError } from "../../src/services/github.js";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(status: number, body: string) {
  return new Response(body, { status });
}

describe("github-write service", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
});
