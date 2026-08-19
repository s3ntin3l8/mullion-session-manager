import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { eq } from "drizzle-orm";
import type * as WebPush from "web-push";
import type { NotificationEvent } from "../../src/services/pty-manager.js";

const mockSendNotification = vi.hoisted(() => vi.fn());
// web-push is CJS (module.exports = {...}) — its named exports only reach
// ESM `import { x } from "web-push"` (push-store.ts's own import style) via
// its `default` object, not as separately-detected top-level bindings, so
// this spreads `actual.default` into both the mock's named exports AND its
// own `default` to satisfy both that style and push-delivery.ts's own
// `import webpush from "web-push"` default import.
vi.mock("web-push", async (importOriginal) => {
  const actual = await importOriginal<typeof WebPush>();
  const merged = { ...actual, ...actual.default, sendNotification: mockSendNotification };
  return { ...merged, default: merged };
});

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { projects, sessions, pushSubscriptions } = await import("../../src/db/schema.js");
const {
  deliverPushNotification,
  createCoalesceState,
  PUSH_COALESCE_MS,
  PUSH_TTL_SECONDS,
  PUSH_SEND_TIMEOUT_MS,
} = await import("../../src/services/push-delivery.js");

const tmpDb = path.join(os.tmpdir(), `push-delivery-test-${process.pid}.db`);

function makeEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    seq: 1,
    sessionId: 1,
    kind: "attention",
    ts: Date.now(),
    payload: { attention: true },
    ...overrides,
  };
}

