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
      { number: 42, title: "Fix the thing", body: "some details", htmlUrl: ISSUE.html_url },
    ]);
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
