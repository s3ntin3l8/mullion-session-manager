import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import type * as ChildProcess from "node:child_process";
import { warmSqliteBinding } from "../helpers/app.js";
import {
  createControlSocketPtyMock,
  mockControlSocketChildProcess,
  createControlSocketPlaywrightMock,
  TEST_TOKEN,
  waitForReply,
  cleanupControlSocketEnv,
  enableControlSocketAuthEnv,
  createRealSession,
  fullScopeSocket,
  sessionScopeSocket,
} from "../helpers/control-socket.js";

const ptyMock = createControlSocketPtyMock();
vi.mock("../../src/services/hook-adapters/codex-trust.js", () => ({
  getCodexHookTrust: () => "pending" as const,
}));
vi.mock("../../src/services/bundle-sync.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isBundleSyncedFor: () => false,
}));
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));
vi.mock("node:child_process", async (importOriginal) =>
  mockControlSocketChildProcess(await importOriginal<typeof ChildProcess>()),
);
vi.mock("playwright", () => createControlSocketPlaywrightMock());

const { buildApp } = await import("../../src/app.js");

describe("browser and device ops (Phase 4, #189)", () => {
  let app: Awaited<ReturnType<typeof buildApp>> | null = null;

  beforeEach(() => {
    enableControlSocketAuthEnv();
  });

  afterEach(async () => {
    if (app) await app.close();
    app = null;
    ptyMock.spawnedPtys.length = 0;
    cleanupControlSocketEnv();
  });

  describe("browser ops (Phase 4, #189)", () => {
    beforeEach(() => {
      process.env.BROWSER_ENABLED = "true";
    });
    afterEach(() => {
      delete process.env.BROWSER_ENABLED;
    });

    it("browser.action (full scope): dispatches to POST /api/sessions/:id/browser and shapes the response", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId } = await createRealSession(app!, ptyMock);
      const socket = await fullScopeSocket(app!);
      socket.write(
        `${JSON.stringify({
          id: 1,
          op: "browser.action",
          body: { sessionId, action: "navigate", url: "http://example.com/" },
        })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(true);
      expect(reply.status).toBe(200);
      expect(reply.result).toMatchObject({ ok: true, url: "http://example.com/" });
      socket.destroy();
    });

    it("browser.action (session scope): omits sessionId, defaults to the connection's own pinned session", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(
        `${JSON.stringify({ id: 1, op: "browser.action", body: { action: "snapshot" } })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(true);
      socket.destroy();
    });

    it("browser.action (session scope): naming a DIFFERENT session's id gets a 403, never a silent redirect", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const { sessionId: otherSessionId } = await createRealSession(app!, ptyMock);
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(
        `${JSON.stringify({
          id: 1,
          op: "browser.action",
          body: { sessionId: otherSessionId, action: "snapshot" },
        })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply).toEqual({
        id: 1,
        ok: false,
        status: 403,
        error: "session-scoped connections may only target their own session",
      });
      socket.destroy();
    });

    it("browser.action (full scope): a non-navigate action (eval) forwards its own body fields correctly", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId } = await createRealSession(app!, ptyMock);
      const socket = await fullScopeSocket(app!);
      socket.write(
        `${JSON.stringify({
          id: 1,
          op: "browser.action",
          body: { sessionId, action: "eval", script: "1+1" },
        })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(true);
      expect(reply.result).toMatchObject({ result: "eval-result" });
      socket.destroy();
    });

    it("browser.action 400s when BROWSER_ENABLED is false", async () => {
      delete process.env.BROWSER_ENABLED;
      app = await buildApp();
      await app.ready();
      const { sessionId } = await createRealSession(app!, ptyMock);
      const socket = await fullScopeSocket(app!);
      socket.write(
        `${JSON.stringify({
          id: 1,
          op: "browser.action",
          body: { sessionId, action: "snapshot" },
        })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(false);
      expect(reply.status).toBe(400);
      socket.destroy();
    });

    it("browser.find (full scope): dispatches to POST /api/sessions/:id/browser/find", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId } = await createRealSession(app!, ptyMock);
      const socket = await fullScopeSocket(app!);
      socket.write(
        `${JSON.stringify({
          id: 1,
          op: "browser.find",
          body: { sessionId, by: "text", value: "Submit" },
        })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(true);
      expect(reply.result).toMatchObject({ ok: true, matchCount: 0, elements: [] });
      socket.destroy();
    });

    it("browser.find (session scope): naming a DIFFERENT session's id gets a 403", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const { sessionId: otherSessionId } = await createRealSession(app!, ptyMock);
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(
        `${JSON.stringify({
          id: 1,
          op: "browser.find",
          body: { sessionId: otherSessionId, by: "text", value: "x" },
        })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply).toEqual({
        id: 1,
        ok: false,
        status: 403,
        error: "session-scoped connections may only target their own session",
      });
      socket.destroy();
    });

    it("browser.bindings (full scope): dispatches to GET /api/sessions/:id/browser", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId } = await createRealSession(app!, ptyMock);
      const socket = await fullScopeSocket(app!);
      socket.write(`${JSON.stringify({ id: 1, op: "browser.bindings", body: { sessionId } })}\n`);
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(true);
      expect(reply.result).toEqual([]);
      socket.destroy();
    });

    it("browser.bindings (full scope): 400s when sessionId is omitted", async () => {
      app = await buildApp();
      await app.ready();
      const socket = await fullScopeSocket(app!);
      socket.write(`${JSON.stringify({ id: 1, op: "browser.bindings" })}\n`);
      const reply = await waitForReply(socket);
      expect(reply).toEqual({
        id: 1,
        ok: false,
        status: 400,
        error: "'sessionId' is required",
      });
      socket.destroy();
    });

    it("browser.bindings (session scope): naming a DIFFERENT session's id gets a 403, never a silent redirect", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const { sessionId: otherSessionId } = await createRealSession(app!, ptyMock);
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(
        `${JSON.stringify({ id: 1, op: "browser.bindings", body: { sessionId: otherSessionId } })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply).toEqual({
        id: 1,
        ok: false,
        status: 403,
        error: "session-scoped connections may only target their own session",
      });
      socket.destroy();
    });
  });

  describe("device ops", () => {
    // Issue #1720 (roadmap 8.6) — the Android device panel is LINUX-ONLY
    // (its emulator runs in a `systemd --user` scope), so on a non-Linux
    // host the panel is off and the device routes answer 400. These ops
    // assert the panel's ENABLED behaviour, so the host platform is
    // stubbed for this describe — the same technique
    // test/services/scope.test.ts uses for its own darwin case.
    let originalPlatform: NodeJS.Platform;
    beforeEach(async () => {
      // The native SQLite binding must be loaded BEFORE the platform is
      // stubbed — see warmSqliteBinding()'s own doc comment.
      await warmSqliteBinding();
      originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      process.env.DEVICE_ENABLED = "true";
    });
    afterEach(() => {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
      delete process.env.DEVICE_ENABLED;
    });

    async function createRealDevice(): Promise<number> {
      const authHeaders = { authorization: `Bearer ${TEST_TOKEN}` };
      const created = await app!.inject({
        method: "POST",
        url: "/api/devices",
        headers: authHeaders,
        payload: { avdName: "dev35" },
      });
      return created.json().id as number;
    }

    it("device.list (full scope): dispatches to GET /api/devices", async () => {
      app = await buildApp();
      await app.ready();
      await createRealDevice();
      const socket = await fullScopeSocket(app!);
      socket.write(`${JSON.stringify({ id: 1, op: "device.list" })}\n`);
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(true);
      expect(Array.isArray(reply.result)).toBe(true);
      expect(reply.result).toHaveLength(1);
      socket.destroy();
    });

    it("device.action (full scope): dispatches to POST /api/devices/:id/action with an explicit deviceId", async () => {
      app = await buildApp();
      await app.ready();
      const deviceId = await createRealDevice();
      const socket = await fullScopeSocket(app!);
      socket.write(
        `${JSON.stringify({
          id: 1,
          op: "device.action",
          body: { deviceId, action: "screenshot" },
        })}\n`,
      );
      const reply = await waitForReply(socket);
      // No live adb connection in this test environment — the point of
      // this test is that the op DISPATCHES with deviceId correctly
      // stripped from the forwarded action body, not that the action
      // itself succeeds.
      expect(reply.ok).toBe(false);
      expect(reply.status).toBe(400);
      socket.destroy();
    });

    it("device.action 400s with 'deviceId is required' when omitted, at either scope", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const fullSocket = await fullScopeSocket(app!);
      fullSocket.write(
        `${JSON.stringify({ id: 1, op: "device.action", body: { action: "screenshot" } })}\n`,
      );
      expect(await waitForReply(fullSocket)).toEqual({
        id: 1,
        ok: false,
        status: 400,
        error: "'deviceId' is required",
      });
      fullSocket.destroy();

      const sessionSocket = await sessionScopeSocket(app!, hookToken);
      sessionSocket.write(
        `${JSON.stringify({ id: 1, op: "device.action", body: { action: "screenshot" } })}\n`,
      );
      expect(await waitForReply(sessionSocket)).toEqual({
        id: 1,
        ok: false,
        status: 400,
        error: "'deviceId' is required",
      });
      sessionSocket.destroy();
    });

    it("device.action (session scope): an explicit deviceId is NOT restricted to any 'own' device — devices have no per-session ownership", async () => {
      app = await buildApp();
      await app.ready();
      const deviceId = await createRealDevice();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(
        `${JSON.stringify({
          id: 1,
          op: "device.action",
          body: { deviceId, action: "screenshot" },
        })}\n`,
      );
      const reply = await waitForReply(socket);
      // Reaches the real route (400 for "no live adb connection", not 403
      // for an ownership check that doesn't exist for devices) — see
      // control-socket.ts's own comment on device.action for why.
      expect(reply.ok).toBe(false);
      expect(reply.status).toBe(400);
      expect(reply.error).not.toMatch(/own session/);
      socket.destroy();
    });

    it("device.create (session scope): reachable with no full-scope requirement for an EMULATOR", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(
        `${JSON.stringify({ id: 1, op: "device.create", body: { avdName: "dev35" } })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(true);
      expect(reply.status).toBe(201);
      socket.destroy();
    });

    // Hermes review on this PR: `kind: "physical"` makes the host's adb
    // server dial an ARBITRARY address a caller supplies — an outbound-
    // dial/internal-network-probe primitive the emulator branch above
    // never had — so it gets the same full-scope-only gate as device.pair
    // below, unlike every other device.* op's session-scope reachability.
    it("device.create (session scope): rejected for kind: physical — a bigger blast radius than the emulator path", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(
        `${JSON.stringify({
          id: 1,
          op: "device.create",
          body: { kind: "physical", address: "192.168.1.23:37251" },
        })}\n`,
      );
      expect(await waitForReply(socket)).toEqual({
        id: 1,
        ok: false,
        status: 403,
        error: "this operation requires full-scope credentials",
      });
      socket.destroy();
    });

    it("device.create (full scope): kind: physical dispatches to POST /api/devices", async () => {
      app = await buildApp();
      await app.ready();
      const socket = await fullScopeSocket(app!);
      socket.write(
        `${JSON.stringify({
          id: 1,
          op: "device.create",
          body: { kind: "physical", address: "192.168.1.23:37251" },
        })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(true);
      expect(reply.status).toBe(201);
      socket.destroy();
    });

    it("device.pair (full scope): dispatches to POST /api/devices/pair", async () => {
      app = await buildApp();
      await app.ready();
      const socket = await fullScopeSocket(app!);
      socket.write(
        `${JSON.stringify({
          id: 1,
          op: "device.pair",
          body: { pairingAddress: "192.168.1.23:41234", pairingCode: "123456" },
        })}\n`,
      );
      const reply = await waitForReply(socket);
      // No real adb server in this test environment — pair() itself
      // rejects, surfacing as a 400 from routes/devices.ts's own catch.
      // The point of this test is that the op DISPATCHES at full scope at
      // all, not that pairing against real hardware succeeds.
      expect(reply.ok).toBe(false);
      expect(reply.status).toBe(400);
      socket.destroy();
    });

    it("device.pair (session scope): rejected — unlike every other device.* op, this one is full-scope only", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(
        `${JSON.stringify({
          id: 1,
          op: "device.pair",
          body: { pairingAddress: "192.168.1.23:41234", pairingCode: "123456" },
        })}\n`,
      );
      expect(await waitForReply(socket)).toEqual({
        id: 1,
        ok: false,
        status: 403,
        error: "not permitted for this connection's scope",
      });
      socket.destroy();
    });

    it("device.pair-and-connect (full scope): dispatches to POST /api/devices/pair-and-connect", async () => {
      app = await buildApp();
      await app.ready();
      const socket = await fullScopeSocket(app!);
      socket.write(
        `${JSON.stringify({
          id: 1,
          op: "device.pair-and-connect",
          body: {
            pairingAddress: "192.168.1.23:41234",
            connectAddress: "192.168.1.23:37251",
            pairingCode: "123456",
          },
        })}\n`,
      );
      // No real adb server in this test env — the route's own validation,
      // a stale row collision from a sibling test, or pair()'s own
      // network failure can each surface as 400/409/500. The point is
      // that the op DISPATCHES at full scope, not that the pairing
      // succeeds (that's covered end-to-end by test/routes/
      // devices-discovery.test.ts with mocked adb).
      const reply = await waitForReply(socket);
      expect([200, 201, 400, 409, 500]).toContain(reply.status);
      socket.destroy();
    });

    it("device.pair-and-connect (session scope): rejected — same full-only gate as device.pair", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(
        `${JSON.stringify({
          id: 1,
          op: "device.pair-and-connect",
          body: {
            pairingAddress: "192.168.1.23:41234",
            connectAddress: "192.168.1.23:37251",
            pairingCode: "123456",
          },
        })}\n`,
      );
      expect(await waitForReply(socket)).toEqual({
        id: 1,
        ok: false,
        status: 403,
        error: "not permitted for this connection's scope",
      });
      socket.destroy();
    });

    it("device.discovered (full scope): dispatches to GET /api/devices/discovered and returns an array", async () => {
      app = await buildApp();
      await app.ready();
      const socket = await fullScopeSocket(app!);
      socket.write(`${JSON.stringify({ id: 1, op: "device.discovered" })}\n`);
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(true);
      expect(reply.status).toBe(200);
      expect(Array.isArray(reply.result)).toBe(true);
      socket.destroy();
    });

    it("device.discovered (session scope): dispatches at session scope — read-only, no network side-effects", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(`${JSON.stringify({ id: 1, op: "device.discovered" })}\n`);
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(true);
      expect(reply.status).toBe(200);
      expect(Array.isArray(reply.result)).toBe(true);
      socket.destroy();
    });

    it("device.terminate 400s with 'deviceId is required' when omitted", async () => {
      app = await buildApp();
      await app.ready();
      const socket = await fullScopeSocket(app!);
      socket.write(`${JSON.stringify({ id: 1, op: "device.terminate" })}\n`);
      expect(await waitForReply(socket)).toEqual({
        id: 1,
        ok: false,
        status: 400,
        error: "'deviceId' is required",
      });
      socket.destroy();
    });

    // The op keeps its historical name but was repointed at the new
    // POST /:id/stop (the reversible teardown) rather than DELETE — see
    // control-socket.ts's own comment on why: its documented meaning
    // ("flips the row to killed and tears the device down") stays exactly
    // true, so the wire API doesn't break, while DELETE becomes the
    // irreversible, full-scope-only remove further down.
    it("device.terminate (session scope): dispatches to POST /api/devices/:id/stop and KEEPS the row", async () => {
      app = await buildApp();
      await app.ready();
      const deviceId = await createRealDevice();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(`${JSON.stringify({ id: 1, op: "device.terminate", body: { deviceId } })}\n`);
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(true);
      expect(reply.status).toBe(204);
      socket.destroy();

      const authHeaders = { authorization: `Bearer ${TEST_TOKEN}` };
      const after = await app.inject({
        method: "GET",
        url: `/api/devices/${deviceId}`,
        headers: authHeaders,
      });
      expect(after.statusCode).toBe(200);
      expect(after.json().status).toBe("killed");
    });

    it("device.start 400s with 'deviceId is required' when omitted", async () => {
      app = await buildApp();
      await app.ready();
      const socket = await fullScopeSocket(app!);
      socket.write(`${JSON.stringify({ id: 1, op: "device.start" })}\n`);
      expect(await waitForReply(socket)).toEqual({
        id: 1,
        ok: false,
        status: 400,
        error: "'deviceId' is required",
      });
      socket.destroy();
    });

    it("device.start (session scope): dispatches to POST /api/devices/:id/start with an explicit deviceId", async () => {
      app = await buildApp();
      await app.ready();
      const deviceId = await createRealDevice();
      // Park it in the stopped state so start has something to reverse.
      const authHeaders = { authorization: `Bearer ${TEST_TOKEN}` };
      await app.inject({
        method: "POST",
        url: `/api/devices/${deviceId}/stop`,
        headers: authHeaders,
      });
      const { hookToken } = await createRealSession(app!, ptyMock);
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(`${JSON.stringify({ id: 1, op: "device.start", body: { deviceId } })}\n`);
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(true);
      expect(reply.status).toBe(200);
      expect((reply.result as { status: string }).status).toBe("active");
      socket.destroy();
    });

    it("device.delete 400s with 'deviceId is required' when omitted", async () => {
      app = await buildApp();
      await app.ready();
      const socket = await fullScopeSocket(app!);
      socket.write(`${JSON.stringify({ id: 1, op: "device.delete" })}\n`);
      expect(await waitForReply(socket)).toEqual({
        id: 1,
        ok: false,
        status: 400,
        error: "'deviceId' is required",
      });
      socket.destroy();
    });

    // Full-scope only — same blast-radius reasoning as device.pair: this
    // one is irreversible (the row is gone) rather than stop's reversible
    // flip, so a session-scoped agent gets the same 403.
    it("device.delete (session scope): rejected — full scope only", async () => {
      app = await buildApp();
      await app.ready();
      const deviceId = await createRealDevice();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(`${JSON.stringify({ id: 1, op: "device.delete", body: { deviceId } })}\n`);
      expect(await waitForReply(socket)).toMatchObject({ ok: false, status: 403 });
      socket.destroy();

      const authHeaders = { authorization: `Bearer ${TEST_TOKEN}` };
      const after = await app.inject({
        method: "GET",
        url: `/api/devices/${deviceId}`,
        headers: authHeaders,
      });
      expect(after.statusCode).toBe(200);
    });

    it("device.delete (full scope): dispatches to DELETE /api/devices/:id and the row is gone", async () => {
      app = await buildApp();
      await app.ready();
      const deviceId = await createRealDevice();
      const socket = await fullScopeSocket(app!);
      socket.write(`${JSON.stringify({ id: 1, op: "device.delete", body: { deviceId } })}\n`);
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(true);
      expect(reply.status).toBe(204);
      socket.destroy();

      const authHeaders = { authorization: `Bearer ${TEST_TOKEN}` };
      const after = await app.inject({
        method: "GET",
        url: `/api/devices/${deviceId}`,
        headers: authHeaders,
      });
      expect(after.statusCode).toBe(404);
    });

    it("device.get 400s with 'deviceId is required' when omitted", async () => {
      app = await buildApp();
      await app.ready();
      const socket = await fullScopeSocket(app!);
      socket.write(`${JSON.stringify({ id: 1, op: "device.get" })}\n`);
      expect(await waitForReply(socket)).toEqual({
        id: 1,
        ok: false,
        status: 400,
        error: "'deviceId' is required",
      });
      socket.destroy();
    });

    it("device.get (session scope): dispatches to GET /api/devices/:id with an explicit deviceId", async () => {
      app = await buildApp();
      await app.ready();
      const deviceId = await createRealDevice();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(`${JSON.stringify({ id: 1, op: "device.get", body: { deviceId } })}\n`);
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(true);
      expect(reply.status).toBe(200);
      expect((reply.result as { id: number }).id).toBe(deviceId);
      socket.destroy();
    });
  });
});
