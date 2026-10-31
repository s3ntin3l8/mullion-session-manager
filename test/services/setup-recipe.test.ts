import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { eq } from "drizzle-orm";
import { sessions, projects } from "../../src/db/schema.js";

// Issue #2245 — the setup-recipe runner and its primary-side trigger. Runs real
// `sh` against a temp dir; nothing here spawns a session scope.
const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const remoteClientModule = await import("../../src/services/remote-host-client.js");
const {
  execSetupRecipe,
  startSetupRecipe,
  startSetupAfterClone,
  readLocalSetupLog,
  readSessionSetupLog,
  runSetupOnHost,
  setupRunsInFlightForTests,
  setSetupTimeoutForTests,
  SETUP_LOG_TAIL_BYTES,
} = await import("../../src/services/setup-recipe.js");

const tmpDb = path.join(os.tmpdir(), `setup-recipe-${process.pid}.db`);
let dir: string;
let logs: string;

beforeAll(() => {
  fs.rmSync(tmpDb, { force: true });
  process.env.DATABASE_URL = `file:${tmpDb}`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "setup-recipe-cwd-"));
  logs = fs.mkdtempSync(path.join(os.tmpdir(), "setup-recipe-logs-"));
});
afterAll(() => {
  closeDb();
  fs.rmSync(tmpDb, { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(logs, { recursive: true, force: true });
  delete process.env.DATABASE_URL;
});
afterEach(() => {
  setSetupTimeoutForTests();
  vi.restoreAllMocks();
});

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 25));
  expect(check()).toBe(true);
}

describe("execSetupRecipe", () => {
  it("refuses a cwd that is relative or not an existing directory", async () => {
    for (const cwd of ["relative/dir", `${dir}/does-not-exist`]) {
      const res = await execSetupRecipe({
        cwd,
        recipe: "echo hi",
        logKey: "901",
        sessionsDir: logs,
      });
      expect(res).toMatchObject({ outcome: "failed", exitCode: null });
    }
  });

  it("refuses a log key that is not a filename stem", async () => {
    const res = await execSetupRecipe({
      cwd: dir,
      recipe: "echo hi",
      logKey: "../escape",
      sessionsDir: logs,
    });
    expect(res).toMatchObject({ outcome: "failed", logPath: "" });
    expect(readLocalSetupLog(logs, "../escape")).toBeNull();
  });

  it("runs the recipe in cwd and captures stdout and stderr to the log", async () => {
    const res = await execSetupRecipe({
      cwd: dir,
      recipe: "pwd; echo out; echo err >&2",
      logKey: "902",
      sessionsDir: logs,
    });
    expect(res).toMatchObject({
      outcome: "ok",
      exitCode: 0,
      logPath: path.join(logs, "902.setup.log"),
    });
    const text = fs.readFileSync(res.logPath, "utf8");
    expect(text).toContain(fs.realpathSync(dir));
    expect(text).toContain("out");
    expect(text).toContain("err");
    expect(setupRunsInFlightForTests()).toBe(0);
  });

  it("does not leak the server's NODE_ENV into the recipe", async () => {
    // vitest runs with NODE_ENV=test; a recipe must not inherit it (a production
    // server's value would make `npm ci` skip devDependencies).
    expect(process.env.NODE_ENV).toBeTruthy();
    const res = await execSetupRecipe({
      cwd: dir,
      recipe: 'echo "node_env=[${NODE_ENV-unset}]"',
      logKey: "903",
      sessionsDir: logs,
    });
    expect(fs.readFileSync(res.logPath, "utf8")).toContain("node_env=[unset]");
  });

  it("does not hand Mullion's own tokens to the recipe", async () => {
    process.env.MULLION_AUTH_TOKEN = "super-secret";
    try {
      const res = await execSetupRecipe({
        cwd: dir,
        recipe: 'echo "[$MULLION_AUTH_TOKEN]"',
        logKey: "904",
        sessionsDir: logs,
      });
      expect(fs.readFileSync(res.logPath, "utf8")).toContain("[]");
    } finally {
      delete process.env.MULLION_AUTH_TOKEN;
    }
  });

  it("reports a non-zero exit as failed with the exit code", async () => {
    const res = await execSetupRecipe({
      cwd: dir,
      recipe: "echo boom; exit 3",
      logKey: "905",
      sessionsDir: logs,
    });
    expect(res).toMatchObject({ outcome: "failed", exitCode: 3 });
    expect(fs.readFileSync(res.logPath, "utf8")).toContain("boom");
  });

  it("kills the whole process group on timeout", async () => {
    setSetupTimeoutForTests(150);
    const res = await execSetupRecipe({
      cwd: dir,
      recipe: "sleep 30 & wait",
      logKey: "906",
      sessionsDir: logs,
    });
    expect(res.outcome).toBe("timeout");
    expect(setupRunsInFlightForTests()).toBe(0);
  });

  it("does not start a second run in the same directory", async () => {
    const first = execSetupRecipe({
      cwd: dir,
      recipe: "sleep 0.3",
      logKey: "907",
      sessionsDir: logs,
    });
    const second = await execSetupRecipe({
      cwd: dir,
      recipe: "echo never",
      logKey: "908",
      sessionsDir: logs,
    });
    expect(second.outcome).toBe("busy");
    expect(fs.existsSync(path.join(logs, "908.setup.log"))).toBe(false);
    expect((await first).outcome).toBe("ok");
  });

  it("reports a missing cwd as failed instead of throwing", async () => {
    const res = await execSetupRecipe({
      cwd: path.join(dir, "missing"),
      recipe: "true",
      logKey: "909",
      sessionsDir: logs,
    });
    expect(res.outcome).toBe("failed");
  });

  it("reports an unwritable log location as failed", async () => {
    const blocker = path.join(logs, "file");
    fs.writeFileSync(blocker, "x");
    const res = await execSetupRecipe({
      cwd: dir,
      recipe: "true",
      logKey: "910",
      sessionsDir: path.join(blocker, "sub"),
    });
    expect(res.outcome).toBe("failed");
    expect(res.detail).toMatch(/setup log/);
  });
});

