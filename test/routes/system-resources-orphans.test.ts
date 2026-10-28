import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { projects, sessions, tasks } from "../../src/db/schema.js";
import { gitEnv } from "../../src/services/git-env.js";
import * as devWorktrees from "../../src/services/dev-worktrees.js";
import { buildTestApp } from "../helpers/app.js";

async function postAndWait(
  app: Awaited<ReturnType<typeof buildTestApp>>,
  projectId: number,
  target: string,
) {
  const started = await app.inject({
    method: "POST",
    url: "/api/storage/worktrees/remove-orphan",
    payload: { projectId, path: target },
  });
  expect(started.statusCode).toBe(202);
  const id = started.json().id as string;
  return vi.waitFor(
    async () => {
      const status = (
        await app.inject({ method: "GET", url: "/api/storage/worktrees/remove-orphan" })
      ).json().job;
      expect(status.id).toBe(id);
      expect(status.state).toBe("done");
      return status.result;
    },
    { timeout: 10_000, interval: 25 },
  );
}

describe("POST /api/storage/worktrees/remove-orphan", () => {
  it("refuses nested task and live ended-session use, then removes a confirmed orphan", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orphan-route-")));
    execFileSync("git", ["init", "-b", "main"], { cwd: root, env: gitEnv(), stdio: "pipe" });
    const target = path.join(root, ".wt", "stray");
    fs.mkdirSync(path.join(target, "nested"), { recursive: true });
    fs.writeFileSync(path.join(target, "file"), "work");
    const app = await buildTestApp();
    try {
      const projectId = Number(
        app.db.insert(projects).values({ name: "orphan", cwd: root }).run().lastInsertRowid,
      );
      const preview = await app.inject({ method: "GET", url: "/api/storage/worktrees" });
      expect(preview.json().candidates).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: target, reason: "orphaned" })]),
      );
      const taskId = Number(
        app.db
          .insert(tasks)
          .values({
            projectId,
            title: "unfinished",
            status: "failed",
            worktreePath: path.join(target, "nested"),
          })
          .run().lastInsertRowid,
      );
      expect(await postAndWait(app, projectId, target)).toEqual({
        removed: false,
        reason: "in-use",
      });
      app.db.delete(tasks).where(eq(tasks.id, taskId)).run();
      const sessionId = Number(
        app.db
          .insert(sessions)
          .values({ projectId, command: "bash", cwd: target, status: "killed" })
          .run().lastInsertRowid,
      );
      const liveness = vi
        .spyOn(app.pty, "isMasterAliveStateBatch")
        .mockResolvedValue({ [String(sessionId)]: "alive" });
      expect(await postAndWait(app, projectId, target)).toEqual({
        removed: false,
        reason: "in-use",
      });
      liveness.mockResolvedValue({ [String(sessionId)]: "dead" });
      const result = await postAndWait(app, projectId, target);
      expect(result).toMatchObject({ removed: true, reclaimedBytes: expect.any(Number) });
      expect(fs.existsSync(target)).toBe(false);
      const after = await app.inject({ method: "GET", url: "/api/storage/worktrees" });
      expect(after.json().candidates ?? []).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ path: target })]),
      );
      liveness.mockRestore();
    } finally {
      await app.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("exposes a running job and refuses another until it finishes", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orphan-job-")));
    execFileSync("git", ["init", "-b", "main"], { cwd: root, env: gitEnv(), stdio: "pipe" });
    const target = path.join(root, ".wt", "stray");
    fs.mkdirSync(target, { recursive: true });
    const app = await buildTestApp();
    let release!: (value: Record<string, "dead">) => void;
    const liveness = new Promise<Record<string, "dead">>((resolve) => {
      release = resolve;
    });
    try {
      const projectId = Number(
        app.db.insert(projects).values({ name: "job", cwd: root }).run().lastInsertRowid,
      );
      const sessionId = Number(
        app.db
          .insert(sessions)
          .values({ projectId, command: "bash", cwd: target, status: "killed" })
          .run().lastInsertRowid,
      );
      const spy = vi.spyOn(app.pty, "isMasterAliveStateBatch").mockReturnValue(liveness);
      const post = () =>
        app.inject({
          method: "POST",
          url: "/api/storage/worktrees/remove-orphan",
          payload: { projectId, path: target },
        });
      expect((await post()).statusCode).toBe(202);
      await vi.waitFor(() => expect(spy).toHaveBeenCalled());
      expect(
        (await app.inject({ method: "GET", url: "/api/storage/worktrees/remove-orphan" })).json()
          .job,
      ).toMatchObject({ state: "running", path: target });
      expect((await post()).statusCode).toBe(409);
      release({ [String(sessionId)]: "dead" });
      await vi.waitFor(
        async () =>
          expect(
            (
              await app.inject({ method: "GET", url: "/api/storage/worktrees/remove-orphan" })
            ).json().job,
          ).toMatchObject({ state: "done", result: { removed: true } }),
        { timeout: 10_000, interval: 25 },
      );
      spy.mockRestore();
    } finally {
      release({});
      await app.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("restores an orphan when a session starts through an alias during removal", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orphan-alias-")));
    execFileSync("git", ["init", "-b", "main"], { cwd: root, env: gitEnv(), stdio: "pipe" });
    const target = path.join(root, ".wt", "stray");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "file"), "keep");
    const alias = path.join(root, "alias");
    fs.symlinkSync(target, alias);
    const app = await buildTestApp();
    const projectId = Number(
      app.db.insert(projects).values({ name: "alias", cwd: root }).run().lastInsertRowid,
    );
    const rename = fs.promises.rename.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
      await rename(from, to);
      if (from === target)
        app.db.insert(sessions).values({ projectId, command: "bash", cwd: alias }).run();
    });
    try {
      const result = await postAndWait(app, projectId, target);
      expect(result).toEqual({ removed: false, reason: "in-use" });
      expect(fs.readFileSync(path.join(target, "file"), "utf8")).toBe("keep");
    } finally {
      spy.mockRestore();
      await app.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not report an in-flight quarantine when a job starts during a recovery scan", async () => {
    const app = await buildTestApp();
    const projectId = Number(
      app.db.insert(projects).values({ name: "race", cwd: "/tmp/race-project" }).run()
        .lastInsertRowid,
    );
    let releaseScan!: (
      value: Awaited<ReturnType<typeof devWorktrees.inspectOrphanRecoveries>>,
    ) => void;
    let releaseJob!: (value: devWorktrees.RemoveOrphanResult) => void;
    const scan = vi.spyOn(devWorktrees, "inspectOrphanRecoveries").mockReturnValueOnce(
      new Promise((resolve) => {
        releaseScan = resolve;
      }),
    );
    const removal = vi.spyOn(devWorktrees, "removeOrphanedDevWorktree").mockReturnValueOnce(
      new Promise((resolve) => {
        releaseJob = resolve;
      }),
    );
    try {
      const pending = app.inject({ method: "GET", url: "/api/storage/worktrees/remove-orphan" });
      await vi.waitFor(() => expect(scan).toHaveBeenCalled());
      const started = await app.inject({
        method: "POST",
        url: "/api/storage/worktrees/remove-orphan",
        payload: { projectId, path: "/tmp/race-project/.wt/x" },
      });
      expect(started.statusCode).toBe(202);
      await vi.waitFor(() => expect(removal).toHaveBeenCalled());
      releaseScan({
        recoveries: [
          {
            projectId,
            originalPath: "/tmp/race-project/.wt/x",
            recoveryPath: "/tmp/race-project/.mullion-orphan-x/directory",
            mayBePartial: false,
          },
        ],
        warnings: [],
      });
      expect((await pending).json()).toMatchObject({ job: { state: "running" }, recoveries: [] });
      releaseJob({ removed: false, reason: "unavailable" });
      await vi.waitFor(async () =>
        expect(
          (await app.inject({ method: "GET", url: "/api/storage/worktrees/remove-orphan" })).json()
            .job.state,
        ).toBe("done"),
      );
    } finally {
      scan.mockRestore();
      removal.mockRestore();
      await app.close();
    }
  });

  it.each(["deleted", "moved"] as const)(
    "rediscovers a quarantine after restart when the project was %s",
    async (change) => {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orphan-restart-")));
      const target = path.join(root, ".wt", "stray");
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, "file"), "keep");
      const stat = fs.statSync(target);
      const quarantine = fs.mkdtempSync(path.join(root, ".mullion-orphan-"));
      const staged = path.join(quarantine, "directory");
      const first = await buildTestApp();
      const projectId = Number(
        first.db.insert(projects).values({ name: "restart", cwd: root }).run().lastInsertRowid,
      );
      const registry = path.join(first.config.SESSIONS_DIR, "orphan-recoveries");
      fs.mkdirSync(registry, { recursive: true });
      const manifest = path.join(registry, `1234-${projectId}.json`);
      fs.writeFileSync(
        manifest,
        JSON.stringify({
          projectId,
          originalPath: target,
          recoveryPath: staged,
          phase: "deleting",
          dev: stat.dev,
          ino: stat.ino,
        }),
      );
      fs.renameSync(target, staged);
      if (change === "deleted") first.db.delete(projects).where(eq(projects.id, projectId)).run();
      else
        first.db
          .update(projects)
          .set({ cwd: path.join(root, "moved") })
          .where(eq(projects.id, projectId))
          .run();
      await first.close();
      const restarted = await buildTestApp();
      try {
        const response = await restarted.inject({
          method: "GET",
          url: "/api/storage/worktrees/remove-orphan",
        });
        expect(response.json()).toMatchObject({
          job: { state: "idle" },
          recoveries: expect.arrayContaining([
            { projectId, originalPath: target, recoveryPath: staged, mayBePartial: true },
          ]),
        });
        expect(fs.readFileSync(path.join(staged, "file"), "utf8")).toBe("keep");
      } finally {
        await restarted.close();
        fs.rmSync(manifest, { force: true });
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("rejects an unknown project and invalid request", async () => {
    const app = await buildTestApp();
    try {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/storage/worktrees/remove-orphan",
            payload: { projectId: 999999, path: "/tmp/nope" },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/storage/worktrees/remove-orphan",
            payload: { projectId: 0, path: "/tmp/nope" },
          })
        ).statusCode,
      ).toBe(400);
    } finally {
      await app.close();
    }
  });
});
