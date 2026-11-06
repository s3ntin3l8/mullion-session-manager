import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { projects, sessionBrowsers, sessions } from "../../src/db/schema.js";
import { RemoteHostClient } from "../../src/services/remote-host-client.js";
import {
  AGENT_OPERATIONS,
  LEGACY_BASELINE,
  PROTOCOL_VERSION,
} from "../../src/shared/agent-protocol.js";
import {
  bindingBrowserTarget,
  resolveProjectDefaultBrowserTarget,
  resolveSessionBrowserTarget,
} from "../../src/services/browser-target.js";
import { resolveAgentBrowserTarget } from "../../src/services/session-lifecycle.js";
import {
  closeSessionBrowserBindings,
  listSessionBrowserBindings,
  recordSessionBrowserBinding,
} from "../../src/services/session-browsers.js";

// Issue #2448 — the browser is bound to the session's execution target (host +
// checkout), the same target for the panel and the agent's automation, and
// never falls back to the project's host or checkout.
const tmpDb = path.join(os.tmpdir(), `browser-targets-test-${process.pid}.db`);

describe("browser execution targets", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let n = 0;

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.BROWSER_ENABLED = "true";
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.BROWSER_ENABLED;
  });
  afterEach(() => vi.restoreAllMocks());

  async function addHost() {
    const res = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: `bt-host-${++n}`, baseUrl: "http://127.0.0.1:1", token: "t".repeat(24) },
    });
    return res.json().id as string;
  }
  function negotiate(hostId: string, operations: readonly string[]) {
    app.hostAgentTracker?.record(hostId, {
      agents: null,
      capabilities: null,
      mullionVersion: null,
      protocol: {
        protocolVersion: PROTOCOL_VERSION,
        legacy: false,
        operations: [...operations],
        launchOptions: [],
      },
    });
  }
  function addProject(cwd: string, hostId: string, hostCwds?: Record<string, string>) {
    return app.db
      .insert(projects)
      .values({
        name: `bt-${++n}`,
        cwd,
        hostId,
        hostCwds: hostCwds ? JSON.stringify(hostCwds) : null,
      })
      .returning({ id: projects.id })
      .get().id;
  }
  function addSession(projectId: number, cwd: string | null, hostId: string | null) {
    return app.db
      .insert(sessions)
      .values({ projectId, name: "s", command: "bash", cwd, hostId })
      .returning({ id: sessions.id })
      .get().id;
  }

  it("gives two sessions in one checkout the same target (one shared browser)", async () => {
    const a = await addHost();
    negotiate(a, AGENT_OPERATIONS);
    const projectId = addProject("/work/p", a);
    const s1 = addSession(projectId, "/work/p", a);
    const s2 = addSession(projectId, "/work/p/sub", a);
    const t1 = await resolveSessionBrowserTarget(app, projectId, s1);
    const t2 = await resolveSessionBrowserTarget(app, projectId, s2);
    expect(t1).toEqual({
      ok: true,
      target: { projectId, hostId: a, checkoutRoot: "/work/p", legacy: true },
    });
    expect(t2).toEqual(t1);
  });

  it("keeps the same path on two hosts apart, and only the project's host is legacy", async () => {
    const a = await addHost();
    const b = await addHost();
    negotiate(a, AGENT_OPERATIONS);
    negotiate(b, AGENT_OPERATIONS);
    const projectId = addProject("/work/p", a, { [b]: "/work/p" });
    const onA = await resolveSessionBrowserTarget(
      app,
      projectId,
      addSession(projectId, "/work/p", a),
    );
    const onB = await resolveSessionBrowserTarget(
      app,
      projectId,
      addSession(projectId, "/work/p", b),
    );
    expect(onA).toMatchObject({ ok: true, target: { hostId: a, legacy: true } });
    expect(onB).toMatchObject({
      ok: true,
      target: { hostId: b, checkoutRoot: "/work/p", legacy: false },
    });
  });

  it("keeps an existing binding when the session's placement later changes", async () => {
    const a = await addHost();
    const b = await addHost();
    negotiate(a, AGENT_OPERATIONS);
    negotiate(b, AGENT_OPERATIONS);
    const projectId = addProject("/work/p", a, { [b]: "/work/p" });
    const sessionId = addSession(projectId, "/work/p", a);
    const first = await resolveSessionBrowserTarget(app, projectId, sessionId);
    if (!first.ok) throw new Error("expected a target");
    recordSessionBrowserBinding(app, sessionId, first.target);
    app.db.update(sessions).set({ hostId: b }).where(eq(sessions.id, sessionId)).run();
    expect(await resolveSessionBrowserTarget(app, projectId, sessionId)).toEqual(first);
  });

  it("resolves a pre-target binding row to the project default", async () => {
    const a = await addHost();
    negotiate(a, AGENT_OPERATIONS);
    const projectId = addProject("/work/p", a);
    const sessionId = addSession(projectId, "/work/p/wt", a);
    app.db
      .insert(sessionBrowsers)
      .values({ sessionId, projectId, createdAt: new Date(), lastAttachedAt: new Date() })
      .run();
    expect(await resolveSessionBrowserTarget(app, projectId, sessionId)).toEqual({
      ok: true,
      target: { projectId, hostId: a, checkoutRoot: "/work/p", legacy: true },
    });
  });

  it("a project-only caller must ask for the project default explicitly", async () => {
    const a = await addHost();
    const b = await addHost();
    negotiate(a, AGENT_OPERATIONS);
    negotiate(b, AGENT_OPERATIONS);
    const projectId = addProject("/work/p", a, { [b]: "/work/p" });
    addSession(projectId, "/work/p", b);
    expect(await resolveProjectDefaultBrowserTarget(app, projectId)).toEqual({
      ok: true,
      target: { projectId, hostId: a, checkoutRoot: "/work/p", legacy: true },
    });
  });

  it("refuses a session on a host without per-target browsers, never falling back", async () => {
    const a = await addHost();
    negotiate(
      a,
      AGENT_OPERATIONS.filter((op) => op !== "browser-targets"),
    );
    const projectId = addProject("/work/p", a);
    const sessionId = addSession(projectId, "/work/p", a);
    const result = await resolveSessionBrowserTarget(app, projectId, sessionId);
    expect(result).toMatchObject({ ok: false, status: 501 });
    expect(result.ok ? "" : result.message).toMatch(/browser-targets/);
  });

  it("refuses a legacy-baseline host and an unavailable host", async () => {
    const legacyHost = await addHost();
    app.hostAgentTracker?.record(legacyHost, {
      agents: null,
      capabilities: null,
      mullionVersion: null,
      protocol: { ...LEGACY_BASELINE, legacy: true },
    });
    const p1 = addProject("/work/p", legacyHost);
    expect(
      await resolveSessionBrowserTarget(app, p1, addSession(p1, "/work/p", legacyHost)),
    ).toMatchObject({ ok: false, status: 501 });

    const p2 = addProject("/work/q", "local");
    expect(
      await resolveSessionBrowserTarget(app, p2, addSession(p2, "/work/q", "no-such-host")),
    ).toMatchObject({ ok: false, status: 503 });
  });

  it("automation forwards a remote session's own target (host, checkout), not the project's", async () => {
    const a = await addHost();
    const b = await addHost();
    negotiate(a, AGENT_OPERATIONS);
    negotiate(b, AGENT_OPERATIONS);
    const projectId = addProject("/work/p", a, { [b]: "/srv/p" });
    const onB = addSession(projectId, "/srv/p", b);
    const calls: { host: string; target: unknown }[] = [];
    vi.spyOn(RemoteHostClient.prototype, "browserAutomationAction").mockImplementation(function (
      this: unknown,
      _sessionId: number,
      target: unknown,
    ) {
      calls.push({ host: (this as { hostId: string }).hostId, target });
      return Promise.resolve({ ok: true });
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${onB}/browser`,
      payload: { action: "snapshot" },
    });
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([
      { host: b, target: { projectId, hostId: b, checkoutRoot: "/srv/p", legacy: false } },
    ]);
  });

  it("automation reports an unsupported older host as 501 and sends nothing", async () => {
    const a = await addHost();
    negotiate(
      a,
      AGENT_OPERATIONS.filter((op) => op !== "browser-targets"),
    );
    const projectId = addProject("/work/p", a);
    const sessionId = addSession(projectId, "/work/p", a);
    const spy = vi.spyOn(RemoteHostClient.prototype, "browserAutomationAction");
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/browser`,
      payload: { action: "snapshot" },
    });
    expect(res.statusCode).toBe(501);
    expect(spy).not.toHaveBeenCalled();
  });

  it("a session whose directory left the project is refused, not served the project's browser", async () => {
    const projectId = addProject("/tmp", "local");
    const sessionId = addSession(projectId, "/definitely/elsewhere", "local");
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/browser`,
      payload: { action: "snapshot" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("keeps the binding's original target when the session's placement later changes", async () => {
    const a = await addHost();
    const b = await addHost();
    const projectId = addProject("/work/p", a, { [b]: "/work/p" });
    const sessionId = addSession(projectId, "/work/p", a);
    recordSessionBrowserBinding(app, sessionId, {
      projectId,
      hostId: a,
      checkoutRoot: "/work/p",
      legacy: true,
    });
    app.db.update(sessions).set({ hostId: b }).where(eq(sessions.id, sessionId)).run();
    recordSessionBrowserBinding(app, sessionId, {
      projectId,
      hostId: b,
      checkoutRoot: "/work/p",
      legacy: false,
    });
    const [binding] = listSessionBrowserBindings(app, sessionId);
    expect(binding).toMatchObject({ targetHostId: a, targetCheckoutRoot: "/work/p" });
  });

  it("maps a pre-target binding row to the project's default target", async () => {
    const a = await addHost();
    const projectId = addProject("/work/p", a);
    const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
    expect(
      bindingBrowserTarget(project, { projectId, targetHostId: null, targetCheckoutRoot: null }),
    ).toEqual({ projectId, hostId: a, checkoutRoot: "/work/p", legacy: true });
  });

  describe("target sent to an agent host at spawn (issue #2639)", () => {
    function projectRow(projectId: number) {
      return app.db.select().from(projects).where(eq(projects.id, projectId)).get()!;
    }
    function negotiateWith(hostId: string, launchOptions: string[]) {
      app.hostAgentTracker?.record(hostId, {
        agents: null,
        capabilities: null,
        mullionVersion: null,
        protocol: {
          protocolVersion: PROTOCOL_VERSION,
          legacy: false,
          operations: [...AGENT_OPERATIONS],
          launchOptions,
        },
      });
    }

    it("sends the project root, as the primary resolves it, for a session in a subdirectory", async () => {
      const a = await addHost();
      negotiateWith(a, ["browserTarget"]);
      const projectId = addProject("/work/p", a);
      const sub = addSession(projectId, "/work/p/sub", a);
      const sent = await resolveAgentBrowserTarget(app, projectRow(projectId), sub, a);
      const primary = await resolveSessionBrowserTarget(app, projectId, sub);
      // The same pool key and the legacy storage file as the panel's.
      expect(sent).toEqual({ projectId, hostId: a, checkoutRoot: "/work/p", legacy: true });
      expect(primary).toEqual({ ok: true, target: sent });
    });

    it("sends nothing to an agent without the launch option, or for a local session", async () => {
      const a = await addHost();
      negotiateWith(a, []);
      const projectId = addProject("/work/p", a);
      const sid = addSession(projectId, "/work/p", a);
      expect(await resolveAgentBrowserTarget(app, projectRow(projectId), sid, a)).toBeUndefined();
      expect(
        await resolveAgentBrowserTarget(app, projectRow(projectId), sid, "local"),
      ).toBeUndefined();
    });

    it("sends nothing when the session's host cannot do per-target browsers", async () => {
      const a = await addHost();
      app.hostAgentTracker?.record(a, {
        agents: null,
        capabilities: null,
        mullionVersion: null,
        protocol: {
          protocolVersion: PROTOCOL_VERSION,
          legacy: false,
          operations: AGENT_OPERATIONS.filter((op) => op !== "browser-targets"),
          launchOptions: ["browserTarget"],
        },
      });
      const projectId = addProject("/work/p", a);
      const sid = addSession(projectId, "/work/p", a);
      expect(await resolveAgentBrowserTarget(app, projectRow(projectId), sid, a)).toBeUndefined();
    });
  });

  describe("cleanup", () => {
    it("closes a remote target on its agent only when the last session using it ends", async () => {
      const a = await addHost();
      negotiate(a, AGENT_OPERATIONS);
      const projectId = addProject("/work/p", "local", { [a]: "/work/p" });
      const s1 = addSession(projectId, "/work/p", a);
      const s2 = addSession(projectId, "/work/p", a);
      const other = addSession(projectId, "/work/other", a);
      const target = { projectId, hostId: a, checkoutRoot: "/work/p", legacy: false };
      for (const id of [s1, s2]) recordSessionBrowserBinding(app, id, target);
      recordSessionBrowserBinding(app, other, { ...target, checkoutRoot: "/work/other" });
      const close = vi
        .spyOn(RemoteHostClient.prototype, "postBrowser")
        .mockResolvedValue({ ok: true });

      closeSessionBrowserBindings(app, s1);
      expect(close).not.toHaveBeenCalled(); // s2 still uses it

      closeSessionBrowserBindings(app, s2);
      await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
      expect(close).toHaveBeenCalledWith("/internal/browser/close", target);
    });

    it("leaves a remote target alone when its host predates per-target browsers", async () => {
      const a = await addHost();
      negotiate(
        a,
        AGENT_OPERATIONS.filter((op) => op !== "browser-targets"),
      );
      const projectId = addProject("/work/p", "local", { [a]: "/work/p" });
      const s1 = addSession(projectId, "/work/p", a);
      recordSessionBrowserBinding(app, s1, {
        projectId,
        hostId: a,
        checkoutRoot: "/work/p",
        legacy: false,
      });
      const close = vi.spyOn(RemoteHostClient.prototype, "postBrowser");
      closeSessionBrowserBindings(app, s1);
      await new Promise((r) => setTimeout(r, 20));
      expect(close).not.toHaveBeenCalled();
    });
  });
});
