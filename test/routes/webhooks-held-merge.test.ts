import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { integrations, projects, tasks } from "../../src/db/schema.js";
import { GITHUB_PROVIDER } from "../../src/services/github-integration.js";
import { gitEnv } from "../../src/services/git-env.js";

const tmpDb = path.join(os.tmpdir(), `webhooks-held-merge-test-${process.pid}.db`);
const TEST_SECRET = "test-webhook-secret-123"; // pragma: allowlist secret

function signPayload(payload: string, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(payload).digest("hex")}`;
}

function createMatchingGitRepo(owner: string, repo: string): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "webhooks-held-merge-repo-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
  git(["init", "-b", "main"]);
  git(["remote", "add", "origin", `https://github.com/${owner}/${repo}.git`]);
  fs.writeFileSync(path.join(cwd, "a.txt"), "a");
  git(["add", "-A"]);
  git(["commit", "-m", "initial", "--no-verify"]);
  return cwd;
}

describe("webhook merge of a held task", () => {
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

  it("clears a review-post-failed hold when the task's PR merges externally", async () => {
    const cwd = createMatchingGitRepo("acme", "widgets-merge-held");
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
      .values({ name: "webhook-merge-held-p1", cwd })
      .returning()
      .all();
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId: project.id,
        title: "held",
        status: "done",
        prNumber: 91,
        needsHumanReason: "review-post-failed",
      })
      .returning()
      .all();

    const payload = JSON.stringify({
      action: "closed",
      pull_request: { number: 91, merged: true },
      repository: { full_name: "acme/widgets-merge-held" },
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
    expect(updated.needsHumanReason).toBeNull();

    await app.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});
