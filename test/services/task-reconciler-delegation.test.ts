import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as TaskPrompt from "../../src/services/task-prompt.js";
import { repoRefMocks } from "../helpers/pr-review-defaults.js";

const mocks = vi.hoisted(() => ({
  repo: vi.fn().mockResolvedValue({ owner: "o", repo: "r" }),
  runs: vi.fn(),
  checks: vi.fn(),
  threads: vi.fn(),
}));
vi.mock("../../src/services/host-git.js", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...repoRefMocks(mocks.repo),
}));
vi.mock("../../src/services/github-integration.js", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  resolveGitHubToken: vi.fn().mockResolvedValue("tok"),
  resolveReviewerToken: vi.fn().mockResolvedValue(null),
  resolveMullionReviewLogins: vi.fn().mockResolvedValue(new Set(["mullion[bot]"])),
}));
vi.mock("../../src/services/github.js", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  fetchRunsForHead: mocks.runs,
  fetchRunsForHeadChecked: async () => ({ ok: true, runs: await mocks.runs() }),
  fetchCheckRunsForHead: mocks.checks,
  detectReleasePleaseConfig: vi.fn().mockResolvedValue(false),
}));
vi.mock("../../src/services/github-write.js", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getPullRequestByNumber: vi.fn().mockResolvedValue({
    number: 9,
    state: "open",
    merged: false,
    draft: false,
    headSha: "sha-head",
    headRef: "mullion/task-x",
    baseRef: "main",
    title: "feat: task",
    mergeable: true,
    mergeableState: "clean",
  }),
  fetchPullRequestReviewThreads: mocks.threads,
  createPullRequestReview: vi
    .fn()
    .mockResolvedValue({ id: 1, htmlUrl: "https://github.com/o/r/pull/9#review-1" }),
  resolveReviewThread: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/task-github-sync.js", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  syncTaskTransition: vi.fn().mockResolvedValue(undefined),
}));
// Keep the reconciler and prompt builders real; replacing the process boundary
// prevents a follow-up round from starting a real agent on the developer's host.
// Background issue polling is unrelated to the explicit reconciliation tick.
vi.mock("../../src/services/task-watcher.js", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  startTaskWatcher: vi.fn(() => () => {}),
}));
vi.mock("../../src/services/task-reseed.js", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  reseedTaskIfSessionExited: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("../../src/services/task-prompt.js", async (original) => {
  const actual = await original<typeof TaskPrompt>();
  return {
    ...actual,
    buildCiFailurePrompt: vi.fn(actual.buildCiFailurePrompt),
    buildSuggestionsPrompt: vi.fn(actual.buildSuggestionsPrompt),
    buildPrReviewCommentsPrompt: vi.fn(actual.buildPrReviewCommentsPrompt),
    buildReviewFeedbackPrompt: vi.fn(actual.buildReviewFeedbackPrompt),
  };
});

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { tasks, sessions } = await import("../../src/db/schema.js");
const { reconcileTasks } = await import("../../src/services/task-reconciler.js");
const { taskReviewFindingsPath } = await import("../../src/services/task-prompt.js");
const prompt = await import("../../src/services/task-prompt.js");
const { eq } = await import("drizzle-orm");
const tmpDb = path.join(os.tmpdir(), `task-reconciler-delegation-${process.pid}.db`);

describe("follow-up worker delegation", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.MULLION_TASK_MASTER_ENABLED = "true";
  });
  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_TASK_MASTER_ENABLED;
  });
  afterEach(() => vi.restoreAllMocks());

  for (const site of ["ci", "pr-comment", "approved-comment", "suggestions", "review"] as const) {
    for (const delegateModel of ["sonnet", null]) {
      it(`${site}: ${delegateModel ? "includes configured delegation" : "omits unconfigured delegation"}`, async () => {
        const app = await buildApp();
        try {
          app.db.delete(tasks).run();
          await app.inject({
            method: "PATCH",
            url: "/api/settings",
            payload: {
              claudeCode: { defaultModel: "opus", delegateModel },
            },
          });
          const created = await app.inject({
            method: "POST",
            url: "/api/projects",
            payload: {
              allowDuplicate: true,
              createDir: true,
              name: `delegation-${site}-${delegateModel}`,
              cwd: "/tmp",
            },
          });
          const projectId = created.json().id as number;
          const ingest = site === "suggestions" || site === "review";
          await app.inject({
            method: "PATCH",
            url: `/api/projects/${projectId}`,
            payload: {
              autoApprove: !ingest,
            },
          });
          const [worker] = app.db
            .insert(sessions)
            .values({ projectId, command: "claude", cwd: "/tmp", status: "active" })
            .returning()
            .all();
          const [reviewer] = app.db
            .insert(sessions)
            .values({ projectId, command: "claude", cwd: "/tmp", status: "active" })
            .returning()
            .all();
          const [task] = app.db
            .insert(tasks)
            .values({
              projectId,
              title: "feat: follow-up delegation",
              body: "Implement the task",
              status: "reviewing",
              claimedAt: new Date(),
              reviewingAt: new Date(),
              worktreePath: "/tmp",
              branchName: "mullion/task-x",
              agentCommand: "claude",
              sessionId: worker.id,
              reviewAgent: "claude",
              reviewSessionId: reviewer.id,
              reviewFindingsIngestedSessionId: ingest ? null : reviewer.id,
              lastReviewVerdict: ingest ? null : "approved",
              prNumber: ingest ? null : 9,
            })
            .returning()
            .all();
          vi.spyOn(app.pty, "get").mockImplementation(
            (id) =>
              ({
                toInfo: () => ({
                  activity: "idle",
                  errorState: "idle",
                  permissionState: "idle",
                  attention: false,
                  lastTurnEndedAt: Number(id) === reviewer.id ? Date.now() : null,
                  workFinishedAt: Number(id) === reviewer.id ? Date.now() : null,
                  outstandingBackgroundTasks: [],
                }),
              }) as never,
          );
          mocks.runs.mockResolvedValue([
            {
              name: "CI",
              status: "completed",
              conclusion: site === "ci" ? "failure" : "success",
              headSha: "sha-head",
              htmlUrl: "https://x/1",
            },
          ]);
          mocks.checks.mockResolvedValue(
            site === "ci" ? [{ name: "test-node / lint-and-test", conclusion: "failure" }] : [],
          );
          mocks.threads.mockResolvedValue({
            viewerLogin: "mullion[bot]",
            truncated: false,
            threads:
              site === "pr-comment" || site === "approved-comment"
                ? [
                    {
                      isResolved: false,
                      comments: [
                        {
                          author: "reviewer",
                          body: "Rename this value",
                          path: "a.ts",
                          line: 3,
                          createdAt: "2026-08-20T10:00:00Z",
                          reviewState: site === "approved-comment" ? "APPROVED" : "COMMENTED",
                        },
                      ],
                    },
                  ]
                : [],
          });
          if (ingest) {
            const findingsPath = taskReviewFindingsPath(
              path.dirname(app.pty.hookSocketPath),
              task.id,
              0,
            );
            fs.mkdirSync(path.dirname(findingsPath), { recursive: true });
            fs.writeFileSync(
              findingsPath,
              JSON.stringify({
                verdict: site === "suggestions" ? "approved" : "changes-requested",
                summary: "Review results",
                findings: [
                  {
                    path: "a.ts",
                    line: 3,
                    severity: site === "suggestions" ? "suggestion" : "warning",
                    body: "Rename this value",
                  },
                ],
              }),
            );
          }
          const builder =
            site === "ci"
              ? prompt.buildCiFailurePrompt
              : site === "pr-comment"
                ? prompt.buildPrReviewCommentsPrompt
                : site === "review"
                  ? prompt.buildReviewFeedbackPrompt
                  : prompt.buildSuggestionsPrompt;
          vi.mocked(builder).mockClear();
          await reconcileTasks(app);
          expect(builder).toHaveBeenCalledTimes(1);
          expect(builder).toHaveBeenCalledWith(
            expect.objectContaining({
              delegation: { workerModel: "opus", delegateModel },
            }),
          );
          const rendered = vi.mocked(builder).mock.results[0].value as string;
          if (delegateModel) {
            expect(rendered).toContain('model: "sonnet"');
            expect(rendered).toContain("whatever you delegate has to land on this branch");
          } else {
            expect(rendered).not.toContain("A subagent adds its own cost");
          }
          expect(app.db.select().from(tasks).where(eq(tasks.id, task.id)).get()?.status).toBe(
            "in_progress",
          );
        } finally {
          await app.close();
        }
      });
    }
  }
});
