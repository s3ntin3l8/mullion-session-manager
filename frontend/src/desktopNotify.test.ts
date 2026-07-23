import { describe, it, expect } from "vitest";
import {
  pickNewNotifiableEvents,
  notificationChannelEnabled,
  shouldRequestNotificationPermission,
  canShowBrowserNotification,
} from "./desktopNotify.js";
import { DEFAULT_SETTINGS } from "./api.js";
import type { NotificationEvent } from "./api.js";

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

describe("pickNewNotifiableEvents", () => {
  it("returns an empty result for no buffered events", () => {
    const { notifiable, processedThrough } = pickNewNotifiableEvents({}, new Map());
    expect(notifiable).toEqual([]);
    expect(processedThrough.size).toBe(0);
  });

  it("classifies a ringing attention event as notifiable", () => {
    const events = { 1: [makeEvent({ seq: 1 })] };
    const { notifiable } = pickNewNotifiableEvents(events, new Map());
    expect(notifiable).toEqual([{ sessionId: 1, event: events[1][0], kind: "attention" }]);
  });

  it("classifies an exited status_change event as notifiable", () => {
    const event = makeEvent({ seq: 1, kind: "status_change", payload: { reason: "exited" } });
    const { notifiable } = pickNewNotifiableEvents({ 1: [event] }, new Map());
    expect(notifiable).toEqual([{ sessionId: 1, event, kind: "exited" }]);
  });

  it("excludes an attention-cleared event (payload.attention !== true)", () => {
    const event = makeEvent({ seq: 1, payload: { attention: false } });
    const { notifiable } = pickNewNotifiableEvents({ 1: [event] }, new Map());
    expect(notifiable).toEqual([]);
  });

  it("excludes routine, high-frequency kinds (title_change, alt-screen status_change)", () => {
    const events = {
      1: [
        makeEvent({ seq: 1, kind: "title_change", payload: { title: "zsh" } }),
        makeEvent({ seq: 2, kind: "status_change", payload: { screen: "alt" } }),
      ],
    };
    const { notifiable, processedThrough } = pickNewNotifiableEvents(events, new Map());
    expect(notifiable).toEqual([]);
    // Still walked past both, even though neither was notifiable — a later
    // notifiable event with a lower seq than these must never be re-surfaced.
    expect(processedThrough.get(1)).toBe(2);
  });

  it("only returns events newer than alreadyProcessed — the poll-diff-style transition guard", () => {
    const events = { 1: [makeEvent({ seq: 1 }), makeEvent({ seq: 2 })] };
    const { notifiable } = pickNewNotifiableEvents(events, new Map([[1, 1]]));
    expect(notifiable).toHaveLength(1);
    expect(notifiable[0].event.seq).toBe(2);
  });

  it("does not mutate alreadyProcessed", () => {
    const alreadyProcessed = new Map([[1, 1]]);
    pickNewNotifiableEvents({ 1: [makeEvent({ seq: 2 })] }, alreadyProcessed);
    expect(alreadyProcessed.get(1)).toBe(1);
  });

  it("excludes backlog events replayed on connect (ts before notBefore), but still advances processedThrough past them", () => {
    // Mirrors a fresh /ws/events connect: the channel replays a session's
    // whole buffered history (store.ts's `events` slice doc comment), and
    // `alreadyProcessed` starts empty right alongside it — without a
    // notBefore cutoff every one of these would misfire as "new".
    const events = {
      1: [makeEvent({ seq: 1, ts: 1000 }), makeEvent({ seq: 2, ts: 2000 })],
    };
    const { notifiable, processedThrough } = pickNewNotifiableEvents(events, new Map(), 5000);
    expect(notifiable).toEqual([]);
    expect(processedThrough.get(1)).toBe(2);
  });

  it("still fires for events at/after notBefore — a genuinely live event isn't swallowed by the backlog cutoff", () => {
    const events = {
      1: [makeEvent({ seq: 1, ts: 1000 }), makeEvent({ seq: 2, ts: 6000 })],
    };
    const { notifiable } = pickNewNotifiableEvents(events, new Map(), 5000);
    expect(notifiable).toHaveLength(1);
    expect(notifiable[0].event.seq).toBe(2);
  });

  it("defaults notBefore to 0 — no filtering when the caller doesn't pass one", () => {
    const events = { 1: [makeEvent({ seq: 1, ts: 1 })] };
    const { notifiable } = pickNewNotifiableEvents(events, new Map());
    expect(notifiable).toHaveLength(1);
  });

  it("tracks multiple sessions independently", () => {
    const events = {
      1: [makeEvent({ sessionId: 1, seq: 1 })],
      2: [makeEvent({ sessionId: 2, seq: 1 })],
    };
    const { notifiable, processedThrough } = pickNewNotifiableEvents(events, new Map());
    expect(notifiable.map((n) => n.sessionId).sort()).toEqual([1, 2]);
    expect(processedThrough.get(1)).toBe(1);
    expect(processedThrough.get(2)).toBe(1);
  });
});

