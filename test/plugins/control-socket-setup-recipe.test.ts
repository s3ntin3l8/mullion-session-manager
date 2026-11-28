import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { buildTestApp } from "../helpers/app.js";
import { makeConnectionState } from "../helpers/control-socket.js";
import { dispatch } from "../../src/plugins/control-socket.js";
import { projects, sessions } from "../../src/db/schema.js";
import { SETUP_RECIPE_MAX_LENGTH } from "../../src/services/setup-recipe-shared.js";
import type * as SetupRecipeModule from "../../src/services/setup-recipe.js";
import type * as TaskEventsModule from "../../src/services/task-events.js";

// #3592 — a session reads/sets its OWN project's setup recipe through
// projects.get_setup_recipe / projects.set_setup_recipe, optionally running it
// once (`run: true`) through the runner a fresh worktree uses.

const fakes = vi.hoisted(() => ({
  runSetupOnHost: vi.fn(),
  readSessionSetupLog: vi.fn(),
  broadcastTaskEvent: vi.fn(),
}));

vi.mock("../../src/services/setup-recipe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof SetupRecipeModule>()),
  runSetupOnHost: fakes.runSetupOnHost,
  readSessionSetupLog: fakes.readSessionSetupLog,
}));
vi.mock("../../src/services/task-events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof TaskEventsModule>()),
  broadcastTaskEvent: fakes.broadcastTaskEvent,
}));

