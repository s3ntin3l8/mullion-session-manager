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
setupSessionsRouteLifecycle("attention");

describe("sessions route: acknowledging attention", () => {
  describe("POST /api/sessions/:id/attention/ack (issue #1430)", () => {
    /** Same round-trip as review-gate's own openPendingGate helper above —
     * opens a real socket against app.pty.hookSocketPath, handshakes, and
     * sends a review_gate:waiting message, then waits for the attention
     * machine to actually confirm it (zero-debounce — see
     * ATTENTION_CONFIRM_MS.reviewGate) before returning. */
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
      await waitUntil(() => session.toInfo().attentionKind === "reviewGate");
      return socket;
    }

    it("400s an invalid session id", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/not-a-number/attention/ack",
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("404s an unknown session id", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/999999/attention/ack",
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("204s (a harmless no-op) for a session with nothing to acknowledge", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${created.json().id}/attention/ack`,
      });
      expect(res.statusCode).toBe(204);
      await app.close();
    });

    it("409s while a blocking kind (a pending review gate) is confirmed, and leaves it untouched", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = created.json().id;
      await waitUntil(() => app.pty.get(String(sessionId))?.isAlive === true);
      const socket = await openPendingGate(app, sessionId, "Deploy?");

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/attention/ack`,
      });

      expect(res.statusCode).toBe(409);
      const info = app.pty.get(String(sessionId))?.toInfo();
      expect(info?.gateState).toBe("waiting");
      expect(info?.attentionKind).toBe("reviewGate");
      socket.destroy();
      await app.close();
    });

    it("clears the finished latch too, not just the attention flag — countAttentionRequired stops counting this session", async () => {
      // Issue #1430 — the ack route must clear BOTH latches session-
      // status.ts's deriveSessionStatus can key an "attention required"
      // status off of. A hook `progress: done` message with no outstanding
      // background tasks is the real, hook-confirmed path to a `finished`
      // SessionInfo.lastTurnEndedAt (see attention-tracker.ts's own
      // resolveDeferredTurnEnd doc comment) — driven the same
      // hook-socket way as openPendingGate above, distinct message kind.
      const app = await buildApp();
      const projectId = await createProject(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = created.json().id;
      await waitUntil(() => app.pty.get(String(sessionId))?.isAlive === true);
      const session = app.pty.get(String(sessionId));
      if (!session) throw new Error("session not tracked");

      const socket = await new Promise<net.Socket>((resolve, reject) => {
        const s = net.createConnection(app.pty.hookSocketPath);
        s.once("connect", () => resolve(s));
        s.once("error", reject);
      });
      socket.write(`${JSON.stringify({ token: session.hookToken })}\n`);
      socket.write(`${JSON.stringify({ kind: "progress", phase: "done" })}\n`);
      await waitUntil(() => session.toInfo().lastTurnEndedAt !== null);

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/attention/ack`,
      });

      expect(res.statusCode).toBe(204);
      expect(session.toInfo().lastTurnEndedAt).toBeNull();
      socket.destroy();
      await app.close();
    });

    it("409s (and does NOT silently discard) a permission request still settling in the deferred queue, even while a DIFFERENT, non-blocking kind (hookNotification) is the currently confirmed one", async () => {
      // Self-review regression test — the exact race the original
      // implementation missed: Session.acknowledgeAttention's own
      // per-decision-latch check (permissionState === "pending") is what
      // catches this, NOT AttentionTracker's confirmedKind-based check
      // alone (confirmedKind is "hookNotification" here, which isn't in
      // ACK_BLOCKING_KINDS). Real Claude Code fires a generic
      // Notification hook alongside PermissionRequest for the same
      // decision (hasRecentStructuredAsk's own doc comment,
      // hook-handlers.ts) — this reproduces that ordering.
      const app = await buildApp();
      const projectId = await createProject(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = created.json().id;
      await waitUntil(() => app.pty.get(String(sessionId))?.isAlive === true);
      const session = app.pty.get(String(sessionId));
      if (!session) throw new Error("session not tracked");

      const socket = await new Promise<net.Socket>((resolve, reject) => {
        const s = net.createConnection(app.pty.hookSocketPath);
        s.once("connect", () => resolve(s));
        s.once("error", reject);
      });
      socket.write(`${JSON.stringify({ token: session.hookToken })}\n`);

      // 1. A generic notification confirms immediately — NOT a blocking
      // kind, so a confirmedKind-only check would wrongly allow ack.
      socket.write(`${JSON.stringify({ kind: "notification", title: "heads up", body: "" })}\n`);
      await waitUntil(() => session.toInfo().attentionKind === "hookNotification");

      // 2. A permission request arrives right behind it — permissionState
      // flips to "pending" SYNCHRONOUSLY (hook-handlers.ts's own doc
      // comment), but the attention machine itself only DEFERS this one
      // (ATTENTION_SETTLE_MS.permissionRequest = 2000ms) rather than
      // confirming it — confirmedKind stays "hookNotification".
      socket.write(
        `${JSON.stringify({ kind: "permission_request", tool: "Bash", summary: "rm -rf /tmp/x" })}\n`,
      );
      await waitUntil(() => session.toInfo().permissionState === "pending");
      expect(session.toInfo().attentionKind).toBe("hookNotification");

      // 3. Ack, right inside the still-settling window — must refuse,
      // not silently clear the deferred permission request.
      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/attention/ack`,
      });
      expect(res.statusCode).toBe(409);

      // 4. The deferred permission request must still land once its
      // settle window elapses (ATTENTION_SETTLE_MS.permissionRequest =
      // 2000ms; ATTENTION_EVAL_INTERVAL_MS's real 500ms tick is what
      // actually drains it) — proving ack did NOT drop it. A real-time
      // wait, not waitUntil's own near-instant setImmediate polling —
      // nothing accelerates this window in a real listening-server test.
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      expect(session.toInfo().attentionKind).toBe("permissionRequest");
      const events = app.pty.listEvents();
      expect(events.some((e) => e.kind === "permission_request")).toBe(true);

      socket.destroy();
      await app.close();
    }, 10_000);
  });
});
