import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  checkForUpdate,
  resolveReleaseByTag,
  UpdateCheckError,
  clearUpdateCheckCacheForTests,
  CACHE_TTL_MS,
} from "../../src/services/update-checker.js";
import { resetGitHubRateLimitForTests } from "../../src/services/github-fetch.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// The service fetches the `/releases` list endpoint (not `/releases/latest`
// — see update-checker.ts's checkForUpdate doc comment for why), so every
// mocked GitHub response here is an array, newest-first like GitHub itself
// returns it.
function releasesResponse(status: number, releases: unknown[]): Response {
  return jsonResponse(status, releases);
}

describe("checkForUpdate", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    // Isolate every test from every other, regardless of repoSlug reuse —
    // simpler than github.test.ts's "unique key per test" convention since
    // this service exposes a reset hook specifically for it.
    clearUpdateCheckCacheForTests();
    // #759 — this file mocks a real 429 response (below), which
    // githubApiFetch now records into github-fetch.ts's process-wide
    // rate-limit budget. Without this reset, that budget leaks into
    // whichever test runs next in this file.
    resetGitHubRateLimitForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    resetGitHubRateLimitForTests();
  });

  it("reports no update available when the latest tag equals the current version", async () => {
    fetchMock.mockResolvedValueOnce(
      releasesResponse(200, [{ tag_name: "v0.1.4", html_url: "https://x", assets: [] }]),
    );

    const result = await checkForUpdate("owner/repo", "0.1.4", true);

    expect(result).toMatchObject({
      currentVersion: "0.1.4",
      latestVersion: "0.1.4",
      updateAvailable: false,
    });
  });

  it("reports update available for a newer patch/minor/major tag", async () => {
    for (const [latest, current] of [
      ["0.1.5", "0.1.4"],
      ["0.2.0", "0.1.9"],
      ["1.0.0", "0.9.9"],
    ]) {
      clearUpdateCheckCacheForTests();
      fetchMock.mockResolvedValueOnce(releasesResponse(200, [{ tag_name: `v${latest}` }]));
      const result = await checkForUpdate("owner/repo", current, true);
      expect(result.updateAvailable).toBe(true);
      expect(result.latestVersion).toBe(latest);
    }
  });

  it("does not report an update for an older or equal tag", async () => {
    fetchMock.mockResolvedValueOnce(releasesResponse(200, [{ tag_name: "v0.1.0" }]));

    const result = await checkForUpdate("owner/repo", "0.1.4", true);

    expect(result.updateAvailable).toBe(false);
  });

  it("strips a leading 'v' from the release tag", async () => {
    fetchMock.mockResolvedValueOnce(releasesResponse(200, [{ tag_name: "v1.2.3" }]));

    const result = await checkForUpdate("owner/repo", "0.1.0", true);

    expect(result.latestVersion).toBe("1.2.3");
  });

  it("treats an unparseable tag as no update available, not a crash", async () => {
    fetchMock.mockResolvedValueOnce(releasesResponse(200, [{ tag_name: "not-a-version" }]));

    const result = await checkForUpdate("owner/repo", "0.1.4", true);

    expect(result.updateAvailable).toBe(false);
    // Malformed tags are still surfaced verbatim (minus a leading "v") for
    // display — only the *comparison* degrades safely, not the value shown.
    expect(result.latestVersion).toBe("not-a-version");
  });

  it("returns latestVersion: null when the releases list is empty", async () => {
    fetchMock.mockResolvedValueOnce(releasesResponse(200, []));

    const result = await checkForUpdate("owner/repo", "0.1.4", true);

    expect(result.latestVersion).toBeNull();
    expect(result.updateAvailable).toBe(false);
  });

  it("returns latestVersion: null when the sole release has no tag_name at all", async () => {
    fetchMock.mockResolvedValueOnce(releasesResponse(200, [{}]));

    const result = await checkForUpdate("owner/repo", "0.1.4", true);

    expect(result.latestVersion).toBeNull();
    expect(result.updateAvailable).toBe(false);
  });

  it("picks the .tgz asset among multiple release assets", async () => {
    fetchMock.mockResolvedValueOnce(
      releasesResponse(200, [
        {
          tag_name: "v0.1.5",
          assets: [
            { name: "checksums.txt", browser_download_url: "https://x/checksums.txt" },
            { name: "mullion-0.1.5.tgz", browser_download_url: "https://x/mullion-0.1.5.tgz" },
          ],
        },
      ]),
    );

    const result = await checkForUpdate("owner/repo", "0.1.4", true);

    expect(result.assetUrl).toBe("https://x/mullion-0.1.5.tgz");
  });

  it("returns assetUrl: null when no .tgz asset is present", async () => {
    fetchMock.mockResolvedValueOnce(
      releasesResponse(200, [{ tag_name: "v0.1.5", assets: [{ name: "notes.txt" }] }]),
    );

    const result = await checkForUpdate("owner/repo", "0.1.4", true);

    expect(result.assetUrl).toBeNull();
  });

  it("picks the .sha256 checksum asset among multiple release assets", async () => {
    fetchMock.mockResolvedValueOnce(
      releasesResponse(200, [
        {
          tag_name: "v0.1.5",
          assets: [
            { name: "mullion-0.1.5.tgz", browser_download_url: "https://x/mullion-0.1.5.tgz" },
            {
              name: "mullion-0.1.5.tgz.sha256",
              browser_download_url: "https://x/mullion-0.1.5.tgz.sha256",
            },
          ],
        },
      ]),
    );

    const result = await checkForUpdate("owner/repo", "0.1.4", true);

    expect(result.checksumUrl).toBe("https://x/mullion-0.1.5.tgz.sha256");
  });

  it("returns checksumUrl: null when no .sha256 asset is present", async () => {
    fetchMock.mockResolvedValueOnce(
      releasesResponse(200, [
        {
          tag_name: "v0.1.5",
          assets: [
            { name: "mullion-0.1.5.tgz", browser_download_url: "https://x/mullion-0.1.5.tgz" },
          ],
        },
      ]),
    );

    const result = await checkForUpdate("owner/repo", "0.1.4", true);

    expect(result.checksumUrl).toBeNull();
  });

  it("skips draft and prerelease entries when picking the latest release", async () => {
    fetchMock.mockResolvedValueOnce(
      releasesResponse(200, [
        { tag_name: "v99.0.0", draft: true },
        { tag_name: "v50.0.0", prerelease: true },
        { tag_name: "v0.1.5" },
      ]),
    );

    const result = await checkForUpdate("owner/repo", "0.1.4", true);

    expect(result.latestVersion).toBe("0.1.5");
  });

  it("returns latestVersion: null when every release is a draft or prerelease", async () => {
    fetchMock.mockResolvedValueOnce(
      releasesResponse(200, [
        { tag_name: "v99.0.0", draft: true },
        { tag_name: "v50.0.0", prerelease: true },
      ]),
    );

    const result = await checkForUpdate("owner/repo", "0.1.4", true);

    expect(result.latestVersion).toBeNull();
    expect(result.updateAvailable).toBe(false);
  });

  it("picks the highest semver among the list, not just the first entry", async () => {
    // Deliberately out of order — GitHub returns newest-created-first, but
    // "created" and "highest version" aren't always the same release (e.g. a
    // hotfix backport tagged after a newer mainline release already shipped).
    fetchMock.mockResolvedValueOnce(
      releasesResponse(200, [
        { tag_name: "v0.1.5" },
        { tag_name: "v0.2.0" },
        { tag_name: "v0.1.9" },
      ]),
    );

    const result = await checkForUpdate("owner/repo", "0.1.0", true);

    expect(result.latestVersion).toBe("0.2.0");
  });

  it("prefers a later parseable release over an earlier unparseable one (Hermes review, PR #130)", async () => {
    fetchMock.mockResolvedValueOnce(
      releasesResponse(200, [{ tag_name: "nightly" }, { tag_name: "v0.1.5" }]),
    );

    const result = await checkForUpdate("owner/repo", "0.1.4", true);

    // "nightly" is newest-created (array order) but unparseable — it must
    // not permanently shadow the properly-tagged release that follows it.
    expect(result.latestVersion).toBe("0.1.5");
  });

  it("keeps the first unparseable entry when no later entry is parseable either", async () => {
    fetchMock.mockResolvedValueOnce(
      releasesResponse(200, [{ tag_name: "nightly-2" }, { tag_name: "nightly-1" }]),
    );

    const result = await checkForUpdate("owner/repo", "0.1.4", true);

    // Among unparseable-only candidates, array order (GitHub's
    // newest-created-first) still decides.
    expect(result.latestVersion).toBe("nightly-2");
  });

  it("passes applyAvailable through as given, independent of GitHub state", async () => {
    // mockImplementation (not mockResolvedValue) — a Response body can only
    // be read once, so each of the two checkForUpdate calls below needs its
    // own fresh Response instance, not the same one returned twice.
    fetchMock.mockImplementation(async () => releasesResponse(200, [{ tag_name: "v0.1.4" }]));

    const withApply = await checkForUpdate("owner/repo", "0.1.4", true);
    clearUpdateCheckCacheForTests();
    const withoutApply = await checkForUpdate("owner/repo", "0.1.4", false);

    expect(withApply.applyAvailable).toBe(true);
    expect(withoutApply.applyAvailable).toBe(false);
  });

  it("throws UpdateCheckError on a non-2xx response", async () => {
    fetchMock.mockResolvedValueOnce(new Response("not found", { status: 404 }));

    await expect(checkForUpdate("owner/repo", "0.1.4", true)).rejects.toThrow(UpdateCheckError);
  });

  it("throws UpdateCheckError when the network request itself fails", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(checkForUpdate("owner/repo", "0.1.4", true)).rejects.toThrow(UpdateCheckError);
  });

  it("caches a successful result and does not re-fetch within the TTL", async () => {
    fetchMock.mockResolvedValueOnce(releasesResponse(200, [{ tag_name: "v0.1.5" }]));

    await checkForUpdate("owner/repo", "0.1.4", true);
    await checkForUpdate("owner/repo", "0.1.4", true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("skips the cache and re-fetches when force=true, even within the TTL", async () => {
    fetchMock.mockResolvedValueOnce(releasesResponse(200, [{ tag_name: "v0.1.5" }]));
    fetchMock.mockResolvedValueOnce(releasesResponse(200, [{ tag_name: "v99.0.0" }]));

    const first = await checkForUpdate("owner/repo", "0.1.4", true);
    expect(first.latestVersion).toBe("0.1.5");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const second = await checkForUpdate("owner/repo", "0.1.4", true, true);
    expect(second.latestVersion).toBe("99.0.0");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("re-fetches once the cache entry's TTL has elapsed", async () => {
    vi.useFakeTimers();
    // Same fresh-Response-per-call reasoning as above.
    fetchMock.mockImplementation(async () => releasesResponse(200, [{ tag_name: "v0.1.5" }]));

    await checkForUpdate("owner/repo", "0.1.4", true);
    vi.advanceTimersByTime(CACHE_TTL_MS + 1);
    await checkForUpdate("owner/repo", "0.1.4", true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends the expected request URL and headers", async () => {
    fetchMock.mockResolvedValueOnce(releasesResponse(200, [{ tag_name: "v0.1.4" }]));

    await checkForUpdate("some-owner/some-repo", "0.1.4", true);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/some-owner/some-repo/releases?per_page=10",
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: "application/vnd.github+json",
          "User-Agent": "mullion-session-manager",
        }),
      }),
    );
  });

  it("sets checkedAt to the current time on a fresh fetch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    fetchMock.mockResolvedValueOnce(releasesResponse(200, [{ tag_name: "v0.1.4" }]));

    const result = await checkForUpdate("owner/repo", "0.1.4", true);

    expect(result.checkedAt).toBe(1_700_000_000_000);
  });

  it("preserves the original checkedAt across a cache hit rather than the hit's own time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    fetchMock.mockResolvedValueOnce(releasesResponse(200, [{ tag_name: "v0.1.5" }]));

    const first = await checkForUpdate("owner/repo", "0.1.4", true);

    vi.setSystemTime(1_700_000_100_000);
    const second = await checkForUpdate("owner/repo", "0.1.4", true);

    expect(second.checkedAt).toBe(first.checkedAt);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// Issue #647 / roadmap 7.8 — resolves a specific tag's release (the
// primary's own running version), not "latest". Distinct entry point from
// checkForUpdate above, sharing only the module's private
// findTarballAsset/findChecksumAsset helpers and UpdateCheckError.
describe("resolveReleaseByTag", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    clearUpdateCheckCacheForTests();
    // #759 — see checkForUpdate's own beforeEach/afterEach above for why.
    resetGitHubRateLimitForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetGitHubRateLimitForTests();
  });

  it("resolves the release's asset/checksum/release URLs for a matching tag", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        tag_name: "v0.1.5",
        html_url: "https://github.com/x/y/releases/tag/v0.1.5",
        assets: [
          { name: "mullion-0.1.5.tgz", browser_download_url: "https://github.com/x/y/a.tgz" },
          {
            name: "mullion-0.1.5.tgz.sha256",
            browser_download_url: "https://github.com/x/y/a.tgz.sha256",
          },
        ],
      }),
    );

    const result = await resolveReleaseByTag("some-owner/some-repo", "0.1.5");

    expect(result).toEqual({
      version: "0.1.5",
      releaseUrl: "https://github.com/x/y/releases/tag/v0.1.5",
      assetUrl: "https://github.com/x/y/a.tgz",
      checksumUrl: "https://github.com/x/y/a.tgz.sha256",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/some-owner/some-repo/releases/tags/v0.1.5",
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: "application/vnd.github+json",
          "User-Agent": "mullion-session-manager",
        }),
      }),
    );
  });

  it("returns a result with null asset/checksum URLs when the release has no such assets yet", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { tag_name: "v0.1.5", html_url: "https://x", assets: [] }),
    );

    const result = await resolveReleaseByTag("owner/repo", "0.1.5");

    expect(result).toMatchObject({ assetUrl: null, checksumUrl: null });
  });

  it("returns null — not an error — when no release matches the tag (404)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("not found", { status: 404 }));

    const result = await resolveReleaseByTag("owner/repo", "9.9.9");

    expect(result).toBeNull();
  });

  it("throws UpdateCheckError for a non-404 non-2xx response", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }));

    await expect(resolveReleaseByTag("owner/repo", "0.1.5")).rejects.toThrow(UpdateCheckError);
  });

  it("throws UpdateCheckError on a network failure", async () => {
    fetchMock.mockRejectedValueOnce(new Error("boom"));

    await expect(resolveReleaseByTag("owner/repo", "0.1.5")).rejects.toThrow(UpdateCheckError);
  });

  it("caches a found release and does not refetch within the TTL", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { tag_name: "v0.1.5", html_url: "https://x", assets: [] }),
    );

    await resolveReleaseByTag("owner/repo", "0.1.5");
    await resolveReleaseByTag("owner/repo", "0.1.5");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caches a 404 (null) result too, so a repeatedly-checked missing tag doesn't refetch", async () => {
    fetchMock.mockResolvedValueOnce(new Response("not found", { status: 404 }));

    const first = await resolveReleaseByTag("owner/repo", "9.9.9");
    const second = await resolveReleaseByTag("owner/repo", "9.9.9");

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keys the cache by repoSlug AND version, not just repoSlug", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { tag_name: "v0.1.5", html_url: "https://x", assets: [] }),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { tag_name: "v0.1.6", html_url: "https://x", assets: [] }),
    );

    const first = await resolveReleaseByTag("owner/repo", "0.1.5");
    const second = await resolveReleaseByTag("owner/repo", "0.1.6");

    expect(first?.version).toBe("0.1.5");
    expect(second?.version).toBe("0.1.6");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // Independent review — a network failure or non-404 GitHub error used to
  // re-fetch on EVERY call with nothing cached; a poller hitting this every
  // 4s (routes/hosts.ts's GET /api/hosts/:id/update) could hammer GitHub's
  // 60/hr unauthenticated budget within minutes during an outage.
  describe("failure caching", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("caches a network failure briefly and does not refetch within the cooldown", async () => {
      fetchMock.mockRejectedValueOnce(new Error("boom"));

      await expect(resolveReleaseByTag("owner/repo", "0.1.5")).rejects.toThrow(UpdateCheckError);
      await expect(resolveReleaseByTag("owner/repo", "0.1.5")).rejects.toThrow(UpdateCheckError);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("caches a non-404 GitHub error response briefly too", async () => {
      fetchMock.mockResolvedValueOnce(new Response("rate limited", { status: 429 }));

      await expect(resolveReleaseByTag("owner/repo", "0.1.5")).rejects.toThrow(UpdateCheckError);
      await expect(resolveReleaseByTag("owner/repo", "0.1.5")).rejects.toThrow(UpdateCheckError);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("refetches once the failure cooldown expires", async () => {
      vi.useFakeTimers();
      fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }));
      await expect(resolveReleaseByTag("owner/repo", "0.1.5")).rejects.toThrow(UpdateCheckError);

      vi.advanceTimersByTime(61_000);
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, { tag_name: "v0.1.5", html_url: "https://x", assets: [] }),
      );
      const result = await resolveReleaseByTag("owner/repo", "0.1.5");

      expect(result).toMatchObject({ version: "0.1.5" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("does not let a cached failure for one version block a different version", async () => {
      fetchMock.mockRejectedValueOnce(new Error("boom"));
      await expect(resolveReleaseByTag("owner/repo", "0.1.5")).rejects.toThrow(UpdateCheckError);

      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, { tag_name: "v0.1.6", html_url: "https://x", assets: [] }),
      );
      const result = await resolveReleaseByTag("owner/repo", "0.1.6");

      expect(result).toMatchObject({ version: "0.1.6" });
    });
  });
});
