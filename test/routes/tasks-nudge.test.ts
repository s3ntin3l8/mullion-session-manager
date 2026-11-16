// The task API payload's worker-nudge fields (#3179): this spell's count, the
// cap and the last nudge time, applied by the serializer so the card never
// re-derives the spell rule.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { projects, tasks } from "../../src/db/schema.js";
import { MAX_WORKER_NUDGES } from "../../src/services/task-nudge.js";

const tmpDb = path.join(os.tmpdir(), `tasks-nudge-route-${process.pid}.db`);
const CLAIMED = new Date("2026-11-16T11:00:00Z");
const NUDGED = new Date("2026-11-16T11:30:00Z");

describe("GET /api/tasks nudge fields (#3179)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });
  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("carries this spell's count, the cap and the last nudge time; a stale spell reads 0", async () => {
    const app = await buildApp();
    const [project] = app.db
      .insert(projects)
      .values({ name: "nudge-route", cwd: os.tmpdir() })
      .returning()
      .all();
    const add = (issueNumber: number, lastNudgedAt: Date) =>
      app.db
        .insert(tasks)
        .values({
          projectId: project.id,
          issueNumber,
          title: `t${issueNumber}`,
          status: "in_progress",
          claimedAt: CLAIMED,
          nudgeCount: 2,
          lastNudgedAt,
        })
        .returning()
        .all()[0];
    const fresh = add(1, NUDGED);
    const stale = add(2, new Date(CLAIMED.getTime() - 60_000));

    const list = (await app.inject({ method: "GET", url: "/api/tasks" })).json() as {
      id: number;
      nudgeCount: number;
      nudgeLimit: number;
      lastNudgedAt: string | null;
    }[];
    expect(list.find((t) => t.id === fresh.id)).toMatchObject({
      nudgeCount: 2,
      nudgeLimit: MAX_WORKER_NUDGES,
      lastNudgedAt: NUDGED.toISOString(),
    });
    expect(list.find((t) => t.id === stale.id)!.nudgeCount).toBe(0);

    const one = (await app.inject({ method: "GET", url: `/api/tasks/${fresh.id}` })).json();
    expect(one).toMatchObject({ nudgeCount: 2, nudgeLimit: MAX_WORKER_NUDGES });
    await app.close();
  });
});
