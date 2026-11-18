import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import type * as ChildProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createControlSocketPtyMock,
  mockControlSocketChildProcess,
  TEST_TOKEN,
  injectedOptions,
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

const { buildApp } = await import("../../src/app.js");
const { sessions } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");

describe("session lifecycle ops: cross-project spawn (#2110)", () => {
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

  // Issue #2110 — a coordinator project's sessions may spawn children in
  // OTHER projects. The permission is the parent's project's
  // allowCrossProjectSpawn flag (default off); `project` only names the target.
  describe("sessions.spawn_child across projects (#2110)", () => {
    const authHeaders = { authorization: `Bearer ${TEST_TOKEN}` };

    async function parentProjectId(parentId: number): Promise<number> {
      const res = await app!.inject({
        method: "GET",
        url: `/api/sessions/${parentId}`,
        headers: authHeaders,
      });
      return (res.json() as { projectId: number }).projectId;
    }

    async function makeProject(name: string): Promise<number> {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xproj-"));
      const res = await app!.inject({
        method: "POST",
        url: "/api/projects",
        headers: authHeaders,
        payload: { allowDuplicate: true, name, cwd: dir },
      });
      expect(res.statusCode).toBe(201);
      return (res.json() as { id: number }).id;
    }

    async function setCoordinator(projectId: number, on: boolean): Promise<void> {
      const res = await app!.inject({
        method: "PATCH",
        url: `/api/projects/${projectId}`,
        headers: authHeaders,
        payload: { allowCrossProjectSpawn: on },
      });
      expect(res.statusCode).toBe(200);
    }

    async function spawn(hookToken: string, body: Record<string, unknown>) {
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(
        `${JSON.stringify({ id: 1, op: "sessions.spawn_child", body: { command: "bash", ...body } })}\n`,
      );
      const reply = await waitForReply(socket);
      socket.destroy();
      return reply;
    }

    it("refuses naming another project while the parent's project is not a coordinator", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const other = await makeProject("other");
      const injectSpy = vi.spyOn(app, "inject");

      const reply = await spawn(hookToken, { project: other });

      expect(reply.ok).toBe(false);
      expect(reply.status).toBe(403);
      expect(String(reply.error)).toMatch(/This project coordinates/);
      // Nothing reached POST /api/sessions.
      expect(
        injectedOptions(injectSpy).filter((o) => o.method === "POST" && o.url === "/api/sessions"),
      ).toEqual([]);
    });

    it("spawns in the named project (by id) once the parent's project is a coordinator", async () => {
      app = await buildApp();
      await app.ready();
      const logInfoSpy = vi.spyOn(app.log, "info");
      const { sessionId: parentId, hookToken } = await createRealSession(app!, ptyMock);
      const other = await makeProject("other");
      await setCoordinator(await parentProjectId(parentId), true);

      const reply = await spawn(hookToken, { project: other });

      expect(reply.ok).toBe(true);
      expect(reply.status).toBe(201);
      expect(reply.result).toMatchObject({ projectId: other, parentSessionId: parentId });
      expect(logInfoSpy).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: other, crossProject: true, scope: "session" }),
        "sessions.spawn_child",
      );
    });

    it("accepts an id spelled as a string, and an exact project name", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId: parentId, hookToken } = await createRealSession(app!, ptyMock);
      const other = await makeProject("runway-byname");
      await setCoordinator(await parentProjectId(parentId), true);

      const byString = await spawn(hookToken, { project: String(other) });
      const byName = await spawn(hookToken, { project: "runway-byname" });

      expect((byString.result as { projectId: number }).projectId).toBe(other);
      expect((byName.result as { projectId: number }).projectId).toBe(other);
    });

    it("refuses an unknown id or name with the same 403 as a refused one, and 409s a name shared by several projects", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId: parentId, hookToken } = await createRealSession(app!, ptyMock);
      const first = await makeProject("twin");
      const second = await makeProject("twin");
      await setCoordinator(await parentProjectId(parentId), true);

      // Issues #2123 / #2124: at session scope an unknown project is indistinguishable
      // from one the coordinator may not use.
      expect((await spawn(hookToken, { project: 999_999 })).status).toBe(403);
      expect((await spawn(hookToken, { project: "nope" })).status).toBe(403);
      const ambiguous = await spawn(hookToken, { project: "twin" });
      expect(ambiguous.status).toBe(409);
      expect(String(ambiguous.error)).toContain(`${first}`);
      expect(String(ambiguous.error)).toContain(`${second}`);
      // A blank or non-string/number value is a 400, not a guess.
      expect((await spawn(hookToken, { project: " " })).status).toBe(400);
      expect((await spawn(hookToken, { project: { id: 1 } })).status).toBe(400);
    });

    async function patchProject(projectId: number, payload: Record<string, unknown>) {
      return app!.inject({
        method: "PATCH",
        url: `/api/projects/${projectId}`,
        headers: authHeaders,
        payload,
      });
    }

    it("a coordinator's target list limits where it can spawn, with the uniform 403 for the rest (#2123)", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId: parentId, hookToken } = await createRealSession(app!, ptyMock);
      const listed = await makeProject("listed-target");
      const unlisted = await makeProject("unlisted-target");
      const coordinator = await parentProjectId(parentId);
      await setCoordinator(coordinator, true);
      expect((await patchProject(coordinator, { crossProjectTargets: [listed] })).statusCode).toBe(
        200,
      );

      expect((await spawn(hookToken, { project: listed })).status).toBe(201);
      const refused = await spawn(hookToken, { project: unlisted });
      const missing = await spawn(hookToken, { project: 999_999 });
      const byName = await spawn(hookToken, { project: "unlisted-target" });
      expect(refused.status).toBe(403);
      expect(missing.error).toBe(refused.error);
      expect(byName.error).toBe(refused.error);
    });

    it("projects.spawn_targets lists only the projects the coordinator may reach (#2123, #2124)", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId: parentId, hookToken } = await createRealSession(app!, ptyMock);
      const open = await makeProject("open-target");
      const closed = await makeProject("closed-target");
      const coordinator = await parentProjectId(parentId);
      await setCoordinator(coordinator, true);
      await patchProject(closed, { acceptsChildrenFrom: "none" });

      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(`${JSON.stringify({ id: 1, op: "projects.spawn_targets" })}\n`);
      const reply = await waitForReply(socket);
      socket.destroy();
      const ids = (reply.result as Array<{ id: number }>).map((p) => p.id);
      expect(ids).toContain(open);
      expect(ids).not.toContain(closed);
      expect(ids).not.toContain(coordinator);
    });

    it("a target that accepts no children is refused like a project that does not exist (#2124)", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId: parentId, hookToken } = await createRealSession(app!, ptyMock);
      const target = await makeProject("shut-target");
      await setCoordinator(await parentProjectId(parentId), true);
      await patchProject(target, { acceptsChildrenFrom: "none" });

      const refused = await spawn(hookToken, { project: target });
      const missing = await spawn(hookToken, { project: 999_999 });
      expect(refused.status).toBe(403);
      expect(refused.error).toBe(missing.error);

      // Back to the default and it spawns again.
      await patchProject(target, { acceptsChildrenFrom: "any" });
      expect((await spawn(hookToken, { project: target })).status).toBe(201);
    });

    it("a 'listed' target accepts only the projects on its list (#2124)", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId: parentId, hookToken } = await createRealSession(app!, ptyMock);
      const target = await makeProject("picky-target");
      const coordinator = await parentProjectId(parentId);
      await setCoordinator(coordinator, true);
      const stranger = await makeProject("stranger");

      await patchProject(target, {
        acceptsChildrenFrom: "listed",
        acceptsChildrenFromList: [stranger],
      });
      expect((await spawn(hookToken, { project: target })).status).toBe(403);
      await patchProject(target, { acceptsChildrenFromList: [stranger, coordinator] });
      expect((await spawn(hookToken, { project: target })).status).toBe(201);
    });

    it("a same-named project that refuses the coordinator is not leaked by the name lookup (#2124)", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId: parentId, hookToken } = await createRealSession(app!, ptyMock);
      const open = await makeProject("twin-name");
      const closed = await makeProject("twin-name");
      await setCoordinator(await parentProjectId(parentId), true);
      await patchProject(closed, { acceptsChildrenFrom: "none" });

      // Only one usable project has the name, so it resolves: no 409 naming the refused one.
      const byName = await spawn(hookToken, { project: "twin-name" });
      expect(byName.status).toBe(201);
      expect((byName.result as { projectId: number }).projectId).toBe(open);
      // The refused one by id (number or numeric string) is the uniform 403.
      const missing = await spawn(hookToken, { project: 999_999 });
      const byId = await spawn(hookToken, { project: closed });
      const byIdString = await spawn(hookToken, { project: String(closed) });
      expect(byId.status).toBe(403);
      expect(byId.error).toBe(missing.error);
      expect(byIdString.error).toBe(missing.error);
    });

    it("full scope keeps the precise 404 for an unknown project but 403s a refused one", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId: parentId } = await createRealSession(app!, ptyMock);
      const closed = await makeProject("full-scope-closed");
      await setCoordinator(await parentProjectId(parentId), true);
      await patchProject(closed, { acceptsChildrenFrom: "none" });

      const socket = await fullScopeSocket(app!);
      const call = async (project: unknown) => {
        socket.write(
          `${JSON.stringify({
            id: 1,
            op: "sessions.spawn_child",
            body: { parentSessionId: parentId, command: "bash", project },
          })}\n`,
        );
        return waitForReply(socket);
      };
      expect((await call(999_999)).status).toBe(404);
      expect((await call(closed)).status).toBe(403);
      socket.destroy();
    });

    it("rejects a project listing itself and reads the lists back as arrays (#2123, #2124)", async () => {
      app = await buildApp();
      await app.ready();
      const project = await makeProject("self-list");
      const other = await makeProject("self-list-other");
      expect((await patchProject(project, { crossProjectTargets: [project] })).statusCode).toBe(
        400,
      );
      expect(
        (
          await patchProject(project, {
            acceptsChildrenFrom: "listed",
            acceptsChildrenFromList: [project],
          })
        ).statusCode,
      ).toBe(400);
      await patchProject(project, { crossProjectTargets: [other] });
      const read = await app.inject({
        method: "GET",
        url: "/api/projects",
        headers: authHeaders,
      });
      const row = (read.json() as Array<{ id: number; crossProjectTargets: number[] | null }>).find(
        (p) => p.id === project,
      );
      expect(row?.crossProjectTargets).toEqual([other]);
    });

    // Issue #2270 — sessions.message. The test sessions run `bash`, which has no
    // prompt framing, so a message that is allowed is QUEUED (202) and then refused
    // or expired rather than typed; delivery itself is covered by the queue's own
    // tests (test/services/session-message-queue.test.ts). What these pin is who may
    // send, and the uniform 403 for everyone else.
    async function messagePair(opts: { accepts?: "any" | "listed" | "none" | null } = {}) {
      const sender = await createRealSession(app!, ptyMock);
      const target = await createRealSession(app!, ptyMock);
      const senderProject = await parentProjectId(sender.sessionId);
      const targetProject = await parentProjectId(target.sessionId);
      await setCoordinator(senderProject, true);
      if (opts.accepts) {
        await patchProject(targetProject, {
          acceptsMessagesFrom: opts.accepts,
          ...(opts.accepts === "listed" ? { acceptsMessagesFromList: [senderProject] } : {}),
        });
      }
      return { sender, target, senderProject, targetProject };
    }

    async function message(hookToken: string, body: Record<string, unknown>) {
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(`${JSON.stringify({ id: 1, op: "sessions.message", body })}\n`);
      const reply = await waitForReply(socket);
      socket.destroy();
      return reply;
    }

    it("queues a message to a consenting project's session, and refuses everyone else with one 403 (#2270)", async () => {
      app = await buildApp();
      await app.ready();
      const { sender, target, targetProject } = await messagePair();
      const body = { sessionId: target.sessionId, text: "heads up" };

      // Off by default: the target project has not opted in.
      const refusedDefault = await message(sender.hookToken, body);
      expect(refusedDefault.status).toBe(403);
      const missing = await message(sender.hookToken, { ...body, sessionId: 999_999 });
      expect(missing.status).toBe(403);
      expect(missing.error).toBe(refusedDefault.error);

      await patchProject(targetProject, { acceptsMessagesFrom: "any" });
      const accepted = await message(sender.hookToken, body);
      expect(accepted.ok).toBe(true);
      expect(accepted.status).toBe(202);
      expect(accepted.result).toMatchObject({
        status: "queued",
        targetSessionId: target.sessionId,
      });
    });

    it("a 'listed' target accepts only the projects on its list; none refuses all (#2270)", async () => {
      app = await buildApp();
      await app.ready();
      const listed = await messagePair({ accepts: "listed" });
      expect(
        (
          await message(listed.sender.hookToken, {
            sessionId: listed.target.sessionId,
            text: "hi",
          })
        ).status,
      ).toBe(202);
      // A second coordinator that is not on the list.
      const stranger = await createRealSession(app!, ptyMock);
      await setCoordinator(await parentProjectId(stranger.sessionId), true);
      expect(
        (await message(stranger.hookToken, { sessionId: listed.target.sessionId, text: "hi" }))
          .status,
      ).toBe(403);

      await patchProject(listed.targetProject, { acceptsMessagesFrom: "none" });
      expect(
        (
          await message(listed.sender.hookToken, {
            sessionId: listed.target.sessionId,
            text: "hi",
          })
        ).status,
      ).toBe(403);
    });

    it("needs a coordinator sender, a top-level target in another project, and not itself (#2270)", async () => {
      app = await buildApp();
      await app.ready();
      const { sender, target, senderProject } = await messagePair({
        accepts: "any",
      });
      const body = { sessionId: target.sessionId, text: "hi" };
      const baseline = await message(sender.hookToken, { sessionId: 999_999, text: "hi" });

      // Not a coordinator.
      await setCoordinator(senderProject, false);
      expect((await message(sender.hookToken, body)).error).toBe(baseline.error);
      await setCoordinator(senderProject, true);

      // The target is a child, not a top-level session.
      const child = await createRealSession(app!, ptyMock);
      app.db
        .update(sessions)
        .set({ parentSessionId: target.sessionId })
        .where(eq(sessions.id, child.sessionId))
        .run();
      await patchProject(await parentProjectId(child.sessionId), { acceptsMessagesFrom: "any" });
      expect(
        (await message(sender.hookToken, { sessionId: child.sessionId, text: "hi" })).error,
      ).toBe(baseline.error);

      // Itself, and ANOTHER session in the sender's own project (even one whose project
      // accepts messages from everyone: messaging is cross-project only).
      expect(
        (await message(sender.hookToken, { sessionId: sender.sessionId, text: "hi" })).status,
      ).toBe(403);
      await patchProject(senderProject, { acceptsMessagesFrom: "any" });
      const sibling = await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: authHeaders,
        payload: { projectId: senderProject, command: "bash" },
      });
      expect(sibling.statusCode).toBe(201);
      const sameProject = await message(sender.hookToken, {
        sessionId: sibling.json().id,
        text: "hi",
      });
      expect(sameProject.status).toBe(403);
      expect(sameProject.error).toBe(baseline.error);
    });

    it("full scope has no sessions.message (it uses sessions.prompt)", async () => {
      app = await buildApp();
      await app.ready();
      const { target } = await messagePair({ accepts: "any" });
      const socket = await fullScopeSocket(app!);
      socket.write(
        `${JSON.stringify({ id: 1, op: "sessions.message", body: { sessionId: target.sessionId, text: "x" } })}\n`,
      );
      const reply = await waitForReply(socket);
      socket.destroy();
      expect(reply.status).toBe(403);
    });

    it("validates the body, and rate-limits a sender (#2270)", async () => {
      app = await buildApp();
      await app.ready();
      const { sender, target } = await messagePair({ accepts: "any" });
      const id = target.sessionId;
      expect((await message(sender.hookToken, { text: "x" })).status).toBe(400);
      expect((await message(sender.hookToken, { sessionId: id })).status).toBe(400);
      expect((await message(sender.hookToken, { sessionId: id, text: "  " })).status).toBe(400);
      expect(
        (await message(sender.hookToken, { sessionId: id, text: "x".repeat(8 * 1024 + 1) })).status,
      ).toBe(413);
      for (const ttlSeconds of [0, 3601, 1.5, "5"]) {
        expect(
          (await message(sender.hookToken, { sessionId: id, text: "x", ttlSeconds })).status,
        ).toBe(400);
      }
      expect(
        (await message(sender.hookToken, { sessionId: id, text: "x", wait: "yes" })).status,
      ).toBe(400);
      // Rejected bodies cost no allowance; ten accepted-or-refused sends do.
      let last = 0;
      for (let i = 0; i < 11; i++) {
        last = Number((await message(sender.hookToken, { sessionId: id, text: `n${i}` })).status);
      }
      expect(last).toBe(429);
    });

    it("reports a message's status to its sender only, and wait:true holds for the outcome (#2270)", async () => {
      app = await buildApp();
      await app.ready();
      const { sender, target } = await messagePair({ accepts: "any" });
      const waited = await message(sender.hookToken, {
        sessionId: target.sessionId,
        text: "will not be typed into a shell",
        wait: true,
        ttlSeconds: 1,
      });
      expect(waited.ok).toBe(true);
      // A shell has no prompt framing, so it is refused (or, if the shell looked busy, expires).
      expect(["refused", "expired"]).toContain((waited.result as { status: string }).status);
      const { messageId } = waited.result as { messageId: string };

      const status = async (token: string, id: string) => {
        const socket = await sessionScopeSocket(app!, token);
        socket.write(
          `${JSON.stringify({ id: 2, op: "sessions.message_status", body: { messageId: id } })}\n`,
        );
        const reply = await waitForReply(socket);
        socket.destroy();
        return reply;
      };
      const own = await status(sender.hookToken, messageId);
      expect(own.result).toMatchObject({ messageId, targetSessionId: target.sessionId });
      // The target (or anyone else) cannot read it; nor an unknown id.
      expect((await status(target.hookToken, messageId)).status).toBe(404);
      expect((await status(sender.hookToken, "nope")).status).toBe(404);
      expect((await status(sender.hookToken, "")).status).toBe(400);
    });

    it("a direct POST /api/sessions with a cross-project parent is bound by the same rule", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId: parentId } = await createRealSession(app!, ptyMock);
      const target = await makeProject("direct-target");
      await setCoordinator(await parentProjectId(parentId), true);
      await patchProject(target, { acceptsChildrenFrom: "none" });

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: authHeaders,
        payload: { projectId: target, command: "bash", parentSessionId: parentId },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain("coordinator");

      // The refusal came from the new rule: the same request succeeds once the target
      // accepts children again.
      await patchProject(target, { acceptsChildrenFrom: "any" });
      const allowed = await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: authHeaders,
        payload: { projectId: target, command: "bash", parentSessionId: parentId },
      });
      expect(allowed.statusCode).toBe(201);
    });

    it("validates and normalises the project lists on PATCH (#2123, #2124)", async () => {
      app = await buildApp();
      await app.ready();
      const project = await makeProject("lists");
      const other = await makeProject("lists-other");

      expect((await patchProject(project, { crossProjectTargets: [999_999] })).statusCode).toBe(
        400,
      );
      expect((await patchProject(project, { acceptsChildrenFrom: "sometimes" })).statusCode).toBe(
        400,
      );
      // "listed" with nobody on the list would be "none" under another name.
      expect((await patchProject(project, { acceptsChildrenFrom: "listed" })).statusCode).toBe(400);

      const saved = await patchProject(project, {
        crossProjectTargets: [other],
        acceptsChildrenFrom: "listed",
        acceptsChildrenFromList: [other],
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toMatchObject({
        crossProjectTargets: [other],
        acceptsChildrenFrom: "listed",
        acceptsChildrenFromList: [other],
      });
      // An empty selection means "all" again.
      const cleared = await patchProject(project, { crossProjectTargets: [] });
      expect(cleared.json().crossProjectTargets).toBeNull();
    });

    it("a non-coordinator gets the SAME 403 whether or not the named project exists (no probing)", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const existing = await makeProject("exists");
      await makeProject("twin-a");
      await makeProject("twin-a");

      const replies = [
        await spawn(hookToken, { project: existing }),
        await spawn(hookToken, { project: 999_999 }),
        await spawn(hookToken, { project: "exists" }),
        await spawn(hookToken, { project: "no-such-project" }),
        await spawn(hookToken, { project: "twin-a" }),
      ];

      for (const reply of replies) {
        expect(reply.status).toBe(403);
        expect(reply.error).toBe(replies[0].error);
      }
    });

    it("cwd containment follows the TARGET project, not the coordinator's", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId: parentId, hookToken } = await createRealSession(app!, ptyMock);
      const other = await makeProject("cwd-target");
      await setCoordinator(await parentProjectId(parentId), true);
      const targetDir = (
        await app.inject({ method: "GET", url: `/api/projects/${other}`, headers: authHeaders })
      ).json() as { cwd: string };

      const inside = await spawn(hookToken, { project: other, cwd: targetDir.cwd });
      // "/tmp" is the COORDINATOR's directory, which is outside the target's.
      const outside = await spawn(hookToken, { project: other, cwd: "/tmp" });

      expect(inside.status).toBe(201);
      expect((inside.result as { projectId: number }).projectId).toBe(other);
      expect(outside.status).toBe(400);
    });

    it("the coordinator still lists, and can kill, its cross-project child", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId: parentId, hookToken } = await createRealSession(app!, ptyMock);
      const other = await makeProject("kid-project");
      await setCoordinator(await parentProjectId(parentId), true);
      const child = (await spawn(hookToken, { project: other })).result as { id: number };

      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(`${JSON.stringify({ id: 1, op: "sessions.children", body: {} })}\n`);
      const listed = await waitForReply(socket);
      socket.write(
        `${JSON.stringify({ id: 2, op: "sessions.kill", body: { sessionId: String(child.id) } })}\n`,
      );
      const killed = await waitForReply(socket);
      socket.destroy();

      expect(listed.ok).toBe(true);
      expect(
        (listed.result as Array<{ id: number; projectId: number }>).map((c) => c.id),
      ).toContain(child.id);
      expect(killed.ok).toBe(true);
    });

    it("naming the parent's OWN project needs no permission", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId: parentId, hookToken } = await createRealSession(app!, ptyMock);
      const own = await parentProjectId(parentId);

      const reply = await spawn(hookToken, { project: own });
      const byString = await spawn(hookToken, { project: String(own) });

      expect(reply.ok).toBe(true);
      expect((reply.result as { projectId: number }).projectId).toBe(own);
      expect((byString.result as { projectId: number }).projectId).toBe(own);
    });

    it("still ignores a raw projectId, even for a coordinator", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId: parentId, hookToken } = await createRealSession(app!, ptyMock);
      const other = await makeProject("other");
      const own = await parentProjectId(parentId);
      await setCoordinator(own, true);

      const reply = await spawn(hookToken, { projectId: other });

      expect((reply.result as { projectId: number }).projectId).toBe(own);
    });

    it("keeps the skipPermissions cap: a prompting coordinator cannot produce an unattended child", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId: parentId, hookToken } = await createRealSession(app!, ptyMock, {
        skipPermissions: false,
      });
      const other = await makeProject("other");
      await setCoordinator(await parentProjectId(parentId), true);

      const reply = await spawn(hookToken, { project: other, skipPermissions: true });

      expect(reply.ok).toBe(true);
      expect((reply.result as { skipPermissions: boolean }).skipPermissions).toBe(false);
    });

    it("full scope: `project` is resolved the same way, and the lifecycle rule still applies", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId: parentId } = await createRealSession(app!, ptyMock);
      const other = await makeProject("other");
      const socket = await fullScopeSocket(app!);
      socket.write(
        `${JSON.stringify({
          id: 1,
          op: "sessions.spawn_child",
          body: { command: "bash", parentSessionId: String(parentId), project: other },
        })}\n`,
      );

      const reply = await waitForReply(socket);
      socket.destroy();

      // Full scope has no special pass: the parent's project must coordinate.
      expect(reply.status).toBe(403);
    });
  });

  describe("projects.spawn_targets (#2110)", () => {
    const authHeaders = { authorization: `Bearer ${TEST_TOKEN}` };

    async function ownProject(sessionId: number): Promise<number> {
      const res = await app!.inject({
        method: "GET",
        url: `/api/sessions/${sessionId}`,
        headers: authHeaders,
      });
      return (res.json() as { projectId: number }).projectId;
    }

    async function targets(hookToken: string) {
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(`${JSON.stringify({ id: 1, op: "projects.spawn_targets" })}\n`);
      const reply = await waitForReply(socket);
      socket.destroy();
      return reply;
    }

    it("refuses a session whose project is not a coordinator", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock);

      const reply = await targets(hookToken);

      expect(reply.ok).toBe(false);
      expect(reply.status).toBe(403);
    });

    it("lists the OTHER projects for a coordinator's session, never its own", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId, hookToken } = await createRealSession(app!, ptyMock);
      const own = await ownProject(sessionId);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xproj-"));
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        headers: authHeaders,
        payload: { allowDuplicate: true, name: "runway-targets", cwd: dir },
      });
      const otherId = (created.json() as { id: number }).id;
      await app.inject({
        method: "PATCH",
        url: `/api/projects/${own}`,
        headers: authHeaders,
        payload: { allowCrossProjectSpawn: true },
      });

      const reply = await targets(hookToken);

      expect(reply.ok).toBe(true);
      // (The DB is shared across this file's tests, so assert on the entries
      // that matter rather than the whole list.)
      const list = reply.result as Array<{ id: number; name: string; hostId: string }>;
      expect(list).toContainEqual({ id: otherId, name: "runway-targets", hostId: "local" });
      expect(list.some((p) => p.id === own)).toBe(false);
    });

    it("full scope must name the session (no implicit self)", async () => {
      app = await buildApp();
      await app.ready();
      const socket = await fullScopeSocket(app!);
      socket.write(`${JSON.stringify({ id: 1, op: "projects.spawn_targets" })}\n`);

      const reply = await waitForReply(socket);
      socket.destroy();

      expect(reply.status).toBe(400);
    });
  });
});
