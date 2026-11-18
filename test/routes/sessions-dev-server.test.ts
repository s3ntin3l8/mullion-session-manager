// Must come before any import below that could itself trigger loading
// "node-pty"/"node:child_process" (e.g. the `node:child_process` import a
// few lines down) — see mock-pty.ts's header comment for the
// empirically confirmed hoisting/ordering failure mode.
import { createNodePtyMock } from "../helpers/mock-pty.js";
import {
  createProject,
  mockSpawnModule,
  opencodeTransferMock,
  setupSessionsRouteLifecycle,
  waitUntil,
} from "../helpers/sessions-routes.js";
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { previews, projects } from "../../src/db/schema.js";
// Session creation spawns real OS processes (systemd-run, dtach) via
// PtyManager — faked here the same way as test/helpers/pty-manager-harness.ts,
// so these files exercise the route/DB layer without depending on a real
// systemd --user session existing in CI. See that file for why.
//
// Each spawned fake PTY's onData listener array is captured here (not just
// created and discarded) so a scrollback-identity test can push real,
// distinguishable output through a specific session's PTY after the fact —
// see the "returns the base64-encoded scrollback buffer" test in test/routes/sessions-read.test.ts.
// `ptyMock.spawnedPtys[n].emitData(...)` (mock-pty.ts's listener-capturing
// variant) replaces the pre-split file's hand-rolled `fakePtyListeners` array.
const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));

// Issue #1733 — the agent's own argv reaches the dtach MASTER's spawn (the
// child_process one), not the attach client's node-pty spawn, so the mock's
// calls have to be reachable from the test.
vi.mock("node:child_process", async (importOriginal) => mockSpawnModule(await importOriginal()));

// Issue #271 follow-up — the opencode session transfer's own subprocess
// calls would otherwise hang; see mockSpawnModule's and opencodeTransferMock's
// doc comments in test/helpers/sessions-routes.ts.
vi.mock("../../src/services/opencode-session-transfer.js", () => opencodeTransferMock());

const { buildApp } = await import("../../src/app.js");

// This suite's own database, reset between tests — no test in this file can
// see another's rows, and no mock state leaks from one test into the next
// (see test/helpers/sessions-routes.ts).
setupSessionsRouteLifecycle("dev-server");

