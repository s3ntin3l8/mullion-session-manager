// Must come before any import below that could itself trigger loading
// "node-pty"/"node:child_process" (e.g. the `node:child_process` import a
// few lines down) — see mock-pty.ts's header comment for the
// empirically confirmed hoisting/ordering failure mode.
import { createNodePtyMock } from "../helpers/mock-pty.js";
import {
  createProject,
  localTarget,
  mockSpawnModule,
  opencodeTransferMock,
  setupSessionsRouteLifecycle,
} from "../helpers/sessions-routes.js";
import { describe, expect, it, vi } from "vitest";
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
setupSessionsRouteLifecycle("browser");

describe("sessions route: the session's browser binding", () => {
  describe("GET /api/sessions/:id/browser (issue #182)", () => {
    it("404s for an unknown session id", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/sessions/999999/browser" });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("400s for a non-integer session id", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/sessions/not-a-number/browser" });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("returns an empty array for a session with no browser binding", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/sessions/${created.json().id}/browser`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);

      await app.close();
    });

    it("returns the recorded binding once one exists", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = created.json().id as number;
      const { recordSessionBrowserBinding } =
        await import("../../src/services/session-browsers.js");
      recordSessionBrowserBinding(app, sessionId, localTarget(projectId));

      const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/browser` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([expect.objectContaining({ sessionId, projectId })]);

      await app.close();
    });

    it("DELETE /api/sessions/:id closes the session's target browser (issue #182)", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = created.json().id as number;
      const { recordSessionBrowserBinding } =
        await import("../../src/services/session-browsers.js");
      recordSessionBrowserBinding(app, sessionId, localTarget(projectId));
      const closeTargetSpy = vi.spyOn(app.browser, "closeTarget").mockResolvedValue(undefined);

      const killed = await app.inject({ method: "DELETE", url: `/api/sessions/${sessionId}` });
      expect(killed.statusCode).toBe(204);
      expect(closeTargetSpy).toHaveBeenCalledWith(localTarget(projectId));

      const after = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/browser` });
      expect(after.json()).toEqual([]);

      await app.close();
    });
  });
});
