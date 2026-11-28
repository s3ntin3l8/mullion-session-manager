// Must come before any import that could load "node-pty"/"node:child_process"
// — see mock-pty.ts's header comment.
import { createNodePtyMock } from "../helpers/mock-pty.js";
import { mockSpawnModule, setupSessionsRouteLifecycle } from "../helpers/sessions-routes.js";
import { describe, expect, it, vi, afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync, spawn as spawnChildProcess } from "node:child_process";
import { eq } from "drizzle-orm";
import { projects, sessions } from "../../src/db/schema.js";
import { gitEnv } from "../../src/services/git-env.js";

// Issue #3588 — a dock session waits for the project's setup recipe before its
// command runs, through the real entry points (POST /api/previews, the Dock
// start route, POST /api/sessions) with the REAL createSessionRecord and a
// real git worktree; only the process spawn and the recipe runner are faked.
const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));
vi.mock("node:child_process", async (importOriginal) => mockSpawnModule(await importOriginal()));

const { buildApp } = await import("../../src/app.js");
const { setDockSetupRunnerForTests, listDockSetups } =
  await import("../../src/services/dock-setup.js");
const { setupLogPath } = await import("../../src/services/setup-recipe.js");

type Runner = NonNullable<Parameters<typeof setDockSetupRunnerForTests>[0]>;

setupSessionsRouteLifecycle("dock-setup-wait");

beforeAll(() => {
  process.env.PREVIEW_BASE_HOST = "preview.example.com";
});

const roots: string[] = [];
afterAll(() => {
  delete process.env.PREVIEW_BASE_HOST;
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});
beforeEach(() => {
  vi.mocked(spawnChildProcess).mockClear();
});
afterEach(() => {
  setDockSetupRunnerForTests();
});

