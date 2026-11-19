// Must come before any import below that could itself trigger loading
// "node-pty"/"node:child_process" (e.g. the `node:child_process` import a
// few lines down) — see mock-pty.ts's header comment for the
// empirically confirmed hoisting/ordering failure mode.
import { createNodePtyMock } from "../helpers/mock-pty.js";
import {
  fakeSessionBackend,
  mockSpawnModule,
  opencodeTransferMock,
  setupSessionsRouteLifecycle,
} from "../helpers/sessions-routes.js";
import { describe, expect, it, vi } from "vitest";
import type { SessionBackend } from "../../src/services/session-backend.js";
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
setupSessionsRouteLifecycle("promote-remote");

describe("sessions route: promoting a session on a remote host", () => {
  // Issue #679 — resolvePendingPromote only clears the SOURCE session's
  // own blocked `promote_request` MCP tool call, a concern entirely
  // separate from whether the promote itself succeeded (the replacement
  // session already exists and is running by the time this call
  // happens). A failure here must not turn a genuinely successful
  // promote into a bare 500, and must not skip killing the source
  // session either.
  describe("option 2 — POST /:id/promote, when resolvePendingPromote fails on a remote host (issue #679)", () => {
    async function createRemotePromoteProject(app: Awaited<ReturnType<typeof buildApp>>) {
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        // Deliberately unreachable — resolveBackend is spied per-test to
        // return a fake backend, so this baseUrl is never actually hit.
        payload: { name: "promote-remote", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const hostId = host.json().id as string;
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          name: "remote-promote-p",
          cwd: "/remote/project",
          hostId,
        },
      });
      return { projectId: project.json().id as number, hostId };
    }

    function makeFakeBackend(
      resolvePendingPromote: SessionBackend["resolvePendingPromote"],
      // Hermes review, this PR — parameterized (default unchanged) so the
      // version-skew warning tests below can simulate a remote spawn
      // response that never echoes `initialPromptApplied` at all
      // (`{}`, i.e. `undefined`) — an old agent build silently stripping
      // the unknown field, not the same thing as it explicitly reporting
      // `false`. See resolveSeedDelivered's own doc comment.
      spawnResult: { initialPromptApplied?: boolean } = { initialPromptApplied: false },
    ): SessionBackend {
      return fakeSessionBackend({
        createWorktree: vi.fn().mockResolvedValue({
          created: true,
          path: "/remote/project/.mullion-worktrees/mullion-session-x",
          branch: "mullion/session-x",
        }),
        spawn: vi.fn().mockResolvedValue(spawnResult),
        resolvePendingPromote,
      });
    }

    it("201s with a warning (not a 500) when the host rejects the request (HostRequestError), and still kills the source", async () => {
      const app = await buildApp();
      const sessionBackendModule = await import("../../src/services/session-backend.js");
      const { HostRequestError } = await import("../../src/services/remote-host-client.js");
      const { projectId } = await createRemotePromoteProject(app);

      const resolvePendingPromote = vi
        .fn()
        .mockRejectedValue(new HostRequestError("promote-remote", 409, "conflict"));
      const fakeBackend = makeFakeBackend(resolvePendingPromote);
      const resolveBackendSpy = vi
        .spyOn(sessionBackendModule, "resolveBackend")
        .mockReturnValue(fakeBackend);

      // The spy must already be installed before the SOURCE session is
      // created too — it also spawns through resolveBackend, against the
      // same (deliberately unreachable) host.
      const sourceRes = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      expect(sourceRes.statusCode).toBe(201);
      const sourceId = sourceRes.json().id as number;

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sourceId}/promote`,
        payload: { baseRef: "main" },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.id).not.toBe(sourceId);
      expect(body.warnings).toBeDefined();
      expect(body.warnings.length).toBeGreaterThan(0);
      expect(fakeBackend.terminate).toHaveBeenCalledWith(String(sourceId));

      resolveBackendSpy.mockRestore();
      await app.close();
    });

    it("201s with a warning (not a 500) when the host is unreachable (HostUnreachableError), and still kills the source", async () => {
      const app = await buildApp();
      const sessionBackendModule = await import("../../src/services/session-backend.js");
      const { HostUnreachableError } = await import("../../src/services/remote-host-client.js");
      const { projectId } = await createRemotePromoteProject(app);

      const resolvePendingPromote = vi
        .fn()
        .mockRejectedValue(new HostUnreachableError("promote-remote", "connection refused"));
      const fakeBackend = makeFakeBackend(resolvePendingPromote);
      const resolveBackendSpy = vi
        .spyOn(sessionBackendModule, "resolveBackend")
        .mockReturnValue(fakeBackend);

      const sourceRes = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      expect(sourceRes.statusCode).toBe(201);
      const sourceId = sourceRes.json().id as number;

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sourceId}/promote`,
        payload: { baseRef: "main" },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.warnings).toBeDefined();
      expect(body.warnings.length).toBeGreaterThan(0);
      expect(fakeBackend.terminate).toHaveBeenCalledWith(String(sourceId));

      // The replacement session is genuinely usable, not a half-built
      // stub — same bar the plan's own verification section set.
      const list = await app.inject({
        method: "GET",
        url: `/api/sessions?projectId=${projectId}`,
      });
      const newRow = list.json().find((s: { id: number }) => s.id === body.id);
      expect(newRow).toBeDefined();
      expect(newRow.status).toBe("active");

      resolveBackendSpy.mockRestore();
      await app.close();
    });

    it("omits warnings entirely on the ordinary success path (no false-positive noise)", async () => {
      const app = await buildApp();
      const sessionBackendModule = await import("../../src/services/session-backend.js");
      const { projectId } = await createRemotePromoteProject(app);

      const fakeBackend = makeFakeBackend(vi.fn().mockResolvedValue(true));
      const resolveBackendSpy = vi
        .spyOn(sessionBackendModule, "resolveBackend")
        .mockReturnValue(fakeBackend);

      const sourceRes = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      expect(sourceRes.statusCode).toBe(201);
      const sourceId = sourceRes.json().id as number;

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sourceId}/promote`,
        payload: { baseRef: "main" },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().warnings).toBeUndefined();

      resolveBackendSpy.mockRestore();
      await app.close();
    });
  });

  // Hermes review, this PR — the `initialPromptApplied` version-skew
  // warning added alongside the initial-prompt delivery fix, exercised
  // only for a remote host (a local spawn is always the same build as
  // this route, so resolveSeedDelivered short-circuits to `true` there
  // regardless of what the response says — see that helper's own doc
  // comment and routes/sessions.ts's promote handler).
  describe("option 2 — POST /:id/promote, initialPromptApplied version-skew warning (remote host)", () => {
    async function createRemotePromoteProject(app: Awaited<ReturnType<typeof buildApp>>) {
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "promote-remote-skew", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const hostId = host.json().id as string;
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          name: "remote-promote-skew-p",
          cwd: "/remote/project",
          hostId,
        },
      });
      return { projectId: project.json().id as number, hostId };
    }

    function makeFakeBackend(spawnResult: { initialPromptApplied?: boolean }): SessionBackend {
      return fakeSessionBackend({
        createWorktree: vi.fn().mockResolvedValue({
          created: true,
          path: "/remote/project/.mullion-worktrees/mullion-session-x",
          branch: "mullion/session-x",
        }),
        spawn: vi.fn().mockResolvedValue(spawnResult),
        resolvePendingPromote: vi.fn().mockResolvedValue(true),
      });
    }

    it("warns when a remote spawn never echoes initialPromptApplied at all (undefined, not false — an old build silently stripping the field)", async () => {
      const app = await buildApp();
      const sessionBackendModule = await import("../../src/services/session-backend.js");
      const { projectId } = await createRemotePromoteProject(app);

      // `{}` — no `initialPromptApplied` key at all, exactly what an
      // old-build response looks like: `initialPromptApplied` comes back
      // `undefined`, not `false`.
      const fakeBackend = makeFakeBackend({});
      const resolveBackendSpy = vi
        .spyOn(sessionBackendModule, "resolveBackend")
        .mockReturnValue(fakeBackend);

      const sourceRes = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "opencode" },
      });
      expect(sourceRes.statusCode).toBe(201);
      const sourceId = sourceRes.json().id as number;

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sourceId}/promote`,
        payload: { baseRef: "main", seedPrompt: "resume the refactor" },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.warnings).toBeDefined();
      expect(body.warnings).toContain(
        "The promoted session is running, but its seed prompt could not be submitted as a first turn — it may be sitting idle until you send it a message.",
      );

      resolveBackendSpy.mockRestore();
      await app.close();
    });

    it("omits the warning when a remote spawn confirms initialPromptApplied: true", async () => {
      const app = await buildApp();
      const sessionBackendModule = await import("../../src/services/session-backend.js");
      const { projectId } = await createRemotePromoteProject(app);

      const fakeBackend = makeFakeBackend({ initialPromptApplied: true });
      const resolveBackendSpy = vi
        .spyOn(sessionBackendModule, "resolveBackend")
        .mockReturnValue(fakeBackend);

      const sourceRes = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "opencode" },
      });
      expect(sourceRes.statusCode).toBe(201);
      const sourceId = sourceRes.json().id as number;

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sourceId}/promote`,
        payload: { baseRef: "main", seedPrompt: "resume the refactor" },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().warnings).toBeUndefined();

      resolveBackendSpy.mockRestore();
      await app.close();
    });

    it("never warns when no seed was requested at all, regardless of what the remote spawn reports", async () => {
      const app = await buildApp();
      const sessionBackendModule = await import("../../src/services/session-backend.js");
      const { projectId } = await createRemotePromoteProject(app);

      const fakeBackend = makeFakeBackend({});
      const resolveBackendSpy = vi
        .spyOn(sessionBackendModule, "resolveBackend")
        .mockReturnValue(fakeBackend);

      const sourceRes = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "opencode" },
      });
      expect(sourceRes.statusCode).toBe(201);
      const sourceId = sourceRes.json().id as number;

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sourceId}/promote`,
        payload: { baseRef: "main" },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().warnings).toBeUndefined();

      resolveBackendSpy.mockRestore();
      await app.close();
    });
  });
});
