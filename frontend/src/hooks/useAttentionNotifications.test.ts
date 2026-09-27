// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useAttentionNotifications } from "./useAttentionNotifications.js";
import type { UseAttentionNotificationsParams } from "./useAttentionNotifications.js";
import { makeSession } from "../test/fixtures.js";
import { DEFAULT_SETTINGS } from "../api/index.js";
import type { AppSettings, NotificationEvent, Session } from "../api/index.js";
import { NOTIFICATION_COALESCE_MS } from "../desktopNotify.js";
import { clearFaviconBadgeCacheForTests, BASE_TITLE } from "../documentBadge.js";
import { playNotificationSound } from "../notifySound.js";

// Mirrors useAppStreams.test.ts's own store-mock shape: a `storeState()`
// factory serving `useDashboardStore.getState()`, the only call form this
// hook uses (requestOpenSession, from the Notification's onclick).
// `mutedSessionIds` is the one extra field this hook now subscribes to
// (#719); kept mutable so the mute test can flip it without re-mocking.
const requestOpenSession = vi.fn();
let mutedSessionIds: number[] = [];
function storeState() {
  return { requestOpenSession, mutedSessionIds };
}
vi.mock("../store/index.js", () => {
  const useDashboardStore = (selector?: (s: unknown) => unknown) => {
    const state = storeState();
    return selector ? selector(state) : state;
  };
  useDashboardStore.getState = storeState;
  return { useDashboardStore };
});

// The actual sound-playing implementation touches the DOM Audio API, which
// jsdom doesn't implement — mocked here so this file asserts only on "was it
// called with the right sound name", same split as documentBadge.ts's own
// "DOM-touching glue stays untested beyond call-count" posture.
vi.mock("../notifySound.js", () => ({ playNotificationSound: vi.fn() }));

// Issue #1428's SW-showNotification fallback — a controllable mock so tests
// can simulate both "a SW is ready" (resolves) and "no SW at all" (rejects,
// matching serviceWorkerReady's own real no-registration/timeout behavior).
const showNotification = vi.fn();
const serviceWorkerReady = vi.fn(() =>
  Promise.resolve({ showNotification } as unknown as ServiceWorkerRegistration),
);
vi.mock("../pushClient.js", () => ({ serviceWorkerReady: () => serviceWorkerReady() }));

function makeEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    seq: 1,
    sessionId: 1,
    kind: "attention",
    ts: Date.now(),
    payload: { attention: true, signal: "bell" },
    ...overrides,
  };
}

// jsdom has no `Notification` global at all (`typeof Notification ===
// "undefined"` there), which would make `Notification.permission` throw
// rather than read as `"denied"` per the hook's own guard — a real browser
// always has the global, just possibly with permission "denied"/"default".
// Stubbed as a class (not a plain object) so `new Notification(...)`
// (the hook's own fire path) works, and every constructed instance is
// tracked so tests can assert on title/body/onclick without reaching into
// module internals.
let notificationInstances: FakeNotification[] = [];
class FakeNotification {
  static permission: NotificationPermission = "granted";
  static requestPermission = vi.fn(() => Promise.resolve<NotificationPermission>("granted"));
  // Issue #1428 — simulates Android Chrome's real "Illegal constructor"
  // throw for a page-context `new Notification()`.
  static shouldThrow = false;
  title: string;
  body?: string;
  tag?: string;
  data?: unknown;
  onclick: (() => void) | null = null;
  close = vi.fn();
  constructor(title: string, options?: NotificationOptions) {
    if (FakeNotification.shouldThrow) throw new DOMException("Illegal constructor");
    this.title = title;
    this.body = options?.body;
    this.tag = options?.tag;
    this.data = options?.data;
    notificationInstances.push(this);
  }
}

const FIXED_NOW = new Date("2026-01-01T00:00:00.000Z").getTime();

