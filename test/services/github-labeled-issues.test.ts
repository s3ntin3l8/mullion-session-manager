import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GitHubApiError, listLabeledIssues } from "../../src/services/github.js";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ISSUE = {
  number: 42,
  title: "Fix the thing",
  body: "some details",
  html_url: "https://github.com/o/r/issues/42",
};
const PR_WITH_LABEL = {
  number: 43,
  title: "A PR that happens to carry the task label",
  body: null,
  html_url: "https://github.com/o/r/pull/43",
  pull_request: {},
};

describe("listLabeledIssues", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches with the labels query param and a bearer token", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, []));
    await listLabeledIssues("tok", "owner", "repo", "mullion-task");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/issues?state=open&labels=mullion-task&per_page=100",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer tok",
          "User-Agent": "mullion-session-manager",
        }),
      }),
    );
  });

  it("maps issue fields and filters out PRs even though they carried the label", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, [ISSUE, PR_WITH_LABEL]));
    const result = await listLabeledIssues("tok", "owner", "repo", "mullion-task");
    expect(result).toEqual([
      {
        number: 42,
        title: "Fix the thing",
        body: "some details",
        htmlUrl: ISSUE.html_url,
        // #701 — ISSUE has no parent_issue_url, so this resolves to a
        // definite `null` (no parent), not `undefined` (unknown) — see
        // parseParentIssueUrl's own doc comment.
        parent: null,
      },
    ]);
  });

  // #701 — parent_issue_url / sub_issues_summary map for free on the same
  // response listLabeledIssues already reads, alongside
  // issue_dependencies_summary. Correcting issue #701's own original (wrong)
  // API research, which claimed no such field existed on this response.
  describe("sub-issue hierarchy (#701)", () => {
    it("parses a well-formed parent_issue_url into {repo, number}", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, [
          {
            ...ISSUE,
            parent_issue_url: "https://api.github.com/repos/s3ntin3l8/branchdam/issues/30",
          },
        ]),
      );
      const [result] = await listLabeledIssues("tok", "owner", "repo", "mullion-task");
      expect(result.parent).toEqual({ repo: "s3ntin3l8/branchdam", number: 30 });
    });

    it("treats an explicit null parent_issue_url as no parent", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, [{ ...ISSUE, parent_issue_url: null }]));
      const [result] = await listLabeledIssues("tok", "owner", "repo", "mullion-task");
      expect(result.parent).toBeNull();
    });

    it("treats a malformed or foreign-host parent_issue_url as no parent, not a partial parse", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, [
          { ...ISSUE, number: 1, parent_issue_url: "https://evil.example.com/repos/o/r/issues/1" },
          { ...ISSUE, number: 2, parent_issue_url: "not-a-url-at-all" },
          { ...ISSUE, number: 3, parent_issue_url: "https://api.github.com/repos/o/r/pulls/1" },
        ]),
      );
      const result = await listLabeledIssues("tok", "owner", "repo", "mullion-task");
      expect(result.every((r) => r.parent === null)).toBe(true);
    });

    it("maps sub_issues_summary into {total, completed}", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, [
          { ...ISSUE, sub_issues_summary: { total: 4, completed: 1, percent_completed: 25 } },
        ]),
      );
      const [result] = await listLabeledIssues("tok", "owner", "repo", "mullion-task");
      expect(result.subIssues).toEqual({ total: 4, completed: 1 });
    });

    it("leaves subIssues undefined when sub_issues_summary is absent", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, [ISSUE]));
      const [result] = await listLabeledIssues("tok", "owner", "repo", "mullion-task");
      expect(result.subIssues).toBeUndefined();
    });
  });

  it("defaults a missing body to null", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, [{ ...ISSUE, body: undefined }]));
    const [result] = await listLabeledIssues("tok", "owner", "repo", "mullion-task");
    expect(result.body).toBeNull();
  });

  it("throws GitHubApiError on a non-ok response", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 404 }));
    await expect(listLabeledIssues("tok", "owner", "repo", "mullion-task")).rejects.toThrow(
      GitHubApiError,
    );
  });

  it("throws GitHubApiError when the request itself fails", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    await expect(listLabeledIssues("tok", "owner", "repo", "mullion-task")).rejects.toThrow(
      GitHubApiError,
    );
  });
});
