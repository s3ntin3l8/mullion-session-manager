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

  it("getIssueState returns the issue's current state", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { state: "closed" }));
    expect(await getIssueState("tok", "owner", "repo", 5)).toBe("closed");
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

  it("createPullRequest posts title/head/base/body and returns number/htmlUrl", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(201, { number: 7, html_url: "https://github.com/owner/repo/pull/7" }),
    );
    const result = await createPullRequest("tok", "owner", "repo", {
      title: "t",
      head: "mullion/task-1",
      base: "main",
      body: "b",
    });
    expect(result).toEqual({ number: 7, htmlUrl: "https://github.com/owner/repo/pull/7" });
  });

  it("findPullRequestByHead GETs /pulls?head=... and returns the first match's number/htmlUrl", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, [{ number: 9, html_url: "https://github.com/owner/repo/pull/9" }]),
    );
    const result = await findPullRequestByHead("tok", "owner", "repo", "owner:mullion/task-1");
    expect(result).toEqual({ number: 9, htmlUrl: "https://github.com/owner/repo/pull/9" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/pulls?head=owner%3Amullion%2Ftask-1&state=all",
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