function git(cwd: string, ...args: string[]) {
  execFileSync("git", ["-c", "gc.auto=0", "-C", cwd, ...args], {
    stdio: "ignore",
    env: {
      ...gitEnv(),
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
}

/** A repo with a `feat/x` branch (carrying a lockfile) and a preview control. */
function makeRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dock-setup-wait-"));
  roots.push(root);
  const cwd = path.join(root, "repo");
  fs.mkdirSync(cwd);
  git(cwd, "init", "--quiet", "-b", "main");
  fs.writeFileSync(path.join(cwd, "package-lock.json"), "{}\n");
  fs.mkdirSync(path.join(cwd, ".crs"));
  fs.writeFileSync(
    path.join(cwd, ".crs", "dock.json"),
    JSON.stringify({
      controls: [{ id: "web", title: "Web", command: "vite --port $PORT", preview: true }],
    }),
  );
  git(cwd, "add", ".");
  git(cwd, "commit", "--quiet", "-m", "init");
  git(cwd, "branch", "feat/x");
  return cwd;
}

const masterSpawns = () =>
  vi.mocked(spawnChildProcess).mock.calls.filter(([command]) => command === "systemd-run");

async function addProject(
  app: Awaited<ReturnType<typeof buildApp>>,
  cwd: string,
  setupRecipe: string | null,
) {
  const [project] = app.db
    .insert(projects)
    .values({ name: `p-${Math.random()}`, cwd, hostId: "local", setupRecipe })
    .returning()
    .all();
  return project;
}

/** A runner held until `release(outcome)`, recording its calls. */
function heldRunner() {
  const calls: { cwd: string; logKey: string }[] = [];
  let resolve!: (outcome: "ok" | "failed") => void;
  const outcome = new Promise<"ok" | "failed">((r) => (resolve = r));
  const runner: Runner = async (app, _host, opts) => {
    calls.push(opts);
    const result = await outcome;
    if (result === "failed") {
      const file = setupLogPath(app.config.SESSIONS_DIR, opts.logKey);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "added 3 packages\nnpm ERR! code E404\nnpm ERR! 404 Not Found\n");
      return { outcome: "failed", exitCode: 1, logPath: file };
    }
    return { outcome: "ok", exitCode: 0, logPath: "" };
  };
  return { calls, runner, release: (o: "ok" | "failed") => resolve(o) };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
}

describe("POST /api/previews waits for the setup recipe (#3588)", () => {
  it("starts the dev server only after the recipe succeeded", async () => {
    const app = await buildApp();
    const project = await addProject(app, makeRepo(), "npm ci");
    const held = heldRunner();
    setDockSetupRunnerForTests(held.runner);

    const pending = app.inject({
      method: "POST",
      url: "/api/previews",
      payload: { kind: "project", projectId: project.id, branch: "feat/x" },
    });
    await until(() => held.calls.length === 1);
    // Installing in the fresh dock-preview worktree; nothing spawned yet.
    expect(path.basename(held.calls[0].cwd)).toMatch(/^dock-preview-/);
    expect(fs.existsSync(path.join(held.calls[0].cwd, "package-lock.json"))).toBe(true);
    expect(listDockSetups(project.id)).toEqual([
      expect.objectContaining({ branch: "feat/x", dockControlId: null }),
    ]);
    const installing = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/dock/setups`,
    });
    expect(installing.json()).toEqual([expect.objectContaining({ branch: "feat/x" })]);
    expect(masterSpawns()).toHaveLength(0);
    expect(app.db.select().from(sessions).all()).toHaveLength(0);

    held.release("ok");
    const res = await pending;
    expect(res.statusCode, res.body).toBe(201);
    expect(masterSpawns()).toHaveLength(1);
    expect(listDockSetups(project.id)).toEqual([]);
    await app.close();
  });

  it("fails the start with the log's tail, runs nothing and removes the worktree", async () => {
    const app = await buildApp();
    const project = await addProject(app, makeRepo(), "npm ci");
    const held = heldRunner();
    setDockSetupRunnerForTests(held.runner);

    const pending = app.inject({
      method: "POST",
      url: "/api/previews",
      payload: { kind: "project", projectId: project.id, branch: "feat/x" },
    });
    await until(() => held.calls.length === 1);
    held.release("failed");
    const res = await pending;

    expect(res.statusCode, res.body).toBe(424);
    const body = res.json() as { code: string; message: string };
    expect(body.code).toBe("setup_failed");
    expect(body.message).toContain("Installing dependencies failed (exit code 1)");
    expect(body.message).toContain("npm ERR! 404 Not Found");
    expect(masterSpawns()).toHaveLength(0);
    expect(app.db.select().from(sessions).all()).toHaveLength(0);
    expect(fs.existsSync(held.calls[0].cwd)).toBe(false);
    await app.close();
  });

  it("with no recipe starts at once and marks the session for the hint", async () => {
    const app = await buildApp();
    const project = await addProject(app, makeRepo(), null);
    const held = heldRunner();
    setDockSetupRunnerForTests(held.runner);

    const res = await app.inject({
      method: "POST",
      url: "/api/previews",
      payload: { kind: "project", projectId: project.id, branch: "feat/x" },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(held.calls).toHaveLength(0);
    const { sessionId } = res.json() as { sessionId: number };
    const row = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    expect(row?.setupHint).toBe("no-recipe");
    await app.close();
  });
});

describe("the Dock start route waits for the setup recipe (#3588)", () => {
  it("starts the control on a branch only after the recipe, and reports a failure", async () => {
    const app = await buildApp();
    const project = await addProject(app, makeRepo(), "npm ci");

    const ok = heldRunner();
    setDockSetupRunnerForTests(ok.runner);
    const pending = app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/dock/controls/web/start`,
      payload: { branch: "feat/x" },
    });
    await until(() => ok.calls.length === 1);
    expect(listDockSetups(project.id)).toEqual([
      expect.objectContaining({ dockControlId: "web", branch: "feat/x" }),
    ]);
    expect(masterSpawns()).toHaveLength(0);
    ok.release("ok");
    const started = await pending;
    expect(started.statusCode, started.body).toBe(201);
    expect(masterSpawns()).toHaveLength(1);
    const { sessionId } = started.json() as { sessionId: number };

    // Stop it, then a start whose recipe fails says why.
    const stopped = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/dock/controls/web/stop`,
    });
    expect(stopped.statusCode, stopped.body).toBe(200);
    expect(stopped.json()).toEqual({ sessionId });

    const failing = heldRunner();
    setDockSetupRunnerForTests(failing.runner);
    vi.mocked(spawnChildProcess).mockClear();
    const second = app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/dock/controls/web/start`,
      payload: { branch: "feat/x" },
    });
    await until(() => failing.calls.length === 1);
    failing.release("failed");
    const res = await second;
    expect(res.statusCode, res.body).toBe(424);
    const body = res.json() as { code: string; message: string };
    expect(body.code).toBe("setup_failed");
    expect(body.message).toContain("npm ERR! code E404");
    expect(masterSpawns()).toHaveLength(0);
    await app.close();
  });

  it("does not run the recipe for a start in the project's own checkout", async () => {
    const app = await buildApp();
    const project = await addProject(app, makeRepo(), "npm ci");
    const held = heldRunner();
    setDockSetupRunnerForTests(held.runner);
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/dock/controls/web/start`,
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(held.calls).toHaveLength(0);
    expect(masterSpawns()).toHaveLength(1);
    await app.close();
  });
});
