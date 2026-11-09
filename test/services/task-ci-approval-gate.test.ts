// ciAllowsAutoApproval (task-ci-approval-gate.ts): auto-approve's CI gate.
//
// Three approved, green tasks sat unapproved for hours because the gate read the
// head's WORKFLOW RUNS, and GitHub had lost a CodeQL / dependency-review run (it
// ended `failure` with its jobs never created, and refuses to retry it). No check
// run was red, so the red-CI return correctly did nothing, and the approval
// returned silently. The gate now cross-checks the CHECK RUNS.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockResolveGitHubToken, mockFetchCheckRunsForHead } = vi.hoisted(() => ({
  mockResolveGitHubToken: vi.fn(),
  mockFetchCheckRunsForHead: vi.fn(),
}));

vi.mock("../../src/services/github-integration.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveGitHubToken: mockResolveGitHubToken,
}));
vi.mock("../../src/services/github.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchCheckRunsForHead: mockFetchCheckRunsForHead,
}));

const { ciAllowsAutoApproval, resetCiApprovalGateLogsForTests } =
  await import("../../src/services/task-ci-approval-gate.js");
const { resetPrCheckRunsWarningsForTests } = await import("../../src/services/pr-check-runs.js");

const task = { id: 7, projectId: 1, prNumber: 9 } as never;
const repoRef = { owner: "o", repo: "r" };

function appWithLog() {
  const log = { info: vi.fn(), warn: vi.fn() };
  return { app: { log } as never, log };
}

function current(
  status: "success" | "failure" | "in_progress" | null,
  runs: { name: string; conclusion: string | null }[] = [],
) {
  return { status, headSha: "sha-head", repoRef, runs };
}

const deadRun = [{ name: "CodeQL", conclusion: "failure" }];

describe("ciAllowsAutoApproval", () => {
  beforeEach(() => {
    mockResolveGitHubToken.mockReset().mockResolvedValue("tok");
    mockFetchCheckRunsForHead.mockReset().mockResolvedValue([]);
    resetCiApprovalGateLogsForTests();
    resetPrCheckRunsWarningsForTests();
  });

  it("allows approval when every workflow run is green, without reading check runs", async () => {
    const { app } = appWithLog();
    await expect(ciAllowsAutoApproval(app, task, current("success"))).resolves.toBe(true);
    expect(mockFetchCheckRunsForHead).not.toHaveBeenCalled();
  });

  it("ignores a failed workflow run that no check run reflects (a run GitHub lost), and says so", async () => {
    const { app, log } = appWithLog();
    mockFetchCheckRunsForHead.mockResolvedValue([
      { name: "test-node / lint-and-test", conclusion: "success" },
      { name: "analyze / setup", conclusion: "success" },
    ]);

    await expect(ciAllowsAutoApproval(app, task, current("failure", deadRun))).resolves.toBe(true);

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 7, failedRuns: ["CodeQL"] }),
      expect.stringContaining("failed without any failing check run"),
    );
  });

  it("holds when a check run is actually red", async () => {
    const { app } = appWithLog();
    mockFetchCheckRunsForHead.mockResolvedValue([
      { name: "test-node / lint-and-test", conclusion: "failure" },
    ]);
    await expect(ciAllowsAutoApproval(app, task, current("failure", deadRun))).resolves.toBe(false);
  });

  it("holds while a check run is still running", async () => {
    const { app } = appWithLog();
    mockFetchCheckRunsForHead.mockResolvedValue([
      { name: "a", conclusion: "success" },
      { name: "b", conclusion: null },
    ]);
    await expect(ciAllowsAutoApproval(app, task, current("failure", deadRun))).resolves.toBe(false);
  });

  it("holds when the head has no check runs at all (nothing contradicts the failure)", async () => {
    const { app } = appWithLog();
    await expect(ciAllowsAutoApproval(app, task, current("failure", deadRun))).resolves.toBe(false);
  });

  it("holds when the check-run lookup cannot be answered", async () => {
    const { app } = appWithLog();
    mockFetchCheckRunsForHead.mockRejectedValue(new Error("HTTP 502"));
    await expect(ciAllowsAutoApproval(app, task, current("failure", deadRun))).resolves.toBe(false);
  });

  it("holds when there is no token to read check runs with", async () => {
    const { app } = appWithLog();
    mockResolveGitHubToken.mockResolvedValue(null);
    await expect(ciAllowsAutoApproval(app, task, current("failure", deadRun))).resolves.toBe(false);
    expect(mockFetchCheckRunsForHead).not.toHaveBeenCalled();
  });

  it("holds without consulting check runs while the workflow runs are still going or absent", async () => {
    const { app } = appWithLog();
    await expect(ciAllowsAutoApproval(app, task, current("in_progress"))).resolves.toBe(false);
    await expect(ciAllowsAutoApproval(app, task, current(null))).resolves.toBe(false);
    expect(mockFetchCheckRunsForHead).not.toHaveBeenCalled();
  });

  it("logs why it is waiting, at most once per task per hour", async () => {
    const { app, log } = appWithLog();

    await ciAllowsAutoApproval(app, task, current("in_progress"));
    await ciAllowsAutoApproval(app, task, current("in_progress"));

    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 7, ciStatus: "in_progress" }),
      expect.stringContaining("waiting on CI"),
    );
  });
});
