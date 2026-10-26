import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import net from "node:net";
import { execFileSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { previews, projects, sessions } from "../../src/db/schema.js";
import * as sessionBackendModule from "../../src/services/session-backend.js";
import * as lifecycleModule from "../../src/services/session-lifecycle.js";
import {
  allocatePreviewPort,
  BranchPreviewError,
  getOrCreateBranchPreview,
  pickPreviewControl,
} from "../../src/services/branch-preview.js";
import {
  CHECKOUT_BRANCH,
  getOrCreateProjectPreview,
  listUpstreamPorts,
} from "../../src/services/preview-registry.js";
import { dockPreviewWorktreePath, ensureLocalBranch } from "../../src/services/git-worktree.js";

type App = Awaited<ReturnType<typeof buildApp>>;

const tmpDb = path.join(os.tmpdir(), `branch-preview-test-${process.pid}.db`);

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-c", "gc.auto=0", "-C", cwd, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  }).toString();
}

/** A repo with a `main` commit and a `feat/x` branch, plus a bare `origin`
 * that also carries `feat/remote-only`. */
function makeRepo(): { cwd: string; origin: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "branch-preview-"));
  const origin = path.join(root, "origin.git");
  const cwd = path.join(root, "repo");
  fs.mkdirSync(cwd);
  git(root, "init", "--quiet", "--bare", origin);
  git(cwd, "init", "--quiet", "-b", "main");
  fs.writeFileSync(path.join(cwd, "a.txt"), "a\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "--quiet", "-m", "init");
  git(cwd, "branch", "feat/x");
  git(cwd, "remote", "add", "origin", origin);
  git(cwd, "push", "--quiet", "origin", "main", "main:feat/remote-only");
  return { cwd, origin };
}

function writeDock(cwd: string, controls: unknown[]) {
  fs.mkdirSync(path.join(cwd, ".crs"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".crs", "dock.json"), JSON.stringify({ controls }));
}

function insertProject(app: App, cwd: string, hostId = "local"): number {
  const [row] = app.db
    .insert(projects)
    .values({ name: `p-${Math.random()}`, cwd, hostId })
    .returning()
    .all();
  return row.id;
}

/** Stands in for the real session create (no PTY/scope may spawn in tests):
 * inserts the dock session row the real one would. */
function fakeCreate(app: App) {
  return vi.spyOn(lifecycleModule, "createSessionRecord").mockImplementation(async (_a, params) => {
    const [row] = app.db
      .insert(sessions)
      .values({
        projectId: params.projectId,
        command: params.command,
        kind: params.kind,
        status: "active",
      })
      .returning()
      .all();
    return { ok: true, row, project: {} as never };
  });
}

function fakeLiveness(state: "alive" | "dead" | "unknown" | Error) {
  vi.spyOn(sessionBackendModule, "resolveBackend").mockReturnValue({
    liveness: vi.fn().mockImplementation(async (ids: string[]) => {
      if (state instanceof Error) throw state;
      return Object.fromEntries(ids.map((id) => [id, state]));
    }),
  } as unknown as ReturnType<typeof sessionBackendModule.resolveBackend>);
}

