// Issues filed by this install's own GitHub App bot are ingested as
// "proposed" (backlog, never auto-claimable) until a human approves them.
// Real app + DB, like task-watcher-ingest.test.ts.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as GithubWriteModule from "../../src/services/github-write.js";
import type * as HostGitModule from "../../src/services/host-git.js";
import type * as GithubIntegrationModule from "../../src/services/github-integration.js";

const mockCloseIssue = vi.fn(async () => undefined);
vi.mock("../../src/services/github-write.js", async (importOriginal) => ({
  ...(await importOriginal<typeof GithubWriteModule>()),
  closeIssue: mockCloseIssue,
}));
vi.mock("../../src/services/host-git.js", async (importOriginal) => ({
  ...(await importOriginal<typeof HostGitModule>()),
  resolveRepoRef: vi.fn(async () => ({ owner: "o", repo: "r" })),
}));
const mockToken = vi.fn(async (): Promise<string | null> => "tok");
vi.mock("../../src/services/github-integration.js", async (importOriginal) => ({
  ...(await importOriginal<typeof GithubIntegrationModule>()),
  resolveGitHubToken: mockToken,
}));

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { tasks } = await import("../../src/db/schema.js");
const { upsertIssueTask } = await import("../../src/services/task-watcher.js");
const { enqueueTask } = await import("../../src/services/task-claim.js");
const { enqueueRetry } = await import("../../src/services/task-retry.js");
const { dispatchQueuedTasks } = await import("../../src/services/task-dispatch.js");
const { proposalContentSha } = await import("../../src/services/task-proposal.js");
const { eq, and } = await import("drizzle-orm");

const tmpDb = path.join(os.tmpdir(), `task-proposal-test-${process.pid}.db`);
const BOT = "mullion-session-manager[bot]";

