import type { AppSettings, NotificationEvent } from "./api.js";
import { notifyKind } from "./eventDescriptions.js";

// Issue #170's client-side decision logic for the live-events-driven half of
// desktop notifications — pulled out as pure functions (rather than inlined
// in App.tsx's effect) for the same reason panelUtils.ts's
// attentionTransitionPanelIds is: the transition/gating logic itself is
// unit-testable without mounting App.tsx's whole dockview tree, while the
// DOM-touching glue (new Notification(...), document.visibilityState,
// window.focus(), the dockviewApi-equivalent store call) stays in App.tsx's
// effect, same split as that earlier #98 auto-focus effect.
//
// Replaces the old poll-diff seenAttentionRef/seenExitedRef Sets that
// diffed polled SessionInfo snapshots each live-refresh tick — this instead
// sources from the live /ws/events channel (issue #166) via store.ts's
// `events` slice, keeping the per-session "already considered" bookkeeping
// keyed by the event stream's own monotonic `seq` instead of Set membership.

// The two kinds eventDescriptions.ts's notifyKind narrows a NotificationEvent
// to — reused here (not re-derived from raw event.kind/payload) so the tab
// badge (#168), the notification panel feed (#169), and desktop notifications
// (#170) all agree on what counts as an actual notification.
export type NotifyKind = NonNullable<ReturnType<typeof notifyKind>>;

export interface NotifiableEvent {
  sessionId: number;
  event: NotificationEvent;
  kind: NotifyKind;
}

export interface PickNewNotifiableEventsResult {
  notifiable: NotifiableEvent[];
  // The highest seq actually walked per session, whether or not it produced
  // a notifiable event — callers should advance their "already processed"
  // tracking to this (not just to the seqs of notifiable events) so a
  // routine event (e.g. title_change) with a higher seq than the last
  // notifiable one isn't re-walked forever.
  processedThrough: Map<number, number>;
}

// Walks every session's buffered events (store.ts's `events` slice) for
// anything newer than what's already been considered (`alreadyProcessed`,
// owned by the caller — an App.tsx ref), classifies each via notifyKind, and
// returns the ones that pass. The backend's attention state machine (#171)
// already debounces per-kind before an `attention` event is ever emitted —
// this deliberately does NOT add a second debounce layer on top: one
// NotificationEvent is one candidate notification. Does not mutate
// `alreadyProcessed`.
//
// `notBefore` (default 0, i.e. no filtering) exists so the caller can pass
// the timestamp the /ws/events stream was opened at: on a fresh connect the
// channel replays each live session's *entire* buffered event history
// (store.ts's own doc comment — up to the backend's ~100-per-session ring
// buffer cap), and `alreadyProcessed` starts empty at that point too, so
// without this every historical attention/exited event would be
// misclassified as "new" and fire a notification for backlog, not just live
// events — a real regression the old poll-diff code never had (it only ever
// looked at a session's *current* `attention` boolean, never a history of
// past events). `event.ts` is the backend's clock and `notBefore` is the
// browser's — there's no server-side "this was a replay" flag to key off
// instead (PR1 didn't build one), so this accepts ordinary clock-skew slop
// as the tradeoff for a frontend-only signal. Backlog events (event.ts <
// notBefore) still count toward
// `processedThrough` — they must never be reconsidered later — they're just
// excluded from `notifiable`.
export function pickNewNotifiableEvents(
  events: Record<number, NotificationEvent[]>,
  alreadyProcessed: ReadonlyMap<number, number>,
  notBefore = 0,
): PickNewNotifiableEventsResult {
  const notifiable: NotifiableEvent[] = [];
  const processedThrough = new Map<number, number>();

  for (const [sessionIdKey, sessionEvents] of Object.entries(events)) {
    const sessionId = Number(sessionIdKey);
    const since = alreadyProcessed.get(sessionId) ?? 0;
    let maxSeq = since;
    for (const event of sessionEvents) {
      if (event.seq <= since) continue;
      maxSeq = Math.max(maxSeq, event.seq);
      if (event.ts < notBefore) continue; // replay backlog, not a live event
      const kind = notifyKind(event);
      if (kind !== null) notifiable.push({ sessionId, event, kind });
    }
    processedThrough.set(sessionId, maxSeq);
  }

  return { notifiable, processedThrough };
}

// Per-kind delivery gate — mirrors the two independent Settings ->
// Notifications toggles the old poll-diff effects each checked
// independently (attentionAlerts for the attention effect, exitedAlerts for
// the separate exited-session-alerts effect), now unified behind the one
// shared NotifyKind classification above instead of two separate effects.
export function notificationChannelEnabled(
  kind: NotifyKind,
  notifications: AppSettings["notifications"],
): boolean {
  return kind === "attention" ? notifications.attentionAlerts : notifications.exitedAlerts;
}

// Issue #170: register Notification permission on the FIRST attention event
// only — not proactively on app load (this is only ever called from the
// events effect, never from a mount effect) and not on every subsequent
// attention event either (the `alreadyRequested` flag, an App.tsx ref).
// "exited" events never trigger this, matching both the issue's literal
// "on first attention event" wording and Settings.tsx's pre-existing
// request-on-toggle path, which is likewise gated behind the Attention
// alerts toggle specifically, not Exited alerts.
export function shouldRequestNotificationPermission(
  kind: NotifyKind,
  permission: NotificationPermission,
  alreadyRequested: boolean,
): boolean {
  return kind === "attention" && !alreadyRequested && permission === "default";
}

// The actual side-effecting permission request — a thin wrapper so
// Settings.tsx's pre-existing request-on-toggle path and this PR's
// request-on-first-event path (App.tsx) share one implementation instead of
// two separate `Notification.requestPermission()` call sites.
export function requestNotificationPermission(
  onResolved?: (permission: NotificationPermission) => void,
): void {
  if (typeof Notification === "undefined") return;
  void Notification.requestPermission().then((p) => onResolved?.(p));
}

// Whether an actual `new Notification()` should fire for an event that
// already passed notificationChannelEnabled — the browser-notification
// delivery channel toggle, permission having actually been granted, and
// issue #170's Page Visibility requirement: only when the tab is hidden/
// unfocused. A visible tab already surfaces the change some other way
// (status line, tab badge, the bell itself), so a desktop notification on
// top of that would just be noise.
export function canShowBrowserNotification(opts: {
  browserChannelEnabled: boolean;
  permission: NotificationPermission;
  documentHidden: boolean;
}): boolean {
  return opts.browserChannelEnabled && opts.permission === "granted" && opts.documentHidden;
}