describe("notificationChannelEnabled", () => {
  it("gates 'attention' on notifications.attentionAlerts", () => {
    expect(
      notificationChannelEnabled("attention", {
        ...DEFAULT_SETTINGS.notifications,
        attentionAlerts: true,
      }),
    ).toBe(true);
    expect(
      notificationChannelEnabled("attention", {
        ...DEFAULT_SETTINGS.notifications,
        attentionAlerts: false,
      }),
    ).toBe(false);
  });

  it("gates 'exited' on notifications.exitedAlerts, independent of attentionAlerts", () => {
    expect(
      notificationChannelEnabled("exited", {
        ...DEFAULT_SETTINGS.notifications,
        attentionAlerts: true,
        exitedAlerts: false,
      }),
    ).toBe(false);
    expect(
      notificationChannelEnabled("exited", {
        ...DEFAULT_SETTINGS.notifications,
        attentionAlerts: false,
        exitedAlerts: true,
      }),
    ).toBe(true);
  });
});

describe("shouldRequestNotificationPermission", () => {
  it("requests on the first attention event when permission is 'default'", () => {
    expect(shouldRequestNotificationPermission("attention", "default", false)).toBe(true);
  });

  it("does not request again once already requested this session", () => {
    expect(shouldRequestNotificationPermission("attention", "default", true)).toBe(false);
  });

  it("does not request when permission has already been granted or denied", () => {
    expect(shouldRequestNotificationPermission("attention", "granted", false)).toBe(false);
    expect(shouldRequestNotificationPermission("attention", "denied", false)).toBe(false);
  });

  it("never requests off an 'exited' event", () => {
    expect(shouldRequestNotificationPermission("exited", "default", false)).toBe(false);
  });
});

describe("canShowBrowserNotification", () => {
  it("requires the browser channel enabled, permission granted, and the document hidden", () => {
    expect(
      canShowBrowserNotification({
        browserChannelEnabled: true,
        permission: "granted",
        documentHidden: true,
      }),
    ).toBe(true);
  });

  it("is false when the tab is visible — the Page Visibility requirement", () => {
    expect(
      canShowBrowserNotification({
        browserChannelEnabled: true,
        permission: "granted",
        documentHidden: false,
      }),
    ).toBe(false);
  });

  it("is false when the browser channel is disabled", () => {
    expect(
      canShowBrowserNotification({
        browserChannelEnabled: false,
        permission: "granted",
        documentHidden: true,
      }),
    ).toBe(false);
  });

  it("is false when permission isn't granted", () => {
    expect(
      canShowBrowserNotification({
        browserChannelEnabled: true,
        permission: "default",
        documentHidden: true,
      }),
    ).toBe(false);
    expect(
      canShowBrowserNotification({
        browserChannelEnabled: true,
        permission: "denied",
        documentHidden: true,
      }),
    ).toBe(false);
  });
});
