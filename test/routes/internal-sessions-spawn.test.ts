import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import {
  createInternalPtyHarness,
  createInternalChildProcessHarness,
  createBundleSyncHarness,
  createInternalAgentEnv,
  INTERNAL_TEST_TOKEN,
  waitUntil,
  waitForOpenOrClose,
  waitForNodeWsOutcome,
  buildAndListen,
} from "../helpers/internal-routes.js";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { WebSocket as NodeWebSocket } from "ws";

const ptyHarness = createInternalPtyHarness();
const childProcessHarness = createInternalChildProcessHarness();
const bundleSyncHarness = createBundleSyncHarness();

vi.mock("node-pty", () => ptyHarness.mockModule());
vi.mock("node:child_process", async (importOriginal) =>
  childProcessHarness.mockModule(await importOriginal()),
);
vi.mock("../../src/services/bundle-sync.js", () => bundleSyncHarness.mockModule());
const { buildApp } = await import("../../src/app.js");
const { clearAgentsCacheForTests } = await import("../../src/services/agent-detect.js");
const { sessionBriefingPath } = await import("../../src/services/project-briefing.js");
const { sessionWorkflowConventionsPath } =
  await import("../../src/services/workflow-conventions.js");
const { spawn: childProcessSpawn } = await import("node:child_process");

const TOKEN = INTERNAL_TEST_TOKEN;
const { fakePtyChildren } = ptyHarness;
const { activeScopeUnits } = childProcessHarness;
const listenApp = () => buildAndListen(buildApp);

