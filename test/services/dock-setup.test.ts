import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { eq } from "drizzle-orm";
import { projects, setupStamps } from "../../src/db/schema.js";

// Issue #3588 — prepareDockCheckout's rules, with the recipe runner faked: a
// fresh worktree always installs; another host's checkout installs only when
// its lockfiles changed since the last successful run there; the project's own
// checkout never does; a failure carries the log's tail; `busy` is waited out.
const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const {
  prepareDockCheckout,
  setDockSetupRunnerForTests,
  listDockSetups,
  logTail,
  dockSetupLogKey,
  lockfileFingerprint,
  controlInstalling,
  DOCK_CONTROL_INSTALLING,
  prepareDockLaunch,
} = await import("../../src/services/dock-setup.js");
const { setupLogPath } = await import("../../src/services/setup-recipe.js");
const { LOCAL_HOST_ID } = await import("../../src/services/host-registry.js");

type Runner = Parameters<typeof setDockSetupRunnerForTests>[0];
type RunOpts = { cwd: string; recipe: string; logKey: string };

const tmpDb = path.join(os.tmpdir(), `dock-setup-${process.pid}.db`);
let dir: string;

describe("prepareDockCheckout (#3588)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });
  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });
  afterEach(() => {
    setDockSetupRunnerForTests();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  async function setup(recipe: string | null, projectHost = LOCAL_HOST_ID) {
    const app = await buildApp();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dock-setup-"));
    const [project] = app.db
      .insert(projects)
      .values({ name: `p-${Math.random()}`, cwd: dir, hostId: projectHost, setupRecipe: recipe })
      .returning()
      .all();
    const calls: RunOpts[] = [];
    const ok: Runner = async (_app, _host, opts) => {
      calls.push(opts);
      return { outcome: "ok", exitCode: 0, logPath: "" };
    };
    return { app, project, calls, ok };
  }

  it("always runs in a fresh worktree, and reports the run while it is in flight", async () => {
    const { app, project, calls } = await setup("npm ci");
    let release!: () => void;
    setDockSetupRunnerForTests(async (_app, _host, opts) => {
      calls.push(opts);
      await new Promise<void>((r) => (release = r));
      return { outcome: "ok", exitCode: 0, logPath: "" };
    });
    const pending = prepareDockCheckout(app, project, {
      hostId: LOCAL_HOST_ID,
      cwd: dir,
      freshWorktree: true,
      dockControlId: "web",
      branch: "feat/x",
    });
    for (let i = 0; i < 50 && calls.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(listDockSetups(project.id)).toEqual([
      expect.objectContaining({ dockControlId: "web", branch: "feat/x", hostId: LOCAL_HOST_ID }),
    ]);
    release();
    expect(await pending).toEqual({ ok: true, hint: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ cwd: dir, recipe: "npm ci" });
    expect(calls[0].logKey).toBe(dockSetupLogKey(project.id, 0));
    expect(listDockSetups(project.id)).toEqual([]);
    await app.close();
  });

  it("never runs in the project's own checkout on its own host", async () => {
    const { app, project, calls, ok } = await setup("npm ci");
    setDockSetupRunnerForTests(ok);
    expect(
      await prepareDockCheckout(app, project, {
        hostId: LOCAL_HOST_ID,
        cwd: dir,
        freshWorktree: false,
      }),
    ).toEqual({ ok: true, hint: null });
    expect(calls).toHaveLength(0);
    await app.close();
  });

  it("re-runs on another host's checkout only when its lockfiles changed", async () => {
    // The project lives on "mac"; the start runs on this host's checkout.
    const { app, project, calls, ok } = await setup("npm ci", "mac");
    setDockSetupRunnerForTests(ok);
    fs.writeFileSync(path.join(dir, "package-lock.json"), '{"v":1}');
    const target = { hostId: LOCAL_HOST_ID, cwd: dir, freshWorktree: false };

    await prepareDockCheckout(app, project, target);
    expect(calls).toHaveLength(1);
    expect(
      app.db.select().from(setupStamps).where(eq(setupStamps.projectId, project.id)).all(),
    ).toHaveLength(1);

    // Unchanged: no second install.
    await prepareDockCheckout(app, project, target);
    expect(calls).toHaveLength(1);

    // Changed lockfile: installs again.
    fs.writeFileSync(path.join(dir, "package-lock.json"), '{"v":2}');
    await prepareDockCheckout(app, project, target);
    expect(calls).toHaveLength(2);
    expect(
      app.db.select().from(setupStamps).where(eq(setupStamps.projectId, project.id)).all(),
    ).toHaveLength(1);
    await app.close();
  });

  it("re-runs on another host's checkout when the recipe changed", async () => {
    const { app, project, calls, ok } = await setup("npm ci", "mac");
    setDockSetupRunnerForTests(ok);
    const target = { hostId: LOCAL_HOST_ID, cwd: dir, freshWorktree: false };
    await prepareDockCheckout(app, project, target);
    await prepareDockCheckout(app, { ...project, setupRecipe: "npm ci && make deps" }, target);
    expect(calls.map((c) => c.recipe)).toEqual(["npm ci", "npm ci && make deps"]);
    await app.close();
  });

  it("takes a busy directory's finished run as done when it stamped the checkout", async () => {
    const { app, project, calls } = await setup("npm ci", "mac");
    const target = { hostId: LOCAL_HOST_ID, cwd: dir, freshWorktree: false };
    // A first start installs (and stamps) while the second one is told "busy".
    let release!: () => void;
    setDockSetupRunnerForTests(async (_app, _host, opts) => {
      calls.push(opts);
      if (calls.length === 1) {
        await new Promise<void>((r) => (release = r));
        return { outcome: "ok", exitCode: 0, logPath: "" };
      }
      release();
      return { outcome: "busy", exitCode: null, logPath: "" };
    }, 5);
    const first = prepareDockCheckout(app, project, target);
    for (let i = 0; i < 50 && calls.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    const second = prepareDockCheckout(app, project, target);
    expect(await first).toEqual({ ok: true, hint: null });
    expect(await second).toEqual({ ok: true, hint: null });
    // The second start never ran the recipe itself after the wait.
    expect(calls).toHaveLength(2);
    await app.close();
  });

  it("refuses a second start of a control that is still installing", async () => {
    const { app, project, calls } = await setup("npm ci");
    let release!: () => void;
    setDockSetupRunnerForTests(async (_app, _host, opts) => {
      calls.push(opts);
      await new Promise<void>((r) => (release = r));
      return { outcome: "ok", exitCode: 0, logPath: "" };
    });
    const target = { hostId: LOCAL_HOST_ID, cwd: dir, freshWorktree: true, dockControlId: "web" };
    const first = prepareDockCheckout(app, project, target);
    for (let i = 0; i < 50 && calls.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(controlInstalling(project.id, "web")).toBe(true);
    expect(await prepareDockCheckout(app, project, target)).toEqual({
      ok: false,
      detail: DOCK_CONTROL_INSTALLING,
    });
    release();
    await first;
    expect(controlInstalling(project.id, "web")).toBe(false);
    await app.close();
  });

  it("prepareDockLaunch leaves anything but a dev server's dock session alone", async () => {
    const { app, project, calls, ok } = await setup("npm ci");
    setDockSetupRunnerForTests(ok);
    const target = { hostId: LOCAL_HOST_ID, cwd: dir, freshWorktree: true };
    expect(await prepareDockLaunch(app, project, { kind: "terminal" }, target)).toEqual({
      ok: true,
      hint: null,
      waited: false,
    });
    // A docker logs/stack session is `kind: "dock"` with no control or port.
    expect(await prepareDockLaunch(app, project, { kind: "dock" }, target)).toMatchObject({
      waited: false,
    });
    expect(calls).toHaveLength(0);
    expect(
      await prepareDockLaunch(app, project, { kind: "dock", previewPort: 4100 }, target),
    ).toEqual({ ok: true, hint: null, waited: true });
    expect(calls).toHaveLength(1);
    await app.close();
  });

  it("does not stamp a failed run, so the next start tries again", async () => {
    const { app, project, calls } = await setup("npm ci", "mac");
    setDockSetupRunnerForTests(async (_app, _host, opts) => {
      calls.push(opts);
      return { outcome: "failed", exitCode: 1, logPath: "" };
    });
    const target = { hostId: LOCAL_HOST_ID, cwd: dir, freshWorktree: false };
    expect((await prepareDockCheckout(app, project, target)).ok).toBe(false);
    expect((await prepareDockCheckout(app, project, target)).ok).toBe(false);
    expect(calls).toHaveLength(2);
    expect(
      app.db.select().from(setupStamps).where(eq(setupStamps.projectId, project.id)).all(),
    ).toHaveLength(0);
    await app.close();
  });

  it("fails with the outcome and the log's tail", async () => {
    const { app, project } = await setup("npm ci");
    setDockSetupRunnerForTests(async (a, _host, opts) => {
      const file = setupLogPath(a.config.SESSIONS_DIR, opts.logKey);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
      fs.writeFileSync(file, `${lines.join("\n")}\n\x1b[31mnpm ERR! missing\x1b[0m\n\n`);
      return { outcome: "failed", exitCode: 1, logPath: file };
    });
    const out = await prepareDockCheckout(app, project, {
      hostId: LOCAL_HOST_ID,
      cwd: dir,
      freshWorktree: true,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.detail).toContain("Installing dependencies failed (exit code 1)");
    expect(out.detail).toContain("the command was not run");
    expect(out.detail).toContain("npm ERR! missing");
    expect(out.detail).not.toContain("\x1b[");
    expect(out.detail).not.toContain("line 0\n");
    await app.close();
  });

  it("reports a timeout as such", async () => {
    const { app, project } = await setup("npm ci");
    setDockSetupRunnerForTests(async () => ({
      outcome: "timeout",
      exitCode: null,
      logPath: "",
      detail: "timed out after 900s",
    }));
    const out = await prepareDockCheckout(app, project, {
      hostId: LOCAL_HOST_ID,
      cwd: dir,
      freshWorktree: true,
    });
    expect(out).toEqual({
      ok: false,
      detail: expect.stringContaining("Installing dependencies timed out (timed out after 900s)"),
    });
    await app.close();
  });

  it("waits out a run already in flight in the same directory (busy)", async () => {
    const { app, project } = await setup("npm ci");
    const outcomes = ["busy", "busy", "ok"] as const;
    let i = 0;
    setDockSetupRunnerForTests(
      async () => ({ outcome: outcomes[i++], exitCode: null, logPath: "" }),
      1,
    );
    const out = await prepareDockCheckout(app, project, {
      hostId: LOCAL_HOST_ID,
      cwd: dir,
      freshWorktree: true,
    });
    expect(out).toEqual({ ok: true, hint: null });
    expect(i).toBe(3);
    await app.close();
  });

  it("turns a runner that throws into a failure", async () => {
    const { app, project } = await setup("npm ci");
    setDockSetupRunnerForTests(async () => {
      throw new Error("boom");
    });
    const out = await prepareDockCheckout(app, project, {
      hostId: LOCAL_HOST_ID,
      cwd: dir,
      freshWorktree: true,
    });
    expect(out).toEqual({ ok: false, detail: expect.stringContaining("failed: boom") });
    await app.close();
  });

  it("with no recipe runs nothing, and hints when the tree has a lockfile", async () => {
    const { app, project, calls, ok } = await setup(null);
    setDockSetupRunnerForTests(ok);
    const target = { hostId: LOCAL_HOST_ID, cwd: dir, freshWorktree: true };
    expect(await prepareDockCheckout(app, project, target)).toEqual({ ok: true, hint: null });
    fs.writeFileSync(path.join(dir, "uv.lock"), "x");
    expect(await prepareDockCheckout(app, project, target)).toEqual({
      ok: true,
      hint: "no-recipe",
    });
    expect(calls).toHaveLength(0);
    await app.close();
  });

  it("fingerprints the lockfiles present, by name and content", async () => {
    const { app } = await setup(null);
    const empty = await lockfileFingerprint(app, LOCAL_HOST_ID, dir);
    fs.writeFileSync(path.join(dir, "yarn.lock"), "a");
    const one = await lockfileFingerprint(app, LOCAL_HOST_ID, dir);
    expect(one).toMatchObject({ ok: true, lockfiles: ["yarn.lock"] });
    expect(empty).toMatchObject({ ok: true, lockfiles: [] });
    if (!one.ok || !empty.ok) return;
    expect(one.hash).not.toBe(empty.hash);
    await app.close();
  });

  it("logTail keeps the last non-blank lines without escapes", () => {
    expect(logTail("a\nb\n\x1b[1mc\x1b[0m\n\n", 2)).toBe("b\nc");
  });
});