describe("sessions route: the dev-server offer", () => {
  // Issue #404 — accept/dismiss for a plain session's detected dev-server
  // offer. Detection itself is driven by a fixed 10s timer in
  // src/plugins/pty.ts (see that file's DEV_SERVER_DETECT_INTERVAL_MS), too
  // slow to wait on in a unit test — these tests manufacture the "pending"
  // state directly via app.pty.sweepDevServerDetection(...), the exact
  // entry point that timer calls, rather than waiting on the real interval
  // or re-testing the detection/dedup logic itself (already covered
  // directly in test/services/pty-manager-dev-server.test.ts).
  describe("POST /api/sessions/:id/dev-server/accept and /dismiss (issue #404)", () => {
    async function createSessionWithPendingPort(
      app: Awaited<ReturnType<typeof buildApp>>,
      port = "5173",
    ): Promise<{ projectId: number; sessionId: number }> {
      const projectId = await createProject(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = created.json().id;
      await waitUntil(() => app.pty.get(String(sessionId))?.isAlive === true);

      const marker = `  ➜  Local:   http://localhost:${port}/\r\n`;
      ptyMock.spawnedPtys[ptyMock.spawnedPtys.length - 1].emitData(marker);

      const detected = app.pty.sweepDevServerDetection(new Map([[String(sessionId), projectId]]));
      if (detected.length === 0) throw new Error("expected a dev-server detection to land");
      return { projectId, sessionId };
    }

    describe("accept", () => {
      it("400s an invalid session id", async () => {
        const app = await buildApp();
        const res = await app.inject({
          method: "POST",
          url: "/api/sessions/not-a-number/dev-server/accept",
          payload: { port: "5173" },
        });
        expect(res.statusCode).toBe(400);
        await app.close();
      });

      it("404s an unknown session id", async () => {
        const app = await buildApp();
        const res = await app.inject({
          method: "POST",
          url: "/api/sessions/999999/dev-server/accept",
          payload: { port: "5173" },
        });
        expect(res.statusCode).toBe(404);
        await app.close();
      });

      it("409s when no dev-server offer is currently pending for this session", async () => {
        const app = await buildApp();
        const projectId = await createProject(app);
        const created = await app.inject({
          method: "POST",
          url: "/api/sessions",
          payload: { projectId, command: "bash" },
        });
        const res = await app.inject({
          method: "POST",
          url: `/api/sessions/${created.json().id}/dev-server/accept`,
          payload: { port: "5173" },
        });
        expect(res.statusCode).toBe(409);
        await app.close();
      });

      it("409s a wrong/stale port that doesn't match the actually-detected one", async () => {
        const app = await buildApp();
        const { sessionId } = await createSessionWithPendingPort(app, "5173");
        const res = await app.inject({
          method: "POST",
          url: `/api/sessions/${sessionId}/dev-server/accept`,
          payload: { port: "9999" },
        });
        expect(res.statusCode).toBe(409);
        await app.close();
      });

      it("400s a port outside the valid 1-65535 range even when it matches the schema and is somehow pending, WITHOUT clearing the pending state", async () => {
        // "99999" passes the route schema's ^\d{1,5}$ pattern but fails
        // isValidDevServerUrl's range check — validated before
        // acceptDevServerPort mutates anything, so a rejected request must
        // leave the real pending offer intact for a later, valid accept.
        const app = await buildApp();
        const { sessionId } = await createSessionWithPendingPort(app, "5173");
        const res = await app.inject({
          method: "POST",
          url: `/api/sessions/${sessionId}/dev-server/accept`,
          payload: { port: "99999" },
        });
        expect(res.statusCode).toBe(400);

        // The real pending offer (from createSessionWithPendingPort's "5173")
        // must still be acceptable afterward.
        const retry = await app.inject({
          method: "POST",
          url: `/api/sessions/${sessionId}/dev-server/accept`,
          payload: { port: "5173" },
        });
        expect(retry.statusCode).toBe(200);
        await app.close();
      });

      it("patches the project's devServerUrl to the bare port and returns preview: null when PREVIEW_BASE_HOST is unset (previews-disabled no-op)", async () => {
        const app = await buildApp();
        const { projectId, sessionId } = await createSessionWithPendingPort(app, "5173");

        const res = await app.inject({
          method: "POST",
          url: `/api/sessions/${sessionId}/dev-server/accept`,
          payload: { port: "5173" },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ devServerUrl: "5173", preview: null });

        const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
        expect(project.devServerUrl).toBe("5173");
        await app.close();
      });

      it("creates/reuses a project preview when PREVIEW_BASE_HOST is configured", async () => {
        process.env.PREVIEW_BASE_HOST = "preview.example.com";
        try {
          const app = await buildApp();
          const { sessionId } = await createSessionWithPendingPort(app, "5173");

          const res = await app.inject({
            method: "POST",
            url: `/api/sessions/${sessionId}/dev-server/accept`,
            payload: { port: "5173" },
          });
          expect(res.statusCode).toBe(200);
          const body = res.json();
          expect(body.devServerUrl).toBe("5173");
          expect(body.preview).toMatchObject({ kind: "project" });
          expect(typeof body.preview.slug).toBe("string");
          // Issue #2007 — the accepting session is the one serving the preview.
          expect(body.preview.sessionId).toBe(sessionId);
          const [row] = app.db
            .select()
            .from(previews)
            .where(eq(previews.slug, body.preview.slug))
            .all();
          expect(row.sessionId).toBe(sessionId);
          await app.close();
        } finally {
          delete process.env.PREVIEW_BASE_HOST;
        }
      });

      it("accepting the SAME offer twice 409s the second time (already resolved)", async () => {
        const app = await buildApp();
        const { sessionId } = await createSessionWithPendingPort(app, "5173");

        const first = await app.inject({
          method: "POST",
          url: `/api/sessions/${sessionId}/dev-server/accept`,
          payload: { port: "5173" },
        });
        expect(first.statusCode).toBe(200);

        const second = await app.inject({
          method: "POST",
          url: `/api/sessions/${sessionId}/dev-server/accept`,
          payload: { port: "5173" },
        });
        expect(second.statusCode).toBe(409);
        await app.close();
      });

      it("409s a second offer on the SAME project instead of clobbering the first accepted devServerUrl (two plain sessions, e.g. a monorepo)", async () => {
        // Eligibility for detection is per-PROJECT (devServerUrl IS NULL),
        // but pending-offer/dedup state is per-SESSION — so two plain
        // sessions on one project can each independently latch a pending
        // offer before either is accepted. Regression test: accepting the
        // second must not silently overwrite the first accept's write.
        const app = await buildApp();
        const projectId = await createProject(app);

        const createSecondSessionWithPendingPort = async (port: string) => {
          const created = await app.inject({
            method: "POST",
            url: "/api/sessions",
            payload: { projectId, command: "bash" },
          });
          const sessionId = created.json().id;
          await waitUntil(() => app.pty.get(String(sessionId))?.isAlive === true);
          const marker = `  ➜  Local:   http://localhost:${port}/\r\n`;
          ptyMock.spawnedPtys[ptyMock.spawnedPtys.length - 1].emitData(marker);
          const detected = app.pty.sweepDevServerDetection(
            new Map([[String(sessionId), projectId]]),
          );
          if (detected.length === 0) throw new Error("expected a dev-server detection to land");
          return sessionId;
        };

        const firstSessionId = await createSecondSessionWithPendingPort("5173");
        const secondSessionId = await createSecondSessionWithPendingPort("3000");

        const first = await app.inject({
          method: "POST",
          url: `/api/sessions/${firstSessionId}/dev-server/accept`,
          payload: { port: "5173" },
        });
        expect(first.statusCode).toBe(200);

        const second = await app.inject({
          method: "POST",
          url: `/api/sessions/${secondSessionId}/dev-server/accept`,
          payload: { port: "3000" },
        });
        expect(second.statusCode).toBe(409);

        const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
        expect(project.devServerUrl).toBe("5173");
        await app.close();
      });
    });

    describe("dismiss", () => {
      it("400s an invalid session id", async () => {
        const app = await buildApp();
        const res = await app.inject({
          method: "POST",
          url: "/api/sessions/not-a-number/dev-server/dismiss",
          payload: { port: "5173" },
        });
        expect(res.statusCode).toBe(400);
        await app.close();
      });

      it("404s an unknown session id", async () => {
        const app = await buildApp();
        const res = await app.inject({
          method: "POST",
          url: "/api/sessions/999999/dev-server/dismiss",
          payload: { port: "5173" },
        });
        expect(res.statusCode).toBe(404);
        await app.close();
      });

      it("409s when no dev-server offer is currently pending", async () => {
        const app = await buildApp();
        const projectId = await createProject(app);
        const created = await app.inject({
          method: "POST",
          url: "/api/sessions",
          payload: { projectId, command: "bash" },
        });
        const res = await app.inject({
          method: "POST",
          url: `/api/sessions/${created.json().id}/dev-server/dismiss`,
          payload: { port: "5173" },
        });
        expect(res.statusCode).toBe(409);
        await app.close();
      });

      it("409s a wrong/stale port", async () => {
        const app = await buildApp();
        const { sessionId } = await createSessionWithPendingPort(app, "5173");
        const res = await app.inject({
          method: "POST",
          url: `/api/sessions/${sessionId}/dev-server/dismiss`,
          payload: { port: "9999" },
        });
        expect(res.statusCode).toBe(409);
        await app.close();
      });

      it("204s and suppresses re-offering the same (session, port) — does NOT patch devServerUrl", async () => {
        const app = await buildApp();
        const { projectId, sessionId } = await createSessionWithPendingPort(app, "5173");

        const res = await app.inject({
          method: "POST",
          url: `/api/sessions/${sessionId}/dev-server/dismiss`,
          payload: { port: "5173" },
        });
        expect(res.statusCode).toBe(204);

        const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
        expect(project.devServerUrl).toBeNull();

        // A re-printed banner for the SAME port must not re-offer.
        ptyMock.spawnedPtys[ptyMock.spawnedPtys.length - 1].emitData(
          "  ➜  Local:   http://localhost:5173/\r\n",
        );
        const detected = app.pty.sweepDevServerDetection(new Map([[String(sessionId), projectId]]));
        expect(detected).toEqual([]);
        await app.close();
      });
    });
  });
});