describe("internal routes: session spawn, liveness, and attach", () => {
  const env = createInternalAgentEnv();
  beforeAll(() => {
    env.setup();
  });
  afterAll(() => {
    env.teardown();
  });
  beforeEach(() => {
    ptyHarness.reset();
    childProcessHarness.reset();
    bundleSyncHarness.reset();
    clearAgentsCacheForTests();
  });

  it("rejects a session id that isn't a plain alphanumeric token", async () => {
    const app = await buildApp();

    const terminateRes = await app.inject({
      method: "POST",
      url: `/internal/sessions/${encodeURIComponent("weird;id")}/terminate`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(terminateRes.statusCode).toBe(400);

    const spawnRes = await app.inject({
      method: "POST",
      url: "/internal/sessions",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { id: "weird id", cwd: "/tmp", command: "bash", cols: 80, rows: 24 },
    });
    expect(spawnRes.statusCode).toBe(400);

    await app.close();
  });

  // Issue #1423 — defense in depth. The primary (POST /api/sessions)
  // already validates model/smallModel before it forwards a spawn here, so
  // this only matters for a direct caller of this agent-side route.
  it("rejects a spawn whose explicit smallModel isn't provider/model-shaped for an opencode command", async () => {
    const app = await buildApp();

    const spawnRes = await app.inject({
      method: "POST",
      url: "/internal/sessions",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        id: "505",
        cwd: "/tmp",
        command: "opencode",
        cols: 80,
        rows: 24,
        smallModel: "sonnet",
      },
    });
    expect(spawnRes.statusCode).toBe(400);

    await app.close();
  });

  it("rejects a spawn whose explicit model would inject a flag into a Claude Code command line", async () => {
    const app = await buildApp();

    const spawnRes = await app.inject({
      method: "POST",
      url: "/internal/sessions",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        id: "503",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
        model: "--dangerously-skip-permissions",
      },
    });
    expect(spawnRes.statusCode).toBe(400);

    await app.close();
  });

  it("accepts a valid explicit model on a spawn and lands it as --model in the command line", async () => {
    const app = await buildApp();
    const before = fakePtyChildren.length;

    const spawnRes = await app.inject({
      method: "POST",
      url: "/internal/sessions",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        id: "504",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
        model: "opusplan",
      },
    });
    expect(spawnRes.statusCode).toBe(201);
    await waitUntil(() => fakePtyChildren.length > before);

    const call = vi
      .mocked(childProcessSpawn)
      .mock.calls.findLast(([command]) => command === "systemd-run");
    const args = call?.[1] as string[];
    expect(args[args.length - 1]).toContain("--model 'opusplan'");

    await app.close();
  });

  it("returns this host's detected agents", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/internal/agents",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
    await app.close();
  });

  // Issue #2306 — on this (linux) test host nothing is spawned, and the device
  // panel is off, so the list is empty, but the shape is the contract.
  it("returns this host's capabilities behind the same gate", async () => {
    const app = await buildApp();
    const denied = await app.inject({ method: "GET", url: "/internal/capabilities" });
    expect(denied.statusCode).toBe(401);
    const res = await app.inject({
      method: "GET",
      url: "/internal/capabilities",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ capabilities: [] });
    await app.close();
  });

  it("spawns a session, reports its live status/liveness, and terminates it", async () => {
    const app = await buildApp();
    const before = fakePtyChildren.length;

    const spawnRes = await app.inject({
      method: "POST",
      url: "/internal/sessions",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { id: "501", cwd: "/tmp", command: "bash", cols: 80, rows: 24 },
    });
    expect(spawnRes.statusCode).toBe(201);
    await waitUntil(() => fakePtyChildren.length > before);

    const liveRes = await app.inject({
      method: "POST",
      url: "/internal/sessions/live",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { ids: ["501", "never-spawned"], idleThresholdMs: 30_000 },
    });
    expect(liveRes.statusCode).toBe(200);
    const live = liveRes.json();
    expect(live["501"]).toMatchObject({ alive: true, cwd: "/tmp", command: "bash" });
    // #1962 — the two fields a primary waiting on this session cannot get anywhere else.
    expect(live["501"]).toMatchObject({
      eventSeqHead: expect.any(Number),
      agentTurnInFlight: false,
    });
    expect(live["never-spawned"]).toBeNull();

    const livenessRes = await app.inject({
      method: "POST",
      url: "/internal/sessions/liveness",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { ids: ["501"] },
    });
    expect(livenessRes.statusCode).toBe(200);
    // The fake systemd-run spawn above (the POST /internal/sessions call)
    // recorded crs-session-501.scope into activeScopeUnits, so the fake
    // `list-units` reply includes it.
    expect(livenessRes.json()).toEqual({ "501": true });

    const terminateRes = await app.inject({
      method: "POST",
      url: "/internal/sessions/501/terminate",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(terminateRes.statusCode).toBe(204);

    await app.close();
  });

  // #3557 — a launch that fails on this host is reported to the primary
  // with its reason. It used to answer 201 before the launch ran, so a Dock
  // start on a Mac agent into a missing directory showed nothing at all.
  // 4xx on purpose: the primary reads a 5xx as "unreachable" and drops the body.
  it("answers 422 with the classified reason when the launch fails here", async () => {
    const app = await buildApp();
    const spawnMock = vi.mocked(childProcessSpawn);
    const passThrough = spawnMock.getMockImplementation()!;
    spawnMock.mockImplementation(((file: string, args: string[], options: unknown) => {
      if (file !== "systemd-run") return passThrough(file, args as never, options as never);
      const ee = new EventEmitter() as EventEmitter & { unref?: () => void };
      ee.unref = () => {};
      setImmediate(() =>
        ee.emit("error", Object.assign(new Error("spawn systemd-run ENOENT"), { code: "ENOENT" })),
      );
      return ee as never;
    }) as never);
    try {
      const missing = path.join(os.tmpdir(), `no-such-dir-3557-${process.pid}`);
      const spawnRes = await app.inject({
        method: "POST",
        url: "/internal/sessions",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { id: "3557", cwd: missing, command: "make dev", cols: 80, rows: 24 },
      });
      expect(spawnRes.statusCode).toBe(422);
      expect(spawnRes.json().message).toContain(`cwd does not exist: ${missing}`);
      // Nothing is left tracked for the id: a retry spawns afresh.
      expect(app.pty.get("3557")).toBeUndefined();
    } finally {
      spawnMock.mockImplementation(passThrough);
      await app.close();
    }
  });

  // Issue #1265 — an explicit regression guard on this route's WIRE FORMAT
  // itself, independent of the internal isMasterAliveBatch/
  // isMasterAliveStateBatch refactor: an id this reachable agent can't
  // confirm ownership of must stay OMITTED from the response body, never
  // rendered as `false`. `RemoteBackend.liveness` (session-backend.ts) on
  // the primary side depends on that omission to tell "unknown" apart from
  // a confident "dead" — silently changing this wire shape (e.g. to
  // `null`) would break that derivation for every already-deployed
  // primary/agent pair without any test here catching it.
  it("omits an unverifiable id from /internal/sessions/liveness's response, rather than reporting it false", async () => {
    const app = await buildApp();
    // A `crs-session-*.scope` unit with no matching entry in
    // unitSocketPaths renders with the bare-unit-name placeholder
    // Description (not real dtach-shaped) — extractDtachSocketPath returns
    // null for it, so listOwnedScopes classifies id "999" as unverifiable,
    // never owned or confidently absent. No real session needs to be
    // spawned for this — it exercises the fake list-units reply directly.
    activeScopeUnits.add("crs-session-999.scope");

    const livenessRes = await app.inject({
      method: "POST",
      url: "/internal/sessions/liveness",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { ids: ["999"] },
    });
    expect(livenessRes.statusCode).toBe(200);
    expect(livenessRes.json()).toEqual({});
    expect("999" in (livenessRes.json() as Record<string, boolean>)).toBe(false);

    activeScopeUnits.delete("crs-session-999.scope");
    await app.close();
  });

  // Task Master's initial-prompt fix (see task-claim.ts's own doc comment)
  // reaches a remote agent host through this exact route — RemoteBackend.
  // spawn (session-backend.ts) serializes the whole SpawnSessionOptions
  // object, including `initialPrompt`, straight into this body.
  it("threads a spawn body's initialPrompt through to the spawned command line as the matched hook adapter's argv", async () => {
    const app = await buildApp();
    const before = fakePtyChildren.length;

    const spawnRes = await app.inject({
      method: "POST",
      url: "/internal/sessions",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        id: "502",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
        initialPrompt: "fix the bug",
      },
    });
    expect(spawnRes.statusCode).toBe(201);
    await waitUntil(() => fakePtyChildren.length > before);

    const call = vi
      .mocked(childProcessSpawn)
      .mock.calls.findLast(([command]) => command === "systemd-run");
    const args = call?.[1] as string[];
    expect(args[args.length - 1]).toContain("'fix the bug'");

    await app.close();
  });

  // Hermes review, PR #538 — the primary's own local `seedDelivered` guess
  // can't be trusted for a remote spawn (an old agent build silently strips
  // unknown body fields), so this route echoes back whether it actually
  // understood and used the prompt. A NEW build's echo must be exact.
  it("echoes initialPromptApplied: true when the spawn body's command can receive an initial prompt", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/internal/sessions",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        id: "504",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
        initialPrompt: "fix the bug",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      ok: true,
      initialPromptApplied: true,
      injectAgentGuide: true,
      injectProjectBriefing: true,
      injectMullionBundle: true,
      // No taskId in the payload, so the echo is `false` (the Session
      // was created without a taskId, the value echoed is the
      // post-creation state, not the absent request field). See
      // routes/internal.ts's own comment on `taskIdApplied`.
      taskIdApplied: false,
    });
    await app.close();
  });

  // gemini, not opencode — opencode gained `initialPromptArgs` (`--prompt`)
  // and now takes the `true` branch above like claude/codex/agy do; see
  // hook-adapters/opencode.ts. gemini has no adapter at all, so it's a
  // genuine example of "no initial-prompt argv form."
  it("echoes initialPromptApplied: false when the spawn body's command has no initial-prompt argv form (gemini)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/internal/sessions",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        id: "505",
        cwd: "/tmp",
        command: "gemini",
        cols: 80,
        rows: 24,
        initialPrompt: "fix the bug",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      ok: true,
      initialPromptApplied: false,
      injectAgentGuide: true,
      injectProjectBriefing: true,
      injectMullionBundle: true,
      // Same `false` echo as the no-initialPrompt test below — neither
      // payload carries taskId, so the resulting Session's `taskId`
      // stays `undefined` and the echo reflects that.
      taskIdApplied: false,
    });
    await app.close();
  });

  it("echoes initialPromptApplied: false when no initialPrompt was sent at all", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/internal/sessions",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { id: "506", cwd: "/tmp", command: "claude", cols: 80, rows: 24 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      ok: true,
      initialPromptApplied: false,
      injectAgentGuide: true,
      injectProjectBriefing: true,
      injectMullionBundle: true,
      // No taskId in the payload — same `false` echo as the `true` /
      // `false` initialPromptApplied tests above.
      taskIdApplied: false,
    });
    await app.close();
  });

  // Hermes review, PR #966 — the agent-side counterpart of
  // task-claim.ts's `taskId: task.id` set on every Task Master spawn.
  // The wire schema accepts it, the handler threads it to getOrCreate,
  // and the echo is `true` iff the resulting Session actually carries
  // that taskId (a reattach of a pre-PR-#966 session would have
  // `taskId: undefined` and the echo would be `false`). See
  // routes/internal.ts's own comment.
  it("threads taskId from the spawn body into the resulting Session and echoes taskIdApplied: true", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/internal/sessions",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        // Numeric id (the agent-side /internal/sessions route's
        // schema accepts alphanumeric, but PtyManager's constructor
        // requires numeric — see pty-manager.ts's own check).
        id: "506506",
        cwd: "/tmp",
        command: "opencode",
        cols: 80,
        rows: 24,
        taskId: 348423,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      ok: true,
      initialPromptApplied: false,
      injectAgentGuide: true,
      injectProjectBriefing: true,
      injectMullionBundle: true,
      taskIdApplied: true,
    });

    // The resulting Session must actually carry the taskId — proves
    // the handler threaded it through getOrCreate rather than just
    // echoing the request body. Public `readonly` field (matches
    // injectAgentGuide's posture) on pty-manager.ts's Session.
    const session = app.pty.get("506506");
    expect(session?.taskId).toBe(348423);

    await app.close();
  });

  // Same Hermes review — `taskIdApplied: false` echoes for a reattach
  // of a session whose original spawn predates this field. The resulting
  // Session has `taskId: undefined` (never set on creation), and the
  // echo reflects that regardless of what THIS particular request body
  // asks for (this request doesn't carry taskId at all, but the
  // assertion is the same `false` value either way — the field is
  // computed from the Session, not the request).
  it("echoes taskIdApplied: false when the resulting Session has no taskId set, regardless of what's in the request", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/internal/sessions",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        id: "506507",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      ok: true,
      initialPromptApplied: false,
      injectAgentGuide: true,
      injectProjectBriefing: true,
      injectMullionBundle: true,
      taskIdApplied: false,
    });
    expect(app.pty.get("506507")?.taskId).toBeUndefined();
    await app.close();
  });

  // Issue #1089 — the agent-side counterpart of session-lifecycle.ts's
  // resolvedInjectMullionBundle (resolved from the primary's own
  // sessions.injectMullionBundle setting, which an agent-role process has
  // no DB of its own to read — see readInjectMullionBundle's own comment,
  // src/plugins/pty.ts). Proves the actual HTTP round trip (request body ->
  // schema validation -> app.pty.getOrCreate) threads a `false` value all
  // the way to the resulting Session, rather than silently falling back to
  // this agent's own DB-less getInjectMullionBundle() closure (always
  // `true`) the way it did before this fix — this is the exact bug #1089
  // reports: an agent host always boot-syncing the bundle back in
  // regardless of what the primary's setting said.
  it("threads injectMullionBundle: false from the spawn body into the resulting Session, instead of falling back to this agent's own (always-true) default", async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/internal/sessions",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        id: "509",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
        injectMullionBundle: false,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(app.pty.get("509")?.injectMullionBundle).toBe(false);

    await app.close();
  });

  it("defaults injectMullionBundle to true when the spawn body omits it (unchanged pre-#1089 behavior)", async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/internal/sessions",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { id: "510", cwd: "/tmp", command: "bash", cols: 80, rows: 24 },
    });
    expect(res.statusCode).toBe(201);
    expect(app.pty.get("510")?.injectMullionBundle).toBe(true);

    await app.close();
  });

  // Issue #1089 — the agent-side query/remove surface routes/bundle-sync.ts's
  // primary-side fan-out talks to (via agent-bundle-state.ts's
  // getHostBundleDisabled/removeHostBundle, RemoteHostClient.
  // getAgentBundleState/removeAgentBundle). readAgentBundleDisabled/
  // writeAgentBundleDisabled resolve off os.homedir(), redirected here the
  // same way the /internal/agent-rules describe block above does, so this
  // never touches the real test-runner's own ~/.mullion. uninstallBundleContent
  // itself is mocked at the top of this file (see that mock's own comment).

  // Issue: per-project briefing storage (a follow-up PR) — this PR only
  // wires the spawn-body channel through; no producer sets briefingOverride
  // yet, but the agent-side route must already thread whatever a future
  // primary sends correctly. Proves the field survives the actual HTTP
  // round trip (request body -> schema validation -> app.pty.getOrCreate ->
  // writeSessionBriefing), not just a typechecked-but-untested pass-through.
  it("threads briefingOverride from the spawn body into the per-session briefing file", async () => {
    const app = await buildApp();
    const before = fakePtyChildren.length;

    const res = await app.inject({
      method: "POST",
      url: "/internal/sessions",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        id: "507",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
        briefingOverride: "operator-configured briefing text",
      },
    });
    expect(res.statusCode).toBe(201);
    await waitUntil(() => fakePtyChildren.length > before);

    const written = fs.readFileSync(sessionBriefingPath(app.config.SESSIONS_DIR, "507"), "utf8");
    expect(written).toContain("operator-configured briefing text");

    await app.close();
  });

  it("rejects a briefingOverride over the schema's maxLength", async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/internal/sessions",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        id: "508",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
        briefingOverride: "a".repeat(8193),
      },
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  // Issue #942 — project-tooling.ts's save-time cap for NEW notes shrank to
  // 512 bytes, but this schema's own maxLength deliberately stayed at the
  // OLD 8192-byte bound (see internal-schemas.ts's own comment): a project
  // that saved a briefing between 512 and 8192 bytes BEFORE that cap shrank
  // still has that value sitting in the DB, unmodified (no data migration),
  // and session-lifecycle.ts's createSessionRecord reads it straight
  // through into this exact spawn-body field on a remote-host spawn. If
  // this schema's maxLength were tightened to match the new save-time cap,
  // that legacy row would 400 here on every remote spawn until someone
  // happened to re-save it — a hard failure the local/primary spawn path
  // never sees (it degrades gracefully via writeSessionBriefing's own
  // clamp instead, which this route's schema gate runs before).
  it("still accepts a legacy briefingOverride saved under the pre-#942 8 KiB cap, well over the new 512-byte save-time one", async () => {
    const app = await buildApp();
    const before = fakePtyChildren.length;

    const res = await app.inject({
      method: "POST",
      url: "/internal/sessions",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        id: "509",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
        briefingOverride: "a".repeat(4000),
      },
    });
    expect(res.statusCode).toBe(201);
    await waitUntil(() => fakePtyChildren.length > before);

    await app.close();
  });

  // Issue #937 — same "proves the field survives the actual HTTP round
  // trip" bar as the briefingOverride test above, for the new
  // workflowConventionsText spawn-body field (request body -> schema
  // validation -> app.pty.getOrCreate -> writeSessionWorkflowConventions).
  it("threads workflowConventionsText from the spawn body into the per-session workflow-conventions file", async () => {
    const app = await buildApp();
    const before = fakePtyChildren.length;

    const res = await app.inject({
      method: "POST",
      url: "/internal/sessions",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        id: "510",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
        workflowConventionsText: "always branch, never commit to main",
      },
    });
    expect(res.statusCode).toBe(201);
    await waitUntil(() => fakePtyChildren.length > before);

    const written = fs.readFileSync(
      sessionWorkflowConventionsPath(app.config.SESSIONS_DIR, "510"),
      "utf8",
    );
    expect(written).toContain("always branch, never commit to main");

    await app.close();
  });

  it("rejects a workflowConventionsText over the schema's maxLength", async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/internal/sessions",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        id: "511",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
        workflowConventionsText: "a".repeat(8193),
      },
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  // Writer-side "empty means unlink, not a body-less file" behavior (see
  // writeSessionWorkflowConventions's own doc comment) — a spawn body
  // carrying an explicit empty string must leave no per-session file, unlike
  // briefingOverride's own deliberately different empty-string posture.
  it("writes no per-session file when workflowConventionsText is an empty string", async () => {
    const app = await buildApp();
    const before = fakePtyChildren.length;

    const res = await app.inject({
      method: "POST",
      url: "/internal/sessions",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        id: "512",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
        workflowConventionsText: "",
      },
    });
    expect(res.statusCode).toBe(201);
    await waitUntil(() => fakePtyChildren.length > before);

    expect(fs.existsSync(sessionWorkflowConventionsPath(app.config.SESSIONS_DIR, "512"))).toBe(
      false,
    );

    await app.close();
  });

  it("omits any prompt argv when a spawn body carries no initialPrompt", async () => {
    const app = await buildApp();
    const before = fakePtyChildren.length;

    const spawnRes = await app.inject({
      method: "POST",
      url: "/internal/sessions",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { id: "503", cwd: "/tmp", command: "claude", cols: 80, rows: 24 },
    });
    expect(spawnRes.statusCode).toBe(201);
    await waitUntil(() => fakePtyChildren.length > before);

    const call = vi
      .mocked(childProcessSpawn)
      .mock.calls.findLast(([command]) => command === "systemd-run");
    const args = call?.[1] as string[];
    expect(args[args.length - 1]).not.toContain("fix the bug");

    await app.close();
  });

  it("expands a leading ~ in a spawned session's cwd against this host's own home dir", async () => {
    const app = await buildApp();
    const before = fakePtyChildren.length;

    await app.inject({
      method: "POST",
      url: "/internal/sessions",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { id: "502", cwd: "~", command: "bash", cols: 80, rows: 24 },
    });
    await waitUntil(() => fakePtyChildren.length > before);

    const liveRes = await app.inject({
      method: "POST",
      url: "/internal/sessions/live",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { ids: ["502"], idleThresholdMs: 30_000 },
    });
    expect(liveRes.json()["502"]).toMatchObject({ cwd: os.homedir() });

    await app.close();
  });

  it("rejects a WS attach with no Authorization header before the upgrade completes", async () => {
    const { app, port } = await listenApp();

    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/internal/ws/attach?id=x&cwd=%2Ftmp&command=bash&cols=80&rows=24`,
    );
    const outcome = await waitForOpenOrClose(ws);
    expect(outcome).toBe("close");

    await app.close();
  });

  it("rejects a WS attach missing required query params, even with a valid token", async () => {
    const { app, port } = await listenApp();

    const ws = new NodeWebSocket(`ws://127.0.0.1:${port}/internal/ws/attach?id=x`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const outcome = await waitForNodeWsOutcome(ws);
    expect(outcome).toBe("close");

    await app.close();
  });

  it("rejects a WS attach whose id isn't a plain alphanumeric token", async () => {
    const { app, port } = await listenApp();

    const ws = new NodeWebSocket(
      `ws://127.0.0.1:${port}/internal/ws/attach?id=${encodeURIComponent("weird;id")}&cwd=%2Ftmp&command=bash&cols=80&rows=24`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    const outcome = await waitForNodeWsOutcome(ws);
    expect(outcome).toBe("close");

    await app.close();
  });

  it("attaches over WS with a valid token, spawning and streaming pty output", async () => {
    const { app, port } = await listenApp();
    const before = fakePtyChildren.length;

    const ws = new NodeWebSocket(
      `ws://127.0.0.1:${port}/internal/ws/attach?id=503&cwd=%2Ftmp&command=bash&cols=80&rows=24`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("close", () => reject(new Error("WS closed instead of opening")));
      ws.once("error", reject);
    });
    await waitUntil(() => fakePtyChildren.length > before);
    const pty = fakePtyChildren[fakePtyChildren.length - 1];

    const messagePromise = new Promise<Buffer>((resolve) => {
      ws.once("message", (data) => resolve(data as Buffer));
    });
    pty.emitData("hello from agent pty");
    const message = await messagePromise;
    expect(message.toString("utf8")).toBe("hello from agent pty");

    ws.close();
    await app.close();
  });
});
