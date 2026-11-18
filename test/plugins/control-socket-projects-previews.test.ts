import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import type * as ChildProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createControlSocketPtyMock,
  mockControlSocketChildProcess,
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

const { buildApp } = await import("../../src/app.js");

describe("project, preview, and agent ops (Phase 4, #134 PR6)", () => {
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

  describe("project/preview/agent ops (Phase 4, #134 PR6)", () => {
    describe("projects.actions", () => {
      it("full scope: dispatches to GET /api/projects/:id/actions with an explicit projectId", async () => {
        app = await buildApp();
        await app.ready();
        const authHeaders = { authorization: `Bearer ${TEST_TOKEN}` };
        const project = await app.inject({
          method: "POST",
          url: "/api/projects",
          headers: authHeaders,
          payload: { allowDuplicate: true, createDir: true, name: "p", cwd: "/tmp" },
        });
        const socket = await fullScopeSocket(app!);
        socket.write(
          `${JSON.stringify({ id: 1, op: "projects.actions", body: { projectId: project.json().id } })}\n`,
        );
        const reply = await waitForReply(socket);
        expect(reply.ok).toBe(true);
        expect(Array.isArray(reply.result)).toBe(true);
        socket.destroy();
      });

      it("full scope: 400s with no projectId", async () => {
        app = await buildApp();
        await app.ready();
        const socket = await fullScopeSocket(app!);
        socket.write(`${JSON.stringify({ id: 1, op: "projects.actions" })}\n`);
        const reply = await waitForReply(socket);
        expect(reply).toEqual({
          id: 1,
          ok: false,
          status: 400,
          error: "'projectId' is required",
        });
        socket.destroy();
      });

      it("session scope: defaults to its own pinned session's project with no projectId given", async () => {
        app = await buildApp();
        await app.ready();
        const { hookToken } = await createRealSession(app!, ptyMock);
        const socket = await sessionScopeSocket(app!, hookToken);
        socket.write(`${JSON.stringify({ id: 1, op: "projects.actions" })}\n`);
        const reply = await waitForReply(socket);
        expect(reply.ok).toBe(true);
        expect(Array.isArray(reply.result)).toBe(true);
        socket.destroy();
      });

      it("session scope: rejects targeting a DIFFERENT project id", async () => {
        app = await buildApp();
        await app.ready();
        const { hookToken } = await createRealSession(app!, ptyMock);
        const otherProject = await app.inject({
          method: "POST",
          url: "/api/projects",
          headers: { authorization: `Bearer ${TEST_TOKEN}` },
          payload: { allowDuplicate: true, createDir: true, name: "other", cwd: "/tmp/other" },
        });
        const socket = await sessionScopeSocket(app!, hookToken);
        socket.write(
          `${JSON.stringify({ id: 1, op: "projects.actions", body: { projectId: otherProject.json().id } })}\n`,
        );
        const reply = await waitForReply(socket);
        expect(reply).toEqual({
          id: 1,
          ok: false,
          status: 403,
          error: "session-scoped connections may only target their own session's project",
        });
        socket.destroy();
      });
    });

    describe("projects.dock", () => {
      it("full scope: dispatches to GET /api/projects/:id/dock", async () => {
        app = await buildApp();
        await app.ready();
        const project = await app.inject({
          method: "POST",
          url: "/api/projects",
          headers: { authorization: `Bearer ${TEST_TOKEN}` },
          payload: { allowDuplicate: true, createDir: true, name: "p", cwd: "/tmp" },
        });
        const socket = await fullScopeSocket(app!);
        socket.write(
          `${JSON.stringify({ id: 1, op: "projects.dock", body: { projectId: project.json().id } })}\n`,
        );
        const reply = await waitForReply(socket);
        expect(reply.ok).toBe(true);
        expect(Array.isArray(reply.result)).toBe(true);
        socket.destroy();
      });

      it("full scope: 400s with no projectId", async () => {
        app = await buildApp();
        await app.ready();
        const socket = await fullScopeSocket(app!);
        socket.write(`${JSON.stringify({ id: 1, op: "projects.dock" })}\n`);
        const reply = await waitForReply(socket);
        expect(reply).toEqual({
          id: 1,
          ok: false,
          status: 400,
          error: "'projectId' is required",
        });
        socket.destroy();
      });

      it("session scope: rejected — full-scope-only op", async () => {
        app = await buildApp();
        await app.ready();
        const { hookToken } = await createRealSession(app!, ptyMock);
        const socket = await sessionScopeSocket(app!, hookToken);
        socket.write(`${JSON.stringify({ id: 1, op: "projects.dock" })}\n`);
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

    describe("projects.get_tooling", () => {
      it("full scope: returns the project's tooling row (nulls for fields not yet authored)", async () => {
        app = await buildApp();
        await app.ready();
        const project = await app.inject({
          method: "POST",
          url: "/api/projects",
          headers: { authorization: `Bearer ${TEST_TOKEN}` },
          payload: { allowDuplicate: true, createDir: true, name: "p", cwd: "/tmp" },
        });
        const socket = await fullScopeSocket(app!);
        socket.write(
          `${JSON.stringify({ id: 1, op: "projects.get_tooling", body: { projectId: project.json().id } })}\n`,
        );
        const reply = await waitForReply(socket);
        expect(reply.ok).toBe(true);
        expect(reply.result).toEqual({
          briefing: null,
          skill: null,
          reviewerAgent: null,
        });
        socket.destroy();
      });

      it("full scope: returns the written fields when a row exists", async () => {
        app = await buildApp();
        await app.ready();
        const project = await app.inject({
          method: "POST",
          url: "/api/projects",
          headers: { authorization: `Bearer ${TEST_TOKEN}` },
          payload: { allowDuplicate: true, createDir: true, name: "p", cwd: "/tmp" },
        });
        const projectId = project.json().id;
        await app.inject({
          method: "PUT",
          url: `/api/projects/${projectId}/tooling`,
          headers: { authorization: `Bearer ${TEST_TOKEN}` },
          payload: { briefing: "run tests before commit" },
        });
        await app.inject({
          method: "PUT",
          url: `/api/projects/${projectId}/tooling/skill`,
          headers: { authorization: `Bearer ${TEST_TOKEN}` },
          payload: {
            skill: "---\nname: x\ndescription: y\n---\nbody",
          },
        });
        const socket = await fullScopeSocket(app!);
        socket.write(
          `${JSON.stringify({ id: 1, op: "projects.get_tooling", body: { projectId } })}\n`,
        );
        const reply = await waitForReply(socket);
        expect(reply.ok).toBe(true);
        expect(reply.result).toEqual({
          briefing: "run tests before commit",
          skill: "---\nname: x\ndescription: y\n---\nbody",
          reviewerAgent: null,
        });
        socket.destroy();
      });

      it("full scope: 400s with no projectId", async () => {
        app = await buildApp();
        await app.ready();
        const socket = await fullScopeSocket(app!);
        socket.write(`${JSON.stringify({ id: 1, op: "projects.get_tooling" })}\n`);
        const reply = await waitForReply(socket);
        expect(reply).toEqual({
          id: 1,
          ok: false,
          status: 400,
          error: "'projectId' is required",
        });
        socket.destroy();
      });

      it("full scope: 404s on unknown project id", async () => {
        app = await buildApp();
        await app.ready();
        const socket = await fullScopeSocket(app!);
        socket.write(
          `${JSON.stringify({ id: 1, op: "projects.get_tooling", body: { projectId: 9999 } })}\n`,
        );
        const reply = await waitForReply(socket);
        expect(reply.ok).toBe(false);
        expect(reply.status).toBe(404);
        socket.destroy();
      });

      it("session scope: returns the pinned session's project's tooling with no projectId", async () => {
        app = await buildApp();
        await app.ready();
        const { hookToken } = await createRealSession(app!, ptyMock);
        const socket = await sessionScopeSocket(app!, hookToken);
        socket.write(`${JSON.stringify({ id: 1, op: "projects.get_tooling" })}\n`);
        const reply = await waitForReply(socket);
        expect(reply.ok).toBe(true);
        expect(reply.result).toEqual({
          briefing: null,
          skill: null,
          reviewerAgent: null,
        });
        socket.destroy();
      });
    });

    describe("projects.set_tooling", () => {
      it("full scope: upserts all three fields and returns the per-field PUT results", async () => {
        app = await buildApp();
        await app.ready();
        const project = await app.inject({
          method: "POST",
          url: "/api/projects",
          headers: { authorization: `Bearer ${TEST_TOKEN}` },
          payload: { allowDuplicate: true, createDir: true, name: "p", cwd: "/tmp" },
        });
        const projectId = project.json().id;
        const socket = await fullScopeSocket(app!);
        socket.write(
          `${JSON.stringify({
            id: 1,
            op: "projects.set_tooling",
            body: {
              projectId,
              briefing: "don't run on Fridays",
              skill: "---\nname: s\ndescription: d\n---\nbody",
              reviewerAgent: "---\nname: r\ndescription: d\n---\nbody",
            },
          })}\n`,
        );
        const reply = await waitForReply(socket);
        expect(reply.id).toBe(1);
        expect(reply.ok).toBe(true);
        // Per-field PUTs are spread at the top level alongside `ok`,
        // not nested under a `result` key.
        expect(reply.briefing).toEqual({
          ok: true,
          status: 200,
          result: { briefing: "don't run on Fridays" },
        });
        expect(reply.skill).toEqual({
          ok: true,
          status: 200,
          result: { skill: "---\nname: s\ndescription: d\n---\nbody" },
        });
        expect(reply.reviewerAgent).toEqual({
          ok: true,
          status: 200,
          result: { reviewerAgent: "---\nname: r\ndescription: d\n---\nbody" },
        });
        // Round-trip via get_tooling to confirm persistence.
        socket.write(
          `${JSON.stringify({ id: 2, op: "projects.get_tooling", body: { projectId } })}\n`,
        );
        const getReply = await waitForReply(socket);
        expect(getReply.result).toEqual({
          briefing: "don't run on Fridays",
          skill: "---\nname: s\ndescription: d\n---\nbody",
          reviewerAgent: "---\nname: r\ndescription: d\n---\nbody",
        });
        socket.destroy();
      });

      it("full scope: partial upsert — only the provided fields are forwarded", async () => {
        app = await buildApp();
        await app.ready();
        const project = await app.inject({
          method: "POST",
          url: "/api/projects",
          headers: { authorization: `Bearer ${TEST_TOKEN}` },
          payload: { allowDuplicate: true, createDir: true, name: "p", cwd: "/tmp" },
        });
        const projectId = project.json().id;
        const socket = await fullScopeSocket(app!);
        socket.write(
          `${JSON.stringify({
            id: 1,
            op: "projects.set_tooling",
            body: { projectId, briefing: "only briefing" },
          })}\n`,
        );
        const reply = await waitForReply(socket);
        expect(reply.id).toBe(1);
        expect(reply.ok).toBe(true);
        // Per-field results are spread at the top level alongside `ok`,
        // not nested under a `result` key.
        expect(reply.briefing).toEqual({
          ok: true,
          status: 200,
          result: { briefing: "only briefing" },
        });
        // skill and reviewerAgent were not sent, so no entries.
        expect(reply).not.toHaveProperty("skill");
        expect(reply).not.toHaveProperty("reviewerAgent");
        socket.destroy();
      });

      it("full scope: top-level ok is false when any individual field PUT fails", async () => {
        app = await buildApp();
        await app.ready();
        const project = await app.inject({
          method: "POST",
          url: "/api/projects",
          headers: { authorization: `Bearer ${TEST_TOKEN}` },
          payload: { allowDuplicate: true, createDir: true, name: "p", cwd: "/tmp" },
        });
        const projectId = project.json().id;
        const socket = await fullScopeSocket(app!);
        // Oversized briefing exceeds MAX_PROJECT_BRIEFING_FIELD_BYTES
        // (512 bytes), and an invalid skill frontmatter is rejected by
        // the PUT route.
        socket.write(
          `${JSON.stringify({
            id: 1,
            op: "projects.set_tooling",
            body: {
              projectId,
              briefing: "x".repeat(10_000),
              skill: "not-valid-frontmatter",
            },
          })}\n`,
        );
        const reply = await waitForReply(socket);
        expect(reply.id).toBe(1);
        expect(reply.ok).toBe(false);
        // projects.set_tooling nests each field's own result under its
        // name — the reply's shape is the op's, not the socket's generic
        // one, so it is narrowed here.
        const briefing = reply.briefing as { ok: boolean; status: number };
        const skill = reply.skill as { ok: boolean; status: number };
        expect(briefing.ok).toBe(false);
        expect(briefing.status).toBeGreaterThanOrEqual(400);
        expect(skill.ok).toBe(false);
        expect(skill.status).toBeGreaterThanOrEqual(400);
        socket.destroy();
      });

      it("full scope: 400s with no projectId", async () => {
        app = await buildApp();
        await app.ready();
        const socket = await fullScopeSocket(app!);
        socket.write(`${JSON.stringify({ id: 1, op: "projects.set_tooling" })}\n`);
        const reply = await waitForReply(socket);
        expect(reply).toEqual({
          id: 1,
          ok: false,
          status: 400,
          error: "'projectId' is required",
        });
        socket.destroy();
      });

      it("session scope: rejected — full-scope-only op", async () => {
        app = await buildApp();
        await app.ready();
        const { hookToken } = await createRealSession(app!, ptyMock);
        const socket = await sessionScopeSocket(app!, hookToken);
        socket.write(`${JSON.stringify({ id: 1, op: "projects.set_tooling" })}\n`);
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

    describe("previews.create / .get / .delete", () => {
      beforeEach(() => {
        process.env.PREVIEW_BASE_HOST = "preview.example.com";
      });

      it("full scope: creates an external preview and can get/delete it by slug", async () => {
        app = await buildApp();
        await app.ready();
        const socket = await fullScopeSocket(app!);
        socket.write(
          `${JSON.stringify({
            id: 1,
            op: "previews.create",
            body: { kind: "external", url: "https://example.com" },
          })}\n`,
        );
        const createReply = await waitForReply(socket);
        expect(createReply.ok).toBe(true);
        expect(createReply.status).toBe(201);
        const slug = (createReply.result as { slug: string }).slug;
        expect(typeof slug).toBe("string");
        socket.destroy();

        const getSocket = await fullScopeSocket(app!);
        getSocket.write(`${JSON.stringify({ id: 2, op: "previews.get", body: { slug } })}\n`);
        const getReply = await waitForReply(getSocket);
        expect(getReply.ok).toBe(true);
        expect((getReply.result as { slug: string }).slug).toBe(slug);
        getSocket.destroy();

        const deleteSocket = await fullScopeSocket(app!);
        deleteSocket.write(`${JSON.stringify({ id: 3, op: "previews.delete", body: { slug } })}\n`);
        const deleteReply = await waitForReply(deleteSocket);
        expect(deleteReply.ok).toBe(true);
        expect(deleteReply.status).toBe(204);
        deleteSocket.destroy();
      });

      it("previews.get: 400s with no slug", async () => {
        app = await buildApp();
        await app.ready();
        const socket = await fullScopeSocket(app!);
        socket.write(`${JSON.stringify({ id: 1, op: "previews.get" })}\n`);
        const reply = await waitForReply(socket);
        expect(reply).toEqual({ id: 1, ok: false, status: 400, error: "'slug' is required" });
        socket.destroy();
      });

      it("previews.get: 404s for an unknown slug, reshaped from the REST route", async () => {
        app = await buildApp();
        await app.ready();
        const socket = await fullScopeSocket(app!);
        socket.write(
          `${JSON.stringify({ id: 1, op: "previews.get", body: { slug: "nonexistent" } })}\n`,
        );
        const reply = await waitForReply(socket);
        expect(reply.ok).toBe(false);
        expect(reply.status).toBe(404);
        socket.destroy();
      });

      it("session scope: previews.create is rejected — full-scope-only op", async () => {
        app = await buildApp();
        await app.ready();
        const { hookToken } = await createRealSession(app!, ptyMock);
        const socket = await sessionScopeSocket(app!, hookToken);
        socket.write(
          `${JSON.stringify({
            id: 1,
            op: "previews.create",
            body: { kind: "external", url: "https://example.com" },
          })}\n`,
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

      it("full scope: previews.list dispatches to GET /api/previews", async () => {
        app = await buildApp();
        await app.ready();
        const createSocket = await fullScopeSocket(app!);
        createSocket.write(
          `${JSON.stringify({
            id: 1,
            op: "previews.create",
            body: { kind: "external", url: "https://example.com" },
          })}\n`,
        );
        const createReply = await waitForReply(createSocket);
        const slug = (createReply.result as { slug: string }).slug;
        createSocket.destroy();

        const listSocket = await fullScopeSocket(app!);
        listSocket.write(`${JSON.stringify({ id: 2, op: "previews.list" })}\n`);
        const listReply = await waitForReply(listSocket);
        expect(listReply.ok).toBe(true);
        expect(listReply.status).toBe(200);
        const slugs = (listReply.result as { slug: string }[]).map((p) => p.slug);
        expect(slugs).toContain(slug);
        listSocket.destroy();
      });

      it("session scope: previews.list is rejected — full-scope-only op", async () => {
        app = await buildApp();
        await app.ready();
        const { hookToken } = await createRealSession(app!, ptyMock);
        const socket = await sessionScopeSocket(app!, hookToken);
        socket.write(`${JSON.stringify({ id: 1, op: "previews.list" })}\n`);
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

    describe("agents.list", () => {
      it("full scope: dispatches to GET /api/agents", async () => {
        app = await buildApp();
        await app.ready();
        const socket = await fullScopeSocket(app!);
        socket.write(`${JSON.stringify({ id: 1, op: "agents.list" })}\n`);
        const reply = await waitForReply(socket);
        expect(reply.ok).toBe(true);
        expect(reply.status).toBe(200);
        socket.destroy();
      });

      it("session scope: rejected — full-scope-only op", async () => {
        app = await buildApp();
        await app.ready();
        const { hookToken } = await createRealSession(app!, ptyMock);
        const socket = await sessionScopeSocket(app!, hookToken);
        socket.write(`${JSON.stringify({ id: 1, op: "agents.list" })}\n`);
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

    // Issue #944/#945 — bundle.status/resync/remove. HOME/MULLION_HOME
    // redirected to scratch directories for this block specifically
    // (unlike every other op above): unlike agents.list's PATH probing,
    // resync/remove do real filesystem writes under os.homedir() (see
    // bundle-sync.ts) — this must never touch the real machine running
    // the suite, same posture as test/services/bundle-sync.test.ts.
    describe("bundle.status / bundle.resync / bundle.remove", () => {
      const originalHome = process.env.HOME;
      const originalMullionHome = process.env.MULLION_HOME;
      let homeDir: string;
      let mullionHomeDir: string;

      beforeEach(() => {
        homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "control-socket-bundle-fakehome-"));
        mullionHomeDir = fs.mkdtempSync(
          path.join(os.tmpdir(), "control-socket-bundle-fakebundle-"),
        );
        process.env.HOME = homeDir;
        process.env.MULLION_HOME = mullionHomeDir;
      });

      afterEach(() => {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
        if (originalMullionHome === undefined) delete process.env.MULLION_HOME;
        else process.env.MULLION_HOME = originalMullionHome;
        fs.rmSync(homeDir, { recursive: true, force: true });
        fs.rmSync(mullionHomeDir, { recursive: true, force: true });
      });

      it("bundle.status — full scope: dispatches to GET /api/bundle-sync/status", async () => {
        app = await buildApp();
        await app.ready();
        const socket = await fullScopeSocket(app!);
        socket.write(`${JSON.stringify({ id: 1, op: "bundle.status" })}\n`);
        const reply = await waitForReply(socket);
        expect(reply.ok).toBe(true);
        expect(reply.status).toBe(200);
        socket.destroy();
      });

      it("bundle.status — session scope: rejected — full-scope-only op", async () => {
        app = await buildApp();
        await app.ready();
        const { hookToken } = await createRealSession(app!, ptyMock);
        const socket = await sessionScopeSocket(app!, hookToken);
        socket.write(`${JSON.stringify({ id: 1, op: "bundle.status" })}\n`);
        const reply = await waitForReply(socket);
        expect(reply).toEqual({
          id: 1,
          ok: false,
          status: 403,
          error: "not permitted for this connection's scope",
        });
        socket.destroy();
      });

      it("bundle.resync — full scope: dispatches to POST /api/bundle-sync/resync", async () => {
        app = await buildApp();
        await app.ready();
        const socket = await fullScopeSocket(app!);
        socket.write(`${JSON.stringify({ id: 1, op: "bundle.resync" })}\n`);
        const reply = await waitForReply(socket);
        expect(reply.status).toBe(200);
        expect(reply.result).toEqual({ changed: expect.any(Boolean) });
        socket.destroy();
      });

      it("bundle.resync — session scope: rejected — full-scope-only op", async () => {
        app = await buildApp();
        await app.ready();
        const { hookToken } = await createRealSession(app!, ptyMock);
        const socket = await sessionScopeSocket(app!, hookToken);
        socket.write(`${JSON.stringify({ id: 1, op: "bundle.resync" })}\n`);
        const reply = await waitForReply(socket);
        expect(reply).toEqual({
          id: 1,
          ok: false,
          status: 403,
          error: "not permitted for this connection's scope",
        });
        socket.destroy();
      });

      it("bundle.remove — full scope: dispatches to POST /api/bundle-sync/remove", async () => {
        app = await buildApp();
        await app.ready();
        const socket = await fullScopeSocket(app!);
        socket.write(`${JSON.stringify({ id: 1, op: "bundle.remove" })}\n`);
        const reply = await waitForReply(socket);
        expect(reply.status).toBe(200);
        expect(reply.result).toEqual({
          removed: expect.any(Number),
          legacySwept: expect.any(Number),
          settingDisabled: true,
        });
        socket.destroy();
      });

      it("bundle.remove — session scope: rejected — full-scope-only op", async () => {
        app = await buildApp();
        await app.ready();
        const { hookToken } = await createRealSession(app!, ptyMock);
        const socket = await sessionScopeSocket(app!, hookToken);
        socket.write(`${JSON.stringify({ id: 1, op: "bundle.remove" })}\n`);
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
  });
});
