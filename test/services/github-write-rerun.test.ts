// rerunFailedJobs and rerunJob (github-write.ts). The module's main test file
// is at its size ceiling, so its tests live here.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rerunFailedJobs, rerunJob } from "../../src/services/github-write.js";
import { GitHubApiError } from "../../src/services/github.js";
import { resetGitHubRateLimitForTests } from "../../src/services/github-fetch.js";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("rerunFailedJobs", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    resetGitHubRateLimitForTests();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs rerun-failed-jobs for the run and reports it accepted", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, {}));
    await expect(rerunFailedJobs("tok", "owner", "repo", 42)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/actions/runs/42/rerun-failed-jobs",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("reports false when GitHub refuses the rerun (a run that cannot be retried)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(403, { message: "This workflow run cannot be retried" }),
    );
    await expect(rerunFailedJobs("tok", "owner", "repo", 42)).resolves.toBe(false);
  });

  it("propagates an error that is not a refusal, so the caller can tell 'could not ask'", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { message: "boom" }));
    await expect(rerunFailedJobs("tok", "owner", "repo", 42)).rejects.toBeInstanceOf(
      GitHubApiError,
    );
  });
});

// #2904 — re-running ONE job, the lever for a coverage upload that Codecov
// never turned into a status.
describe("rerunJob", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    resetGitHubRateLimitForTests();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the job's rerun endpoint and reports it accepted", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, {}));
    await expect(rerunJob("tok", "owner", "repo", 7001)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/actions/jobs/7001/rerun",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("reports false when GitHub refuses with 422 (the job cannot be rerun)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(422, { message: "Cannot rerun job" }));
    await expect(rerunJob("tok", "owner", "repo", 7001)).resolves.toBe(false);
  });

  it("reports false when GitHub refuses with 403 (no Actions write)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { message: "Resource not accessible" }));
    await expect(rerunJob("tok", "owner", "repo", 7001)).resolves.toBe(false);
  });

  it("propagates an error that is not a refusal, so the caller can tell 'could not ask'", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { message: "boom" }));
    await expect(rerunJob("tok", "owner", "repo", 7001)).rejects.toBeInstanceOf(GitHubApiError);
  });
});
