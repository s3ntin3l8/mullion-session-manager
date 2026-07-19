import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  checkForUpdate,
  UpdateCheckError,
  clearUpdateCheckCacheForTests,
} from "../../src/services/update-checker.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
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
      jsonResponse(200, { tag_name: "v0.1.4", html_url: "https://x", assets: [] }),
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
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { tag_name: `v${latest}` }));
      const result = await checkForUpdate("owner/repo", current, true);
      expect(result.updateAvailable).toBe(true);
      expect(result.latestVersion).toBe(latest);
    }
  });

  it("does not report an update for an older or equal tag", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { tag_name: "v0.1.0" }));

    const result = await checkForUpdate("owner/repo", "0.1.4", true);

    expect(result.updateAvailable).toBe(false);
  });

  it("strips a leading 'v' from the release tag", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { tag_name: "v1.2.3" }));

    const result = await checkForUpdate("owner/repo", "0.1.0", true);

    expect(result.latestVersion).toBe("1.2.3");
  });

  it("treats an unparseable tag as no update available, not a crash", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { tag_name: "not-a-version" }));

    const result = await checkForUpdate("owner/repo", "0.1.4", true);

    expect(result.updateAvailable).toBe(false);
    // Malformed tags are still surfaced verbatim (minus a leading "v") for
    // display — only the *comparison* degrades safely, not the value shown.
    expect(result.latestVersion).toBe("not-a-version");
  });

  it("returns latestVersion: null when the release has no tag_name at all", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));

    const result = await checkForUpdate("owner/repo", "0.1.4", true);

    expect(result.latestVersion).toBeNull();
    expect(result.updateAvailable).toBe(false);
  });

  it("picks the .tgz asset among multiple release assets", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        tag_name: "v0.1.5",
        assets: [
          { name: "checksums.txt", browser_download_url: "https://x/checksums.txt" },
          { name: "tessera-0.1.5.tgz", browser_download_url: "https://x/tessera-0.1.5.tgz" },
        ],
      }),
    );

    const result = await checkForUpdate("owner/repo", "0.1.4", true);

    expect(result.assetUrl).toBe("https://x/tessera-0.1.5.tgz");
  });

  it("returns assetUrl: null when no .tgz asset is present", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { tag_name: "v0.1.5", assets: [{ name: "notes.txt" }] }),
    );

    const result = await checkForUpdate("owner/repo", "0.1.4", true);

    expect(result.assetUrl).toBeNull();
  });

  it("picks the .sha256 checksum asset among multiple release assets", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        tag_name: "v0.1.5",
        assets: [
          { name: "tessera-0.1.5.tgz", browser_download_url: "https://x/tessera-0.1.5.tgz" },
          {
            name: "tessera-0.1.5.tgz.sha256",
            browser_download_url: "https://x/tessera-0.1.5.tgz.sha256",
          },
        ],
      }),
    );

    const result = await checkForUpdate("owner/repo", "0.1.4", true);

    expect(result.checksumUrl).toBe("https://x/tessera-0.1.5.tgz.sha256");
  });

  it("returns checksumUrl: null when no .sha256 asset is present", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        tag_name: "v0.1.5",
        assets: [
          { name: "tessera-0.1.5.tgz", browser_download_url: "https://x/tessera-0.1.5.tgz" },
        ],
      }),
    );

    const result = await checkForUpdate("owner/repo", "0.1.4", true);

    expect(result.checksumUrl).toBeNull();
  });

  it("passes applyAvailable through as given, independent of GitHub state", async () => {
    // mockImplementation (not mockResolvedValue) — a Response body can only
    // be read once, so each of the two checkForUpdate calls below needs its
    // own fresh Response instance, not the same one returned twice.
    fetchMock.mockImplementation(async () => jsonResponse(200, { tag_name: "v0.1.4" }));

    const withApply = await checkForUpdate("owner/repo", "0.1.4", true);
    clearUpdateCheckCacheForTests();
    const withoutApply = await checkForUpdate("owner/repo", "0.1.4", false);

    expect(withApply.applyAvailable).toBe(true);
    expect(withoutApply.applyAvailable).toBe(false);
  });

  it("throws UpdateCheckError on a non-2xx response (e.g. a repo with no releases yet)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("not found", { status: 404 }));

    await expect(checkForUpdate("owner/repo", "0.1.4", true)).rejects.toThrow(UpdateCheckError);
  });

  it("throws UpdateCheckError when the network request itself fails", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(checkForUpdate("owner/repo", "0.1.4", true)).rejects.toThrow(UpdateCheckError);
  });

  it("caches a successful result and does not re-fetch within the TTL", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { tag_name: "v0.1.5" }));

    await checkForUpdate("owner/repo", "0.1.4", true);
    await checkForUpdate("owner/repo", "0.1.4", true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-fetches once the cache entry's TTL has elapsed", async () => {
    vi.useFakeTimers();
    // Same fresh-Response-per-call reasoning as above.
    fetchMock.mockImplementation(async () => jsonResponse(200, { tag_name: "v0.1.5" }));

    await checkForUpdate("owner/repo", "0.1.4", true);
    vi.advanceTimersByTime(6 * 60 * 60 * 1000 + 1);
    await checkForUpdate("owner/repo", "0.1.4", true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends the expected request URL and headers", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { tag_name: "v0.1.4" }));

    await checkForUpdate("some-owner/some-repo", "0.1.4", true);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/some-owner/some-repo/releases/latest",
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: "application/vnd.github+json",
          "User-Agent": "tessera-session-manager",
        }),
      }),
    );
  });
});
