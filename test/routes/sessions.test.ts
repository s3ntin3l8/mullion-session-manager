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
import { spawn as spawnChildProcess } from "node:child_process";
import { eq } from "drizzle-orm";
import { sessions } from "../../src/db/schema.js";
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
setupSessionsRouteLifecycle("core");

describe("sessions route: creating and listing a session", () => {
  it("creates a session, spawns it, and lists it as alive", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      projectId,
      command: "bash",
      status: "active",
      kind: "terminal",
      nameLocked: false,
    });
    const sessionId = created.json().id;

    await waitUntil(async () => {
      const list = await app.inject({ method: "GET", url: `/api/sessions?projectId=${projectId}` });
      return list.json()[0]?.alive === true;
    });

    const list = await app.inject({ method: "GET", url: `/api/sessions?projectId=${projectId}` });
    expect(list.json()).toEqual([expect.objectContaining({ id: sessionId, alive: true })]);

    await app.close();
  });

  // Issue #822 — the DB round trip: `env` persists to sessions.env (not
  // just held in memory for the initial spawn), comes back on the response
  // as a real object (not the raw JSON-as-text column — session-live-info.ts's
  // own override), and actually reaches the spawned process's environment.
  it("persists a session's env, echoes it back as an object, and spawns with it applied", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash", env: { CUSTOM_VAR: "hello" } },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().env).toEqual({ CUSTOM_VAR: "hello" });
    const sessionId = created.json().id;

    const fetched = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
    expect(fetched.json().env).toEqual({ CUSTOM_VAR: "hello" });

    const call = vi
      .mocked(spawnChildProcess)
      .mock.calls.findLast(([command]) => command === "systemd-run");
    const opts = call?.[2] as { env?: Record<string, string> };
    expect(opts.env?.CUSTOM_VAR).toBe("hello");

    await app.close();
  });

  it("a corrupt env column does not 500 the session list", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash", env: { A: "1" } },
    });
    const sessionId = created.json().id as number;
    app.db.update(sessions).set({ env: "{not json" }).where(eq(sessions.id, sessionId)).run();

    const list = await app.inject({ method: "GET", url: `/api/sessions?projectId=${projectId}` });
    expect(list.statusCode).toBe(200);
    expect(list.json().find((s: { id: number }) => s.id === sessionId).env).toBeNull();
    await app.close();
  });

  it("rejects an unknown kind/status filter with 400", async () => {
    const app = await buildApp();
    expect((await app.inject({ method: "GET", url: "/api/sessions?kind=nope" })).statusCode).toBe(
      400,
    );
    expect((await app.inject({ method: "GET", url: "/api/sessions?status=nope" })).statusCode).toBe(
      400,
    );
    await app.close();
  });

  it("rejects a non-integer projectId query instead of silently returning []", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/sessions?projectId=abc" });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("a session created with no env echoes it back as null, not an empty object or the string 'null'", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" },
    });
    expect(created.json().env).toBeNull();

    await app.close();
  });

  // Root-cause fix for the opencode `command`-embedded-prompt trap: before
  // this, spawn_child_session (and any other caller of POST /api/sessions)
  // had no channel to submit a real first turn at all, so an opencode-hosted
  // caller baked prompt text straight into `command` — which opencode's CLI
  // misreads as its `[project]` start-directory positional and fails to
  // launch on (opencode.ts's own comment documents this exact trap).
  // `seedPrompt` is the fix, mirroring the promote route's own
  // commandSupportsSeed-gated "argv turn vs. context-only" translation (see
  // "delivers the promote seed as initialPrompt argv..." above for the
  // promote-route version of this same test).
  it("delivers a direct-create seedPrompt as initialPrompt argv for a seed-capable command (opencode)", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "opencode", seedPrompt: "do the thing" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().initialPromptApplied).toBe(true);

    const call = vi
      .mocked(spawnChildProcess)
      .mock.calls.findLast(([command]) => command === "systemd-run");
    const args = call?.[1] as string[];
    expect(args[args.length - 1]).toBe("opencode --standalone --prompt 'do the thing'");

    await app.close();
  });

  // The other half of the same fix: a command with no matched hook adapter
  // at all (plain `bash`) has no argv channel and no hook round trip either
  // — the session must still launch normally (no 400, no crash), just
  // without the prompt, and the caller must be told so via
  // `initialPromptApplied: false` rather than a silent no-op that looks
  // identical to success.
  it("still creates the session when seedPrompt is set on a command with no matched adapter, and reports it as not applied", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash", seedPrompt: "do the thing" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().initialPromptApplied).toBe(false);

    const call = vi
      .mocked(spawnChildProcess)
      .mock.calls.findLast(([command]) => command === "systemd-run");
    const args = call?.[1] as string[];
    expect(args[args.length - 1]).toBe("bash");

    await app.close();
  });

  it("omits initialPromptApplied when no seedPrompt is given at all", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().initialPromptApplied).toBeUndefined();

    await app.close();
  });

  // Hermes review, PR #1333 — a whitespace-only seedPrompt has length > 0
  // before trimming, which would otherwise deliver a literal `--prompt
  // '   '` to the child instead of cleanly falling through to no delivery.
  it("treats a whitespace-only seedPrompt as no seed at all", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "opencode", seedPrompt: "   " },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().initialPromptApplied).toBeUndefined();

    const call = vi
      .mocked(spawnChildProcess)
      .mock.calls.findLast(([command]) => command === "systemd-run");
    const args = call?.[1] as string[];
    expect(args[args.length - 1]).toBe("opencode --standalone");

    await app.close();
  });

  // Hermes review, this PR (issue #822) — a direct full-scope POST
  // /api/sessions call never goes through dock-config.ts's validateOneControl
  // (that's the .crs/dock.json write path only), so the reserved-key check
  // has to be enforced again in createSessionRecord itself or this route
  // would silently re-introduce exactly the vars buildSessionEnv()'s scrub
  // (issue #70) exists to strip. Covers a SERVER_ENV_KEYS member
  // (DATABASE_URL) alongside the pre-existing MULLION_*/SSH_AUTH_SOCK
  // classes, since those three are validated by the same shared predicate
  // but were previously exercised only via dock-config.test.ts.
  it.each([
    ["a MULLION_-prefixed key", "MULLION_AUTH_TOKEN"],
    ["SSH_AUTH_SOCK", "SSH_AUTH_SOCK"],
    ["a SERVER_ENV_KEYS member (DATABASE_URL)", "DATABASE_URL"],
  ])(
    "rejects %s in env on direct POST /api/sessions, and creates no session",
    async (_label, key) => {
      const app = await buildApp();
      const projectId = await createProject(app);

      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash", env: { [key]: "attacker-value" } },
      });
      expect(created.statusCode).toBe(400);
      expect(created.json().message).toMatch(new RegExp(key));

      const list = await app.inject({ method: "GET", url: `/api/sessions?projectId=${projectId}` });
      expect(list.json()).toEqual([]);

      await app.close();
    },
  );

  // Regression test for the bug that shipped in PR #300: SessionInfo grew
  // permissionState/planState/errorState/endedReason, but withLiveInfo
  // (session-live-info.ts) hand-enumerated which live fields to copy onto each
  // row and was never updated, leaving those four permanently absent from
  // every REST response — which in turn left Sidebar.tsx's "Needs
  // permission"/"Plan ready"/"API error"/"Tool failure" branches unreachable
  // even though the backend hook plumbing behind them worked correctly. This
  // asserts the FULL live-info field set is present (with its documented
  // idle/no-signal defaults) so a future field added to SessionInfo without
  // being wired into buildLiveInfo is caught by a failing assertion here, in
  // addition to the `LiveInfoKey` exhaustiveness check `make typecheck` now
  // enforces at the type level.
  it("includes every live-only SessionInfo field in the session list response", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" },
    });
    const sessionId = created.json().id;

    await waitUntil(async () => {
      const list = await app.inject({ method: "GET", url: `/api/sessions?projectId=${projectId}` });
      return list.json()[0]?.alive === true;
    });

    const list = await app.inject({ method: "GET", url: `/api/sessions?projectId=${projectId}` });
    expect(list.json()).toEqual([
      expect.objectContaining({
        id: sessionId,
        alive: true,
        subscriberCount: 0,
        activity: "idle",
        lastActivityAt: null,
        liveCwd: null,
        attention: false,
        attentionAt: null,
        lastTitle: null,
        liveBranch: null,
        gateState: "idle",
        gatePrompt: null,
        promoteState: "idle",
        promoteSummary: null,
        promoteSuggestedBaseRef: null,
        permissionState: "idle",
        planState: "idle",
        errorState: "idle",
        endedReason: null,
        exitCode: null,
        // Rich statuses (issue: extend surfaced session statuses).
        attentionKind: null,
        errorDetail: null,
        lastAssistantMessage: null,
        compactState: "idle",
        subagentCount: 0,
        elicitationState: "idle",
        elicitationServer: null,
        lastTurnEndedAt: null,
        hookEmits: [],
        sessionStatus: "idle",
        sessionStatusSeverity: "dormant",
        sessionStatusDetail: null,
        sessionStatusAttentionRequired: false,
      }),
    ]);

    // POST /api/sessions' own response shares the same withLiveInfo via
    // withLiveStatus (session-live-info.ts) — assert it isn't a second,
    // possibly-drifting copy of the field list.
    expect(created.json()).toMatchObject({
      permissionState: "idle",
      planState: "idle",
      errorState: "idle",
      endedReason: null,
      sessionStatus: "idle",
      sessionStatusSeverity: "dormant",
    });

    await app.close();
  });

  it("accepts an optional cwd override distinct from the project's cwd", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash", cwd: "/tmp/subdir" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ projectId, command: "bash", cwd: "/tmp/subdir" });

    await app.close();
  });

  it("accepts skipPermissions flag and passes it through", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash", skipPermissions: true },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ projectId, command: "bash", skipPermissions: true });

    await app.close();
  });

  it("creates a dock-kind session and filters it via ?kind=dock (WS-5)", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" }, // default kind: terminal
    });
    const dockCreated = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "npm run dev", kind: "dock" },
    });
    expect(dockCreated.json()).toMatchObject({ kind: "dock" });

    const dockOnly = await app.inject({
      method: "GET",
      url: `/api/sessions?projectId=${projectId}&kind=dock`,
    });
    expect(dockOnly.json()).toEqual([expect.objectContaining({ kind: "dock" })]);

    const terminalOnly = await app.inject({
      method: "GET",
      url: `/api/sessions?projectId=${projectId}&kind=terminal`,
    });
    expect(
      (terminalOnly.json() as Array<{ kind: string }>).every((s) => s.kind === "terminal"),
    ).toBe(true);

    await app.close();
  });

  it("rejects an invalid kind querystring value", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/sessions?kind=bogus" });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  // Perf audit finding A6 — GET /api/sessions had no status filter at all,
  // so every 4s poll tick paid for every `killed` tombstone ever created
  // (nothing purges them). This asserts the new filter actually narrows the
  // result set, same pattern as the ?kind= test above.
  it("filters the session list by ?status=", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" },
    });
    const sessionId = created.json().id;
    await waitUntil(async () => {
      const list = await app.inject({ method: "GET", url: `/api/sessions?projectId=${projectId}` });
      return list.json()[0]?.alive === true;
    });

    const killed = await app.inject({ method: "DELETE", url: `/api/sessions/${sessionId}` });
    expect(killed.statusCode).toBe(204);

    const activeOnly = await app.inject({
      method: "GET",
      url: `/api/sessions?projectId=${projectId}&status=active`,
    });
    expect(activeOnly.json()).toEqual([]);

    const killedOnly = await app.inject({
      method: "GET",
      url: `/api/sessions?projectId=${projectId}&status=killed`,
    });
    expect(killedOnly.json()).toEqual([
      expect.objectContaining({ id: sessionId, status: "killed" }),
    ]);

    await app.close();
  });

  // Perf audit finding A6 — withLiveInfo (session-live-info.ts) used to call
  // resolveProjectHostId(app, row.projectId) itself, re-running the exact
  // per-project SELECT the route handler had already batched into
  // `projectHostIds` just above it — one redundant synchronous
  // better-sqlite3 query *per session row*, on every request. Pinned by
  // counting `app.db.select` invocations for a 1-row vs. a 5-row list:
  // before the fix this call count scaled with row count; after, GET
  // /api/sessions issues the same fixed number of `select`s regardless of
  // how many sessions it returns.
  it("does not issue a per-row DB query for host resolution in the session list (no N+1)", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" },
    });

    const selectSpy = vi.spyOn(app.db, "select");
    selectSpy.mockClear();
    const oneRow = await app.inject({ method: "GET", url: `/api/sessions?projectId=${projectId}` });
    expect(oneRow.json()).toHaveLength(1);
    const callsForOneRow = selectSpy.mock.calls.length;

    for (let i = 0; i < 4; i++) {
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
    }

    selectSpy.mockClear();
    const fiveRows = await app.inject({
      method: "GET",
      url: `/api/sessions?projectId=${projectId}`,
    });
    expect(fiveRows.json()).toHaveLength(5);
    const callsForFiveRows = selectSpy.mock.calls.length;

    // Constant, not scaling with row count — an N+1 here would show
    // callsForFiveRows == callsForOneRow + 4.
    expect(callsForFiveRows).toBe(callsForOneRow);

    selectSpy.mockRestore();
    await app.close();
  });

  // Perf audit finding A4 — @fastify/compress is registered via app.ts's
  // onRoute hook before routes/sessions.ts's routes are registered, so it
  // must cover this API route too, not just @fastify/static's assets (see
  // test/plugins/static.test.ts's equivalent assertion). This is the
  // biggest single win in A4 (a poll-heavy JSON payload hit every 4s from
  // every open tab), so it's pinned directly rather than just assumed from
  // registration order — the preview-proxy path in
  // test/plugins/preview-proxy.test.ts is the one route that does NOT get
  // this coverage, and is asserted separately as a documented exception.
  it("compresses a large GET /api/sessions response when the client accepts gzip", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    // Pad well past @fastify/compress's default 1024-byte threshold — a
    // single session row is small, so create enough of them.
    for (let i = 0; i < 10; i++) {
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash", name: `session-${i}-with-a-somewhat-longer-name` },
      });
    }

    const uncompressedCheck = await app.inject({
      method: "GET",
      url: `/api/sessions?projectId=${projectId}`,
    });
    expect(uncompressedCheck.rawPayload.length).toBeGreaterThan(1024);

    const response = await app.inject({
      method: "GET",
      url: `/api/sessions?projectId=${projectId}`,
      headers: { "accept-encoding": "gzip" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-encoding"]).toBe("gzip");

    await app.close();
  });
});
