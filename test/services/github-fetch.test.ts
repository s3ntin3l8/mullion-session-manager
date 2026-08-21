import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  classifyRateLimit,
  githubApiFetch,
  GitHubApiError,
  GitHubRateLimitError,
  isGitHubRateLimited,
  githubRateLimitRemainingMs,
  recordGitHubRateLimit,
  resetGitHubRateLimitForTests,
} from "../../src/services/github-fetch.js";

function textResponse(status: number, body: string, headers?: Record<string, string>) {
  return new Response(body, { status, headers });
}

describe("github-fetch service", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    resetGitHubRateLimitForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetGitHubRateLimitForTests();
  });

  describe("classifyRateLimit", () => {
    it("classifies 429 unconditionally, regardless of headers", () => {
      const result = classifyRateLimit(textResponse(429, "rate limited"));
      expect(result).toBeInstanceOf(GitHubRateLimitError);
      expect(result?.statusCode).toBe(429);
    });

    it("returns null for a 403 with neither Retry-After nor X-RateLimit-Remaining: 0", () => {
      expect(classifyRateLimit(textResponse(403, "no access"))).toBeNull();
    });

    it("returns null for a 403 with X-RateLimit-Remaining: 0 but a PAST X-RateLimit-Reset — stale/inconsistent headers are not a live rate limit", () => {
      const pastReset = Math.floor(Date.now() / 1000) - 60;
      const result = classifyRateLimit(
        textResponse(403, "no access", {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(pastReset),
        }),
      );
      expect(result).toBeNull();
    });

    it("returns null for a genuinely unrelated status (200, 404, 500)", () => {
      expect(classifyRateLimit(textResponse(200, "ok"))).toBeNull();
      expect(classifyRateLimit(textResponse(404, "not found"))).toBeNull();
      expect(classifyRateLimit(textResponse(500, "server error"))).toBeNull();
    });

    it("falls back to the default backoff when Retry-After is present but unparseable", () => {
      const result = classifyRateLimit(
        textResponse(429, "rate limited", { "retry-after": "not-a-number-or-date" }),
      );
      expect(result?.retryAfterMs).toBe(60_000);
    });

    it("parses an HTTP-date Retry-After, not just a seconds count", () => {
      const future = new Date(Date.now() + 45_000).toUTCString();
      const result = classifyRateLimit(
        textResponse(429, "rate limited", { "retry-after": future }),
      );
      // Allow a little slack for the time elapsed formatting/parsing the date.
      expect(result?.retryAfterMs).toBeGreaterThan(40_000);
      expect(result?.retryAfterMs).toBeLessThanOrEqual(45_000);
    });
  });

  describe("the shared budget", () => {
    it("isGitHubRateLimited/githubRateLimitRemainingMs reflect what recordGitHubRateLimit sets", () => {
      expect(isGitHubRateLimited()).toBe(false);
      recordGitHubRateLimit(Date.now() + 10_000);
      expect(isGitHubRateLimited()).toBe(true);
      expect(githubRateLimitRemainingMs()).toBeGreaterThan(0);
      expect(githubRateLimitRemainingMs()).toBeLessThanOrEqual(10_000);
    });

    it("recordGitHubRateLimit only ever extends the budget, never shortens it", () => {
      recordGitHubRateLimit(Date.now() + 60_000);
      const before = githubRateLimitRemainingMs();
      recordGitHubRateLimit(Date.now() + 1_000); // an earlier resume time than what's already set
      expect(githubRateLimitRemainingMs()).toBeGreaterThanOrEqual(before - 50); // unchanged (minus test jitter)
    });
  });

  describe("githubApiFetch", () => {
    it("short-circuits with GitHubRateLimitError, without calling fetch, once the budget is set", async () => {
      recordGitHubRateLimit(Date.now() + 10_000);
      await expect(githubApiFetch("/repos/o/r")).rejects.toBeInstanceOf(GitHubRateLimitError);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("records a rate limit into the shared budget even for a caller that doesn't itself throw on 403 — returns the Response as-is per its own contract", async () => {
      fetchMock.mockResolvedValueOnce(
        textResponse(403, "no access", { "x-ratelimit-remaining": "0", "retry-after": "20" }),
      );
      const res = await githubApiFetch("/repos/o/r");
      // The response is handed back unchanged — 403/404/etc mean different
      // things to different callers, so this function never decides for them.
      expect(res.status).toBe(403);
      // ...but the shared budget still learns about it.
      expect(isGitHubRateLimited()).toBe(true);
    });

    it("does not record anything for an ordinary non-rate-limit failure", async () => {
      fetchMock.mockResolvedValueOnce(textResponse(404, "not found"));
      await githubApiFetch("/repos/o/r");
      expect(isGitHubRateLimited()).toBe(false);
    });

    it("still maps a raw network failure to GitHubApiError(msg, 0), unaffected by the rate-limit budget", async () => {
      fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      try {
        await githubApiFetch("/repos/o/r");
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(GitHubApiError);
        expect((err as GitHubApiError).statusCode).toBe(0);
      }
    });
  });
});