function renderAttentionNotifications(overrides: Partial<UseAttentionNotificationsParams> = {}) {
  const props: UseAttentionNotificationsParams = {
    events: {},
    sessions: [makeSession({ id: 1, sessionStatus: "awaiting_permission" })],
    settings: DEFAULT_SETTINGS,
    activePanelId: null,
    ...overrides,
  };
  return renderHook((p: UseAttentionNotificationsParams) => useAttentionNotifications(p), {
    initialProps: props,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  notificationInstances = [];
  mutedSessionIds = [];
  FakeNotification.permission = "granted";
  FakeNotification.requestPermission.mockClear();
  FakeNotification.shouldThrow = false;
  showNotification.mockClear();
  serviceWorkerReady.mockClear();
  serviceWorkerReady.mockImplementation(() =>
    Promise.resolve({ showNotification } as unknown as ServiceWorkerRegistration),
  );
  vi.stubGlobal("Notification", FakeNotification);
  document.head.innerHTML = '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />';
  document.title = BASE_TITLE;
  clearFaviconBadgeCacheForTests();
  // jsdom has no real canvas backend — stubbed the same way
  // documentBadge.test.ts stubs it, purely to silence "Not implemented:
  // HTMLCanvasElement's getContext()" console noise; this file only asserts
  // on `document.title` (documentBadge.ts's own header comment explains why
  // the favicon data: URL itself isn't meaningfully assertable here).
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    fillStyle: "",
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,stub");
  Object.defineProperty(document, "visibilityState", {
    value: "hidden",
    configurable: true,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("useAttentionNotifications — desktop notification effect", () => {
  it("fires a browser Notification for a fresh notifiable event (tab hidden, session not active)", () => {
    const event = makeEvent({ ts: FIXED_NOW + 1 });
    renderAttentionNotifications({ events: { 1: [event] } });

    expect(notificationInstances).toHaveLength(1);
    expect(notificationInstances[0].title).toBe("claude code"); // session.name is null, falls back to command
    expect(notificationInstances[0].body).toBe("Bell");
  });

  it("does NOT fire for a backlog event already present at mount (ts before the stream's own start)", () => {
    // notifyStreamStartRef is set to Date.now() the moment the effect first
    // runs — an event timestamped BEFORE that (a /ws/events on-connect
    // replay of history, not a live arrival) must be treated as backlog and
    // never notify, even though it's otherwise a perfectly notifiable
    // "attention" event. This is the trap: a test asserting "no
    // notification fired" here would pass vacuously if the hook never fired
    // at all — the companion "fresh event" test above is what proves this
    // one isn't just a false negative.
    const backlogEvent = makeEvent({ ts: FIXED_NOW - 60_000 });
    renderAttentionNotifications({ events: { 1: [backlogEvent] } });

    expect(notificationInstances).toHaveLength(0);
  });

  it("fires for an 'exited' status_change event with its own describeEvent body text", () => {
    // A distinct notifyKind path from the "attention"/bell events above
    // ("the exact same 'attention actually ringing, OR A PROGRAM EXITED'
    // filter" per this hook's own header comment) — exercises
    // notificationChannelEnabled against the `exited` matrix column instead
    // of `awaiting_permission`, and describeEvent's own `status_change`
    // branch instead of its `attention` branch.
    const event = makeEvent({
      kind: "status_change",
      ts: FIXED_NOW + 1,
      payload: { reason: "exited" },
    });
    const settings: AppSettings = {
      ...DEFAULT_SETTINGS,
      notifications: {
        ...DEFAULT_SETTINGS.notifications,
        notificationMatrix: {
          ...DEFAULT_SETTINGS.notifications.notificationMatrix,
          exited: { notify: true, sound: false, autoFocus: false },
        },
      },
    };
    renderAttentionNotifications({
      events: { 1: [event] },
      sessions: [makeSession({ id: 1, sessionStatus: "exited" })],
      settings,
    });

    expect(notificationInstances).toHaveLength(1);
    expect(notificationInstances[0].body).toBe("Exited");
  });

  it("skips dev_server_detected events entirely (issue #404 — no matching SessionStatus)", () => {
    // notifyKind (eventDescriptions.ts) classifies an un-actioned
    // dev_server_detected event (payload.state undefined) as "attention" so
    // it reaches the notifiable loop at all — the hook's own explicit
    // `event.kind === "dev_server_detected"` check is what then skips it,
    // per issue #404 (see this hook's own header comment on that branch).
    const event = makeEvent({
      kind: "dev_server_detected",
      ts: FIXED_NOW + 1,
      payload: {},
    });
    renderAttentionNotifications({ events: { 1: [event] } });

    expect(notificationInstances).toHaveLength(0);
  });

  it("skips an event whose session id no longer matches any live session", () => {
    const event = makeEvent({ sessionId: 999, ts: FIXED_NOW + 1 });
    renderAttentionNotifications({ events: { 999: [event] } });

    expect(notificationInstances).toHaveLength(0);
  });

  it("skips when notificationChannelEnabled is false for the session's current status", () => {
    const event = makeEvent({ ts: FIXED_NOW + 1 });
    renderAttentionNotifications({
      events: { 1: [event] },
      sessions: [makeSession({ id: 1, sessionStatus: "idle" })], // matrix.idle.notify === false
    });

    expect(notificationInstances).toHaveLength(0);
  });

  it("coalesces a second notifiable event for the same session within the coalesce window", () => {
    const first = makeEvent({ seq: 1, ts: FIXED_NOW + 1 });
    const second = makeEvent({ seq: 2, ts: FIXED_NOW + 2 });
    renderAttentionNotifications({ events: { 1: [first, second] } });

    expect(notificationInstances).toHaveLength(1);
  });

  it("does not coalesce a second event for the same session once the coalesce window has elapsed", () => {
    const first = makeEvent({ seq: 1, ts: FIXED_NOW + 1 });
    const { rerender } = renderAttentionNotifications({ events: { 1: [first] } });
    expect(notificationInstances).toHaveLength(1);

    vi.setSystemTime(FIXED_NOW + NOTIFICATION_COALESCE_MS + 1_000);
    const second = makeEvent({ seq: 2, ts: FIXED_NOW + NOTIFICATION_COALESCE_MS + 1_000 });
    rerender({
      events: { 1: [first, second] },
      sessions: [makeSession({ id: 1, sessionStatus: "awaiting_permission" })],
      settings: DEFAULT_SETTINGS,
      activePanelId: null,
    });

    expect(notificationInstances).toHaveLength(2);
  });

  // Issue #1428 — Notification.requestPermission() only reliably grants (or
  // works at all on some platforms) in direct response to a user gesture;
  // an effect firing off a WS event is not one. The old immediate-request
  // behavior is exactly the gap this defers.
  it("does not request Notification permission immediately on the first attention event — only on the next user gesture", () => {
    FakeNotification.permission = "default";
    const event = makeEvent({ ts: FIXED_NOW + 1 });
    renderAttentionNotifications({ events: { 1: [event] } });

    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();

    act(() => void window.dispatchEvent(new MouseEvent("click")));

    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
    // canShowBrowserNotification requires permission === "granted", so no
    // actual Notification gets constructed while still merely "default".
    expect(notificationInstances).toHaveLength(0);
  });

  it("also requests on a keydown gesture, not just a click", () => {
    FakeNotification.permission = "default";
    renderAttentionNotifications({ events: { 1: [makeEvent({ ts: FIXED_NOW + 1 })] } });

    act(() => void window.dispatchEvent(new KeyboardEvent("keydown")));

    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
  });

  it("requests permission at most once per hook instance, even across two attention events and two later gestures", () => {
    FakeNotification.permission = "default";
    const first = makeEvent({ seq: 1, ts: FIXED_NOW + 1 });
    const { rerender } = renderAttentionNotifications({ events: { 1: [first] } });

    vi.setSystemTime(FIXED_NOW + NOTIFICATION_COALESCE_MS + 1_000);
    const second = makeEvent({ seq: 2, ts: FIXED_NOW + NOTIFICATION_COALESCE_MS + 1_000 });
    rerender({
      events: { 1: [first, second] },
      sessions: [makeSession({ id: 1, sessionStatus: "awaiting_permission" })],
      settings: DEFAULT_SETTINGS,
      activePanelId: null,
    });

    // The first gesture (dispatched inside its own `act`, so React commits
    // the resulting setAwaitingGesturePermission(false) — and the effect
    // cleanup that removes the keydown listener — before the second
    // dispatch) is what proves "at most once", not just that the two
    // listeners share one flag.
    act(() => void window.dispatchEvent(new MouseEvent("click")));
    act(() => void window.dispatchEvent(new KeyboardEvent("keydown")));

    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
  });

  it("plays the notification sound only when both the global toggle and the per-status matrix column are on", () => {
    const event = makeEvent({ ts: FIXED_NOW + 1 });
    const settings: AppSettings = {
      ...DEFAULT_SETTINGS,
      notifications: {
        ...DEFAULT_SETTINGS.notifications,
        channels: { ...DEFAULT_SETTINGS.notifications.channels, sound: true },
        notificationMatrix: {
          ...DEFAULT_SETTINGS.notifications.notificationMatrix,
          awaiting_permission: { notify: true, sound: true, autoFocus: false },
        },
      },
    };
    renderAttentionNotifications({ events: { 1: [event] }, settings });

    expect(playNotificationSound).toHaveBeenCalledWith(settings.notifications.soundName);
  });

  it("does not play the sound when the global sound channel is off, even if the matrix column is on", () => {
    const event = makeEvent({ ts: FIXED_NOW + 1 });
    const settings: AppSettings = {
      ...DEFAULT_SETTINGS,
      notifications: {
        ...DEFAULT_SETTINGS.notifications,
        channels: { ...DEFAULT_SETTINGS.notifications.channels, sound: false },
        notificationMatrix: {
          ...DEFAULT_SETTINGS.notifications.notificationMatrix,
          awaiting_permission: { notify: true, sound: true, autoFocus: false },
        },
      },
    };
    renderAttentionNotifications({ events: { 1: [event] }, settings });

    expect(playNotificationSound).not.toHaveBeenCalled();
  });

  it("suppresses the browser notification for the session whose pane is currently active in a visible tab (issue #322)", () => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    const event = makeEvent({ ts: FIXED_NOW + 1 });
    renderAttentionNotifications({ events: { 1: [event] }, activePanelId: "session-1" });

    expect(notificationInstances).toHaveLength(0);
  });

  it("still notifies for a backgrounded pane in an otherwise-visible tab (issue #322)", () => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    const event = makeEvent({ ts: FIXED_NOW + 1 });
    renderAttentionNotifications({ events: { 1: [event] }, activePanelId: "session-2" });

    expect(notificationInstances).toHaveLength(1);
  });

  it("fires even while the tab is hidden regardless of activePanelId", () => {
    const event = makeEvent({ ts: FIXED_NOW + 1 });
    renderAttentionNotifications({ events: { 1: [event] }, activePanelId: "session-1" });

    expect(notificationInstances).toHaveLength(1);
  });

  it("does not fire when the browser channel itself is disabled", () => {
    const event = makeEvent({ ts: FIXED_NOW + 1 });
    const settings: AppSettings = {
      ...DEFAULT_SETTINGS,
      notifications: {
        ...DEFAULT_SETTINGS.notifications,
        channels: { ...DEFAULT_SETTINGS.notifications.channels, browser: false },
      },
    };
    renderAttentionNotifications({ events: { 1: [event] }, settings });

    expect(notificationInstances).toHaveLength(0);
  });

  // Issue #1429 — one click destination everywhere: the session itself
  // (via the store-level requestOpenSession "intent", since this hook has
  // no direct onOpenSession of its own), not the notifications panel.
  it("wires the notification's onclick to focus the window, request opening the session, and close itself", () => {
    const focusSpy = vi.spyOn(window, "focus").mockImplementation(() => {});
    const event = makeEvent({ ts: FIXED_NOW + 1 });
    renderAttentionNotifications({ events: { 1: [event] } });

    expect(notificationInstances).toHaveLength(1);
    const notification = notificationInstances[0];
    notification.onclick?.();

    expect(focusSpy).toHaveBeenCalledTimes(1);
    expect(requestOpenSession).toHaveBeenCalledWith(1);
    expect(notification.close).toHaveBeenCalledTimes(1);
  });

  // Issue #1429 — the same tag/data shape push-sw.js's own showNotification
  // call uses, so a later push notification for this session collapses onto
  // this one instead of stacking a duplicate.
  it("tags the notification with the session id, so it collapses with a later push for the same session", () => {
    const event = makeEvent({ ts: FIXED_NOW + 1 });
    renderAttentionNotifications({ events: { 1: [event] } });

    expect(notificationInstances[0].tag).toBe("mullion-session-1");
    expect(notificationInstances[0].data).toEqual({ sessionId: 1 });
  });

  // Issue #1428 — the real-world case this guards: Android Chrome throws
  // "Illegal constructor" for a page-context `new Notification()` on
  // exactly this reachable path (browser channel on, permission granted,
  // backgrounded tab).
  it("falls back to the service worker's showNotification when the constructor throws", async () => {
    FakeNotification.shouldThrow = true;
    const event = makeEvent({ ts: FIXED_NOW + 1 });
    renderAttentionNotifications({ events: { 1: [event] } });

    expect(notificationInstances).toHaveLength(0);
    await vi.waitFor(() => expect(showNotification).toHaveBeenCalledTimes(1));
    expect(showNotification).toHaveBeenCalledWith(
      "claude code",
      expect.objectContaining({ tag: "mullion-session-1", data: { sessionId: 1 } }),
    );
  });

  it("does not throw when the constructor throws and no service worker is registered either", async () => {
    FakeNotification.shouldThrow = true;
    serviceWorkerReady.mockImplementation(() => Promise.reject(new Error("no SW registered")));
    const event = makeEvent({ ts: FIXED_NOW + 1 });

    expect(() => renderAttentionNotifications({ events: { 1: [event] } })).not.toThrow();
    // Nothing more to assert on — the point is that this doesn't reject
    // unhandled or crash the effect; the bell/tab badge/title still work.
    await vi.waitFor(() => expect(serviceWorkerReady).toHaveBeenCalledTimes(1));
  });

  // Self-review — a genuine showNotification() failure (unlike "no SW
  // registered at all") used to be swallowed exactly the same silent way;
  // it's now logged so it isn't indistinguishable from the expected case.
  it("logs (but does not throw) when the service worker itself is ready but showNotification() fails", async () => {
    FakeNotification.shouldThrow = true;
    showNotification.mockRejectedValue(new Error("storage quota exceeded"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const event = makeEvent({ ts: FIXED_NOW + 1 });

    expect(() => renderAttentionNotifications({ events: { 1: [event] } })).not.toThrow();
    await vi.waitFor(() =>
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("showNotification"),
        expect.any(Error),
      ),
    );
  });

  it("uses session.name over session.command when both are present", () => {
    const event = makeEvent({ ts: FIXED_NOW + 1 });
    renderAttentionNotifications({
      events: { 1: [event] },
      sessions: [makeSession({ id: 1, sessionStatus: "awaiting_permission", name: "My Session" })],
    });

    expect(notificationInstances[0].title).toBe("My Session");
  });

  it("suppresses the OS notification, sound, and permission prompt for a muted session (#719)", () => {
    // A fresh notifiable event that would otherwise fire (see the first test
    // above) — muted must produce no Notification, no sound, and must NOT
    // trigger a permission request, since the whole alerting branch is
    // skipped for the session.
    mutedSessionIds = [1];
    const event = makeEvent({ ts: FIXED_NOW + 1 });
    renderAttentionNotifications({ events: { 1: [event] } });

    expect(notificationInstances).toHaveLength(0);
    expect(playNotificationSound).not.toHaveBeenCalled();
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
  });
});

describe("useAttentionNotifications — document title / favicon badge effect", () => {
  const noAttentionSession: Session[] = [
    makeSession({ id: 1, sessionStatusAttentionRequired: false }),
  ];

  it("leaves the bare base title when no session needs attention", () => {
    renderAttentionNotifications({ sessions: noAttentionSession });
    expect(document.title).toBe(BASE_TITLE);
  });

  it("prefixes the title with the attention-required count", () => {
    const sessions = [
      makeSession({ id: 1, sessionStatusAttentionRequired: true }),
      makeSession({ id: 2, sessionStatusAttentionRequired: false }),
    ];
    renderAttentionNotifications({ sessions });
    expect(document.title).toBe(`(1) ${BASE_TITLE}`);
  });

  it("caps the visible count at 9+", () => {
    const sessions: Session[] = Array.from({ length: 12 }, (_, i) =>
      makeSession({ id: i + 1, sessionStatusAttentionRequired: true }),
    );
    renderAttentionNotifications({ sessions });
    expect(document.title).toBe(`(9+) ${BASE_TITLE}`);
  });

  it("updates the title again on a later re-render with a different count", () => {
    const { rerender } = renderAttentionNotifications({ sessions: noAttentionSession });
    expect(document.title).toBe(BASE_TITLE);

    rerender({
      events: {},
      sessions: [makeSession({ id: 1, sessionStatusAttentionRequired: true })],
      settings: DEFAULT_SETTINGS,
      activePanelId: null,
    });
    expect(document.title).toBe(`(1) ${BASE_TITLE}`);
  });
});

// Issue #1433 — the same effect also drives the OS-level app badge.
// navigator.setAppBadge/clearAppBadge aren't real jsdom APIs — stubbed
// directly, same approach as documentBadge.test.ts's own updateAppBadge
// tests, just exercised through the real hook instead of calling the
// function directly.
describe("useAttentionNotifications — app badge effect (issue #1433)", () => {
  let setAppBadge: ReturnType<typeof vi.fn>;
  let clearAppBadge: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setAppBadge = vi.fn().mockResolvedValue(undefined);
    clearAppBadge = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { setAppBadge, clearAppBadge });
  });

  afterEach(() => {
    delete (navigator as { setAppBadge?: unknown }).setAppBadge;
    delete (navigator as { clearAppBadge?: unknown }).clearAppBadge;
  });

  it("clears the badge when no session needs attention", () => {
    renderAttentionNotifications({
      sessions: [makeSession({ id: 1, sessionStatusAttentionRequired: false })],
    });
    expect(clearAppBadge).toHaveBeenCalled();
    expect(setAppBadge).not.toHaveBeenCalled();
  });

  it("sets the badge to the attention-required count", () => {
    renderAttentionNotifications({
      sessions: [
        makeSession({ id: 1, sessionStatusAttentionRequired: true }),
        makeSession({ id: 2, sessionStatusAttentionRequired: true }),
        makeSession({ id: 3, sessionStatusAttentionRequired: false }),
      ],
    });
    expect(setAppBadge).toHaveBeenCalledWith(2);
  });

  it("updates the badge again on a later re-render with a different count", () => {
    const { rerender } = renderAttentionNotifications({
      sessions: [makeSession({ id: 1, sessionStatusAttentionRequired: false })],
    });
    expect(clearAppBadge).toHaveBeenCalledTimes(1);

    rerender({
      events: {},
      sessions: [makeSession({ id: 1, sessionStatusAttentionRequired: true })],
      settings: DEFAULT_SETTINGS,
      activePanelId: null,
    });
    expect(setAppBadge).toHaveBeenCalledWith(1);
  });

  it("does not throw when the Badging API isn't supported at all", () => {
    delete (navigator as { setAppBadge?: unknown }).setAppBadge;
    delete (navigator as { clearAppBadge?: unknown }).clearAppBadge;
    expect(() =>
      renderAttentionNotifications({
        sessions: [makeSession({ id: 1, sessionStatusAttentionRequired: true })],
      }),
    ).not.toThrow();
  });
});
