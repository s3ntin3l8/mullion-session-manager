import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { eq } from "drizzle-orm";

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { sessionBrowsers, sessions } = await import("../../src/db/schema.js");
const { recordSessionBrowserBinding, listSessionBrowserBindings, closeSessionBrowserBindings } =
  await import("../../src/services/session-browsers.js");

const tmpDb = path.join(os.tmpdir(), `session-browsers-test-${process.pid}.db`);

describe("session-browsers", () => {
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
    vi.restoreAllMocks();
  });

  async function createProjectAndSessions(
    app: Awaited<ReturnType<typeof buildApp>>,
    count = 1,
  ): Promise<{ projectId: number; sessionIds: number[] }> {
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "p", cwd: "/tmp" },
    });
    const projectId = project.json().id as number;
    const sessionIds: number[] = [];
    for (let i = 0; i < count; i++) {
      const [row] = app.db
        .insert(sessions)
        .values({ projectId, command: "bash" })
        .returning()
        .all();
      sessionIds.push(row.id);
    }
    return { projectId, sessionIds };
  }

  describe("recordSessionBrowserBinding", () => {
    it("creates a binding row for a session", async () => {
      const app = await buildApp();
      const { projectId, sessionIds } = await createProjectAndSessions(app);

      recordSessionBrowserBinding(app, sessionIds[0], projectId);

      const rows = listSessionBrowserBindings(app, sessionIds[0]);
      expect(rows).toHaveLength(1);
      expect(rows[0].projectId).toBe(projectId);

      await app.close();
    });

    it("upserts rather than accumulating a new row per reconnect", async () => {
      const app = await buildApp();
      const { projectId, sessionIds } = await createProjectAndSessions(app);

      recordSessionBrowserBinding(app, sessionIds[0], projectId);
      const firstRows = listSessionBrowserBindings(app, sessionIds[0]);
      recordSessionBrowserBinding(app, sessionIds[0], projectId);
      recordSessionBrowserBinding(app, sessionIds[0], projectId);

      const rows = listSessionBrowserBindings(app, sessionIds[0]);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(firstRows[0].id);
      expect(rows[0].lastAttachedAt.getTime()).toBeGreaterThanOrEqual(
        firstRows[0].lastAttachedAt.getTime(),
      );

      await app.close();
    });
  });

  describe("listSessionBrowserBindings", () => {
    it("returns an empty array for a session with no binding", async () => {
      const app = await buildApp();
      const { sessionIds } = await createProjectAndSessions(app);

      expect(listSessionBrowserBindings(app, sessionIds[0])).toEqual([]);

      await app.close();
    });
  });

  describe("closeSessionBrowserBindings", () => {
    it("is a no-op for a session with no binding", async () => {
      const app = await buildApp();
      const { sessionIds } = await createProjectAndSessions(app);
      const closeForProjectSpy = vi
        .spyOn(app.browser, "closeForProject")
        .mockResolvedValue(undefined);

      closeSessionBrowserBindings(app, sessionIds[0]);

      expect(closeForProjectSpy).not.toHaveBeenCalled();

      await app.close();
    });

    it("deletes the binding row and closes the project browser when no sibling session uses it", async () => {
      const app = await buildApp();
      const { projectId, sessionIds } = await createProjectAndSessions(app);
      const closeForProjectSpy = vi
        .spyOn(app.browser, "closeForProject")
        .mockResolvedValue(undefined);
      recordSessionBrowserBinding(app, sessionIds[0], projectId);

      closeSessionBrowserBindings(app, sessionIds[0]);

      expect(listSessionBrowserBindings(app, sessionIds[0])).toEqual([]);
      expect(closeForProjectSpy).toHaveBeenCalledWith(projectId);

      await app.close();
    });

    it("does NOT close the project browser while a sibling session still holds a binding to it", async () => {
      const app = await buildApp();
      const { projectId, sessionIds } = await createProjectAndSessions(app, 2);
      const closeForProjectSpy = vi
        .spyOn(app.browser, "closeForProject")
        .mockResolvedValue(undefined);
      recordSessionBrowserBinding(app, sessionIds[0], projectId);
      recordSessionBrowserBinding(app, sessionIds[1], projectId);

      closeSessionBrowserBindings(app, sessionIds[0]);

      // This session's own binding is gone, the sibling's remains, and the
      // shared project browser stays up for it.
      expect(listSessionBrowserBindings(app, sessionIds[0])).toEqual([]);
      expect(listSessionBrowserBindings(app, sessionIds[1])).toHaveLength(1);
      expect(closeForProjectSpy).not.toHaveBeenCalled();

      // Closing the last remaining session's binding now does close it.
      closeSessionBrowserBindings(app, sessionIds[1]);
      expect(closeForProjectSpy).toHaveBeenCalledWith(projectId);

      await app.close();
    });

    it("cascade-deletes a session's binding row when the session row itself is deleted", async () => {
      const app = await buildApp();
      const { projectId, sessionIds } = await createProjectAndSessions(app);
      recordSessionBrowserBinding(app, sessionIds[0], projectId);

      app.db.delete(sessions).where(eq(sessions.id, sessionIds[0])).run();

      const remaining = app.db
        .select()
        .from(sessionBrowsers)
        .where(eq(sessionBrowsers.sessionId, sessionIds[0]))
        .all();
      expect(remaining).toEqual([]);

      await app.close();
    });
  });
});
