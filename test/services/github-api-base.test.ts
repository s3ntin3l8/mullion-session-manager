import Fastify from "fastify";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { envPlugin } from "../../src/plugins/env.js";
import { githubApiBasePlugin } from "../../src/plugins/github-api-base.js";
import { listLabeledIssues } from "../../src/services/github.js";
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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

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

  it("drops trailing slashes and spaces, and falls back to the default for an empty value", () => {
    setGitHubApiBase(` ${FAKE}// `);
    expect(githubApiBase()).toBe(FAKE);
    setGitHubApiBase("");
    expect(githubApiBase()).toBe("https://api.github.com");
  });

  it("accepts parent_issue_url on the configured base, and only that base", async () => {
    const parent = (host: string) =>
      jsonResponse([
        { number: 1, title: "t", body: "", parent_issue_url: `${host}/repos/acme/epic/issues/7` },
      ]);
    setGitHubApiBase(FAKE);
    fetchMock.mockResolvedValueOnce(parent(FAKE));
    const [onBase] = await listLabeledIssues("tok", "o", "r", "mullion-task");
    expect(onBase.parent).toEqual({ repo: "acme/epic", number: 7 });

    fetchMock.mockResolvedValueOnce(parent("https://api.github.com"));
    const [offBase] = await listLabeledIssues("tok", "o", "r", "mullion-task");
    expect(offBase.parent).toBeNull();
  });

  describe("githubApiBasePlugin", () => {
    const KEY = "MULLION_GITHUB_API_URL";
    let saved: string | undefined;

    beforeEach(() => {
      saved = process.env[KEY];
    });
    afterEach(() => {
      if (saved === undefined) delete process.env[KEY];
      else process.env[KEY] = saved;
    });

    async function boot(): Promise<void> {
      const app = Fastify();
      await app.register(envPlugin);
      await app.register(githubApiBasePlugin);
      await app.close();
    }

    it("applies MULLION_GITHUB_API_URL from the environment config", async () => {
      process.env[KEY] = ` ${FAKE}/ `;
      await boot();
      expect(githubApiBase()).toBe(FAKE);
    });

    it("keeps the default when the variable is unset", async () => {
      delete process.env[KEY];
      await boot();
      expect(githubApiBase()).toBe("https://api.github.com");
    });

    it("refuses to boot on a value that is not a URL", async () => {
      process.env[KEY] = "127.0.0.1:9999";
      await expect(boot()).rejects.toThrow(/MULLION_GITHUB_API_URL is not a valid URL/);
    });
  });
});
