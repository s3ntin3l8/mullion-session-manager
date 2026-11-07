import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { eq } from "drizzle-orm";
import { buildTestApp } from "../helpers/app.js";

const { closeDb } = await import("../../src/db/client.js");
const { sessionBrowsers, sessions, previews } = await import("../../src/db/schema.js");
const { resolveSessionBrowserTarget } = await import("../../src/services/browser-target.js");
const { browserTargetKey } = await import("../../src/services/browser-manager.js");
const { recordSessionBrowserBinding, listSessionBrowserBindings, closeSessionBrowserBindings } =
  await import("../../src/services/session-browsers.js");

const localTarget = (projectId: number, checkoutRoot = "/tmp") => ({
  projectId,
  hostId: "local",
  checkoutRoot,
  legacy: true,
});

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
    app: Awaited<ReturnType<typeof buildTestApp>>,
    count = 1,
  ): Promise<{ projectId: number; sessionIds: number[] }> {
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "p", cwd: "/tmp" },
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
      const app = await buildTestApp();
      const { projectId, sessionIds } = await createProjectAndSessions(app);

      recordSessionBrowserBinding(app, sessionIds[0], localTarget(projectId));

      const rows = listSessionBrowserBindings(app, sessionIds[0]);
      expect(rows).toHaveLength(1);
      expect(rows[0].projectId).toBe(projectId);
    });

    it("upserts rather than accumulating a new row per reconnect", async () => {
      const app = await buildTestApp();
      const { projectId, sessionIds } = await createProjectAndSessions(app);

      recordSessionBrowserBinding(app, sessionIds[0], localTarget(projectId));
      const firstRows = listSessionBrowserBindings(app, sessionIds[0]);
      recordSessionBrowserBinding(app, sessionIds[0], localTarget(projectId));
      recordSessionBrowserBinding(app, sessionIds[0], localTarget(projectId));

      const rows = listSessionBrowserBindings(app, sessionIds[0]);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(firstRows[0].id);
      expect(rows[0].lastAttachedAt.getTime()).toBeGreaterThanOrEqual(
        firstRows[0].lastAttachedAt.getTime(),
      );
    });
  });

  describe("listSessionBrowserBindings", () => {
    it("returns an empty array for a session with no binding", async () => {
      const app = await buildTestApp();
      const { sessionIds } = await createProjectAndSessions(app);

      expect(listSessionBrowserBindings(app, sessionIds[0])).toEqual([]);
    });
  });

  describe("closeSessionBrowserBindings", () => {
    it("is a no-op for a session with no binding", async () => {
      const app = await buildTestApp();
      const { sessionIds } = await createProjectAndSessions(app);
      const closeTargetSpy = vi.spyOn(app.browser, "closeTarget").mockResolvedValue(undefined);

      closeSessionBrowserBindings(app, sessionIds[0]);

      expect(closeTargetSpy).not.toHaveBeenCalled();
    });

    it("deletes the binding row and closes the project browser when no sibling session uses it", async () => {
      const app = await buildTestApp();
      const { projectId, sessionIds } = await createProjectAndSessions(app);
      const closeTargetSpy = vi.spyOn(app.browser, "closeTarget").mockResolvedValue(undefined);
      recordSessionBrowserBinding(app, sessionIds[0], localTarget(projectId));

      closeSessionBrowserBindings(app, sessionIds[0]);

      expect(listSessionBrowserBindings(app, sessionIds[0])).toEqual([]);
      expect(closeTargetSpy).toHaveBeenCalledWith(localTarget(projectId));
    });

    it("does NOT close the project browser while a sibling session still holds a binding to it", async () => {
      const app = await buildTestApp();
      const { projectId, sessionIds } = await createProjectAndSessions(app, 2);
      const closeTargetSpy = vi.spyOn(app.browser, "closeTarget").mockResolvedValue(undefined);
      recordSessionBrowserBinding(app, sessionIds[0], localTarget(projectId));
      recordSessionBrowserBinding(app, sessionIds[1], localTarget(projectId));

      closeSessionBrowserBindings(app, sessionIds[0]);

      // This session's own binding is gone, the sibling's remains, and the
      // shared project browser stays up for it.
      expect(listSessionBrowserBindings(app, sessionIds[0])).toEqual([]);
      expect(listSessionBrowserBindings(app, sessionIds[1])).toHaveLength(1);
      expect(closeTargetSpy).not.toHaveBeenCalled();

      // Closing the last remaining session's binding now does close it.
      closeSessionBrowserBindings(app, sessionIds[1]);
      expect(closeTargetSpy).toHaveBeenCalledWith(localTarget(projectId));
    });

    it("gives two preview endpoints of one checkout separate contexts through the real resolver, and closes both on session end (#2672)", async () => {
      const app = await buildTestApp();
      const { projectId, sessionIds } = await createProjectAndSessions(app, 2);
      // Two previews of the same (default) checkout, one bound to each session.
      app.db
        .insert(previews)
        .values([
          { slug: "prev-a", kind: "project", projectId, sessionId: sessionIds[0], branch: "" },
          { slug: "prev-b", kind: "project", projectId, sessionId: sessionIds[1], branch: "b" },
        ])
        .run();
      const targets = [];
      for (const id of sessionIds) {
        const resolved = await resolveSessionBrowserTarget(app, projectId, id);
        expect(resolved.ok).toBe(true);
        if (!resolved.ok) return;
        targets.push(resolved.target);
        recordSessionBrowserBinding(app, id, resolved.target);
      }
      expect(targets[0].checkoutRoot).toBe(targets[1].checkoutRoot);
      expect(targets.map((t) => t.endpoint)).toEqual(["prev-a", "prev-b"]);
      expect(browserTargetKey(targets[0])).not.toBe(browserTargetKey(targets[1]));
      expect(listSessionBrowserBindings(app, sessionIds[0])[0].targetEndpoint).toBe("prev-a");

      // A resolve after the binding stays on the stored target (and endpoint).
      const again = await resolveSessionBrowserTarget(app, projectId, sessionIds[0]);
      expect(again.ok && again.target).toEqual(targets[0]);

      const closeTargetSpy = vi.spyOn(app.browser, "closeTarget").mockResolvedValue(undefined);
      closeSessionBrowserBindings(app, sessionIds[0]);
      closeSessionBrowserBindings(app, sessionIds[1]);
      expect(closeTargetSpy).toHaveBeenCalledTimes(2);
      expect(closeTargetSpy).toHaveBeenCalledWith(targets[0]);
      expect(closeTargetSpy).toHaveBeenCalledWith(targets[1]);
    });

    it("keeps a shared endpoint open until its last session ends, and a different endpoint apart (#2672)", async () => {
      const app = await buildTestApp();
      const { projectId, sessionIds } = await createProjectAndSessions(app, 3);
      const closeTargetSpy = vi.spyOn(app.browser, "closeTarget").mockResolvedValue(undefined);
      const withEndpoint = (endpoint?: string) => ({ ...localTarget(projectId), endpoint });
      recordSessionBrowserBinding(app, sessionIds[0], withEndpoint("p1"));
      recordSessionBrowserBinding(app, sessionIds[1], withEndpoint("p1"));
      recordSessionBrowserBinding(app, sessionIds[2], withEndpoint("p2"));

      closeSessionBrowserBindings(app, sessionIds[2]);
      expect(closeTargetSpy).toHaveBeenCalledWith(withEndpoint("p2"));
      closeTargetSpy.mockClear();
      closeSessionBrowserBindings(app, sessionIds[0]);
      expect(closeTargetSpy).not.toHaveBeenCalled();
      closeSessionBrowserBindings(app, sessionIds[1]);
      expect(closeTargetSpy).toHaveBeenCalledWith(withEndpoint("p1"));
    });

    it("closes a remote session's browser on its agent, endpoint included (#2672)", async () => {
      const app = await buildTestApp();
      const { projectId, sessionIds } = await createProjectAndSessions(app);
      const remote = {
        projectId,
        hostId: "agent-9",
        checkoutRoot: "/r/p",
        endpoint: "e",
        legacy: false,
      };
      recordSessionBrowserBinding(app, sessionIds[0], remote);
      const postBrowser = vi.fn().mockResolvedValue({ ok: true });
      const hostAgents = await import("../../src/services/host-agents.js");
      vi.spyOn(hostAgents, "requireOperation").mockReturnValue({ ok: true } as never);
      const remoteClient = await import("../../src/services/remote-host-client.js");
      vi.spyOn(remoteClient, "getRemoteHostClient").mockReturnValue({ postBrowser } as never);

      closeSessionBrowserBindings(app, sessionIds[0]);

      await vi.waitFor(() =>
        expect(postBrowser).toHaveBeenCalledWith("/internal/browser/close", remote),
      );
    });

    it("cascade-deletes a session's binding row when the session row itself is deleted", async () => {
      const app = await buildTestApp();
      const { projectId, sessionIds } = await createProjectAndSessions(app);
      recordSessionBrowserBinding(app, sessionIds[0], localTarget(projectId));

      app.db.delete(sessions).where(eq(sessions.id, sessionIds[0])).run();

      const remaining = app.db
        .select()
        .from(sessionBrowsers)
        .where(eq(sessionBrowsers.sessionId, sessionIds[0]))
        .all();
      expect(remaining).toEqual([]);
    });
  });
});
