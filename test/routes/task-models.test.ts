import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { eq } from "drizzle-orm";

// Issue #2491 — PATCH /api/tasks/:id's task-level model fields.
const tmpDb = path.join(os.tmpdir(), `task-models-route-test-${process.pid}.db`);
const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { tasks } = await import("../../src/db/schema.js");

beforeAll(() => {
  fs.rmSync(tmpDb, { force: true });
  process.env.DATABASE_URL = `file:${tmpDb}`;
});
afterAll(() => {
  closeDb();
  fs.rmSync(tmpDb, { force: true });
  delete process.env.DATABASE_URL;
});

async function createProject(app: Awaited<ReturnType<typeof buildApp>>, cwd: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { allowDuplicate: true, createDir: true, name: "task-models-p", cwd },
  });
  return res.json().id as number;
}

describe("PATCH /api/tasks/:id task-level models (#2491)", () => {
  async function setup(
    path: string,
    payload: Record<string, unknown> = {},
  ): Promise<{ app: Awaited<ReturnType<typeof buildApp>>; id: number }> {
    const app = await buildApp();
    const projectId = await createProject(app, path);
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: { projectId, title: "Model task", ...payload },
      })
    ).json();
    return { app, id: created.id };
  }
  const patch = (app: Awaited<ReturnType<typeof buildApp>>, id: number, payload: object) =>
    app.inject({ method: "PATCH", url: `/api/tasks/${id}`, payload });

  it("stores model, smallModel and reviewerModel and clears them with null", async () => {
    const { app, id } = await setup("/tmp/task-models-1", {
      agent: "opencode",
      reviewAgent: "claude",
    });
    const res = await patch(app, id, {
      model: "anthropic/claude-opus-4-5",
      smallModel: "anthropic/claude-haiku-4-5",
      reviewerModel: "claude-sonnet-4-5",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      modelOverride: "anthropic/claude-opus-4-5",
      smallModelOverride: "anthropic/claude-haiku-4-5",
      reviewerModel: "claude-sonnet-4-5",
      // The resolved record is untouched by a user choice.
      model: null,
    });
    const cleared = await patch(app, id, {
      model: null,
      smallModel: null,
      reviewerModel: null,
    });
    expect(cleared.json()).toMatchObject({
      modelOverride: null,
      smallModelOverride: null,
      reviewerModel: null,
    });
    await app.close();
  });

  it("400s on a model that does not fit the effective agent, and stores nothing", async () => {
    const { app, id } = await setup("/tmp/task-models-2", { agent: "opencode" });
    const res = await patch(app, id, { model: "no-slash" });
    expect(res.statusCode).toBe(400);
    const row = (await app.inject({ method: "GET", url: `/api/tasks/${id}` })).json();
    expect(row.modelOverride).toBeNull();
    await app.close();
  });

  it("validates against the agent in the same PATCH", async () => {
    const { app, id } = await setup("/tmp/task-models-3", { agent: "opencode" });
    const res = await patch(app, id, { agent: "codex", model: "gpt-5" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ agent: "codex", modelOverride: "gpt-5" });
    await app.close();
  });

  it("400s on a smallModel for a worker without one, and on a reviewerModel with no CLI reviewer", async () => {
    const { app, id } = await setup("/tmp/task-models-4", {
      agent: "codex",
      reviewAgent: "none",
    });
    expect((await patch(app, id, { smallModel: "gpt-5-mini" })).statusCode).toBe(400);
    expect((await patch(app, id, { reviewerModel: "gpt-5" })).statusCode).toBe(400);
    await app.close();
  });

  it("clears a stored model when the agent family changes, keeps it within a family", async () => {
    const { app, id } = await setup("/tmp/task-models-5", { agent: "opencode" });
    await patch(app, id, { model: "anthropic/claude-opus-4-5" });
    const changed = await patch(app, id, { agent: "codex" });
    expect(changed.json().modelOverride).toBeNull();

    await patch(app, id, { model: "gpt-5" });
    const kept = await patch(app, id, { agent: "codex", boardOrder: 3 });
    expect(kept.json().modelOverride).toBe("gpt-5");
    await app.close();
  });

  it("pins the agent the model was validated against into the agent column", async () => {
    const { app, id } = await setup("/tmp/task-models-pin", {
      body: "Do X.\n\nAgent: codex\n",
    });
    const res = await patch(app, id, { model: "gpt-5" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ agent: "codex", modelOverride: "gpt-5" });
    // Clearing the model leaves the pin; `agent: null` with a model keeps it.
    const again = await patch(app, id, { agent: null, model: "gpt-5-mini" });
    expect(again.json()).toMatchObject({ agent: "codex", modelOverride: "gpt-5-mini" });
    await app.close();
  });

  it("409s once the task is past backlog/ready", async () => {
    const { app, id } = await setup("/tmp/task-models-6", { agent: "opencode" });
    app.db.update(tasks).set({ status: "in_progress" }).where(eq(tasks.id, id)).run();
    const res = await patch(app, id, { model: "anthropic/claude-opus-4-5" });
    expect(res.statusCode).toBe(409);
    await app.close();
  });
});