describe("readLocalSetupLog", () => {
  it("returns null when there is no log, the whole log when small, the tail when large", () => {
    expect(readLocalSetupLog(logs, "911")).toBeNull();
    fs.writeFileSync(path.join(logs, "912.setup.log"), "hi");
    expect(readLocalSetupLog(logs, "912")).toEqual({ content: "hi", truncated: false });
    fs.writeFileSync(path.join(logs, "913.setup.log"), "a".repeat(SETUP_LOG_TAIL_BYTES) + "TAIL");
    const big = readLocalSetupLog(logs, "913");
    expect(big?.truncated).toBe(true);
    expect(big?.content.endsWith("TAIL")).toBe(true);
    expect(big?.content.length).toBe(SETUP_LOG_TAIL_BYTES);
  });
});

describe("startSetupRecipe / startSetupAfterClone", () => {
  async function setup(recipe: string | null) {
    const app = await buildApp();
    app.config.SESSIONS_DIR = logs;
    const [project] = app.db
      .insert(projects)
      .values({ name: `p-${Math.random()}`, cwd: dir, setupRecipe: recipe })
      .returning()
      .all();
    const [session] = app.db
      .insert(sessions)
      .values({ projectId: project.id, command: "bash", cwd: dir })
      .returning()
      .all();
    const status = () =>
      app.db.select().from(sessions).where(eq(sessions.id, session.id)).all()[0]?.setupStatus ??
      null;
    return { app, project, session, status };
  }

  it("with no recipe nothing runs and the status stays null", async () => {
    const { app, project, session, status } = await setup(null);
    startSetupRecipe(app, project, { id: session.id, hostId: "local", cwd: dir });
    startSetupRecipe(
      app,
      { ...project, setupRecipe: "   " },
      { id: session.id, hostId: "local", cwd: dir },
    );
    expect(status()).toBeNull();
    expect(setupRunsInFlightForTests()).toBe(0);
    expect(fs.existsSync(path.join(logs, `${session.id}.setup.log`))).toBe(false);
    await app.close();
  });

  it("flags the session running, then ok, and keeps the log path", async () => {
    const { app, project, session, status } = await setup("echo installed");
    startSetupRecipe(app, project, { id: session.id, hostId: "local", cwd: dir });
    expect(status()).toBe("running");
    await until(() => status() === "ok");
    const row = app.db.select().from(sessions).where(eq(sessions.id, session.id)).all()[0];
    expect(row.setupLogPath).toBe(path.join(logs, `${session.id}.setup.log`));
    expect((await readSessionSetupLog(app, "local", session.id))?.content).toContain("installed");
    await app.close();
  });

  it("flags a failing recipe failed without touching the session", async () => {
    const { app, project, session, status } = await setup("exit 1");
    startSetupRecipe(app, project, { id: session.id, hostId: "local", cwd: dir });
    await until(() => status() === "failed");
    const row = app.db.select().from(sessions).where(eq(sessions.id, session.id)).all()[0];
    expect(row.status).not.toBe("killed");
    await app.close();
  });

  it("clears the flag when another run already owns the directory", async () => {
    const { app, project, session, status } = await setup("echo hi");
    const blocker = execSetupRecipe({
      cwd: dir,
      recipe: "sleep 0.3",
      logKey: "914",
      sessionsDir: logs,
    });
    startSetupRecipe(app, project, { id: session.id, hostId: "local", cwd: dir });
    await until(() => status() === null && setupRunsInFlightForTests() === 1);
    await blocker;
    expect(status()).toBeNull();
    await app.close();
  });

  it("dispatches a remote host's run through the client and records its outcome", async () => {
    const { app, project, session, status } = await setup("npm ci");
    const resolveRunSetup = vi
      .fn()
      .mockResolvedValue({ outcome: "timeout", exitCode: null, logPath: "/remote/1.setup.log" });
    const resolveSetupLog = vi.fn().mockResolvedValue({ content: "remote log", truncated: false });
    vi.spyOn(remoteClientModule, "getRemoteHostClient").mockReturnValue({
      resolveRunSetup,
      resolveSetupLog,
    } as unknown as ReturnType<typeof remoteClientModule.getRemoteHostClient>);
    startSetupRecipe(app, project, { id: session.id, hostId: "h1", cwd: "/remote/wt" });
    await until(() => status() === "timeout");
    expect(resolveRunSetup).toHaveBeenCalledWith("/remote/wt", "npm ci", String(session.id));
    const row = app.db.select().from(sessions).where(eq(sessions.id, session.id)).all()[0];
    expect(row.setupLogPath).toBe("/remote/1.setup.log");
    expect(await readSessionSetupLog(app, "h1", session.id)).toEqual({
      content: "remote log",
      truncated: false,
    });
    await app.close();
  });

  it("maps an old or unreachable remote host to a failed outcome", async () => {
    const { app } = await setup(null);
    const spy = vi.spyOn(remoteClientModule, "getRemoteHostClient");
    spy.mockReturnValue({
      resolveRunSetup: vi
        .fn()
        .mockRejectedValue(new remoteClientModule.HostRequestError("h1", 404, "nf")),
    } as unknown as ReturnType<typeof remoteClientModule.getRemoteHostClient>);
    const old = await runSetupOnHost(app, "h1", { cwd: "/x", recipe: "true", logKey: "1" });
    expect(old).toMatchObject({ outcome: "failed" });
    expect(old.detail).toMatch(/too old/);
    spy.mockReturnValue({
      resolveRunSetup: vi.fn().mockRejectedValue(new Error("down")),
      resolveSetupLog: vi.fn().mockRejectedValue(new Error("down")),
    } as unknown as ReturnType<typeof remoteClientModule.getRemoteHostClient>);
    const down = await runSetupOnHost(app, "h1", { cwd: "/x", recipe: "true", logKey: "1" });
    expect(down).toMatchObject({ outcome: "failed", detail: "down" });
    expect(await readSessionSetupLog(app, "h1", 1)).toBeNull();
    await app.close();
  });

  it("runs after a clone with a checkout-scoped log, and not at all without a recipe", async () => {
    const { app, project } = await setup("echo cloned");
    startSetupAfterClone(app, { ...project, setupRecipe: null }, "local", dir);
    startSetupAfterClone(app, project, "local", dir);
    await until(() => fs.existsSync(path.join(logs, `checkout-${project.id}.setup.log`)));
    await until(() => setupRunsInFlightForTests() === 0);
    expect(fs.readFileSync(path.join(logs, `checkout-${project.id}.setup.log`), "utf8")).toContain(
      "cloned",
    );
    await app.close();
  });
});
