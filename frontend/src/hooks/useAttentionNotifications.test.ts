// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
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
// hook uses (openNotificationsPanel, from the Notification's onclick).
// `mutedSessionIds` is the one extra field this hook now subscribes to
// (#719); kept mutable so the mute test can flip it without re-mocking.
const openNotificationsPanel = vi.fn();
let mutedSessionIds: number[] = [];
function storeState() {
  return { openNotificationsPanel, mutedSessionIds };
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
  title: string;
  body?: string;
  onclick: (() => void) | null = null;
  close = vi.fn();
  constructor(title: string, options?: NotificationOptions) {
    this.title = title;
    this.body = options?.body;
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

  it("requests Notification permission on the first attention event when permission is still 'default'", () => {
    FakeNotification.permission = "default";
    const event = makeEvent({ ts: FIXED_NOW + 1 });
    renderAttentionNotifications({ events: { 1: [event] } });

    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
    // canShowBrowserNotification requires permission === "granted", so no
    // actual Notification gets constructed while still merely "default".
    expect(notificationInstances).toHaveLength(0);
  });

  it("requests permission at most once per hook instance, even across two attention events", () => {
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

  it("wires the notification's onclick to focus the window, open the notifications panel, and close itself", () => {
    const focusSpy = vi.spyOn(window, "focus").mockImplementation(() => {});
    const event = makeEvent({ ts: FIXED_NOW + 1 });
    renderAttentionNotifications({ events: { 1: [event] } });

    expect(notificationInstances).toHaveLength(1);
    const notification = notificationInstances[0];
    notification.onclick?.();

    expect(focusSpy).toHaveBeenCalledTimes(1);
    expect(openNotificationsPanel).toHaveBeenCalledTimes(1);
    expect(notification.close).toHaveBeenCalledTimes(1);
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
