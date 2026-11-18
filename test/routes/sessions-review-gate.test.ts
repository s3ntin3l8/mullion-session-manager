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
setupSessionsRouteLifecycle("review-gate");

describe("sessions route: the review gate", () => {
  describe("POST /api/sessions/:id/review-gate (issue #178)", () => {
    /** Opens a real socket against app.pty.hookSocketPath, handshakes, and
     * sends a `review_gate: waiting` message — the same round-trip
     * forwarder.mjs's runGate() does — then waits for it to actually land
     * (session.gateState flips to "waiting") before returning the raw
     * socket, so the route under test has a real pending gate to resolve. */
    async function openPendingGate(
      app_: Awaited<ReturnType<typeof buildApp>>,
      sessionId: number,
      prompt: string,
    ): Promise<net.Socket> {
      const session = app_.pty.get(String(sessionId));
      if (!session) throw new Error("session not tracked");
      const socket = await new Promise<net.Socket>((resolve, reject) => {
        const s = net.createConnection(app_.pty.hookSocketPath);
        s.once("connect", () => resolve(s));
        s.once("error", reject);
      });
      socket.write(`${JSON.stringify({ token: session.hookToken })}\n`);
      socket.write(`${JSON.stringify({ kind: "review_gate", state: "waiting", prompt })}\n`);
      await waitUntil(() => session.toInfo().gateState === "waiting");
      return socket;
    }

    it("400s an invalid session id", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/not-a-number/review-gate",
        payload: { decision: "approved" },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("404s an unknown session id", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/999999/review-gate",
        payload: { decision: "approved" },
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("409s when no review is currently pending for a real session", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = created.json().id;

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/review-gate`,
        payload: { decision: "approved" },
      });
      expect(res.statusCode).toBe(409);
      await app.close();
    });

    it("delivers an approve decision to the pending gate connection and flips gateState", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = created.json().id;

      const socket = await openPendingGate(app, sessionId, "rm -rf /tmp/scratch");
      const replyPromise = new Promise<string>((resolve) => {
        socket.on("data", (chunk: Buffer) => resolve(chunk.toString("utf8").trim()));
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/review-gate`,
        payload: { decision: "approved" },
      });
      expect(res.statusCode).toBe(204);

      expect(JSON.parse(await replyPromise)).toEqual({ decision: "approved" });
      const list = await app.inject({ method: "GET", url: `/api/sessions?projectId=${projectId}` });
      expect(list.json()).toEqual([
        expect.objectContaining({ id: sessionId, gateState: "approved", gatePrompt: null }),
      ]);

      socket.destroy();
      await app.close();
    });

    it("delivers a deny decision with a reason", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = created.json().id;

      const socket = await openPendingGate(app, sessionId, "curl http://evil.example");
      const replyPromise = new Promise<string>((resolve) => {
        socket.on("data", (chunk: Buffer) => resolve(chunk.toString("utf8").trim()));
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/review-gate`,
        payload: { decision: "denied", reason: "looks unsafe" },
      });
      expect(res.statusCode).toBe(204);
      expect(JSON.parse(await replyPromise)).toEqual({
        decision: "denied",
        reason: "looks unsafe",
      });

      socket.destroy();
      await app.close();
    });

    it("400s an unrecognized decision value", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = created.json().id;

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/review-gate`,
        payload: { decision: "maybe" },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });
  });
});