describe("branch previews (issues #2016/#2018)", () => {
  let app: App;
  const roots: string[] = [];

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    app = await buildApp();
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    await app.close();
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
  });

  function repo() {
    const r = makeRepo();
    roots.push(path.dirname(r.cwd));
    return r;
  }

  describe("pickPreviewControl", () => {
    const c = (id: string, preview?: boolean) => ({ id, title: id, command: "x", preview });
    it("prefers the flagged control, else the only one, else none", () => {
      expect(pickPreviewControl([c("a"), c("b", true)])?.id).toBe("b");
      expect(pickPreviewControl([c("a")])?.id).toBe("a");
      expect(pickPreviewControl([c("a"), c("b")])).toBeNull();
      expect(pickPreviewControl([])).toBeNull();
    });
  });

  it("allocates a free port that no other preview holds", async () => {
    const port = await allocatePreviewPort(new Set());
    expect(port).toBeGreaterThan(0);
    // The port is genuinely free: we can bind it.
    await new Promise<void>((resolve, reject) => {
      const s = net.createServer().once("error", reject);
      s.listen(port, "127.0.0.1", () => s.close(() => resolve()));
    });
  });

  it("gives up when every port the OS offers is taken", async () => {
    const taken = { has: () => true } as unknown as ReadonlySet<number>;
    await expect(allocatePreviewPort(taken)).rejects.toThrow(/no free port/);
  });

  describe("ensureLocalBranch", () => {
    it("keeps a local branch, fetches one only origin has, refuses the rest", async () => {
      const { cwd } = repo();
      expect(await ensureLocalBranch(cwd, "feat/x")).toBe(true);
      expect(await ensureLocalBranch(cwd, "feat/remote-only")).toBe(true);
      expect(git(cwd, "rev-parse", "--verify", "refs/heads/feat/remote-only").trim()).toMatch(
        /^[0-9a-f]{40}$/,
      );
      expect(await ensureLocalBranch(cwd, "feat/nowhere")).toBe(false);
      expect(await ensureLocalBranch(cwd, "bad..name")).toBe(false);
      expect(await ensureLocalBranch(cwd, "-x")).toBe(false);
    });
  });

  it("starts the preview control in the branch worktree with PORT, and binds the row", async () => {
    const { cwd } = repo();
    writeDock(cwd, [
      { id: "dev", title: "Dev", command: "npm run dev", env: { A: "1" } },
      { id: "web", title: "Web", command: "vite", preview: true, worktreeRefresh: true },
    ]);
    const projectId = insertProject(app, cwd);
    const create = fakeCreate(app);

    const preview = await getOrCreateBranchPreview(app, projectId, "feat/x");

    expect(create).toHaveBeenCalledTimes(1);
    const params = create.mock.calls[0][1];
    expect(params).toMatchObject({
      projectId,
      command: "vite",
      kind: "dock",
      worktree: { branch: "feat/x" },
      worktreeRefresh: true,
    });
    expect(params.env?.PORT).toBe(String(preview.upstreamPort));
    expect(preview).toMatchObject({ kind: "project", projectId, branch: "feat/x" });
    expect(preview.sessionId).toBe(
      create.mock.results[0] && (await create.mock.results[0].value).row.id,
    );
    expect(listUpstreamPorts(app).has(preview.upstreamPort!)).toBe(true);
  });

  it("reuses a live bound session and restarts a dead one under the same slug", async () => {
    const { cwd } = repo();
    writeDock(cwd, [{ id: "dev", title: "Dev", command: "npm run dev" }]);
    const projectId = insertProject(app, cwd);
    const create = fakeCreate(app);

    const first = await getOrCreateBranchPreview(app, projectId, "feat/x");
    fakeLiveness("alive");
    const again = await getOrCreateBranchPreview(app, projectId, "feat/x");
    expect(again).toMatchObject({ slug: first.slug, sessionId: first.sessionId });
    expect(create).toHaveBeenCalledTimes(1);

    // The host cannot tell: treated as alive, no second dev server.
    fakeLiveness("unknown");
    await getOrCreateBranchPreview(app, projectId, "feat/x");
    fakeLiveness(new Error("down"));
    await getOrCreateBranchPreview(app, projectId, "feat/x");
    expect(create).toHaveBeenCalledTimes(1);

    fakeLiveness("dead");
    const restarted = await getOrCreateBranchPreview(app, projectId, "feat/x");
    expect(restarted.slug).toBe(first.slug);
    expect(restarted.sessionId).not.toBe(first.sessionId);
    expect(create).toHaveBeenCalledTimes(2);

    // A killed row is dead regardless of the host.
    app.db
      .update(sessions)
      .set({ status: "killed" })
      .where(eq(sessions.id, restarted.sessionId!))
      .run();
    fakeLiveness("alive");
    await getOrCreateBranchPreview(app, projectId, "feat/x");
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("shares one create between concurrent requests for the same branch", async () => {
    const { cwd } = repo();
    writeDock(cwd, [{ id: "dev", title: "Dev", command: "npm run dev" }]);
    const projectId = insertProject(app, cwd);
    const create = fakeCreate(app);
    const [a, b] = await Promise.all([
      getOrCreateBranchPreview(app, projectId, "feat/x"),
      getOrCreateBranchPreview(app, projectId, "feat/x"),
    ]);
    expect(a.slug).toBe(b.slug);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("keeps the checkout preview and branch previews of one project apart", async () => {
    const { cwd } = repo();
    writeDock(cwd, [{ id: "dev", title: "Dev", command: "npm run dev" }]);
    const projectId = insertProject(app, cwd);
    fakeCreate(app);
    const checkout = getOrCreateProjectPreview(app, projectId);
    const branch = await getOrCreateBranchPreview(app, projectId, "feat/x");
    expect(branch.slug).not.toBe(checkout.slug);
    expect(getOrCreateProjectPreview(app, projectId).slug).toBe(checkout.slug);
    const rows = app.db.select().from(previews).where(eq(previews.projectId, projectId)).all();
    expect(rows.map((r) => r.branch).sort()).toEqual([CHECKOUT_BRANCH, "feat/x"]);
  });

  it("refuses with a code for each case it cannot serve", async () => {
    const expectCode = async (p: Promise<unknown>, code: string, status: number) => {
      const err = await p.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BranchPreviewError);
      expect(err).toMatchObject({ code, statusCode: status });
    };
    await expectCode(getOrCreateBranchPreview(app, 999_999, "x"), "unknown_project", 404);

    const { cwd } = repo();
    writeDock(cwd, [{ id: "dev", title: "Dev", command: "npm run dev" }]);
    await expectCode(
      getOrCreateBranchPreview(app, insertProject(app, cwd, "remote-1"), "feat/x"),
      "remote_unsupported",
      409,
    );

    const projectId = insertProject(app, cwd);
    await expectCode(getOrCreateBranchPreview(app, projectId, "nope"), "unknown_branch", 404);

    const create = vi
      .spyOn(lifecycleModule, "createSessionRecord")
      .mockResolvedValue({ ok: false, reason: "worktree-failed" } as never);
    await expectCode(getOrCreateBranchPreview(app, projectId, "feat/x"), "start_failed", 502);
    expect(create).toHaveBeenCalled();

    const ambiguous = repo().cwd;
    writeDock(ambiguous, [
      { id: "a", title: "A", command: "a" },
      { id: "b", title: "B", command: "b" },
    ]);
    await expectCode(
      getOrCreateBranchPreview(app, insertProject(app, ambiguous), "feat/x"),
      "no_preview_control",
      409,
    );
  });

  describe("a preview worktree left on disk", () => {
    it("is recut when no live session runs in it", async () => {
      const { cwd } = repo();
      writeDock(cwd, [{ id: "dev", title: "Dev", command: "npm run dev" }]);
      const projectId = insertProject(app, cwd);
      const wt = dockPreviewWorktreePath(cwd, "feat/x");
      git(cwd, "worktree", "add", "--quiet", "--detach", wt, "feat/x");
      app.db
        .insert(sessions)
        .values({ projectId, command: "npm run dev", kind: "dock", cwd: wt, status: "active" })
        .run();
      fakeLiveness("dead");
      const create = fakeCreate(app);
      await getOrCreateBranchPreview(app, projectId, "feat/x");
      expect(create).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(wt)).toBe(false);
    });

    it("is refused while a live session runs in it", async () => {
      const { cwd } = repo();
      writeDock(cwd, [{ id: "dev", title: "Dev", command: "npm run dev" }]);
      const projectId = insertProject(app, cwd);
      const wt = dockPreviewWorktreePath(cwd, "feat/x");
      git(cwd, "worktree", "add", "--quiet", "--detach", wt, "feat/x");
      app.db
        .insert(sessions)
        .values({ projectId, command: "npm run dev", kind: "dock", cwd: wt, status: "active" })
        .run();
      fakeLiveness("alive");
      const create = fakeCreate(app);
      await expect(getOrCreateBranchPreview(app, projectId, "feat/x")).rejects.toMatchObject({
        code: "worktree_busy",
      });
      expect(create).not.toHaveBeenCalled();
      expect(fs.existsSync(wt)).toBe(true);
    });

    it("is refused when it cannot be removed", async () => {
      const { cwd } = repo();
      writeDock(cwd, [{ id: "dev", title: "Dev", command: "npm run dev" }]);
      const projectId = insertProject(app, cwd);
      // A plain directory, not a registered worktree: `worktree remove` fails.
      fs.mkdirSync(dockPreviewWorktreePath(cwd, "feat/x"), { recursive: true });
      const create = fakeCreate(app);
      await expect(getOrCreateBranchPreview(app, projectId, "feat/x")).rejects.toMatchObject({
        code: "worktree_busy",
      });
      expect(create).not.toHaveBeenCalled();
    });
  });
});
