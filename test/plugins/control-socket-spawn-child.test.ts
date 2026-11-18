import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import type * as ChildProcess from "node:child_process";
import {
  createControlSocketPtyMock,
  mockControlSocketChildProcess,
  TEST_TOKEN,
  injectedOptions,
  waitForReply,
  waitUntil,
  collectFrames,
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

const { buildApp } = await import("../../src/app.js");
const { OPS } = await import("../../src/plugins/control-socket.js");
const { sessions } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");

describe("session lifecycle ops: sessions.spawn_child", () => {
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

  // Phase 5 (Track B, issue #193 5.3b) — the narrow, session-scope-reachable
  // path to a real child session, unlike sessions.create above.
  describe("sessions.spawn_child", () => {
    it("session scope: forwards only the allowlisted fields (#1518)", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const injectSpy = vi.spyOn(app, "inject");
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(
        `${JSON.stringify({
          id: 1,
          op: "sessions.spawn_child",
          body: {
            command: "bash",
            name: "kid",
            nameLocked: true,
            futureField: "x",
            skipPermissions: true,
          },
        })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(true);
      const post = injectedOptions(injectSpy).find(
        (o) => o.method === "POST" && o.url === "/api/sessions",
      )!;
      expect(Object.keys(JSON.parse(String(post.payload))).sort()).toEqual(
        // Issue #1733 — `skipPermissions` joins the allowlist: it is
        // capped by the parent's own value server-side, so forwarding it
        // can only narrow. `kind` does NOT join — see the "silently strips
        // kind" test below.
        // `nameLocked` is derived server-side from a supplied `name` (#2112),
        // never taken from the caller's own `nameLocked: true` above.
        ["command", "name", "nameLocked", "parentSessionId", "projectId", "skipPermissions"].sort(),
      );
      socket.destroy();
    });

    it("pins a supplied name (nameLocked) so the agent's auto-title can't replace it (#2112)", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const injectSpy = vi.spyOn(app, "inject");
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(
        `${JSON.stringify({
          id: 1,
          op: "sessions.spawn_child",
          body: { command: "bash", name: "1854 mac probe", nameLocked: false },
        })}\n`,
      );
      await waitForReply(socket);
      const post = injectedOptions(injectSpy).find(
        (o) => o.method === "POST" && o.url === "/api/sessions",
      )!;
      expect(JSON.parse(String(post.payload)).nameLocked).toBe(true);
      socket.destroy();
    });

    it("leaves nameLocked unset when no name (or a blank one) is supplied (#2112)", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const injectSpy = vi.spyOn(app, "inject");
      const socket = await sessionScopeSocket(app!, hookToken);
      for (const body of [{ command: "bash" }, { command: "bash", name: "   " }]) {
        socket.write(`${JSON.stringify({ id: 1, op: "sessions.spawn_child", body })}\n`);
        await waitForReply(socket);
      }
      const posts = injectedOptions(injectSpy).filter(
        (o) => o.method === "POST" && o.url === "/api/sessions",
      );
      expect(posts.length).toBeGreaterThanOrEqual(2);
      for (const post of posts) {
        expect(JSON.parse(String(post.payload))).not.toHaveProperty("nameLocked");
      }
      socket.destroy();
    });

    // Issue #1951 — a child can be aimed at a host/platform and given its
    // own server-chosen worktree. Those three keys are forwarded; the raw
    // `worktree` object stays stripped.
    it("session scope: forwards targetHostId/targetPlatform/isolate but still strips worktree (#1951)", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const injectSpy = vi.spyOn(app, "inject");
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(
        `${JSON.stringify({
          id: 1,
          op: "sessions.spawn_child",
          body: {
            command: "bash",
            targetPlatform: "darwin",
            isolate: true,
            worktree: { baseRef: "main" },
          },
        })}\n`,
      );
      await waitForReply(socket);
      const post = injectedOptions(injectSpy).find(
        (o) => o.method === "POST" && o.url === "/api/sessions",
      )!;
      const payload = JSON.parse(String(post.payload));
      expect(payload.targetPlatform).toBe("darwin");
      expect(payload.isolate).toBe(true);
      expect(payload).not.toHaveProperty("worktree");
      socket.destroy();
    });

    it("session scope: forwards the advisory `open` hint and stores it on the child (#1624)", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(
        `${JSON.stringify({
          id: 1,
          op: "sessions.spawn_child",
          body: { command: "bash", open: "below" },
        })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(true);
      expect((reply.result as { openHint: unknown }).openHint).toBe("below");
      socket.destroy();
    });

    it("session scope: a parent whose row is no longer active cannot spawn children (#1518)", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId, hookToken } = await createRealSession(app!, ptyMock);
      const socket = await sessionScopeSocket(app!, hookToken);
      app.db.update(sessions).set({ status: "killed" }).where(eq(sessions.id, sessionId)).run();
      socket.write(
        `${JSON.stringify({ id: 1, op: "sessions.spawn_child", body: { command: "bash" } })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply).toMatchObject({ ok: false, status: 403 });
      socket.destroy();
    });

    it("every full-scope-only op is rejected at session scope, both by dispatch and by its own handler (#1518)", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const fullOnly = Object.entries(OPS).filter(
        ([, spec]) => spec.scopes.length === 1 && spec.scopes[0] === "full",
      );
      expect(fullOnly.length).toBeGreaterThan(10);
      const socket = await sessionScopeSocket(app!, hookToken);
      const frames = collectFrames(socket);
      fullOnly.forEach(([op], i) => {
        socket.write(`${JSON.stringify({ id: i + 1, op, body: {} })}\n`);
      });
      await waitUntil(() => frames.length === fullOnly.length);
      expect(frames.every((f) => f.status === 403)).toBe(true);
      socket.destroy();

      // Defense in depth: the ops that name a full-scope-only REST route
      // must refuse on their own even if dispatch were bypassed.
      const injectSpy = vi.spyOn(app, "inject");
      const sessionConn = { scope: "session", sessionId: "1", openChannels: new Map() };
      for (const op of [
        "device.pair",
        "device.pair-and-connect",
        "device.delete",
        "projects.set_tooling",
      ]) {
        const replies: unknown[] = [];
        await OPS[op].handler({
          app: app!,
          conn: sessionConn as never,
          id: 1,
          body: { deviceId: 1, projectId: 1, briefing: "x" },
          reply: (r) => replies.push(r),
        });
        // set_tooling nests each field's own result under its name.
        expect(replies[0]).toMatchObject(
          op === "projects.set_tooling"
            ? { ok: false, briefing: { status: 403 } }
            : { ok: false, status: 403 },
        );
      }
      expect(injectSpy).not.toHaveBeenCalled();
    });

    it("session scope: spawns a child of its own session with no parentSessionId given", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId: parentId, hookToken } = await createRealSession(app!, ptyMock);
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(
        `${JSON.stringify({ id: 1, op: "sessions.spawn_child", body: { command: "bash" } })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(true);
      expect(reply.status).toBe(201);
      expect((reply.result as { parentSessionId: number }).parentSessionId).toBe(parentId);
      socket.destroy();
    });

    it("session scope: derives projectId from the parent, ignoring any projectId the caller's own body supplies", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId: parentId, hookToken } = await createRealSession(app!, ptyMock);
      const parentRow = (
        await app!.inject({
          method: "GET",
          url: `/api/sessions/${parentId}`,
          headers: { authorization: `Bearer ${TEST_TOKEN}` },
        })
      ).json() as { projectId: number };
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(
        `${JSON.stringify({
          id: 1,
          op: "sessions.spawn_child",
          body: { command: "bash", projectId: 999_999 },
        })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(true);
      expect((reply.result as { projectId: number }).projectId).toBe(parentRow.projectId);
      socket.destroy();
    });

    it("session scope: rejects naming a DIFFERENT session as the parent", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const { sessionId: otherSessionId } = await createRealSession(app!, ptyMock);
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(
        `${JSON.stringify({
          id: 1,
          op: "sessions.spawn_child",
          body: { command: "bash", parentSessionId: otherSessionId },
        })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply).toEqual({
        id: 1,
        ok: false,
        status: 403,
        error: "session-scoped connections may only spawn children of their own session",
      });
      socket.destroy();
    });

    it("full scope: requires an explicit parentSessionId — no pinned session to default to", async () => {
      app = await buildApp();
      await app.ready();
      const socket = await fullScopeSocket(app!);
      socket.write(
        `${JSON.stringify({ id: 1, op: "sessions.spawn_child", body: { command: "bash" } })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply).toEqual({
        id: 1,
        ok: false,
        status: 400,
        error: "'parentSessionId' is required",
      });
      socket.destroy();
    });

    it("full scope: spawns a child of an explicitly named parentSessionId", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId: parentId } = await createRealSession(app!, ptyMock);
      const socket = await fullScopeSocket(app!);
      socket.write(
        `${JSON.stringify({
          id: 1,
          op: "sessions.spawn_child",
          body: { command: "bash", parentSessionId: parentId },
        })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(true);
      expect(reply.status).toBe(201);
      expect((reply.result as { parentSessionId: number }).parentSessionId).toBe(parentId);
      socket.destroy();
    });

    it("404s an unknown parentSessionId — this op resolves the parent's own project via a real GET first", async () => {
      app = await buildApp();
      await app.ready();
      const socket = await fullScopeSocket(app!);
      socket.write(
        `${JSON.stringify({
          id: 1,
          op: "sessions.spawn_child",
          body: { command: "bash", parentSessionId: 999_999 },
        })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(false);
      expect(reply.status).toBe(404);
      socket.destroy();
    });

    // Independent review, PR #426 — session scope must never be able to
    // escalate a spawned child's privileges or hide it as a dock session.
    it("session scope: silently strips kind — a child always starts as a visible terminal session", async () => {
      // Issue #1733 — `kind` REMAINS full-scope only: making a child a
      // dock session hides it from the session list, which is a visibility
      // change rather than a permission one, and #426 called it out
      // explicitly. `skipPermissions` is the one field that moved (see the
      // inheritance tests below) — it is capped by the parent's own value.
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(
        `${JSON.stringify({
          id: 1,
          op: "sessions.spawn_child",
          body: { command: "bash", kind: "dock" },
        })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(true);
      expect(reply.result).toMatchObject({ kind: "terminal" });
      socket.destroy();
    });

    // Issue #1733 — a delegated child inherits the parent's unattended
    // permission posture. Task Master's own workers run unattended
    // (settings.taskMaster.skipPermissions is "on" by default), and a child
    // they spawned used to start with permission prompts ON — so a
    // delegated step that touched a file outside the sandbox blocked on a
    // prompt nobody was watching. Agent-to-agent delegation was strictly
    // LESS autonomous than the queue path it was supposed to complement.
    it("session scope: a child INHERITS the parent's skipPermissions", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock, { skipPermissions: true });
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(
        `${JSON.stringify({
          id: 1,
          op: "sessions.spawn_child",
          body: { command: "bash" },
        })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(true);
      expect(reply.result).toMatchObject({ skipPermissions: true });
      socket.destroy();
    });

    it("session scope: a child of a prompting parent does NOT get skipPermissions", async () => {
      // The parent's posture is the CEILING. A session-scoped caller that
      // asks for a MORE permissive child must not get one — that is the
      // #426 invariant, and it is what makes forwarding the field safe.
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock, { skipPermissions: false });
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(
        `${JSON.stringify({
          id: 1,
          op: "sessions.spawn_child",
          body: { command: "bash", skipPermissions: true },
        })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(true);
      expect(reply.result).toMatchObject({ skipPermissions: false });
      socket.destroy();
    });

    it("session scope: a NON-boolean skipPermissions narrows to false", async () => {
      // The socket body is not schema-validated before this point (only
      // POST /api/sessions would 400 it), so this is the only place a
      // nonsense value can be caught — and it must fail CLOSED: a
      // non-boolean is neither "unset" nor "true", so it narrows.
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock, { skipPermissions: true });
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(
        `${JSON.stringify({
          id: 1,
          op: "sessions.spawn_child",
          body: { command: "bash", skipPermissions: "true" },
        })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(true);
      expect(reply.result).toMatchObject({ skipPermissions: false });
      socket.destroy();
    });

    it("session scope: a child may NARROW its parent's skipPermissions", async () => {
      // The other direction is always allowed: a child can be less
      // permissive than its parent.
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock, { skipPermissions: true });
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(
        `${JSON.stringify({
          id: 1,
          op: "sessions.spawn_child",
          body: { command: "bash", skipPermissions: false },
        })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(true);
      expect(reply.result).toMatchObject({ skipPermissions: false });
      socket.destroy();
    });

    // Issue #822 — env joins the session-scope strip list for the same
    // reason skipPermissions/kind are there: without it, a session-scoped
    // agent spawning a child of its own session could hand that child
    // arbitrary extra env, a capability session scope never intended to
    // grant.
    it("session scope: silently strips env — a child never gets extra env from a session-scoped spawn", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(
        `${JSON.stringify({
          id: 1,
          op: "sessions.spawn_child",
          body: { command: "bash", env: { CUSTOM_VAR: "attacker-value" } },
        })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(true);
      expect(reply.result).toMatchObject({ env: null });
      socket.destroy();
    });

    // Root-cause fix for the opencode `command`-embedded-prompt trap —
    // unlike skipPermissions/kind/env above, `seedPrompt` grants no extra
    // privilege or visibility to the child (it only affects what the
    // child's first turn says, which a session-scoped caller already
    // fully controls via `command` itself), so it's deliberately NOT in
    // the session-scope strip list.
    it("session scope: does NOT strip seedPrompt — a session-scoped caller can still set a child's first turn", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(
        `${JSON.stringify({
          id: 1,
          op: "sessions.spawn_child",
          body: { command: "opencode", seedPrompt: "do the thing" },
        })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(true);
      expect(reply.result).toMatchObject({ initialPromptApplied: true });
      socket.destroy();
    });

    it("full scope: honors an explicit env", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId: parentId } = await createRealSession(app!, ptyMock);
      const socket = await fullScopeSocket(app!);
      socket.write(
        `${JSON.stringify({
          id: 1,
          op: "sessions.spawn_child",
          body: { command: "bash", parentSessionId: parentId, env: { CUSTOM_VAR: "hello" } },
        })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(true);
      expect(reply.result).toMatchObject({ env: { CUSTOM_VAR: "hello" } });
      socket.destroy();
    });

    it("full scope: honors an explicit skipPermissions and kind", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId: parentId } = await createRealSession(app!, ptyMock);
      const socket = await fullScopeSocket(app!);
      socket.write(
        `${JSON.stringify({
          id: 1,
          op: "sessions.spawn_child",
          body: {
            command: "bash",
            parentSessionId: parentId,
            skipPermissions: true,
            kind: "dock",
          },
        })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(true);
      expect(reply.result).toMatchObject({ kind: "dock", skipPermissions: true });
      socket.destroy();
    });

    it("strips a caller-supplied worktree/worktreeRefresh, even at full scope", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId: parentId } = await createRealSession(app!, ptyMock);
      const socket = await fullScopeSocket(app!);
      socket.write(
        `${JSON.stringify({
          id: 1,
          op: "sessions.spawn_child",
          body: {
            command: "bash",
            parentSessionId: parentId,
            worktree: { baseRef: "main" },
            worktreeRefresh: true,
          },
        })}\n`,
      );
      const reply = await waitForReply(socket);
      // A forwarded `worktree` would have gone through actual git-worktree
      // creation (this test's fake child_process mock only special-cases
      // `git`, see this file's own header) — succeeding at all (with a
      // plain, non-worktree cwd) confirms the field never reached
      // createSessionRecord's worktree branch.
      expect(reply.ok).toBe(true);
      expect(reply.status).toBe(201);
      socket.destroy();
    });

    // Hermes review, PR #426 — the live-child cap must hold even when
    // requests race each other, not just when checked sequentially.
    it("enforces the live-child cap exactly under concurrent spawn attempts from separate connections", async () => {
      app = await buildApp();
      await app.ready();
      const authHeaders = { authorization: `Bearer ${TEST_TOKEN}` };
      await app!.inject({
        method: "PATCH",
        url: "/api/settings",
        headers: authHeaders,
        payload: { sessions: { maxChildSessionsPerParent: 2 } },
      });
      const { sessionId: parentId } = await createRealSession(app!, ptyMock);

      const spawnOne = async () => {
        const socket = await fullScopeSocket(app!);
        socket.write(
          `${JSON.stringify({
            id: 1,
            op: "sessions.spawn_child",
            body: { command: "bash", parentSessionId: parentId },
          })}\n`,
        );
        const reply = await waitForReply(socket);
        socket.destroy();
        return reply;
      };

      const replies = await Promise.all([1, 2, 3, 4].map(() => spawnOne()));
      const succeeded = replies.filter((r) => r.ok);
      const capped = replies.filter((r) => !r.ok && r.status === 429);
      expect(succeeded.length).toBe(2);
      expect(capped.length).toBe(2);
    });

    // Issue #441 — the audit-log line had no test pinning it, so a
    // refactor could silently drop it without anything going red. Hermes
    // review: the log fires before the downstream POST /api/sessions
    // completes (control-socket.ts logs, then replies), so it records a
    // validated spawn ATTEMPT, not a confirmed success — this test's own
    // `reply.ok` assertion still exercises the success path, the title
    // just doesn't overclaim what the log line itself guarantees.
    it("logs the spawn attempt via app.log.info, with the parent, project, and connection scope", async () => {
      app = await buildApp();
      await app.ready();
      const logInfoSpy = vi.spyOn(app.log, "info");
      const { sessionId: parentId, hookToken } = await createRealSession(app!, ptyMock);
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(
        `${JSON.stringify({ id: 1, op: "sessions.spawn_child", body: { command: "bash" } })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(true);
      const projectId = (reply.result as { projectId: number }).projectId;
      expect(logInfoSpy).toHaveBeenCalledWith(
        { parentSessionId: String(parentId), projectId, crossProject: false, scope: "session" },
        "sessions.spawn_child",
      );
      socket.destroy();
    });
  });
});
