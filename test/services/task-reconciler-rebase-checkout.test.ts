import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as ChildProcess from "node:child_process";
import { createNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";

// #2732 — the auto-rebase retry clears the previous attempt's worktree before
// resuming. That step must go through the checkout helper, so the browser
// state keyed to the (reused) path is released with it. Driven through
// reconcileTasks; only the host backend and GitHub are faked, the browser
// manager is a real one on a temp dir. Lives beside task-reconciler.test.ts,
// which is over its size ceiling.
const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return mockChildProcessSpawn(actual);
});

const { mockResolveRepoRef, mockResolveGitHubToken, mockGetPullRequestByNumber } = vi.hoisted(
  () => ({
    mockResolveRepoRef: vi.fn(),
    mockResolveGitHubToken: vi.fn(),
    mockGetPullRequestByNumber: vi.fn(),
  }),
);
vi.mock("../../src/services/host-git.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveRepoRef: mockResolveRepoRef,
}));
vi.mock("../../src/services/github-integration.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveGitHubToken: mockResolveGitHubToken,
}));
vi.mock("../../src/services/github-write.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPullRequestByNumber: mockGetPullRequestByNumber,
}));

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { tasks } = await import("../../src/db/schema.js");
const { reconcileTasks } = await import("../../src/services/task-reconciler.js");
const sessionBackendModule = await import("../../src/services/session-backend.js");
const { BrowserManager } = await import("../../src/services/browser-manager.js");
const { deriveWorktreePath } = await import("../../src/services/git-worktree.js");

const tmpDb = path.join(os.tmpdir(), `task-reconciler-rebase-checkout-${process.pid}.db`);

describe("auto-rebase's stale worktree clear releases the checkout's browser state (#2732)", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let dataDir: string;
  let manager: InstanceType<typeof BrowserManager>;

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.MULLION_TASK_MASTER_ENABLED = "true";
    app = await buildApp();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-rebase-"));
    manager = new BrowserManager({ enabled: true, maxContexts: 2, dataDir });
  });
  afterAll(async () => {
    await app.close();
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_TASK_MASTER_ENABLED;
  });
  afterEach(() => vi.restoreAllMocks());

  it("deletes the stale checkout's stored state before resuming the worktree", async () => {
    const cwd = "/tmp";
    const branchName = "mullion/task-x";
    const stalePath = deriveWorktreePath(cwd, branchName);

    mockResolveRepoRef.mockResolvedValue({ owner: "o", repo: "r" });
    mockResolveGitHubToken.mockResolvedValue("tok");
    mockGetPullRequestByNumber.mockResolvedValue({
      number: 9,
      htmlUrl: "https://github.com/o/r/pull/9",
      nodeId: "PR_node9",
      draft: false,
      headSha: "sha-head",
      headRef: branchName,
      baseRef: "main",
      title: "feat: do the thing",
      state: "open",
      merged: false,
      mergeable: true,
      mergeableState: "dirty",
    });

    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "p-rebase-checkout", cwd },
    });
    const projectId = project.json().id as number;
    await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}`,
      payload: { autoApprove: true },
    });
    const hostId = project.json().hostId ?? "local";
    app.db
      .insert(tasks)
      .values({
        projectId,
        title: "conflicted",
        status: "done",
        claimedAt: new Date(),
        completedAt: new Date(),
        prNumber: 9,
        prUrl: "https://github.com/o/r/pull/9",
        mergeRequestedAt: new Date(),
        branchName,
        agentCommand: "claude",
      })
      .run();

    // The previous attempt's browser state, keyed to the path the retry clears.
    const file = (manager as unknown as { storageStatePath(t: unknown): string }).storageStatePath({
      projectId,
      hostId,
      checkoutRoot: stalePath,
      legacy: false,
    });
    fs.writeFileSync(file, "{}");
    const forget = vi
      .spyOn(app.browser, "forgetCheckout")
      .mockImplementation((p, h, c) => manager.forgetCheckout(p, h, c));

    // The file must already be gone when the worktree is resumed.
    const existedAtResume: boolean[] = [];
    const resumeTaskWorktree = vi.fn().mockImplementation(async () => {
      existedAtResume.push(fs.existsSync(file));
      return null;
    });
    const backend = {
      removeWorktree: vi.fn().mockResolvedValue(true),
      resumeTaskWorktree,
      terminate: vi.fn().mockResolvedValue(undefined),
      resolveSessionsDir: vi.fn().mockResolvedValue(dataDir),
    };
    vi.spyOn(sessionBackendModule, "resolveBackend").mockReturnValue(
      backend as unknown as ReturnType<typeof sessionBackendModule.resolveBackend>,
    );

    await reconcileTasks(app);

    expect(resumeTaskWorktree).toHaveBeenCalledWith(cwd, branchName);
    expect(forget).toHaveBeenCalledWith(projectId, hostId, stalePath);
    expect(fs.existsSync(file)).toBe(false);
    expect(existedAtResume).toEqual([false]);
    expect(forget.mock.invocationCallOrder[0]).toBeLessThan(
      resumeTaskWorktree.mock.invocationCallOrder[0],
    );
  });
});
