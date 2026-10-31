import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import type * as ChildProcess from "node:child_process";
import { eq } from "drizzle-orm";
import { gitEnv } from "../../src/services/git-env.js";
import { deriveTaskBranchName } from "../../src/services/git-worktree.js";

// Same fakes as task-claim.test.ts: no real systemd/pty, real git.
vi.mock("node-pty", () => ({
  spawn: vi.fn(() => ({
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn((command: string, args?: readonly string[], options?: object) => {
      if (command === "git") return actual.spawn(command, args, options);
      const ee = new EventEmitter() as EventEmitter & { stdout?: EventEmitter };
      setImmediate(() => {
        ee.emit("exit", 0);
        ee.stdout = new EventEmitter();
        setImmediate(() => ee.emit("close", 0));
      });
      return ee;
    }),
  };
});
vi.mock("../../src/services/task-github-sync.js", () => ({
  syncTaskTransition: vi.fn().mockResolvedValue(undefined),
}));

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { retryTask } = await import("../../src/services/task-claim.js");
const { tasks, projects } = await import("../../src/db/schema.js");
const { resolveReviewerSmallModel } = await import("../../src/services/task-model-patch.js");
const { createWorktree, removeWorktreeIfClean } =
  await import("../../src/services/git-worktree.js");

const tmpDb = path.join(os.tmpdir(), `task-claim-retry-model-${process.pid}.db`);

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
}

describe("retryTask task-level model (#2491)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.MULLION_TASK_MAX_CONCURRENT = "1000";
  });
  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_TASK_MAX_CONCURRENT;
  });

  it("runs with the chosen model; an agent-family change drops it", async () => {
    const app = await buildApp();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "task-claim-retry-model-repo-"));
    git(cwd, ["init", "-b", "main"]);
    fs.writeFileSync(path.join(cwd, "a.txt"), "a");
    git(cwd, ["add", "-A"]);
    git(cwd, ["commit", "-m", "initial", "--no-verify"]);
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "retry-model-p", cwd },
    });
    const projectId = res.json().id as number;

    // A failed task whose preserved branch (no worktree dir) can be resumed.
    const failedTask = async (issueNumber: number, agent: string) => {
      const [row] = app.db
        .insert(tasks)
        .values({ projectId, issueNumber, title: "t", status: "ready" })
        .returning()
        .all();
      const branchName = deriveTaskBranchName(row);
      const created = await createWorktree({ cwd, baseRef: "main", seed: branchName, branchName });
      if (!created?.path) throw new Error("test setup: failed to create worktree");
      await removeWorktreeIfClean(created.path, cwd);
      app.db
        .update(tasks)
        .set({
          status: "failed",
          worktreePath: created.path,
          branchName,
          agent,
          modelOverride: "claude-opus-4-5",
          model: "stale",
        })
        .where(eq(tasks.id, row.id))
        .run();
      return row.id;
    };
    const load = (id: number) => app.db.select().from(tasks).where(eq(tasks.id, id)).all()[0];

    const same = await failedTask(71, "claude");
    expect((await retryTask(app, same)).ok).toBe(true);
    expect(load(same)).toMatchObject({
      model: "claude-opus-4-5",
      modelOverride: "claude-opus-4-5",
    });

    // A bare retry after the project default agent moved to another family
    // must not hand the old family's model to the new worker.
    const drifted = await failedTask(73, "");
    app.db
      .update(tasks)
      .set({ agent: null, agentCommand: "opencode", modelOverride: "openrouter/foo" })
      .where(eq(tasks.id, drifted))
      .run();
    app.db.update(projects).set({ defaultAgent: "claude" }).where(eq(projects.id, projectId)).run();
    expect((await retryTask(app, drifted)).ok).toBe(true);
    expect(load(drifted).modelOverride).toBeNull();
    app.db.update(projects).set({ defaultAgent: null }).where(eq(projects.id, projectId)).run();

    // PATCH agent=codex then model: the row pins codex while agentCommand still
    // records the LAST run (claude). A bare retry must keep the chosen model.
    const pinned = await failedTask(74, "codex");
    app.db
      .update(tasks)
      .set({ agentCommand: "claude", modelOverride: "gpt-5" })
      .where(eq(tasks.id, pinned))
      .run();
    expect((await retryTask(app, pinned)).ok).toBe(true);
    expect(load(pinned)).toMatchObject({ agent: "codex", modelOverride: "gpt-5", model: "gpt-5" });

    // A body that gains `Agent: codex` (watcher re-sync / plain body PATCH) does
    // not revalidate the override, so it must not count as a pin: the opencode
    // model is cleared rather than handed to codex.
    const bodyDrift = await failedTask(75, "");
    app.db
      .update(tasks)
      .set({
        agent: null,
        agentCommand: "opencode",
        modelOverride: "openrouter/foo",
        smallModelOverride: "openrouter/bar",
        body: "Do X.\n\nAgent: codex\n",
      })
      .where(eq(tasks.id, bodyDrift))
      .run();
    expect((await retryTask(app, bodyDrift)).ok).toBe(true);
    expect(load(bodyDrift)).toMatchObject({ modelOverride: null, smallModelOverride: null });

    // Same family as the last run: a body `Agent:` that still matches
    // `agentCommand` leaves the override alone.
    const sameFamily = await failedTask(76, "");
    app.db
      .update(tasks)
      .set({
        agent: null,
        agentCommand: "codex",
        modelOverride: "gpt-5",
        body: "Do X.\n\nAgent: codex\n",
      })
      .where(eq(tasks.id, sameFamily))
      .run();
    expect((await retryTask(app, sameFamily)).ok).toBe(true);
    expect(load(sameFamily)).toMatchObject({ modelOverride: "gpt-5" });

    const changed = await failedTask(72, "claude");
    expect((await retryTask(app, changed, { agent: "codex" })).ok).toBe(true);
    expect(load(changed)).toMatchObject({ agent: "codex", modelOverride: null });

    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });

  it("resolveReviewerSmallModel only passes a small model to a same-family reviewer", async () => {
    const app = await buildApp();
    const task = (agentCommand: string | null, smallModelOverride: string | null) => ({
      agentCommand,
      smallModelOverride,
      body: null,
    });
    const oc = task("opencode", "anthropic/claude-haiku-4-5");
    expect(resolveReviewerSmallModel(app, oc, "claude")).toBeUndefined();
    expect(resolveReviewerSmallModel(app, oc, "opencode")).toBe("anthropic/claude-haiku-4-5");
    expect(resolveReviewerSmallModel(app, task("claude", "claude-haiku-5-5"), "claude")).toBe(
      "claude-haiku-5-5",
    );
    expect(
      resolveReviewerSmallModel(app, task(null, "claude-haiku-5-5"), "claude"),
    ).toBeUndefined();
    await app.close();
  });
});
