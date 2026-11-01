import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  githubApiBase,
  githubApiFetch,
  resetGitHubApiBaseForTests,
  resetGitHubRateLimitForTests,
  setGitHubApiBase,
} from "../../src/services/github-fetch.js";
import { addLabels } from "../../src/services/github-write.js";
import { graphql, resetGraphqlBackoffForTests } from "../../src/services/github-pr-reviews.js";

const FAKE = "http://127.0.0.1:9999";

function ok(body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("GitHub API base (MULLION_GITHUB_API_URL)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => ok({ data: {} }));
    vi.stubGlobal("fetch", fetchMock);
    resetGitHubApiBaseForTests();
    resetGitHubRateLimitForTests();
    resetGraphqlBackoffForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetGitHubApiBaseForTests();
    resetGitHubRateLimitForTests();
    resetGraphqlBackoffForTests();
  });

  const calledUrls = () => fetchMock.mock.calls.map((c) => String(c[0]));

  it("defaults to api.github.com on all three transports", async () => {
    expect(githubApiBase()).toBe("https://api.github.com");
    await githubApiFetch("/user");
    await addLabels("tok", "o", "r", 1, ["x"]);
    await graphql("tok", "query {}", {});
    expect(calledUrls()).toEqual([
      "https://api.github.com/user",
      "https://api.github.com/repos/o/r/issues/1/labels",
      "https://api.github.com/graphql",
    ]);
  });

  it("routes all three transports to the configured base", async () => {
    setGitHubApiBase(FAKE);
    await githubApiFetch("/user");
    await addLabels("tok", "o", "r", 1, ["x"]);
    await graphql("tok", "query {}", {});
    expect(calledUrls()).toEqual([
      `${FAKE}/user`,
      `${FAKE}/repos/o/r/issues/1/labels`,
      `${FAKE}/graphql`,
    ]);
  });

  it("drops trailing slashes, and falls back to the default for an empty value", () => {
    setGitHubApiBase(`${FAKE}//`);
    expect(githubApiBase()).toBe(FAKE);
    setGitHubApiBase("");
    expect(githubApiBase()).toBe("https://api.github.com");
  });
});
