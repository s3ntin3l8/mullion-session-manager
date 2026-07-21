import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  checkForUpdate,
  UpdateCheckError,
  clearUpdateCheckCacheForTests,
  CACHE_TTL_MS,
} from "../../src/services/update-checker.js";

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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
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
            { name: "tessera-0.1.5.tgz", browser_download_url: "https://x/tessera-0.1.5.tgz" },
          ],
        },
      ]),
    );

    const result = await checkForUpdate("owner/repo", "0.1.4", true);

    expect(result.assetUrl).toBe("https://x/tessera-0.1.5.tgz");
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
            { name: "tessera-0.1.5.tgz", browser_download_url: "https://x/tessera-0.1.5.tgz" },
            {
              name: "tessera-0.1.5.tgz.sha256",
              browser_download_url: "https://x/tessera-0.1.5.tgz.sha256",
            },
          ],
        },
      ]),
    );

    const result = await checkForUpdate("owner/repo", "0.1.4", true);

    expect(result.checksumUrl).toBe("https://x/tessera-0.1.5.tgz.sha256");
  });

  it("returns checksumUrl: null when no .sha256 asset is present", async () => {
    fetchMock.mockResolvedValueOnce(
      releasesResponse(200, [
        {
          tag_name: "v0.1.5",
          assets: [
            { name: "tessera-0.1.5.tgz", browser_download_url: "https://x/tessera-0.1.5.tgz" },
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

  it("falls back to the first parseable, non-draft, non-prerelease entry when tags don't compare", async () => {
    fetchMock.mockResolvedValueOnce(
      releasesResponse(200, [{ tag_name: "not-a-version" }, { tag_name: "v0.1.5" }]),
    );

    const result = await checkForUpdate("owner/repo", "0.1.4", true);

    // The first entry (unparseable) is still the array's "best" by position
    // since it's non-draft/non-prerelease and never loses a comparison to
    // the parseable one that follows it.
    expect(result.latestVersion).toBe("not-a-version");
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
          "User-Agent": "tessera-session-manager",
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
