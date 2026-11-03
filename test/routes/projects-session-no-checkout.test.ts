import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { closeDb } from "../../src/db/client.js";
import { hosts, projects, sessions } from "../../src/db/schema.js";

// A session whose project has no checkout on the session's host is durably
// invalid: the batch routes answer `null` (clear), never omit it (keep the
// last-known-good value), and the single-file diff 404s.
const tmpDb = path.join(os.tmpdir(), `projects-no-checkout-test-${process.pid}.db`);
process.env.DATABASE_URL = `file:${tmpDb}`;

const { buildApp } = await import("../../src/app.js");

describe("session on a host its project has no checkout on", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
  });
  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
  });

  it("reports null (not absent) from the batch routes and 404s the file diff", async () => {
    const app = await buildApp();
    app.db
      .insert(hosts)
      .values({ id: "no-checkout-host", name: "nc", baseUrl: "http://127.0.0.1:1" })
      .run();
    const projectId = app.db
      .insert(projects)
      .values({ name: "no-checkout", cwd: os.tmpdir() })
      .returning({ id: projects.id })
      .get().id;
    const sessionId = app.db
      .insert(sessions)
      .values({ projectId, name: "s", command: "bash", hostId: "no-checkout-host" })
      .returning({ id: sessions.id })
      .get().id;

    for (const route of ["git-statuses", "git-diff-stats"]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${route}?sessionIds=${sessionId}`,
      });
      expect(res.statusCode).toBe(200);
      const map = route === "git-statuses" ? res.json().sessions : res.json();
      expect(String(sessionId) in map).toBe(true);
      expect(map[String(sessionId)]).toBeNull();
    }
    const diff = await app.inject({
      method: "GET",
      url: `/api/projects/git-file-diff?sessionId=${sessionId}&path=a.txt`,
    });
    expect(diff.statusCode).toBe(404);
    await app.close();
  });
});