describe("projects.get_setup_recipe / set_setup_recipe (#3592)", () => {
  let cwdA: string;
  let cwdB: string;

  beforeEach(() => {
    cwdA = fs.mkdtempSync(path.join(os.tmpdir(), "srec-a-"));
    cwdB = fs.mkdtempSync(path.join(os.tmpdir(), "srec-b-"));
    fakes.runSetupOnHost.mockReset();
    fakes.readSessionSetupLog.mockReset();
    fakes.broadcastTaskEvent.mockReset();
  });
  afterEach(() => {
    fs.rmSync(cwdA, { recursive: true, force: true });
    fs.rmSync(cwdB, { recursive: true, force: true });
  });

  async function setup() {
    const app = await buildTestApp();
    await app.ready();
    const mk = (name: string, cwd: string) =>
      Number(app.db.insert(projects).values({ name, cwd }).run().lastInsertRowid);
    const projectA = mk("a", cwdA);
    const projectB = mk("b", cwdB);
    app.db.update(projects).set({ setupRecipe: "make b" }).where(eq(projects.id, projectB)).run();
    const agent = String(
      Number(
        app.db.insert(sessions).values({ projectId: projectA, command: "claude", cwd: cwdA }).run()
          .lastInsertRowid,
      ),
    );
    const recipeOf = (id: number) =>
      app.db.select().from(projects).where(eq(projects.id, id)).get()!.setupRecipe;
    return { app, projectA, projectB, agent, recipeOf, ...makeConnectionState("session", agent) };
  }

  it("reads and sets the caller's own project's recipe, trimmed, and rings the project doorbell", async () => {
    const { app, conn, frames, projectA, recipeOf } = await setup();
    await dispatch(app, conn, { id: 1, op: "projects.get_setup_recipe", body: {} });
    await dispatch(app, conn, {
      id: 2,
      op: "projects.set_setup_recipe",
      body: { recipe: "  npm ci  " },
    });
    await dispatch(app, conn, { id: 3, op: "projects.get_setup_recipe", body: {} });
    expect(frames.map((f) => f.result)).toEqual([
      { projectId: projectA, setupRecipe: null },
      { projectId: projectA, setupRecipe: "npm ci" },
      { projectId: projectA, setupRecipe: "npm ci" },
    ]);
    expect(recipeOf(projectA)).toBe("npm ci");
    expect(fakes.broadcastTaskEvent).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 0, projectId: projectA, kind: "project" }),
    );
    expect(fakes.runSetupOnHost).not.toHaveBeenCalled();
  });

  it("null or a blank recipe clears it", async () => {
    const { app, conn, frames, projectA, recipeOf } = await setup();
    const set = (id: number, recipe: unknown) =>
      dispatch(app, conn, { id, op: "projects.set_setup_recipe", body: { recipe } });
    await set(1, "npm ci");
    await set(2, null);
    expect(recipeOf(projectA)).toBeNull();
    await set(3, "npm ci");
    await set(4, "   ");
    expect(recipeOf(projectA)).toBeNull();
    expect(frames.map((f) => f.status)).toEqual([200, 200, 200, 200]);
  });

  it("refuses a too-long, missing or non-string recipe and saves nothing", async () => {
    const { app, conn, frames, projectA, recipeOf } = await setup();
    const set = (id: number, body: Record<string, unknown>) =>
      dispatch(app, conn, { id, op: "projects.set_setup_recipe", body });
    await set(1, { recipe: "x".repeat(SETUP_RECIPE_MAX_LENGTH + 1) });
    await set(2, {});
    await set(3, { recipe: 42 });
    await set(4, { recipe: "npm ci", run: "yes" });
    expect(frames.map((f) => f.status)).toEqual([400, 400, 400, 400]);
    expect(recipeOf(projectA)).toBeNull();
    expect(fakes.broadcastTaskEvent).not.toHaveBeenCalled();
  });

  it("only the recipe reaches the project: other body fields are ignored", async () => {
    const { app, conn, frames, projectA } = await setup();
    await dispatch(app, conn, {
      id: 1,
      op: "projects.set_setup_recipe",
      body: { recipe: "npm ci", name: "hijacked", cwd: "/" },
    });
    expect(frames[0]).toMatchObject({ ok: true });
    const row = app.db.select().from(projects).where(eq(projects.id, projectA)).get()!;
    expect([row.name, row.cwd]).toEqual(["a", cwdA]);
  });

  it("refuses another project at session scope", async () => {
    const { app, conn, frames, projectB, recipeOf } = await setup();
    for (const op of ["projects.get_setup_recipe", "projects.set_setup_recipe"]) {
      await dispatch(app, conn, {
        id: 1,
        op,
        body: { projectId: String(projectB), recipe: null },
      });
    }
    expect(frames.map((f) => f.status)).toEqual([403, 403]);
    expect(recipeOf(projectB)).toBe("make b");
  });

  it("full scope must name the project", async () => {
    const { app, projectB, recipeOf } = await setup();
    const { conn, frames } = makeConnectionState("full", null);
    await dispatch(app, conn, { id: 1, op: "projects.get_setup_recipe", body: {} });
    await dispatch(app, conn, {
      id: 2,
      op: "projects.get_setup_recipe",
      body: { projectId: projectB },
    });
    await dispatch(app, conn, {
      id: 3,
      op: "projects.set_setup_recipe",
      body: { projectId: String(projectB), recipe: "make c" },
    });
    expect(frames.map((f) => f.status)).toEqual([400, 200, 200]);
    expect(frames[1].result).toEqual({ projectId: projectB, setupRecipe: "make b" });
    expect(recipeOf(projectB)).toBe("make c");
  });

  it("run: true saves, then runs the recipe once in the session's directory and returns the log tail", async () => {
    const { app, conn, frames, projectA, agent, recipeOf } = await setup();
    fakes.runSetupOnHost.mockResolvedValue({
      outcome: "failed",
      exitCode: 1,
      logPath: "/x.setup.log",
      detail: "exited with code 1",
    });
    fakes.readSessionSetupLog.mockResolvedValue({
      content: "a".repeat(5000) + "npm ERR! missing script",
      truncated: false,
    });
    await dispatch(app, conn, {
      id: 1,
      op: "projects.set_setup_recipe",
      body: { recipe: " npm ci ", run: true, sessionId: "999" },
    });
    expect(frames[0]).toMatchObject({ ok: true, status: 200 });
    const result = frames[0].result as { setupRecipe: string; run: Record<string, unknown> };
    expect(result.setupRecipe).toBe("npm ci");
    expect(result.run).toMatchObject({
      outcome: "failed",
      exitCode: 1,
      detail: "exited with code 1",
      hostId: "local",
      logTruncated: true,
    });
    expect((result.run.logTail as string).endsWith("npm ERR! missing script")).toBe(true);
    expect((result.run.logTail as string).length).toBe(4000);
    // The caller's own session (never the body's), with the trimmed, saved recipe.
    expect(fakes.runSetupOnHost).toHaveBeenCalledWith(app, "local", {
      cwd: cwdA,
      recipe: "npm ci",
      logKey: agent,
    });
    expect(fakes.readSessionSetupLog).toHaveBeenCalledWith(app, "local", Number(agent));
    expect(recipeOf(projectA)).toBe("npm ci");
  });

  it("run: true reports a busy run without reading someone else's log, and restores the badge", async () => {
    const { app, conn, frames, agent } = await setup();
    const status = () =>
      app.db
        .select()
        .from(sessions)
        .where(eq(sessions.id, Number(agent)))
        .get()!.setupStatus;
    app.db
      .update(sessions)
      .set({ setupStatus: "ok" })
      .where(eq(sessions.id, Number(agent)))
      .run();
    const during: (string | null)[] = [];
    fakes.runSetupOnHost.mockImplementation(async () => {
      during.push(status());
      return { outcome: "busy", exitCode: null, logPath: "" };
    });
    await dispatch(app, conn, {
      id: 1,
      op: "projects.set_setup_recipe",
      body: { recipe: "npm ci", run: true },
    });
    expect((frames[0].result as { run: unknown }).run).toMatchObject({
      outcome: "busy",
      logTail: "",
      logTruncated: false,
    });
    expect(fakes.readSessionSetupLog).not.toHaveBeenCalled();
    // `running` while the recipe runs, then back to what it was.
    expect(during).toEqual(["running"]);
    expect(status()).toBe("ok");
  });

  it("a busy run does not overwrite a status someone else settled meanwhile", async () => {
    const { app, conn, agent } = await setup();
    const id = Number(agent);
    fakes.runSetupOnHost.mockImplementation(async () => {
      // The session's own start run finishes while ours is being refused.
      app.db.update(sessions).set({ setupStatus: "failed" }).where(eq(sessions.id, id)).run();
      return { outcome: "busy", exitCode: null, logPath: "" };
    });
    await dispatch(app, conn, {
      id: 1,
      op: "projects.set_setup_recipe",
      body: { recipe: "npm ci", run: true },
    });
    expect(app.db.select().from(sessions).where(eq(sessions.id, id)).get()!.setupStatus).toBe(
      "failed",
    );
  });

  it("run: true needs a recipe, and a session at full scope; a refused run saves nothing", async () => {
    const { app, conn, frames, projectA, recipeOf } = await setup();
    await dispatch(app, conn, {
      id: 1,
      op: "projects.set_setup_recipe",
      body: { recipe: null, run: true },
    });
    const full = makeConnectionState("full", null);
    await dispatch(app, full.conn, {
      id: 2,
      op: "projects.set_setup_recipe",
      body: { projectId: projectA, recipe: "npm ci", run: true },
    });
    expect(frames[0]).toMatchObject({ ok: false, status: 400 });
    expect(full.frames[0]).toMatchObject({ ok: false, status: 400 });
    expect(recipeOf(projectA)).toBeNull();
    expect(fakes.runSetupOnHost).not.toHaveBeenCalled();
  });

  it("full scope runs in the named session; one outside the project is refused after saving", async () => {
    const { app, projectA, projectB, recipeOf } = await setup();
    fakes.runSetupOnHost.mockResolvedValue({ outcome: "ok", exitCode: 0, logPath: "/l" });
    fakes.readSessionSetupLog.mockResolvedValue({ content: "done", truncated: false });
    const own = Number(
      app.db.insert(sessions).values({ projectId: projectA, command: "bash", cwd: cwdA }).run()
        .lastInsertRowid,
    );
    const foreign = Number(
      app.db.insert(sessions).values({ projectId: projectB, command: "bash", cwd: cwdB }).run()
        .lastInsertRowid,
    );
    const { conn, frames } = makeConnectionState("full", null);
    await dispatch(app, conn, {
      id: 1,
      op: "projects.set_setup_recipe",
      body: { projectId: projectA, recipe: "npm ci", run: true, sessionId: own },
    });
    await dispatch(app, conn, {
      id: 2,
      op: "projects.set_setup_recipe",
      body: { projectId: projectA, recipe: "npm i", run: true, sessionId: foreign },
    });
    expect((frames[0].result as { run: unknown }).run).toMatchObject({
      outcome: "ok",
      exitCode: 0,
      logTail: "done",
    });
    expect(frames[1]).toMatchObject({ ok: false, status: 400 });
    expect(frames[1].error).toMatch(/^recipe saved, but the dry run could not start/);
    expect(recipeOf(projectA)).toBe("npm i");
    expect(fakes.runSetupOnHost).toHaveBeenCalledTimes(1);
  });
  it("run: true uses the session's own directory, not the project root, and updates its setup badge", async () => {
    const { app, projectA } = await setup();
    fakes.runSetupOnHost.mockResolvedValue({ outcome: "failed", exitCode: 2, logPath: "/s.log" });
    fakes.readSessionSetupLog.mockResolvedValue({ content: "boom", truncated: false });
    const sub = path.join(cwdA, "packages", "web");
    fs.mkdirSync(sub, { recursive: true });
    const inSub = Number(
      app.db.insert(sessions).values({ projectId: projectA, command: "bash", cwd: sub }).run()
        .lastInsertRowid,
    );
    app.db.update(sessions).set({ setupStatus: "ok" }).where(eq(sessions.id, inSub)).run();
    const { conn, frames } = makeConnectionState("full", null);
    await dispatch(app, conn, {
      id: 1,
      op: "projects.set_setup_recipe",
      body: { projectId: projectA, recipe: "npm ci", run: true, sessionId: String(inSub) },
    });
    expect((frames[0].result as { run: { cwd: string } }).run.cwd).toBe(sub);
    expect(fakes.runSetupOnHost).toHaveBeenCalledWith(app, "local", {
      cwd: sub,
      recipe: "npm ci",
      logKey: String(inSub),
    });
    const row = app.db.select().from(sessions).where(eq(sessions.id, inSub)).get()!;
    expect([row.setupStatus, row.setupLogPath]).toEqual(["failed", "/s.log"]);
    expect(fakes.broadcastTaskEvent).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: projectA, kind: "setup" }),
    );
  });

  it("run: true at full scope refuses a non-numeric session id before saving", async () => {
    const { app, projectA, recipeOf } = await setup();
    const { conn, frames } = makeConnectionState("full", null);
    await dispatch(app, conn, {
      id: 1,
      op: "projects.set_setup_recipe",
      body: { projectId: projectA, recipe: "npm ci", run: true, sessionId: "abc" },
    });
    expect(frames[0]).toMatchObject({ ok: false, status: 400 });
    expect(frames[0].error).toBe("Invalid session id");
    expect(recipeOf(projectA)).toBeNull();
    expect(fakes.runSetupOnHost).not.toHaveBeenCalled();
  });
});
