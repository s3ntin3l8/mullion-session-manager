import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { sessions, tasks } from "../../src/db/schema.js";

const tmpDb = path.join(os.tmpdir(), `tasks-park-${process.pid}.db`);
const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");

// #2940 — a rate-limit park clears `sessionId`, so the board needs the reset
// time and the task timeline needs the old worker sessions (not the review).
describe("tasks route: rate-limit park fields", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });
  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("exposes rateLimitUntil and workerSessionIds on both GETs", async () => {
    const app = await buildApp();
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "demo-park", cwd: "/tmp/demo-park" },
    });
    const projectId = project.json().id;
    const reset = new Date(Date.now() + 60 * 60 * 1000);
    reset.setMilliseconds(0);

    const [row] = app.db
      .insert(tasks)
      .values({
        projectId,
        issueNumber: 46,
        title: "A parked task",
        status: "ready",
        rateLimitUntil: reset,
        failureReason: "rate limited; held until the provider reset",
      })
      .returning({ id: tasks.id })
      .all();
    const mk = (name: string) =>
      app.db
        .insert(sessions)
        .values({ projectId, command: "codex", status: "killed", taskId: row.id, name })
        .returning({ id: sessions.id })
        .get().id;
    const first = mk(`Task #${row.id} · worker`);
    mk(`Task #${row.id} · review`);
    const second = mk(`Task #${row.id} · worker`);

    const expected = { rateLimitUntil: reset.toISOString(), workerSessionIds: [second, first] };
    const list = (await app.inject({ method: "GET", url: "/api/tasks" })).json() as {
      id: number;
    }[];
    expect(list.find((t) => t.id === row.id)).toMatchObject(expected);
    const single = await app.inject({ method: "GET", url: `/api/tasks/${row.id}` });
    expect(single.json()).toMatchObject(expected);

    await app.close();
  });
});
