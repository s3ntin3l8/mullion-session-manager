import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import type * as ChildProcess from "node:child_process";
import {
  createControlSocketPtyMock,
  mockControlSocketChildProcess,
  TEST_TOKEN,
  injectedOptions,
  waitForReply,
  waitUntil,
  cleanupControlSocketEnv,
  enableControlSocketAuthEnv,
  createRealSession,
  fullScopeSocket,
  sessionScopeSocket,
} from "../helpers/control-socket.js";
import { MullionClient } from "../../src/mcp/client.mjs";
import { applySettingsPatch } from "../../src/services/settings.js";
import { setHermesKey } from "../../src/services/hermes-integration.js";

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

const { buildApp } = await import("../../src/app.js");

describe("session lifecycle ops: core session, review, triage (Phase 4, #187)", () => {
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

  describe("sessions.get", () => {
    it("full scope: returns the session by explicit sessionId", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId } = await createRealSession(app!, ptyMock);
      const socket = await fullScopeSocket(app!);
      socket.write(`${JSON.stringify({ id: 1, op: "sessions.get", body: { sessionId } })}\n`);
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(true);
      expect(reply.status).toBe(200);
      expect((reply.result as { id: number }).id).toBe(sessionId);
      socket.destroy();
    });

    it("full scope: 400s with no sessionId — a full-scope connection has no implicit self", async () => {
      app = await buildApp();
      await app.ready();
      await createRealSession(app!, ptyMock);
      const socket = await fullScopeSocket(app!);
      socket.write(`${JSON.stringify({ id: 1, op: "sessions.get" })}\n`);
      const reply = await waitForReply(socket);
      expect(reply).toEqual({ id: 1, ok: false, status: 400, error: "'sessionId' is required" });
      socket.destroy();
    });

    it("full scope: 400s with an empty-string sessionId, treated the same as omitted rather than a literal target", async () => {
      app = await buildApp();
      await app.ready();
      const socket = await fullScopeSocket(app!);
      socket.write(`${JSON.stringify({ id: 1, op: "sessions.get", body: { sessionId: "" } })}\n`);
      const reply = await waitForReply(socket);
      expect(reply).toEqual({ id: 1, ok: false, status: 400, error: "'sessionId' is required" });
      socket.destroy();
    });

    it("session scope: defaults to the connection's own pinned session with no sessionId given", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId, hookToken } = await createRealSession(app!, ptyMock);
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(`${JSON.stringify({ id: 1, op: "sessions.get" })}\n`);
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(true);
      expect((reply.result as { id: number }).id).toBe(sessionId);
      socket.destroy();
    });

    it("session scope: an explicit sessionId matching its own pin also works", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId, hookToken } = await createRealSession(app!, ptyMock);
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(`${JSON.stringify({ id: 1, op: "sessions.get", body: { sessionId } })}\n`);
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(true);
      socket.destroy();
    });

    it("session scope: rejects targeting a DIFFERENT session id", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const { sessionId: otherSessionId } = await createRealSession(app!, ptyMock);
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(
        `${JSON.stringify({ id: 1, op: "sessions.get", body: { sessionId: otherSessionId } })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply).toEqual({
        id: 1,
        ok: false,
        status: 403,
        error: "session-scoped connections may only target their own session or its children",
      });
      socket.destroy();
    });

    it("full scope: 404s for an unknown session id, same as the REST route", async () => {
      app = await buildApp();
      await app.ready();
      const socket = await fullScopeSocket(app!);
      socket.write(
        `${JSON.stringify({ id: 1, op: "sessions.get", body: { sessionId: 999999 } })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(false);
      expect(reply.status).toBe(404);
      socket.destroy();
    });
  });

  describe("sessions.scrollback", () => {
    it("mode:rendered returns the screen as plain text instead of base64 (issue #2112)", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId } = await createRealSession(app!, ptyMock);
      const socket = await fullScopeSocket(app!);
      socket.write(
        `${JSON.stringify({ id: 1, op: "sessions.scrollback", body: { sessionId, mode: "rendered" } })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(true);
      const result = reply.result as { text?: string; b64?: string };
      expect(result.b64).toBeUndefined();
      expect(result.text).toContain(`scrollback-marker-${sessionId}`);
      socket.destroy();
    });

    it("full scope: returns a base64 scrollback buffer for an explicit sessionId, containing that session's own output", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId } = await createRealSession(app!, ptyMock);
      const socket = await fullScopeSocket(app!);
      socket.write(
        `${JSON.stringify({ id: 1, op: "sessions.scrollback", body: { sessionId } })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(true);
      const { b64 } = reply.result as { b64: string };
      expect(typeof b64).toBe("string");
      expect(Buffer.from(b64, "base64").toString("utf8")).toContain(
        `scrollback-marker-${sessionId}`,
      );
      socket.destroy();
    });

    it("session scope: defaults to its own pinned session with no sessionId given, returning that session's own output", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId, hookToken } = await createRealSession(app!, ptyMock);
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(`${JSON.stringify({ id: 1, op: "sessions.scrollback" })}\n`);
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(true);
      const { b64 } = reply.result as { b64: string };
      expect(Buffer.from(b64, "base64").toString("utf8")).toContain(
        `scrollback-marker-${sessionId}`,
      );
      socket.destroy();
    });

    it("session scope: rejects targeting a different session id", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const { sessionId: otherSessionId } = await createRealSession(app!, ptyMock);
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(
        `${JSON.stringify({ id: 1, op: "sessions.scrollback", body: { sessionId: otherSessionId } })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(false);
      expect(reply.status).toBe(403);
      socket.destroy();
    });
  });

  describe("sessions.transcript", () => {
    // The test sessions run `bash`, which has no transcript (not-supported), so
    // these prove routing, scope and validation; the reading itself is covered
    // in test/services/session-transcript.test.ts.
    it("session scope: defaults to its own session and reaches the route (501 for a shell)", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(`${JSON.stringify({ id: 1, op: "sessions.transcript" })}\n`);
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(false);
      expect(reply.status).toBe(501);
      expect(String(reply.error)).toContain("not-supported");
      socket.destroy();
    });

    it("full scope: names the session explicitly and passes the cursor options through", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId } = await createRealSession(app!, ptyMock);
      const socket = await fullScopeSocket(app!);
      socket.write(
        `${JSON.stringify({
          id: 1,
          op: "sessions.transcript",
          body: { sessionId, afterSeq: 3999, limit: 5, tools: true },
        })}\n`,
      );
      const reply = await waitForReply(socket);
      // Past validation and routing: the shell has no transcript.
      expect(reply.status).toBe(501);
      socket.destroy();
    });

    it("rejects a malformed afterSeq, limit or tools with a 400", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const socket = await sessionScopeSocket(app!, hookToken);
      for (const body of [
        { afterSeq: -1 },
        { afterSeq: "x" },
        { limit: 0 },
        { limit: 501 },
        { tools: "yes" },
      ]) {
        socket.write(`${JSON.stringify({ id: 1, op: "sessions.transcript", body })}\n`);
        const reply = await waitForReply(socket);
        expect(reply.status).toBe(400);
      }
      socket.destroy();
    });

    it("session scope: rejects targeting a different session id", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const { sessionId: otherSessionId } = await createRealSession(app!, ptyMock);
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(
        `${JSON.stringify({ id: 1, op: "sessions.transcript", body: { sessionId: otherSessionId } })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(false);
      expect(reply.status).toBe(403);
      socket.destroy();
    });
  });

  // The test project is /tmp (no git remote), so a request that is routed
  // and pinned correctly reaches the real route and stops at its own 412
  // "no GitHub remote" (once a reviewer is configured) — enough to prove scope + pinning without GitHub or
  // Hermes. The route's own behavior is covered in
  // test/routes/review-request.test.ts.
  describe("reviews.request", () => {
    it("session scope: defaults to its own pinned session and reaches the route", async () => {
      app = await buildApp();
      await app.ready();
      // Past the route's reviewer-configured gate, so it reaches the
      // remote lookup this test asserts on.
      applySettingsPatch(app, {
        reviewRelay: { provider: "hermes", apiUrl: "http://192.168.2.6:8643" },
      });
      setHermesKey(app, "test-key"); // pragma: allowlist secret
      const { hookToken } = await createRealSession(app!, ptyMock);
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(`${JSON.stringify({ id: 1, op: "reviews.request", body: {} })}\n`);
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(false);
      expect(reply.status).toBe(412);
      expect(String(reply.error)).toContain("GitHub remote");
      socket.destroy();
    });

    it("session scope: rejects targeting a different session id", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const { sessionId: otherSessionId } = await createRealSession(app!, ptyMock);
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(
        `${JSON.stringify({ id: 1, op: "reviews.request", body: { sessionId: otherSessionId } })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(false);
      expect(reply.status).toBe(403);
      socket.destroy();
    });

    it("full scope: requires an explicit sessionId", async () => {
      app = await buildApp();
      await app.ready();
      await createRealSession(app!, ptyMock);
      const socket = await fullScopeSocket(app!);
      socket.write(`${JSON.stringify({ id: 1, op: "reviews.request", body: {} })}\n`);
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(false);
      expect(reply.status).toBe(400);
      socket.destroy();
    });

    it("full scope: routes an explicit sessionId and forwards prNumber to the route", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId } = await createRealSession(app!, ptyMock);
      const injectSpy = vi.spyOn(app, "inject");
      const socket = await fullScopeSocket(app!);
      socket.write(
        `${JSON.stringify({ id: 1, op: "reviews.request", body: { sessionId, prNumber: 5 } })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply.status).toBe(412);
      const forwarded = injectedOptions(injectSpy).find(
        (o) => o.url === `/api/sessions/${sessionId}/review-request`,
      );
      expect(forwarded).toBeDefined();
      expect(JSON.parse(String(forwarded!.payload))).toEqual({ prNumber: 5 });
      socket.destroy();
    });
  });

  // #2102 — a worker pushes through Mullion, pinned to its own session.
  describe("tasks.push", () => {
    it("session scope: rejects pushing another session's task", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const { sessionId: otherSessionId } = await createRealSession(app!, ptyMock);
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(
        `${JSON.stringify({ id: 1, op: "tasks.push", body: { sessionId: otherSessionId } })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(false);
      expect(reply.status).toBe(403);
      socket.destroy();
    });

    it("session scope: defaults to its own session and reaches the task-push route", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken, sessionId } = await createRealSession(app!, ptyMock);
      const injectSpy = vi.spyOn(app, "inject");
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(`${JSON.stringify({ id: 1, op: "tasks.push", body: {} })}\n`);
      await waitForReply(socket);
      const forwarded = injectedOptions(injectSpy).find(
        (o) => o.url === `/api/sessions/${sessionId}/task-push`,
      );
      expect(forwarded).toBeDefined();
      expect(forwarded!.method).toBe("POST");
      socket.destroy();
    });

    it("full scope: requires an explicit sessionId", async () => {
      app = await buildApp();
      await app.ready();
      await createRealSession(app!, ptyMock);
      const socket = await fullScopeSocket(app!);
      socket.write(`${JSON.stringify({ id: 1, op: "tasks.push", body: {} })}\n`);
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(false);
      expect(reply.status).toBe(400);
      socket.destroy();
    });
  });

  describe("repo and branch targeting", () => {
    // Each op forwards only the target fields the caller set, as the
    // route's own body/query, so the route's schema is the one validator.
    const forwardedTo = async (op: string, body: Record<string, unknown>, urlPart: string) => {
      app = await buildApp();
      await app.ready();
      const { sessionId } = await createRealSession(app!, ptyMock);
      const injectSpy = vi.spyOn(app, "inject");
      const socket = await fullScopeSocket(app!);
      socket.write(`${JSON.stringify({ id: 1, op, body: { sessionId, ...body } })}\n`);
      await waitForReply(socket);
      socket.destroy();
      return injectedOptions(injectSpy).find((o) =>
        o.url?.startsWith(`/api/sessions/${sessionId}/${urlPart}`),
      );
    };

    it("reviews.request forwards repo and branch with prNumber", async () => {
      const forwarded = await forwardedTo(
        "reviews.request",
        { prNumber: 7, repo: "acme/.github", branch: "feat/ci", ignored: "x" },
        "review-request",
      );
      expect(JSON.parse(String(forwarded!.payload))).toEqual({
        prNumber: 7,
        repo: "acme/.github",
        branch: "feat/ci",
      });
    });

    it("reviews.request forwards force", async () => {
      const request = await forwardedTo(
        "reviews.request",
        { prNumber: 7, force: true },
        "review-request",
      );
      expect(JSON.parse(String(request!.payload))).toEqual({ prNumber: 7, force: true });
    });

    it("reviews.status never forwards force (it is a request-only override)", async () => {
      const status = await forwardedTo(
        "reviews.status",
        { prNumber: 7, force: true },
        "review-request",
      );
      expect(status!.url).toContain("prNumber=7");
      expect(status!.url).not.toContain("force");
    });

    it("reviews.status puts the target fields in the query string, encoded", async () => {
      const forwarded = await forwardedTo(
        "reviews.status",
        { repo: "acme/.github", branch: "feat/a b" },
        "review-request",
      );
      expect(forwarded!.method).toBe("GET");
      expect(forwarded!.url).toMatch(/\?repo=acme%2F\.github&branch=feat%2Fa%20b$/);
    });

    it("reviews.status keeps a bare URL when nothing is targeted", async () => {
      const forwarded = await forwardedTo("reviews.status", {}, "review-request");
      expect(forwarded!.url).toMatch(/\/review-request$/);
    });

    it("triage.request forwards repo only", async () => {
      const request = await forwardedTo(
        "triage.request",
        { issueNumber: 5, repo: "acme/.github", branch: "dropped" },
        "triage-request",
      );
      expect(JSON.parse(String(request!.payload))).toEqual({
        issueNumber: 5,
        repo: "acme/.github",
      });
    });

    it("triage.status forwards repo only, in the query", async () => {
      const status = await forwardedTo(
        "triage.status",
        { issueNumber: 5, repo: "acme/.github", branch: "dropped" },
        "triage-request",
      );
      expect(status!.url).toMatch(/\?issueNumber=5&repo=acme%2F\.github$/);
    });
  });

  describe("reviews.status / reviews.stop", () => {
    it("session scope: status routes to its own pinned session's review-request GET", async () => {
      app = await buildApp();
      await app.ready();
      applySettingsPatch(app, {
        reviewRelay: { provider: "hermes", apiUrl: "http://192.168.2.6:8643" },
      });
      setHermesKey(app, "test-key"); // pragma: allowlist secret
      const { hookToken, sessionId } = await createRealSession(app!, ptyMock);
      const injectSpy = vi.spyOn(app, "inject");
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(`${JSON.stringify({ id: 1, op: "reviews.status", body: { prNumber: 5 } })}\n`);
      const reply = await waitForReply(socket);
      expect(reply.status).toBe(412); // past the reviewer gate, stops at "no GitHub remote"
      const forwarded = injectedOptions(injectSpy).find((o) =>
        o.url?.startsWith(`/api/sessions/${sessionId}/review-request`),
      );
      expect(forwarded).toMatchObject({
        method: "GET",
        url: `/api/sessions/${sessionId}/review-request?prNumber=5`,
      });
      socket.destroy();
    });

    it("session scope: status without a prNumber sends no query string", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken, sessionId } = await createRealSession(app!, ptyMock);
      const injectSpy = vi.spyOn(app, "inject");
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(`${JSON.stringify({ id: 1, op: "reviews.status", body: {} })}\n`);
      await waitForReply(socket);
      expect(
        injectedOptions(injectSpy).some(
          (o) => o.url === `/api/sessions/${sessionId}/review-request`,
        ),
      ).toBe(true);
      socket.destroy();
    });

    it("session scope: stop requires a runId and rejects targeting another session", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const { sessionId: otherSessionId } = await createRealSession(app!, ptyMock);
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(`${JSON.stringify({ id: 1, op: "reviews.stop", body: {} })}\n`);
      expect((await waitForReply(socket)).status).toBe(400);
      socket.write(
        `${JSON.stringify({ id: 2, op: "reviews.stop", body: { runId: "r", sessionId: otherSessionId } })}\n`,
      );
      expect((await waitForReply(socket)).status).toBe(403);
      socket.destroy();
    });

    it("session scope: stop forwards the runId for the pinned session", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken, sessionId } = await createRealSession(app!, ptyMock);
      const injectSpy = vi.spyOn(app, "inject");
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(`${JSON.stringify({ id: 1, op: "reviews.stop", body: { runId: "run_1" } })}\n`);
      await waitForReply(socket);
      const forwarded = injectedOptions(injectSpy).find(
        (o) => o.url === `/api/sessions/${sessionId}/review-stop`,
      );
      expect(JSON.parse(String(forwarded!.payload))).toEqual({ runId: "run_1" });
      socket.destroy();
    });
  });

  describe("triage.request / triage.status", () => {
    it("session scope: triage.request reaches the route for the pinned session", async () => {
      app = await buildApp();
      await app.ready();
      applySettingsPatch(app, {
        reviewRelay: { provider: "hermes", apiUrl: "http://192.168.2.6:8643" },
      });
      setHermesKey(app, "test-key"); // pragma: allowlist secret
      const { hookToken, sessionId } = await createRealSession(app!, ptyMock);
      const injectSpy = vi.spyOn(app, "inject");
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(
        `${JSON.stringify({ id: 1, op: "triage.request", body: { issueNumber: 12 } })}\n`,
      );
      const reply = await waitForReply(socket);
      // Past the reviewer gate, stopped by the route's own "no GitHub remote".
      expect(reply.status).toBe(412);
      const forwarded = injectedOptions(injectSpy).find(
        (o) => o.url === `/api/sessions/${sessionId}/triage-request`,
      );
      expect(forwarded).toMatchObject({ method: "POST" });
      expect(JSON.parse(String(forwarded!.payload))).toEqual({ issueNumber: 12 });
      socket.destroy();
    });

    it("session scope: triage.status forwards the issue number", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken, sessionId } = await createRealSession(app!, ptyMock);
      const injectSpy = vi.spyOn(app, "inject");
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(
        `${JSON.stringify({ id: 1, op: "triage.status", body: { issueNumber: 12 } })}\n`,
      );
      await waitForReply(socket);
      const forwarded = injectedOptions(injectSpy).find((o) =>
        o.url?.startsWith(`/api/sessions/${sessionId}/triage-request`),
      );
      expect(forwarded).toMatchObject({
        method: "GET",
        url: `/api/sessions/${sessionId}/triage-request?issueNumber=12`,
      });
      socket.destroy();
    });

    it("session scope: requires an issueNumber", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(`${JSON.stringify({ id: 1, op: "triage.request", body: {} })}\n`);
      expect((await waitForReply(socket)).status).toBe(400);
      socket.write(`${JSON.stringify({ id: 2, op: "triage.status", body: { issueNumber: 0 } })}\n`);
      expect((await waitForReply(socket)).status).toBe(400);
      socket.destroy();
    });

    it("session scope: rejects targeting a different session id", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const { sessionId: otherSessionId } = await createRealSession(app!, ptyMock);
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(
        `${JSON.stringify({ id: 1, op: "triage.request", body: { issueNumber: 12, sessionId: otherSessionId } })}\n`,
      );
      expect((await waitForReply(socket)).status).toBe(403);
      socket.destroy();
    });
  });

  describe("sessions.rename", () => {
    it("full scope: renames by explicit sessionId", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId } = await createRealSession(app!, ptyMock);
      const socket = await fullScopeSocket(app!);
      socket.write(
        `${JSON.stringify({ id: 1, op: "sessions.rename", body: { sessionId, name: "renamed" } })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(true);
      expect((reply.result as { name: string }).name).toBe("renamed");
      socket.destroy();
    });

    it("session scope: renames its own pinned session with no sessionId given", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(`${JSON.stringify({ id: 1, op: "sessions.rename", body: { name: "self" } })}\n`);
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(true);
      expect((reply.result as { name: string }).name).toBe("self");
      socket.destroy();
    });

    it("400s when 'name' is missing", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId } = await createRealSession(app!, ptyMock);
      const socket = await fullScopeSocket(app!);
      socket.write(`${JSON.stringify({ id: 1, op: "sessions.rename", body: { sessionId } })}\n`);
      const reply = await waitForReply(socket);
      expect(reply).toEqual({ id: 1, ok: false, status: 400, error: "'name' is required" });
      socket.destroy();
    });

    it("session scope: rejects renaming a different session id", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const { sessionId: otherSessionId } = await createRealSession(app!, ptyMock);
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(
        `${JSON.stringify({ id: 1, op: "sessions.rename", body: { sessionId: otherSessionId, name: "x" } })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(false);
      expect(reply.status).toBe(403);
      socket.destroy();
    });
  });

  describe("sessions.create", () => {
    it("full scope: creates a session", async () => {
      app = await buildApp();
      await app.ready();
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
        payload: { allowDuplicate: true, createDir: true, name: "p2", cwd: "/tmp" },
      });
      const socket = await fullScopeSocket(app!);
      socket.write(
        `${JSON.stringify({
          id: 1,
          op: "sessions.create",
          body: { projectId: project.json().id, command: "bash" },
        })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(true);
      expect(reply.status).toBe(201);
      socket.destroy();
    });

    it("reshapes the REST route's own validation error (missing projectId) into the socket's error envelope", async () => {
      app = await buildApp();
      await app.ready();
      const socket = await fullScopeSocket(app!);
      socket.write(
        `${JSON.stringify({ id: 1, op: "sessions.create", body: { command: "bash" } })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(false);
      expect(reply.status).toBe(400);
      expect(typeof reply.error).toBe("string");
      socket.destroy();
    });

    it("session scope: rejected — full-scope-only op", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(
        `${JSON.stringify({ id: 1, op: "sessions.create", body: { projectId: 1, command: "bash" } })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply).toEqual({
        id: 1,
        ok: false,
        status: 403,
        error: "not permitted for this connection's scope",
      });
      socket.destroy();
    });
  });

  describe("sessions.kill", () => {
    it("full scope: kills by explicit sessionId", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId } = await createRealSession(app!, ptyMock);
      const socket = await fullScopeSocket(app!);
      socket.write(`${JSON.stringify({ id: 1, op: "sessions.kill", body: { sessionId } })}\n`);
      const reply = await waitForReply(socket);
      expect(reply).toEqual({ id: 1, ok: true, status: 204, result: "" });
      socket.destroy();
    });

    it("full scope: 400s with no sessionId", async () => {
      app = await buildApp();
      await app.ready();
      const socket = await fullScopeSocket(app!);
      socket.write(`${JSON.stringify({ id: 1, op: "sessions.kill" })}\n`);
      const reply = await waitForReply(socket);
      expect(reply).toEqual({ id: 1, ok: false, status: 400, error: "'sessionId' is required" });
      socket.destroy();
    });

    it("full scope: 400s with an empty-string sessionId, rather than reaching app.inject() with an empty path segment", async () => {
      app = await buildApp();
      await app.ready();
      const socket = await fullScopeSocket(app!);
      socket.write(`${JSON.stringify({ id: 1, op: "sessions.kill", body: { sessionId: "" } })}\n`);
      const reply = await waitForReply(socket);
      expect(reply).toEqual({ id: 1, ok: false, status: 400, error: "'sessionId' is required" });
      socket.destroy();
    });

    it("session scope: rejected — a session may not kill itself through this socket", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId, hookToken } = await createRealSession(app!, ptyMock);
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(`${JSON.stringify({ id: 1, op: "sessions.kill", body: { sessionId } })}\n`);
      const reply = await waitForReply(socket);
      expect(reply).toEqual({
        id: 1,
        ok: false,
        status: 403,
        error: "session-scoped connections may only target a child of their own session",
      });
      socket.destroy();
    });

    // Phase 5 (Track B, issue #196 5.6) — body.cascade rides through as a
    // querystring on the proxied DELETE (see control-socket.ts's own
    // comment for why: a DELETE-with-body doesn't carry through
    // app.inject() the way a querystring does).
    it("full scope: body.cascade='kill' cascades to a live child", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId: parentId } = await createRealSession(app!, ptyMock);
      const spawnSocket = await fullScopeSocket(app!);
      spawnSocket.write(
        `${JSON.stringify({
          id: 1,
          op: "sessions.spawn_child",
          body: { command: "bash", parentSessionId: parentId },
        })}\n`,
      );
      const spawnReply = await waitForReply(spawnSocket);
      const childId = (spawnReply.result as { id: number }).id;
      spawnSocket.destroy();

      const socket = await fullScopeSocket(app!);
      socket.write(
        `${JSON.stringify({
          id: 1,
          op: "sessions.kill",
          body: { sessionId: parentId, cascade: "kill" },
        })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply).toEqual({ id: 1, ok: true, status: 204, result: "" });
      socket.destroy();

      const child = await app!.inject({
        method: "GET",
        url: `/api/sessions/${childId}`,
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(child.json().status).toBe("killed");
    });

    // Independent review, PR #426 — an invalid value used to fall through
    // silently to the REST route's own default ("detach") instead of
    // surfacing an error, unlike the identical bad input over REST
    // directly (sessions-parent-child.test.ts's "rejects an invalid ?cascade= value").
    it("400s an invalid body.cascade value, rather than silently defaulting", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId } = await createRealSession(app!, ptyMock);
      const socket = await fullScopeSocket(app!);
      socket.write(
        `${JSON.stringify({
          id: 1,
          op: "sessions.kill",
          body: { sessionId, cascade: "bogus" },
        })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply).toEqual({
        id: 1,
        ok: false,
        status: 400,
        error: "'cascade' must be 'detach' or 'kill'",
      });
      socket.destroy();
    });
  });

  // Hermes review, PR #1292 — MullionClient's own-session fallback
  // (issue #1291) matches the exact error strings resolveTargetSessionId/
  // resolveTargetProjectId/resolveParentSessionId produce above, hardcoded
  // a second time in src/mcp/client.mjs with nothing tying the two
  // together. Exercising the real MullionClient against this real,
  // in-process server (not a hand-typed mock) means a future reword of
  // any of those three error messages fails this test immediately,
  // instead of silently disabling the fallback with no signal.
  describe("MullionClient own-session fallback (issue #1291)", () => {
    it("getScrollback/listActions/spawnChildSession all resolve via ownSessionId when full scope has no explicit id", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId } = await createRealSession(app!, ptyMock);
      const client = new MullionClient({
        MULLION_SOCKET_PATH: app!.pty.controlSocketPath,
        MULLION_AUTH_TOKEN: TEST_TOKEN,
        MULLION_SESSION_ID: String(sessionId),
      });

      const scrollback = await client.getScrollback();
      expect(Buffer.from(scrollback.b64, "base64").toString("utf8")).toContain(
        `scrollback-marker-${sessionId}`,
      );

      const actions = await client.listActions();
      expect(Array.isArray(actions)).toBe(true);

      const before = ptyMock.spawnedPtys.length;
      const child = await client.spawnChildSession({ command: "bash" });
      expect(child.parentSessionId).toBe(sessionId);
      await waitUntil(() => ptyMock.spawnedPtys.length > before);
    });
  });
});
