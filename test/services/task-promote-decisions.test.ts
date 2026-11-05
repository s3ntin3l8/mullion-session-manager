import { describe, it, expect, vi, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { gitEnv } from "../../src/services/git-env.js";
import type * as GithubWrite from "../../src/services/github-write.js";
import type * as HostGit from "../../src/services/host-git.js";
import type * as WorkflowGate from "../../src/services/task-workflow-gate.js";
import type { tasks, projects } from "../../src/db/schema.js";

// The PR description's "Worker decisions" section (#2599): real git repos for
// the commit messages, every GitHub call mocked.
const mockCreatePullRequest = vi.fn();
const mockGetPullRequestBody = vi.fn();
const mockUpdatePullRequestBody = vi.fn();

vi.mock("../../src/services/github-integration.js", () => ({
  resolveGitHubToken: () => "ghp_token",
  resolveWorkflowWriteToken: vi.fn(),
}));
vi.mock("../../src/services/task-workflow-gate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof WorkflowGate>();
  return {
    ...actual,
    evaluateWorkflowGate: vi.fn().mockResolvedValue({ kind: "clear" }),
    recordWorkflowHold: vi.fn(),
    clearWorkflowHold: vi.fn(),
  };
});
vi.mock("../../src/services/task-events.js", () => ({ broadcastTaskEvent: vi.fn() }));
vi.mock("../../src/services/push-delivery.js", () => ({ notifyTaskNeedsAttention: vi.fn() }));
vi.mock("../../src/services/github-write.js", async (importOriginal) => {
  const actual = await importOriginal<typeof GithubWrite>();
  return {
    ...actual,
    createPullRequest: mockCreatePullRequest,
    updatePullRequestTitle: vi.fn(),
  };
});
vi.mock("../../src/services/github-pr-body.js", () => ({
  getPullRequestBody: mockGetPullRequestBody,
  updatePullRequestBody: mockUpdatePullRequestBody,
}));
vi.mock("../../src/services/task-github-sync.js", () => ({
  recordGithubSyncError: vi.fn(),
  clearGithubSyncError: vi.fn(),
}));
vi.mock("../../src/services/host-git.js", async (importOriginal) => {
  const actual = await importOriginal<typeof HostGit>();
  return { ...actual, resolveRepoRef: vi.fn().mockResolvedValue({ owner: "o", repo: "r" }) };
});

const { openDraftPRForTask } = await import("../../src/services/task-promote.js");

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() }).toString();
}

function createBareRemote(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-decisions-remote-"));
  git(dir, ["init", "--bare", "-b", "main"]);
  return dir;
}

function createGitRepoWithRemote(remotePath: string): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "task-decisions-work-"));
  git(cwd, ["init", "-b", "main"]);
  fs.writeFileSync(path.join(cwd, "a.txt"), "a");
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-m", "initial", "--no-verify"]);
  git(cwd, ["remote", "add", "origin", remotePath]);
  git(cwd, ["push", "origin", "main"]);
  return cwd;
}

function baseTask(overrides: Partial<typeof tasks.$inferSelect> = {}) {
  return {
    id: 1,
    projectId: 1,
    issueNumber: null,
    title: "Some task",
    body: "task body",
    status: "reviewing",
    prUrl: null,
    prNumber: null,
    prTitle: null,
    worktreePath: null,
    branchName: null,
    ...overrides,
  } as typeof tasks.$inferSelect;
}

function baseProject(overrides: Partial<typeof projects.$inferSelect> = {}) {
  return {
    id: 1,
    hostId: "local",
    cwd: "/tmp/does-not-matter",
    ...overrides,
  } as typeof projects.$inferSelect;
}

describe("task PR description — worker decisions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreatePullRequest.mockResolvedValue({
      number: 9,
      htmlUrl: "https://github.com/o/r/pull/9",
    });
    mockGetPullRequestBody.mockResolvedValue("");
    mockUpdatePullRequestBody.mockResolvedValue(undefined);
  });

  it("opens the draft PR with the worker's declared decisions under 'Worker decisions'", async () => {
    const remote = createBareRemote();
    const cwd = createGitRepoWithRemote(remote);
    git(cwd, ["checkout", "-b", "mullion/task-1"]);
    fs.writeFileSync(path.join(cwd, "b.txt"), "b");
    git(cwd, ["add", "-A"]);
    git(cwd, [
      "commit",
      "-m",
      "feat: b",
      "-m",
      "Decision: used a Map, the issue's array would not do\nSkipped: the docs page\nunrelated line",
      "--no-verify",
    ]);

    const task = baseTask({ worktreePath: cwd, branchName: "mullion/task-1" });
    await openDraftPRForTask({ config: {} } as never, task, baseProject({ cwd }));

    const body = mockCreatePullRequest.mock.calls[0][3].body as string;
    expect(body).toContain("### Worker decisions");
    expect(body).toContain("- Decision: used a Map, the issue's array would not do");
    expect(body).toContain("- Skipped: the docs page");
    expect(body).not.toContain("unrelated line");
    expect(body.indexOf("Worker decisions")).toBeLessThan(body.indexOf("Opened by Mullion"));

    fs.rmSync(remote, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("adds no 'Worker decisions' section when the branch declares none", async () => {
    const remote = createBareRemote();
    const cwd = createGitRepoWithRemote(remote);
    git(cwd, ["checkout", "-b", "mullion/task-1"]);
    fs.writeFileSync(path.join(cwd, "b.txt"), "b");
    git(cwd, ["add", "-A"]);
    git(cwd, ["commit", "-m", "feat: b", "--no-verify"]);

    await openDraftPRForTask(
      { config: {} } as never,
      baseTask({ worktreePath: cwd, branchName: "mullion/task-1" }),
      baseProject({ cwd }),
    );

    expect(mockCreatePullRequest.mock.calls[0][3].body).not.toContain("Worker decisions");

    fs.rmSync(remote, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("refreshes the decisions section of the live description after a new push", async () => {
    const remote = createBareRemote();
    const cwd = createGitRepoWithRemote(remote);
    git(cwd, ["checkout", "-b", "mullion/task-1"]);
    fs.writeFileSync(path.join(cwd, "b.txt"), "b");
    git(cwd, ["add", "-A"]);
    git(cwd, ["commit", "-m", "fix: b", "-m", "Not run locally: the e2e suite", "--no-verify"]);
    mockGetPullRequestBody.mockResolvedValue("A human wrote this.\n\n---\nOpened by Mullion.");

    await openDraftPRForTask(
      { config: {} } as never,
      baseTask({
        worktreePath: cwd,
        branchName: "mullion/task-1",
        prNumber: 9,
        prUrl: "https://github.com/test-owner/test-repo/pull/9",
      }),
      baseProject({ cwd }),
    );

    expect(mockUpdatePullRequestBody).toHaveBeenCalledTimes(1);
    const next = mockUpdatePullRequestBody.mock.calls[0][4] as string;
    expect(next).toContain("A human wrote this.");
    expect(next).toContain("- Not run locally: the e2e suite");

    fs.rmSync(remote, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});