describe("proposed tasks (own-bot issues)", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let projectId: number;
  let n = 1000;

  const issue = (over: Record<string, unknown> = {}) => ({
    number: ++n,
    title: "fix(x): a deferred thing",
    body: "do it",
    htmlUrl: "https://github.com/o/r/issues/1",
    authorLogin: BOT,
    authorAssociation: "CONTRIBUTOR",
    ...over,
  });
  const row = (num: number) =>
    app.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), eq(tasks.issueNumber, num)))
      .get();

  const post = (id: number, action: string) => {
    const r = row_(id);
    return app.inject({
      method: "POST",
      url: `/api/tasks/${id}/${action}`,
      payload: action === "approve-proposal" ? { title: r?.title, body: r?.body ?? null } : {},
    });
  };
  const row_ = (id: number) => app.db.select().from(tasks).where(eq(tasks.id, id)).get();

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    app = await buildApp();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "task-proposal-test-project-"));
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "proposal-test", cwd },
    });
    projectId = res.json().id;
  });

  afterAll(async () => {
    await app.close();
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  beforeEach(() => {
    mockCloseIssue.mockClear();
    mockToken.mockResolvedValue("tok");
  });

  it("ingests the own bot's issue as a backlog proposal", () => {
    const i = issue();
    upsertIssueTask(app, projectId, i, BOT);
    expect(row(i.number)).toMatchObject({ status: "backlog", proposalState: "proposed" });
  });

  it("still ignores the bot when no own-bot login is known", () => {
    const i = issue();
    upsertIssueTask(app, projectId, i, null);
    expect(row(i.number)).toBeUndefined();
  });

  it("still ignores a different untrusted author", () => {
    const i = issue({ authorLogin: "stranger", authorAssociation: "NONE" });
    upsertIssueTask(app, projectId, i, BOT);
    expect(row(i.number)).toBeUndefined();
  });

  it("matches the bot login case-insensitively", () => {
    const i = issue({ authorLogin: "Mullion-Session-Manager[bot]" });
    upsertIssueTask(app, projectId, i, BOT);
    expect(row(i.number)?.proposalState).toBe("proposed");
  });

  it("keeps a trusted human's issue an ordinary ready task", () => {
    const i = issue({ authorLogin: "me", authorAssociation: "OWNER" });
    upsertIssueTask(app, projectId, i, BOT);
    expect(row(i.number)).toMatchObject({ status: "ready", proposalState: null });
  });

  it("does not promote a proposal when a Manual: true line is removed", () => {
    const i = issue({ body: "Manual: true\ndo it" });
    upsertIssueTask(app, projectId, i, BOT);
    upsertIssueTask(app, projectId, { ...i, body: "do it" }, BOT);
    expect(row(i.number)).toMatchObject({ status: "backlog", proposalState: "proposed" });
  });

  describe("approve / dismiss", () => {
    it("approve makes it ready, pins the content and records the transition", async () => {
      const i = issue();
      upsertIssueTask(app, projectId, i, BOT);
      const id = row(i.number)!.id;
      const res = await post(id, "approve-proposal");
      expect(res.statusCode).toBe(200);
      expect(row(i.number)).toMatchObject({
        status: "ready",
        proposalState: "approved",
        approvedBodySha: proposalContentSha(i.title, i.body),
      });
      expect((await post(id, "approve-proposal")).statusCode).toBe(409);
    });

    it("approve keeps a Manual: true proposal in backlog", async () => {
      const i = issue({ body: "Manual: true\nx" });
      upsertIssueTask(app, projectId, i, BOT);
      await post(row(i.number)!.id, "approve-proposal");
      expect(row(i.number)).toMatchObject({ status: "backlog", proposalState: "approved" });
    });

    it("refuses approve on an ordinary task", async () => {
      const i = issue({ authorLogin: "me", authorAssociation: "OWNER" });
      upsertIssueTask(app, projectId, i, BOT);
      expect((await post(row(i.number)!.id, "approve-proposal")).statusCode).toBe(409);
    });

    it("PATCH cannot move a proposal to ready", async () => {
      const i = issue();
      upsertIssueTask(app, projectId, i, BOT);
      const res = await app.inject({
        method: "PATCH",
        url: `/api/tasks/${row(i.number)!.id}`,
        payload: { status: "ready" },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("proposal-needs-approval");
      expect(row(i.number)?.status).toBe("backlog");
    });

    it("an approved task goes back to proposed when its body is edited", async () => {
      const i = issue();
      upsertIssueTask(app, projectId, i, BOT);
      await post(row(i.number)!.id, "approve-proposal");
      upsertIssueTask(app, projectId, { ...i }, BOT);
      expect(row(i.number)).toMatchObject({ status: "ready", proposalState: "approved" });
      upsertIssueTask(app, projectId, { ...i, body: "do something else" }, BOT);
      expect(row(i.number)).toMatchObject({ status: "backlog", proposalState: "proposed" });
    });

    it("dismiss closes the issue, fails and archives the task", async () => {
      const i = issue();
      upsertIssueTask(app, projectId, i, BOT);
      const res = await post(row(i.number)!.id, "dismiss-proposal");
      expect(res.statusCode).toBe(200);
      expect(mockCloseIssue).toHaveBeenCalledWith("tok", "o", "r", i.number);
      const r = row(i.number)!;
      expect(r.status).toBe("failed");
      expect(r.archivedAt).not.toBeNull();
    });

    it("dismiss keeps the proposal when GitHub refuses", async () => {
      mockCloseIssue.mockRejectedValueOnce(new Error("boom"));
      const i = issue();
      upsertIssueTask(app, projectId, i, BOT);
      const res = await post(row(i.number)!.id, "dismiss-proposal");
      expect(res.statusCode).toBe(502);
      expect(row(i.number)).toMatchObject({ status: "backlog", proposalState: "proposed" });
    });

    it("dismiss 502s with no token and closes nothing", async () => {
      mockToken.mockResolvedValueOnce(null);
      const i = issue();
      upsertIssueTask(app, projectId, i, BOT);
      expect((await post(row(i.number)!.id, "dismiss-proposal")).statusCode).toBe(502);
      expect(mockCloseIssue).not.toHaveBeenCalled();
    });

    it("approve refuses text the human did not see", async () => {
      const i = issue();
      upsertIssueTask(app, projectId, i, BOT);
      const id = row(i.number)!.id;
      const stale = await app.inject({
        method: "POST",
        url: `/api/tasks/${id}/approve-proposal`,
        payload: { title: i.title, body: "an older body" },
      });
      expect(stale.statusCode).toBe(409);
      const none = await app.inject({ method: "POST", url: `/api/tasks/${id}/approve-proposal` });
      expect(none.statusCode).toBe(400);
      expect(row(i.number)?.proposalState).toBe("proposed");
    });
  });

  describe("no other road to a run", () => {
    it("claim refuses a proposal and an approved-then-edited task", async () => {
      const i = issue();
      upsertIssueTask(app, projectId, i, BOT);
      const id = row(i.number)!.id;
      expect(await enqueueTask(app, id, { auto: false })).toMatchObject({
        ok: false,
        reason: "not-ready",
      });
      app.db
        .update(tasks)
        .set({ proposalState: "approved", approvedBodySha: "stale", status: "ready" })
        .where(eq(tasks.id, id))
        .run();
      expect(await enqueueTask(app, id, { auto: false })).toMatchObject({ ok: false });
    });

    it("retry refuses a dismissed proposal", async () => {
      const i = issue();
      upsertIssueTask(app, projectId, i, BOT);
      const id = row(i.number)!.id;
      await app.inject({ method: "POST", url: `/api/tasks/${id}/dismiss-proposal` });
      expect(await enqueueRetry(app, id, {})).toMatchObject({ ok: false, reason: "not-failed" });
      expect(row(i.number)?.status).toBe("failed");
    });

    it("the dispatch sweep sends an edited, already-queued task back to proposed", async () => {
      const i = issue();
      upsertIssueTask(app, projectId, i, BOT);
      const id = row(i.number)!.id;
      app.db
        .update(tasks)
        .set({
          proposalState: "approved",
          approvedBodySha: proposalContentSha(i.title, "the approved body"),
          status: "claimed",
        })
        .where(eq(tasks.id, id))
        .run();
      await dispatchQueuedTasks(app);
      expect(row(i.number)).toMatchObject({ status: "backlog", proposalState: "proposed" });
    });

    it("an unresolved bot login does not demote an approved proposal", async () => {
      const i = issue();
      upsertIssueTask(app, projectId, i, BOT);
      await post(row(i.number)!.id, "approve-proposal");
      upsertIssueTask(app, projectId, { ...i }, null);
      expect(row(i.number)).toMatchObject({ status: "ready", proposalState: "approved" });
    });
  });
});
