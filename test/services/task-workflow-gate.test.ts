import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { gitEnv } from "../../src/services/git-env.js";
import { clearGitDiffStatsCacheForTests } from "../../src/services/git-diff.js";

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { tasks } = await import("../../src/db/schema.js");
const {
  parseWorkflowChange,
  evaluateWorkflowGate,
  recordWorkflowHold,
  clearWorkflowHold,
  approveWorkflowChange,
} = await import("../../src/services/task-workflow-gate.js");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() }).toString().trim();
}

const tmpDb = path.join(os.tmpdir(), `task-workflow-gate-test-${process.pid}.db`);

describe("task-workflow-gate", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let projectId: number;
  let worktree: string;

  function insertTask(): typeof tasks.$inferSelect {
    return app.db
      .insert(tasks)
      .values({
        projectId,
        title: "gate task",
        worktreePath: worktree,
        branchName: "mullion/task-1-gate",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning()
      .get();
  }
  const reload = (id: number) => app.db.select().from(tasks).where(eq(tasks.id, id)).get()!;

  function commitFile(rel: string, content: string): string {
    fs.mkdirSync(path.dirname(path.join(worktree, rel)), { recursive: true });
    fs.writeFileSync(path.join(worktree, rel), content);
    git(worktree, ["add", "-A"]);
    git(worktree, ["commit", "-m", `edit ${rel}`, "--no-verify"]);
    clearGitDiffStatsCacheForTests();
    return git(worktree, ["rev-parse", "HEAD"]);
  }

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    app = await buildApp();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "task-workflow-gate-project-"));
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "gate-project", cwd },
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
    worktree = fs.mkdtempSync(path.join(os.tmpdir(), "task-workflow-gate-wt-"));
    git(worktree, ["init", "-b", "main"]);
    fs.writeFileSync(path.join(worktree, "a.txt"), "a\n");
    git(worktree, ["add", "-A"]);
    git(worktree, ["commit", "-m", "initial", "--no-verify"]);
    // The gate diffs against the default base, which it finds via origin/*.
    git(worktree, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(worktree, ["checkout", "-b", "mullion/task-1-gate"]);
    clearGitDiffStatsCacheForTests();
  });

  describe("parseWorkflowChange", () => {
    it("reads a stored change", () => {
      expect(parseWorkflowChange('{"sha":"abc","files":["x.yml"]}')).toEqual({
        sha: "abc",
        files: ["x.yml"],
      });
    });
    it("treats null, empty, corrupt and wrongly-shaped values as nothing waiting", () => {
      expect(parseWorkflowChange(null)).toBeNull();
      expect(parseWorkflowChange("")).toBeNull();
      expect(parseWorkflowChange("{not json")).toBeNull();
      expect(parseWorkflowChange('{"sha":1,"files":[]}')).toBeNull();
    });
  });

  describe("evaluateWorkflowGate", () => {
    it("is clear when the branch changes no workflow files", async () => {
      commitFile("src/x.ts", "x\n");
      const task = insertTask();
      expect(await evaluateWorkflowGate(app, task, "local")).toEqual({ kind: "clear" });
    });

    it("is clear for a task with no worktree", async () => {
      const task = { ...insertTask(), worktreePath: null };
      expect(await evaluateWorkflowGate(app, task, "local")).toEqual({ kind: "clear" });
    });

    it("is unverified, never clear, when there is no base ref to diff against", async () => {
      commitFile(".github/workflows/ci.yml", "name: ci\n");
      git(worktree, ["update-ref", "-d", "refs/remotes/origin/main"]);
      clearGitDiffStatsCacheForTests();
      const task = insertTask();
      const gate = await evaluateWorkflowGate(app, task, "local");
      expect(gate.kind).toBe("unverified");
      expect((gate as { detail: string }).detail).toContain("no origin/main or origin/master");
    });

    it("is unverified when a remote host cannot answer", async () => {
      const task = insertTask();
      // Host id with no registered client: the lookup throws, which must not read as clear.
      expect((await evaluateWorkflowGate(app, task, "no-such-host")).kind).toBe("unverified");
    });

    it("holds a branch that edits .github/workflows/, naming the head commit and files", async () => {
      const head = commitFile(".github/workflows/ci.yml", "name: ci\n");
      const task = insertTask();
      expect(await evaluateWorkflowGate(app, task, "local")).toEqual({
        kind: "held",
        change: { sha: head, files: [".github/workflows/ci.yml"] },
      });
    });

    it("treats an approval for an older head as void once a new commit lands", async () => {
      const first = commitFile(".github/workflows/ci.yml", "name: ci\n");
      const task = { ...insertTask(), workflowApprovedSha: first };
      expect((await evaluateWorkflowGate(app, task, "local")).kind).toBe("approved");

      const second = commitFile("src/more.ts", "more\n");
      const gate = await evaluateWorkflowGate(app, task, "local");
      expect(gate).toMatchObject({ kind: "held", change: { sha: second } });
    });
  });

  describe("record/clear hold", () => {
    it("round-trips through the task row and clears", () => {
      const task = insertTask();
      recordWorkflowHold(app, task.id, { sha: "abc", files: ["w.yml"] });
      expect(parseWorkflowChange(reload(task.id).workflowChange)).toEqual({
        sha: "abc",
        files: ["w.yml"],
      });
      clearWorkflowHold(app, reload(task.id));
      expect(reload(task.id).workflowChange).toBeNull();
    });

    it("reports a hold as new only for a head commit not already recorded (#2108)", () => {
      const task = insertTask();
      const change = { sha: "a".repeat(40), files: ["w.yml"] };
      expect(recordWorkflowHold(app, task.id, change)).toBe(true);
      // The retry sweeps re-record the same head every tick: not new.
      expect(recordWorkflowHold(app, task.id, change)).toBe(false);
      // A new commit is a new hold, and so is the same sha after the hold was cleared.
      expect(recordWorkflowHold(app, task.id, { ...change, sha: "b".repeat(40) })).toBe(true);
      clearWorkflowHold(app, reload(task.id));
      expect(recordWorkflowHold(app, task.id, { ...change, sha: "b".repeat(40) })).toBe(true);
    });

    it("clearing a task with no hold does not write", () => {
      const task = insertTask();
      const before = reload(task.id).updatedAt;
      clearWorkflowHold(app, task);
      expect(reload(task.id).updatedAt).toEqual(before);
    });
  });

  describe("approveWorkflowChange", () => {
    it("records the approved head and drops the hold", async () => {
      const head = commitFile(".github/workflows/ci.yml", "name: ci\n");
      const task = insertTask();
      recordWorkflowHold(app, task.id, { sha: head, files: [".github/workflows/ci.yml"] });

      const result = await approveWorkflowChange(app, reload(task.id), "local", head);
      expect(result).toEqual({ ok: true, sha: head });
      const row = reload(task.id);
      expect(row.workflowApprovedSha).toBe(head);
      expect(row.workflowChange).toBeNull();
    });

    it("refuses when nothing is held", async () => {
      const task = insertTask();
      expect(await approveWorkflowChange(app, task, "local", "a".repeat(40))).toEqual({
        ok: false,
        reason: "nothing-held",
      });
    });

    it("refuses as unreadable when the changed files cannot be verified", async () => {
      const task = insertTask();
      git(worktree, ["update-ref", "-d", "refs/remotes/origin/main"]);
      clearGitDiffStatsCacheForTests();
      recordWorkflowHold(app, task.id, { sha: "c".repeat(40), files: ["w.yml"] });
      expect(await approveWorkflowChange(app, reload(task.id), "local", "c".repeat(40))).toEqual({
        ok: false,
        reason: "unreadable",
      });
      expect(reload(task.id).workflowApprovedSha).toBeNull();
    });

    it("drops a hold whose workflow edit has since been removed", async () => {
      const task = insertTask();
      recordWorkflowHold(app, task.id, { sha: "b".repeat(40), files: ["w.yml"] });
      const result = await approveWorkflowChange(app, reload(task.id), "local", "b".repeat(40));
      expect(result).toEqual({ ok: false, reason: "nothing-held" });
      expect(reload(task.id).workflowChange).toBeNull();
    });

    it("is stale when the branch moved after the operator was shown it, and records the fresh head", async () => {
      const shown = commitFile(".github/workflows/ci.yml", "name: ci\n");
      const task = insertTask();
      recordWorkflowHold(app, task.id, { sha: shown, files: [".github/workflows/ci.yml"] });
      const moved = commitFile(".github/workflows/ci.yml", "name: ci\non: push\n");

      const result = await approveWorkflowChange(app, reload(task.id), "local", shown);
      expect(result).toMatchObject({ ok: false, reason: "stale", change: { sha: moved } });
      const row = reload(task.id);
      expect(row.workflowApprovedSha).toBeNull();
      expect(parseWorkflowChange(row.workflowChange)?.sha).toBe(moved);
    });

    it("drops a stale hold when the head is already approved", async () => {
      const head = commitFile(".github/workflows/ci.yml", "name: ci\n");
      const task = insertTask();
      app.db.update(tasks).set({ workflowApprovedSha: head }).where(eq(tasks.id, task.id)).run();
      recordWorkflowHold(app, task.id, { sha: head, files: [".github/workflows/ci.yml"] });
      const result = await approveWorkflowChange(app, reload(task.id), "local", head);
      expect(result).toEqual({ ok: true, sha: head });
      expect(reload(task.id).workflowChange).toBeNull();
    });

    it("is idempotent when the current head is already approved", async () => {
      const head = commitFile(".github/workflows/ci.yml", "name: ci\n");
      const task = insertTask();
      recordWorkflowHold(app, task.id, { sha: head, files: [".github/workflows/ci.yml"] });
      await approveWorkflowChange(app, reload(task.id), "local", head);
      // A second click finds the approval already covering the head.
      recordWorkflowHold(app, task.id, { sha: head, files: [".github/workflows/ci.yml"] });
      expect(await approveWorkflowChange(app, reload(task.id), "local", head)).toEqual({
        ok: true,
        sha: head,
      });
    });
  });
});
