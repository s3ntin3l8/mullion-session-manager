// A PR merged by hand on github.com is observed only by the `pull_request`
// webhook, which writes mergedAt inline and never reaches markTaskMerged. The
// `→ done` sync leaves the issue open while the PR awaits its merge, so this
// path must close it too.
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type * as GithubIntegration from "../../src/services/github-integration.js";
import type * as GithubWrite from "../../src/services/github-write.js";

const mocks = vi.hoisted(() => ({ closeIssue: vi.fn(), getIssueState: vi.fn() }));
vi.mock("../../src/services/github-integration.js", async (importOriginal) => ({
  ...(await importOriginal<typeof GithubIntegration>()),
  resolveGitHubToken: vi.fn().mockResolvedValue("ghp_token"),
}));
vi.mock("../../src/services/github-write.js", async (importOriginal) => ({
  ...(await importOriginal<typeof GithubWrite>()),
  closeIssue: mocks.closeIssue,
  getIssueState: mocks.getIssueState,
}));

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { integrations, projects, tasks } = await import("../../src/db/schema.js");
const { GITHUB_PROVIDER } = await import("../../src/services/github-integration.js");
const { gitEnv } = await import("../../src/services/git-env.js");

const tmpDb = path.join(os.tmpdir(), `webhooks-merge-closes-issue-test-${process.pid}.db`);
const TEST_SECRET = "test-webhook-secret-123"; // pragma: allowlist secret

function signPayload(payload: string, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(payload).digest("hex")}`;
}

function createMatchingGitRepo(owner: string, repo: string): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "webhooks-merge-closes-issue-repo-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
  git(["init", "-b", "main"]);
  git(["remote", "add", "origin", `https://github.com/${owner}/${repo}.git`]);
  fs.writeFileSync(path.join(cwd, "a.txt"), "a");
  git(["add", "-A"]);
  git(["commit", "-m", "initial", "--no-verify"]);
  return cwd;
}

describe("webhook merge closes the task's still-open issue", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.MULLION_WEBHOOK_BASE_URL = "https://hooks.example.com";
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_WEBHOOK_BASE_URL;
  });

  it("closes the issue of a done task when its PR is merged by hand", async () => {
    mocks.getIssueState.mockResolvedValue({ state: "open", labels: [] });
    const cwd = createMatchingGitRepo("acme", "widgets-merge-closes");
    const app = await buildApp();
    const secretEnc = app.encryption.encryptString(TEST_SECRET);
    app.db
      .insert(integrations)
      .values({ provider: GITHUB_PROVIDER, webhookEnabled: true, webhookSecretEnc: secretEnc })
      .onConflictDoUpdate({
        target: integrations.provider,
        set: { webhookEnabled: true, webhookSecretEnc: secretEnc },
      })
      .run();
    const [project] = app.db
      .insert(projects)
      .values({ name: "webhook-merge-closes-p1", cwd })
      .returning()
      .all();
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId: project.id,
        title: "approved",
        status: "done",
        issueNumber: 321,
        prNumber: 92,
      })
      .returning()
      .all();

    const payload = JSON.stringify({
      action: "closed",
      pull_request: { number: 92, merged: true },
      repository: { full_name: "acme/widgets-merge-closes" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signPayload(payload, TEST_SECRET),
        "x-github-event": "pull_request",
      },
      payload,
    });
    expect(res.statusCode).toBe(200);

    const [updated] = app.db.select().from(tasks).where(eq(tasks.id, task.id)).all();
    expect(updated.mergedAt).not.toBeNull();
    await vi.waitFor(() =>
      expect(mocks.closeIssue).toHaveBeenCalledWith(
        "ghp_token",
        "acme",
        "widgets-merge-closes",
        321,
      ),
    );

    await app.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});
