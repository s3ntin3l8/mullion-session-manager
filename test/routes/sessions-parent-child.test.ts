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
setupSessionsRouteLifecycle("parent-child");

describe("sessions route: parent and child sessions", () => {
  // Phase 5 (Track B, issue #193 5.3b) — parentSessionId validation and the
  // sessions.spawn_child guardrails, exercised at the REST layer
  // (createSessionRecord is shared by POST /api/sessions and the socket op;
  // control-socket.test.ts covers the op-specific resolution/stamping).
  describe("parentSessionId (Phase 5, issue #193 5.3b)", () => {
    async function createActiveSession(
      app: Awaited<ReturnType<typeof buildApp>>,
      projectId: number,
      overrides: Record<string, unknown> = {},
    ) {
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash", ...overrides },
      });
      expect(created.statusCode).toBe(201);
      return created.json().id as number;
    }

    it("spawns a child with parentSessionId set and returns it in the response", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const parentId = await createActiveSession(app, projectId);

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash", parentSessionId: parentId },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().parentSessionId).toBe(parentId);

      await app.close();
    });

    it("stores the advisory open hint on a child and returns it (issue #1624)", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const parentId = await createActiveSession(app, projectId);

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash", parentSessionId: parentId, open: "below" },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().openHint).toBe("below");

      // Reaches the list the frontend polls, via the row spread.
      const list = await app.inject({ method: "GET", url: "/api/sessions" });
      const listed = list.json().find((s: { id: number }) => s.id === res.json().id);
      expect(listed.openHint).toBe("below");

      await app.close();
    });

    it("ignores `open` on a session with no parent, and rejects an invalid value", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);

      const noParent = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash", open: "right" },
      });
      expect(noParent.statusCode).toBe(201);
      expect(noParent.json().openHint).toBeNull();

      const invalid = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash", open: "left" },
      });
      expect(invalid.statusCode).toBe(400);

      await app.close();
    });

    it("400s an unknown parentSessionId", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash", parentSessionId: 999_999 },
      });

      expect(res.statusCode).toBe(400);

      await app.close();
    });

    it("400s a parentSessionId belonging to a different project", async () => {
      const app = await buildApp();
      const projectA = await createProject(app);
      const projectB = await createProject(app);
      const parentInB = await createActiveSession(app, projectB);

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId: projectA, command: "bash", parentSessionId: parentInB },
      });

      expect(res.statusCode).toBe(400);

      await app.close();
    });

    // Issue #2110 — the one exception to "same project": a parent whose project
    // is a coordinator (projects.allowCrossProjectSpawn). The rule lives in the
    // lifecycle, so a direct POST /api/sessions is bound by it too.
    it("accepts a parentSessionId from a different project when that project is a coordinator (#2110)", async () => {
      const app = await buildApp();
      const coordinator = await createProject(app);
      const target = await createProject(app);
      const parent = await createActiveSession(app, coordinator);
      const patch = await app.inject({
        method: "PATCH",
        url: `/api/projects/${coordinator}`,
        payload: { allowCrossProjectSpawn: true },
      });
      expect(patch.statusCode).toBe(200);

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId: target, command: "bash", parentSessionId: parent },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ projectId: target, parentSessionId: parent });

      await app.close();
    });

    it("the coordinator flag belongs to the PARENT's project, not the target's (#2110)", async () => {
      const app = await buildApp();
      const coordinator = await createProject(app);
      const target = await createProject(app);
      const parentInTarget = await createActiveSession(app, target);
      await app.inject({
        method: "PATCH",
        url: `/api/projects/${coordinator}`,
        payload: { allowCrossProjectSpawn: true },
      });

      // The flag is on `coordinator`, but the parent lives in `target`.
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId: coordinator, command: "bash", parentSessionId: parentInTarget },
      });

      expect(res.statusCode).toBe(400);

      await app.close();
    });

    it("still 400s a cross-project parent that is itself a child, even for a coordinator (#2110)", async () => {
      const app = await buildApp();
      const coordinator = await createProject(app);
      const target = await createProject(app);
      const grandparent = await createActiveSession(app, coordinator);
      const parent = await createActiveSession(app, coordinator, { parentSessionId: grandparent });
      await app.inject({
        method: "PATCH",
        url: `/api/projects/${coordinator}`,
        payload: { allowCrossProjectSpawn: true },
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId: target, command: "bash", parentSessionId: parent },
      });

      expect(res.statusCode).toBe(400);

      await app.close();
    });

    it("400s spawning a child of a session that is ITSELF a child — one level of nesting only", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const grandparentId = await createActiveSession(app, projectId);
      const parentId = await createActiveSession(app, projectId, {
        parentSessionId: grandparentId,
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash", parentSessionId: parentId },
      });

      expect(res.statusCode).toBe(400);

      await app.close();
    });

    it("400s a child spawn whose cwd resolves outside the project directory", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const parentId = await createActiveSession(app, projectId);

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: {
          projectId,
          command: "bash",
          parentSessionId: parentId,
          cwd: "/etc/passwd-adjacent-escape",
        },
      });

      expect(res.statusCode).toBe(400);

      await app.close();
    });

    it("429s once a parent's LIVE child count reaches maxChildSessionsPerParent", async () => {
      const app = await buildApp();
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { sessions: { maxChildSessionsPerParent: 2 } },
      });
      const projectId = await createProject(app);
      const parentId = await createActiveSession(app, projectId);

      await createActiveSession(app, projectId, { parentSessionId: parentId });
      await createActiveSession(app, projectId, { parentSessionId: parentId });

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash", parentSessionId: parentId },
      });

      expect(res.statusCode).toBe(429);

      await app.close();
    });

    it("does not count a killed child against the live cap", async () => {
      const app = await buildApp();
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { sessions: { maxChildSessionsPerParent: 1 } },
      });
      const projectId = await createProject(app);
      const parentId = await createActiveSession(app, projectId);
      const firstChildId = await createActiveSession(app, projectId, {
        parentSessionId: parentId,
      });

      await app.inject({ method: "DELETE", url: `/api/sessions/${firstChildId}` });

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash", parentSessionId: parentId },
      });

      expect(res.statusCode).toBe(201);

      await app.close();
    });

    // Issue #1337 — when parentSessionId is set and model/smallModel are
    // not explicitly supplied by the caller, the child inherits the parent
    // session's model/smallModel before falling through to install-wide
    // defaults.
    it("inherits parent's model when child omits it", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const parentId = await createActiveSession(app, projectId, {
        command: "opencode",
        model: "openrouter/anthropic/claude-sonnet-4-5",
        smallModel: "openrouter/anthropic/claude-haiku-3.5",
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: {
          projectId,
          command: "opencode",
          parentSessionId: parentId,
        },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().model).toBe("openrouter/anthropic/claude-sonnet-4-5");
      expect(res.json().smallModel).toBe("openrouter/anthropic/claude-haiku-3.5");

      await app.close();
    });

    it("does not inherit parent's model when child supplies its own", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const parentId = await createActiveSession(app, projectId, {
        command: "opencode",
        model: "openrouter/anthropic/claude-sonnet-4-5",
        smallModel: "openrouter/anthropic/claude-haiku-3.5",
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: {
          projectId,
          command: "opencode",
          parentSessionId: parentId,
          model: "openrouter/minimax-m3",
        },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().model).toBe("openrouter/minimax-m3");
      // smallModel is still inherited since it was not explicitly set
      expect(res.json().smallModel).toBe("openrouter/anthropic/claude-haiku-3.5");

      await app.close();
    });

    it("does not inherit parent's model for non-opencode commands", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const parentId = await createActiveSession(app, projectId, {
        command: "opencode",
        model: "openrouter/anthropic/claude-sonnet-4-5",
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: {
          projectId,
          command: "bash",
          parentSessionId: parentId,
        },
      });

      expect(res.statusCode).toBe(201);
      // Non-opencode commands don't get model stamping at all
      expect(res.json().model).toBeNull();

      await app.close();
    });

    it("does not inherit when parent has no model", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const parentId = await createActiveSession(app, projectId, {
        command: "opencode",
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: {
          projectId,
          command: "opencode",
          parentSessionId: parentId,
        },
      });

      expect(res.statusCode).toBe(201);
      // No parent model, so it falls through to install-wide default (or null)
      expect(res.json().model).toBeNull();

      await app.close();
    });
  });

  // Phase 5 (Track B, issue #196 5.6) — killSession's cascade parameter,
  // exercised via the DELETE route's own ?cascade= querystring.
  describe("cascade kill (Phase 5, issue #196 5.6)", () => {
    async function createActiveSession(
      app: Awaited<ReturnType<typeof buildApp>>,
      projectId: number,
      overrides: Record<string, unknown> = {},
    ) {
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash", ...overrides },
      });
      expect(created.statusCode).toBe(201);
      return created.json().id as number;
    }

    it("defaults to detach: a killed parent's live children survive, re-parented to none", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const parentId = await createActiveSession(app, projectId);
      const childId = await createActiveSession(app, projectId, { parentSessionId: parentId });

      const res = await app.inject({ method: "DELETE", url: `/api/sessions/${parentId}` });
      expect(res.statusCode).toBe(204);

      const child = await app.inject({ method: "GET", url: `/api/sessions/${childId}` });
      expect(child.json().status).toBe("active");
      expect(child.json().parentSessionId).toBe(null);

      await app.close();
    });

    it("?cascade=kill kills live children too", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const parentId = await createActiveSession(app, projectId);
      const childId = await createActiveSession(app, projectId, { parentSessionId: parentId });

      const res = await app.inject({
        method: "DELETE",
        url: `/api/sessions/${parentId}?cascade=kill`,
      });
      expect(res.statusCode).toBe(204);

      const child = await app.inject({ method: "GET", url: `/api/sessions/${childId}` });
      expect(child.json().status).toBe("killed");

      await app.close();
    });

    it("rejects an invalid ?cascade= value", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const sessionId = await createActiveSession(app, projectId);

      const res = await app.inject({
        method: "DELETE",
        url: `/api/sessions/${sessionId}?cascade=bogus`,
      });
      expect(res.statusCode).toBe(400);

      await app.close();
    });
  });
});