describe("push-delivery (issue #95)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  beforeEach(() => {
    mockSendNotification.mockReset();
    mockSendNotification.mockResolvedValue({ statusCode: 201, body: "", headers: {} });
  });

  // Unique per call, not a fixed literal — this describe block shares one
  // DB across tests (see beforeAll), and push_subscriptions.endpoint is
  // uniquely indexed.
  let endpointCounter = 0;
  function uniqueEndpoint(): string {
    endpointCounter += 1;
    return `https://push.example.com/sub-${endpointCounter}`;
  }

  // Creates a project + session row directly (bypassing the route, so no
  // real PTY is spawned) and a push subscription, then enables the push
  // channel via a real PATCH /api/settings round-trip — every predicate
  // this file tests lives downstream of that merge path, not just the raw
  // DB row, so exercising it for real here is deliberate.
  async function setupNotifiableSession(app: Awaited<ReturnType<typeof buildApp>>) {
    // deliverPushNotification sends to EVERY stored subscription, by
    // design (a subscription belongs to a device, not a session) — clear
    // the table first so a prior test's still-present subscription can't
    // also receive this test's send, since this describe block shares one
    // DB across tests (see beforeAll).
    app.db.delete(pushSubscriptions).run();
    const [project] = app.db.insert(projects).values({ name: "p", cwd: "/tmp" }).returning().all();
    const [session] = app.db
      .insert(sessions)
      .values({ projectId: project.id, command: "bash", status: "active" })
      .returning()
      .all();
    const endpoint = uniqueEndpoint();
    app.db
      .insert(pushSubscriptions)
      .values({
        endpoint,
        p256dhKey: "p256dh",
        authKeyEnc: "auth-fixture", // pragma: allowlist secret
        createdAt: new Date(),
      })
      .run();

    const patch = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: {
        notifications: {
          channels: { push: true },
          // "idle" is what deriveSessionStatus falls back to for a DB row
          // with no live PtyManager handle backing it (defaultDeriveStatusInfo's
          // all-idle/false defaults) — the case these tests exercise, since
          // they insert a session row directly rather than spawning a real
          // PTY. notify:true here is what lets makeEvent()'s notifiable
          // event kind actually reach a send; push-delivery.ts's own gating
          // on isNotifiableEvent is what these tests are really about, not
          // deriveSessionStatus's own precedence (covered elsewhere).
          // "exited" is ALSO enabled deliberately, not left to inherit
          // whatever an earlier test's own PATCH happened to leave behind
          // (this describe block shares one settings row across tests) —
          // status_change/"exited" events bypass deriveSessionStatus
          // entirely (see push-delivery.ts's own comment) and gate on this
          // key directly, so the table-driven matrix test below needs it
          // explicitly true to be correct regardless of execution order.
          notificationMatrix: {
            idle: { notify: true, sound: false, autoFocus: false },
            exited: { notify: true, sound: false, autoFocus: false },
          },
        },
      },
    });
    expect(patch.statusCode).toBe(200);

    return { sessionId: session.id, endpoint };
  }

  it("sends a push notification for a notifiable, notify-enabled event", async () => {
    const app = await buildApp();
    const { sessionId, endpoint } = await setupNotifiableSession(app);

    await deliverPushNotification(app, makeEvent({ sessionId }), createCoalesceState());

    expect(mockSendNotification).toHaveBeenCalledTimes(1);
    const [subscription, payload, options] = mockSendNotification.mock.calls[0];
    expect(subscription).toEqual({
      endpoint,
      keys: { p256dh: "p256dh", auth: "auth-fixture" },
    });
    expect(JSON.parse(payload)).toEqual(
      expect.objectContaining({ sessionId, title: expect.any(String), body: expect.any(String) }),
    );
    // A short, explicit TTL — not web-push's own 4-week default, which
    // would let a stale "attention now" nudge arrive a month late.
    expect(options.TTL).toBe(PUSH_TTL_SECONDS);
    // web-push has no default socket timeout — must be passed explicitly
    // or a blackholed endpoint pins the send indefinitely.
    expect(options.timeout).toBe(PUSH_SEND_TIMEOUT_MS);

    const [row] = app.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, endpoint))
      .all();
    expect(row!.lastSuccessAt).not.toBeNull();
    await app.close();
  });

  // Every other test in this file inserts a session DB row with no live
  // PtyManager handle behind it, so app.pty.get() always returns undefined
  // and deriveSessionStatus falls back to defaultDeriveStatusInfo(undefined)
  // — the "idle" case. This test stubs app.pty.get to return a live
  // session so the OTHER branch (real, populated SessionInfo) is actually
  // exercised too, since the two paths compute the notify-gating status
  // very differently.
  it("sends using the LIVE session's info when app.pty.get returns a tracked session", async () => {
    const app = await buildApp();
    app.db.delete(pushSubscriptions).run();
    const [project] = app.db.insert(projects).values({ name: "p", cwd: "/tmp" }).returning().all();
    const [session] = app.db
      .insert(sessions)
      .values({ projectId: project.id, command: "bash", status: "active" })
      .returning()
      .all();
    const endpoint = uniqueEndpoint();
    app.db
      .insert(pushSubscriptions)
      .values({ endpoint, p256dhKey: "p256dh", authKeyEnc: "auth-fixture", createdAt: new Date() }) // pragma: allowlist secret
      .run();
    await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { notifications: { channels: { push: true } } },
    });
    // permissionState: "pending" derives "awaiting_permission" (session-
    // status.ts's own precedence order), which DEFAULT_SETTINGS already
    // sets notify:true for — no matrix override needed, unlike every other
    // test's "idle" fallback case.
    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () => ({
        activity: "idle",
        attention: false,
        attentionKind: null,
        permissionState: "pending",
        planState: "idle",
        gateState: "idle",
        promoteState: "idle",
        elicitationState: "idle",
        questionState: "idle",
        errorState: "idle",
        errorDetail: null,
        endedReason: null,
        exitCode: null,
        compactState: "idle",
        subagentCount: 0,
        lastTurnEndedAt: null,
        outstandingBackgroundTasks: [],
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    await deliverPushNotification(app, makeEvent({ sessionId: session.id }), createCoalesceState());

    expect(mockSendNotification).toHaveBeenCalledTimes(1);
    await app.close();
  });

  // Issue #674 — toInfo() defaults its idle threshold to a hardcoded 2s
  // fallback (pty-manager.ts's IDLE_THRESHOLD_MS) when a caller omits the
  // argument; every other production caller passes the live, persisted
  // notifications.idleThresholdSeconds setting instead, and push-delivery.ts
  // was the one silent omission. This pins the plumbing directly (the exact
  // argument toInfo() is called with) rather than inferring it from a
  // derived status, so a regression back to the bare default fails loudly
  // here instead of only manifesting as an occasionally-wrong notify
  // decision.
  it("passes the live idleThresholdSeconds setting (not the 2s default) into toInfo()", async () => {
    const app = await buildApp();
    app.db.delete(pushSubscriptions).run();
    const [project] = app.db.insert(projects).values({ name: "p", cwd: "/tmp" }).returning().all();
    const [session] = app.db
      .insert(sessions)
      .values({ projectId: project.id, command: "bash", status: "active" })
      .returning()
      .all();
    const endpoint = uniqueEndpoint();
    app.db
      .insert(pushSubscriptions)
      .values({ endpoint, p256dhKey: "p256dh", authKeyEnc: "auth-fixture", createdAt: new Date() }) // pragma: allowlist secret
      .run();
    await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: {
        notifications: {
          channels: { push: true },
          // Deliberately not the 30s default (services/settings.ts) — a
          // distinctive value the assertion below can only match if the
          // live setting was actually threaded through, not some other
          // constant (e.g. the module's own 2s fallback, or 30s coincidentally).
          idleThresholdSeconds: 77,
        },
      },
    });

    const toInfo = vi.fn().mockReturnValue({
      activity: "idle",
      attention: false,
      attentionKind: null,
      permissionState: "pending",
      planState: "idle",
      gateState: "idle",
      promoteState: "idle",
      elicitationState: "idle",
      questionState: "idle",
      errorState: "idle",
      errorDetail: null,
      endedReason: null,
      exitCode: null,
      compactState: "idle",
      subagentCount: 0,
      lastTurnEndedAt: null,
      outstandingBackgroundTasks: [],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(app.pty, "get").mockReturnValue({ toInfo } as any);

    await deliverPushNotification(app, makeEvent({ sessionId: session.id }), createCoalesceState());

    expect(toInfo).toHaveBeenCalledWith(77 * 1000);
    await app.close();
  });

  it("sends a status_change/exited push even though the DB row still says active", async () => {
    // Regression test for the race deriveSessionStatus's dbStatus axis has
    // with the 30s reconciler sweep: the exited event fires the instant
    // ptyProcess.onExit runs, well before session-reconciler.ts ever flips
    // row.status away from "active". Without the special-case in
    // deliverPushNotification, this would derive "idle" (dead-process
    // defaults, still-active dbStatus) and never notify even with
    // exited.notify explicitly enabled.
    const app = await buildApp();
    app.db.delete(pushSubscriptions).run();
    const [project] = app.db.insert(projects).values({ name: "p", cwd: "/tmp" }).returning().all();
    const [session] = app.db
      .insert(sessions)
      .values({ projectId: project.id, command: "bash", status: "active" })
      .returning()
      .all();
    const endpoint = uniqueEndpoint();
    app.db
      .insert(pushSubscriptions)
      .values({ endpoint, p256dhKey: "p256dh", authKeyEnc: "auth", createdAt: new Date() }) // pragma: allowlist secret
      .run();
    await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: {
        notifications: {
          channels: { push: true },
          notificationMatrix: { exited: { notify: true, sound: false, autoFocus: false } },
        },
      },
    });

    await deliverPushNotification(
      app,
      makeEvent({
        sessionId: session.id,
        kind: "status_change",
        payload: { reason: "exited" },
      }),
      createCoalesceState(),
    );

    expect(mockSendNotification).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("does not send for a non-notifiable event kind", async () => {
    const app = await buildApp();
    const { sessionId } = await setupNotifiableSession(app);

    await deliverPushNotification(
      app,
      makeEvent({ sessionId, kind: "title_change", payload: { title: "x" } }),
      createCoalesceState(),
    );

    expect(mockSendNotification).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not send when the push channel is disabled", async () => {
    const app = await buildApp();
    const { sessionId } = await setupNotifiableSession(app);
    await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { notifications: { channels: { push: false } } },
    });

    await deliverPushNotification(app, makeEvent({ sessionId }), createCoalesceState());

    expect(mockSendNotification).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not send when the derived status's matrix entry has notify:false", async () => {
    const app = await buildApp();
    const { sessionId } = await setupNotifiableSession(app);
    await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: {
        notifications: {
          notificationMatrix: { idle: { notify: false, sound: false, autoFocus: false } },
        },
      },
    });

    await deliverPushNotification(app, makeEvent({ sessionId }), createCoalesceState());

    expect(mockSendNotification).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not send when the session row no longer exists", async () => {
    const app = await buildApp();
    await setupNotifiableSession(app);

    await deliverPushNotification(app, makeEvent({ sessionId: 999_999 }), createCoalesceState());

    expect(mockSendNotification).not.toHaveBeenCalled();
    await app.close();
  });

  it("evicts the coalesce entry once the session row is gone", async () => {
    const app = await buildApp();
    const { sessionId } = await setupNotifiableSession(app);
    const coalesceState = createCoalesceState();

    // A real send, so the session has a coalesce entry.
    await deliverPushNotification(app, makeEvent({ sessionId, seq: 1 }), coalesceState);
    expect(coalesceState.has(sessionId)).toBe(true);

    // Session row deleted (mirrors "deleted immediately after exiting").
    app.db.delete(sessions).where(eq(sessions.id, sessionId)).run();
    await deliverPushNotification(app, makeEvent({ sessionId, seq: 2 }), coalesceState);

    expect(coalesceState.has(sessionId)).toBe(false);
    await app.close();
  });

  it("coalesces a second notifiable event for the same session within the window", async () => {
    const app = await buildApp();
    const { sessionId } = await setupNotifiableSession(app);
    const coalesceState = createCoalesceState();

    await deliverPushNotification(app, makeEvent({ sessionId, seq: 1 }), coalesceState);
    await deliverPushNotification(app, makeEvent({ sessionId, seq: 2 }), coalesceState);

    expect(mockSendNotification).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("sends again for the same session once the coalesce window has passed", async () => {
    const app = await buildApp();
    const { sessionId } = await setupNotifiableSession(app);
    const coalesceState = createCoalesceState();

    await deliverPushNotification(app, makeEvent({ sessionId, seq: 1 }), coalesceState);
    // Backdate the recorded time rather than sleeping in the test.
    coalesceState.set(sessionId, Date.now() - PUSH_COALESCE_MS - 1);
    await deliverPushNotification(app, makeEvent({ sessionId, seq: 2 }), coalesceState);

    expect(mockSendNotification).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("prunes the subscription on a 404 send response", async () => {
    const app = await buildApp();
    const { sessionId, endpoint } = await setupNotifiableSession(app);
    mockSendNotification.mockRejectedValue(Object.assign(new Error("Gone"), { statusCode: 404 }));

    await deliverPushNotification(app, makeEvent({ sessionId }), createCoalesceState());

    const rows = app.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, endpoint))
      .all();
    expect(rows).toHaveLength(0);
    await app.close();
  });

  it("prunes the subscription on a 410 send response", async () => {
    const app = await buildApp();
    const { sessionId, endpoint } = await setupNotifiableSession(app);
    mockSendNotification.mockRejectedValue(Object.assign(new Error("Gone"), { statusCode: 410 }));

    await deliverPushNotification(app, makeEvent({ sessionId }), createCoalesceState());

    const rows = app.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, endpoint))
      .all();
    expect(rows).toHaveLength(0);
    await app.close();
  });

  it("keeps the subscription and stamps lastFailureAt on a non-404/410 send error", async () => {
    const app = await buildApp();
    const { sessionId, endpoint } = await setupNotifiableSession(app);
    mockSendNotification.mockRejectedValue(
      Object.assign(new Error("Service unavailable"), { statusCode: 503 }),
    );

    await deliverPushNotification(app, makeEvent({ sessionId }), createCoalesceState());

    const [row] = app.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, endpoint))
      .all();
    expect(row).toBeDefined();
    expect(row!.lastFailureAt).not.toBeNull();
    await app.close();
  });

  it("does not send at all when there are no stored subscriptions", async () => {
    const app = await buildApp();
    app.db.delete(pushSubscriptions).run();
    const [project] = app.db.insert(projects).values({ name: "p", cwd: "/tmp" }).returning().all();
    const [session] = app.db
      .insert(sessions)
      .values({ projectId: project.id, command: "bash", status: "active" })
      .returning()
      .all();
    await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: {
        notifications: {
          channels: { push: true },
          notificationMatrix: { idle: { notify: true, sound: false, autoFocus: false } },
        },
      },
    });

    await deliverPushNotification(app, makeEvent({ sessionId: session.id }), createCoalesceState());

    expect(mockSendNotification).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not advance the coalesce window when there were no subscriptions to send to", async () => {
    const app = await buildApp();
    app.db.delete(pushSubscriptions).run();
    const [project] = app.db.insert(projects).values({ name: "p", cwd: "/tmp" }).returning().all();
    const [session] = app.db
      .insert(sessions)
      .values({ projectId: project.id, command: "bash", status: "active" })
      .returning()
      .all();
    await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: {
        notifications: {
          channels: { push: true },
          notificationMatrix: { idle: { notify: true, sound: false, autoFocus: false } },
        },
      },
    });
    const coalesceState = createCoalesceState();

    // First event: no subscriptions exist yet — nothing sent, and this
    // must NOT count against the coalesce window.
    await deliverPushNotification(app, makeEvent({ sessionId: session.id, seq: 1 }), coalesceState);
    expect(mockSendNotification).not.toHaveBeenCalled();

    // A device subscribes, then the very next notifiable event (even
    // within what would be the coalesce window) must still send — it's
    // the first one anything was ever actually delivered for.
    app.db
      .insert(pushSubscriptions)
      .values({
        endpoint: "https://push.example.com/joined-late",
        p256dhKey: "p256dh",
        authKeyEnc: "auth", // pragma: allowlist secret
        createdAt: new Date(),
      })
      .run();
    await deliverPushNotification(app, makeEvent({ sessionId: session.id, seq: 2 }), coalesceState);
    expect(mockSendNotification).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("excludes dev_server_detected from notifiability regardless of matrix contents", async () => {
    const app = await buildApp();
    const { sessionId } = await setupNotifiableSession(app);

    await deliverPushNotification(
      app,
      makeEvent({ sessionId, kind: "dev_server_detected", payload: {} }),
      createCoalesceState(),
    );

    expect(mockSendNotification).not.toHaveBeenCalled();
    await app.close();
  });

  // Walks isNotifiableEvent's full kind matrix (it isn't itself exported —
  // driven indirectly through deliverPushNotification) so a future edit
  // that silently drifts from frontend/src/eventDescriptions.ts's
  // notifyKind shows up as a failing test here, not a support ticket.
  describe.each([
    { kind: "attention", payload: { attention: true }, notifiable: true },
    { kind: "attention", payload: { attention: false }, notifiable: false },
    { kind: "status_change", payload: { reason: "exited" }, notifiable: true },
    { kind: "status_change", payload: { reason: "other" }, notifiable: false },
    { kind: "review_gate", payload: { state: "waiting" }, notifiable: true },
    { kind: "review_gate", payload: { state: "approved" }, notifiable: false },
    // permission_request/stop_failure/tool_failure/plan_ready/
    // promote_request/elicitation/question are all notifiable: false now —
    // each is always accompanied by a paired `attention` event carrying the
    // same information (see push-delivery.ts's own updated header comment),
    // so keeping the NotificationEvent kind itself notifiable too meant a
    // single agent action pushed the phone twice. `promote_request`
    // specifically used to be doubly wrong: its OTHER raise site
    // (pty-manager.ts's resolvePromote) fires with no paired attention
    // signal at all, so it was pushing for the RESOLUTION of a promote
    // request, not just the request.
    { kind: "permission_request", payload: {}, notifiable: false },
    { kind: "stop_failure", payload: {}, notifiable: false },
    { kind: "tool_failure", payload: {}, notifiable: false },
    { kind: "plan_ready", payload: {}, notifiable: false },
    { kind: "promote_request", payload: {}, notifiable: false },
    { kind: "elicitation", payload: { state: "started" }, notifiable: false },
    { kind: "elicitation", payload: { state: "finished" }, notifiable: false },
    { kind: "question", payload: { state: "started" }, notifiable: false },
    { kind: "question", payload: { state: "finished" }, notifiable: false },
    { kind: "dev_server_detected", payload: {}, notifiable: false },
    { kind: "title_change", payload: { title: "x" }, notifiable: false },
    { kind: "file_change", payload: {}, notifiable: false },
    { kind: "session_diff", payload: {}, notifiable: false },
    { kind: "todo", payload: {}, notifiable: false },
    { kind: "session_end", payload: {}, notifiable: false },
  ])("isNotifiableEvent matrix: $kind $payload", ({ kind, payload, notifiable }) => {
    it(`${notifiable ? "sends" : "does not send"}`, async () => {
      const app = await buildApp();
      const { sessionId } = await setupNotifiableSession(app);

      await deliverPushNotification(
        app,
        makeEvent({ sessionId, kind: kind as NotificationEvent["kind"], payload }),
        createCoalesceState(),
      );

      if (notifiable) {
        expect(mockSendNotification).toHaveBeenCalledTimes(1);
      } else {
        expect(mockSendNotification).not.toHaveBeenCalled();
      }
      await app.close();
    });
  });
});
