import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { tasks } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";

// The `reviewPostPending` boolean that withAutoReturnCapped derives from the
// raw retry marker (#2749). Split out of tasks.test.ts, which the file-size
// ratchet won't let grow.
const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");

const tmpDb = path.join(os.tmpdir(), `tasks-review-post-pending-${process.pid}.db`);

describe("task responses carry reviewPostPending (#2749)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("is true on the list and detail while a marker is set, false once it clears, and never leaks the raw payload", async () => {
    const app = await buildApp();
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "post-pending", cwd: "/tmp" },
    });
    const projectId = project.json().id as number;
    const marker = JSON.stringify({
      key: "1-1",
      body: "<!-- mullion-review-post:1-1 -->\nsecret body",
      verdict: "approved",
      posted: false,
      createdAt: Date.now(),
    });
    const [task] = app.db
      .insert(tasks)
      .values({ projectId, title: "pending post", status: "reviewing", reviewPostPending: marker })
      .returning()
      .all();

    const read = async () => {
      const list = await app.inject({ method: "GET", url: "/api/tasks" });
      const detail = await app.inject({ method: "GET", url: `/api/tasks/${task.id}` });
      expect(detail.statusCode).toBe(200);
      return {
        list: (list.json() as Array<{ id: number }>).find((t) => t.id === task.id) as Record<
          string,
          unknown
        >,
        detail: detail.json() as Record<string, unknown>,
      };
    };

    let { list, detail } = await read();
    expect(list.reviewPostPending).toBe(true);
    expect(detail.reviewPostPending).toBe(true);
    expect(JSON.stringify(detail)).not.toContain("secret body");

    app.db.update(tasks).set({ reviewPostPending: null }).where(eq(tasks.id, task.id)).run();
    ({ list, detail } = await read());
    expect(list.reviewPostPending).toBe(false);
    expect(detail.reviewPostPending).toBe(false);
    await app.close();
  });
});
