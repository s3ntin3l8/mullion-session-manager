// Must come before any import below that could itself trigger loading
// "node-pty"/"node:child_process" (e.g. the `node:child_process` import a
// few lines down) — see mock-pty.ts's header comment for the
// empirically confirmed hoisting/ordering failure mode.
import { createNodePtyMock } from "../helpers/mock-pty.js";
import {
  createProjectWithGitRepo,
  mockSpawnModule,
  opencodeTransferMock,
  setupSessionsRouteLifecycle,
  waitUntil,
} from "../helpers/sessions-routes.js";
// AFTER sessions-routes.js: this helper imports node:child_process, so
// importing it earlier would run the node:child_process mock factory before
// mockSpawnModule is initialised (see mock-pty.ts's header).
import { createGitRepo } from "../helpers/git-fixture-repo.js";
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import net from "node:net";
// Session creation spawns real OS processes (systemd-run, dtach) via
// PtyManager — faked here the same way as test/services/pty-manager.test.ts,
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
setupSessionsRouteLifecycle("promote-decline");

describe("sessions route: declining a promote", () => {
  describe("POST /:id/promote/decline", () => {
    it("resolves a pending promote_request as declined and unblocks the model's tool call", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const projectId = await createProjectWithGitRepo(app, cwd);
      const sourceId = await (async () => {
        const created = await app.inject({
          method: "POST",
          url: "/api/sessions",
          payload: { projectId, command: "bash" },
        });
        return created.json().id as number;
      })();
      const session = app.pty.get(String(sourceId))!;

      const socket = await new Promise<net.Socket>((resolve, reject) => {
        const s = net.createConnection(app.pty.hookSocketPath);
        s.once("connect", () => resolve(s));
        s.once("error", reject);
      });
      socket.write(`${JSON.stringify({ token: session.hookToken })}\n`);
      socket.write(`${JSON.stringify({ kind: "promote_request", summary: "start work" })}\n`);
      await waitUntil(() => session.toInfo().promoteState === "pending");

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sourceId}/promote/decline`,
        payload: { reason: "not yet" },
      });
      expect(res.statusCode).toBe(204);
      expect(session.toInfo().promoteState).toBe("declined");

      // The source session is untouched — declining doesn't kill it.
      const list = await app.inject({
        method: "GET",
        url: `/api/sessions?projectId=${projectId}`,
      });
      expect(list.json().find((s: { id: number }) => s.id === sourceId).status).toBe("active");

      socket.destroy();
      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("409s when nothing is pending", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const projectId = await createProjectWithGitRepo(app, cwd);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sourceId = created.json().id as number;

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sourceId}/promote/decline`,
        payload: {},
      });
      expect(res.statusCode).toBe(409);

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });
  });
});
