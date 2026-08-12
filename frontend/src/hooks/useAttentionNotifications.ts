import { useEffect, useRef } from "react";
import type { AppSettings, NotificationEvent, Session } from "../api/index.js";
import { useDashboardStore } from "../store/index.js";
import { describeEvent } from "../eventDescriptions.js";
import { playNotificationSound } from "../notifySound.js";
import {
  pickNewNotifiableEvents,
  notificationChannelEnabled,
  shouldRequestNotificationPermission,
  requestNotificationPermission,
  canShowBrowserNotification,
  isCoalesced,
} from "../desktopNotify.js";
import {
  countAttentionRequired,
  formatDocumentTitle,
  updateFaviconBadge,
} from "../documentBadge.js";

export interface UseAttentionNotificationsParams {
  events: Record<number, NotificationEvent[]>;
  sessions: Session[];
  // Whole `AppSettings`, not just `settings.notifications` — the body below
  // reads `settings.notifications.channels.sound`/`.soundName`/
  // `.notificationMatrix`/`.channels.browser` verbatim; passing the whole
  // object keeps both the body and this hook's own effect dependency array
  // (`settings.notifications`, not `settings`) identical to what App.tsx had
  // before this extraction.
  settings: AppSettings;
  // Issue #322 — whichever dockview panel currently has focus, so the
  // desktop-notification effect below can suppress a notification for the
  // pane the user is already looking at. Sourced from the store (written by
  // App.tsx's own `onDidActivePanelChange` effect), not owned by this hook.
  activePanelId: string | null;
}

// Extracted from App.tsx (PR 34f of the hook-extraction series) — the two
// effects that surface session-attention state to the user at the app
// level: a browser Notification (+ sound) per notification-worthy /ws/events
// arrival (issue #170), and the backgrounded-tab document.title/favicon
// badge (the "extend surfaced session statuses" rich-statuses work). Every
// ref below (notifiedThroughSeqRef/notifyStreamStartRef/permissionRequestedRef/
// lastNotifiedAtRef) moved here verbatim from App.tsx, where each one was
// used exclusively inside the desktop-notification effect and nowhere
// else in that file (confirmed via a full-file grep before this
// extraction) — so none of them needed to stay behind.
//
// Ordering/coupling analysis:
//
// - Internally, between the two effects below: fully independent. The
//   title/favicon effect reads only `sessions` and writes only
//   `document.title` / the favicon `<link>`'s `href` — nothing the
//   desktop-notification effect (or any other effect anywhere in App.tsx)
//   reads or writes. The desktop-notification effect's own four refs are,
//   per the paragraph above, read/written nowhere but inside its own effect
//   body. Neither effect's dependency array overlaps with the other's refs.
//   Because of this, the title/favicon effect's execution position (App.tsx
//   used to run it later — after the auto-open-child-panel/deep-link/
//   push-message/highlight effects — since it lived further down the file)
//   safely moves earlier, alongside the desktop-notification effect, with no
//   behavior change: nothing in between ever depended on it having run yet,
//   and it never depended on anything those effects produce.
//
// - Relative to the REST of App.tsx: also independent, with one exception.
//   `activePanelId` (a store-subscribed value, not a ref) is written by
//   App.tsx's `onDidActivePanelChange` effect (issue #322), which calls
//   `useDashboardStore.getState().setActivePanelId(...)` synchronously on
//   the commit where `dockviewApi` first becomes non-null. Because this
//   hook's own effect reads `activePanelId` as a normal subscribed prop
//   (not a ref), calling this hook AFTER that effect — the exact position
//   App.tsx calls it at — means a notification evaluated on that same flush
//   already sees the up-to-date `activePanelId` rather than a stale `null`
//   from before dockviewApi was ready. This is preserved by keeping the call
//   site below `onDidActivePanelChange`'s effect in App.tsx, same as before
//   this extraction; it is NOT a requirement to keep this hook itself
//   between any of the OTHER effects that used to sit between the two
//   extracted effects' original positions (see the point above).
//
// - `events`/`sessions` get a fresh array/object identity on effectively
//   every relevant tick (the live /ws/events push and the ~4s sessions poll,
//   respectively) regardless of whether anything notification-worthy
//   actually changed — that's exactly why `notifiedThroughSeqRef`
//   (per-session "already walked through this seq") and `lastNotifiedAtRef`
//   (per-session coalescing window, desktopNotify.ts's `isCoalesced`) exist:
//   they're what make it safe for this effect to re-run on every one of
//   those identity churns without re-notifying for events/state it already
//   considered.
export function useAttentionNotifications({
  events,
  sessions,
  settings,
  activePanelId,
}: UseAttentionNotificationsParams): void {
  // Issue #170's per-session "already considered" bookkeeping for the
  // desktop-notification effect below — the event-stream equivalent of the
  // old seenAttentionRef/seenExitedRef poll-diff Sets (removed), just keyed
  // by the /ws/events channel's own monotonic seq (desktopNotify.ts's
  // pickNewNotifiableEvents) instead of Set membership.
  const notifiedThroughSeqRef = useRef<Map<number, number>>(new Map());
  // The moment the desktop-notification effect below first ran — passed as
  // `notBefore` to pickNewNotifiableEvents so the /ws/events channel's
  // on-connect replay of each session's buffered event *history* (store.ts's
  // `events` slice — "live + replayed events") doesn't get misclassified as
  // a burst of fresh notifications on every page load; only events at/after
  // this instant (genuinely new, not backlog) can fire. See that function's
  // own doc comment for why `alreadyProcessed` alone can't substitute for
  // this. Lazily set inside the effect itself (not `useRef(Date.now())`) —
  // reading the clock belongs in an effect, not render.
  const notifyStreamStartRef = useRef<number | null>(null);
  // Whether Notification permission has already been requested this page
  // session — gates desktopNotify.ts's shouldRequestNotificationPermission
  // to the FIRST attention event only (issue #170), independent of
  // Settings.tsx's own request-on-toggle path.
  const permissionRequestedRef = useRef(false);
  // Rich statuses (issue: extend surfaced session statuses) — per-session
  // notification coalescing (desktopNotify.ts's isCoalesced), so a burst of
  // notifiable events for the same session in quick succession fires at
  // most one sound/desktop-notification every NOTIFICATION_COALESCE_MS,
  // not one per event.
  const lastNotifiedAtRef = useRef<Map<number, number>>(new Map());

  // Issue #170: fires a browser Notification (and/or the notification
  // sound) when the live /ws/events channel (issue #166, store.ts's
  // `events` slice) delivers a genuinely notification-worthy event —
  // desktopNotify.ts's pickNewNotifiableEvents, which reuses
  // eventDescriptions.ts's notifyKind (the exact same "attention actually
  // ringing, or a program exited" filter the tab badge (#168) and
  // notification panel feed (#169) already use, so all three surfaces agree
  // on what counts). Replaces the old poll-diff seenAttentionRef/
  // seenExitedRef effects (removed above) that diffed polled SessionInfo
  // snapshots each live-refresh tick — leaving both live would double-fire
  // during the migration. The backend's attention state machine (#171)
  // already debounces per-kind before an `attention` event is ever emitted,
  // so this deliberately does not add a second debounce layer on top: one
  // NotificationEvent is one candidate notification.
  useEffect(() => {
    if (notifyStreamStartRef.current === null) notifyStreamStartRef.current = Date.now();
    const { notifiable, processedThrough } = pickNewNotifiableEvents(
      events,
      notifiedThroughSeqRef.current,
      notifyStreamStartRef.current,
    );
    notifiedThroughSeqRef.current = processedThrough;

    for (const { sessionId, event, kind } of notifiable) {
      // Issue #404 — every OTHER notifyKind-classified event kind has a
      // matching SessionStatus that's simultaneously true when it fires
      // (e.g. a permission_request event and session.sessionStatus ===
      // "awaiting_permission" land together), which is what makes gating
      // this loop by session.sessionStatus below meaningful: the matrix
      // entry checked is actually the entry FOR this event. dev_server_detected
      // deliberately has no SessionStatus of its own (see sessionStatus.ts —
      // this is a background housekeeping signal, not an agent-state
      // transition), so that same lookup would instead check whatever ELSE
      // the session happens to be doing right now (idle/working/etc) —
      // orthogonal to this event, and in practice almost always notify:false
      // by default, silently defeating the feature. Skipped here entirely:
      // it still gets the in-app treatment (bell icon, panel row with
      // accept/dismiss, tab badge via PaneTab.tsx's own notifyKind use) —
      // just never an OS-level Notification/sound/auto-focus, which would be
      // gated by the wrong axis anyway.
      if (event.kind === "dev_server_detected") continue;
      const session = sessions.find((s) => s.id === sessionId);
      if (!session) continue;
      if (!notificationChannelEnabled(session.sessionStatus, settings.notifications)) continue;

      const now = Date.now();
      if (isCoalesced(sessionId, now, lastNotifiedAtRef.current)) continue;
      lastNotifiedAtRef.current.set(sessionId, now);

      const permission = typeof Notification !== "undefined" ? Notification.permission : "denied";
      if (shouldRequestNotificationPermission(kind, permission, permissionRequestedRef.current)) {
        permissionRequestedRef.current = true;
        requestNotificationPermission();
      }

      // Per-status sound: the global channels.sound toggle AND the
      // per-status matrix column must both be on for a sound to fire.
      if (
        settings.notifications.channels.sound &&
        settings.notifications.notificationMatrix[session.sessionStatus]?.sound
      ) {
        playNotificationSound(settings.notifications.soundName);
      }

      // Issue #170's Page Visibility requirement: only actually raise the
      // desktop notification while the tab is hidden/unfocused — a visible
      // tab already surfaces the change some other way (status line, tab
      // badge, the bell itself). Issue #322: also fires for backgrounded
      // dockview panes in a visible tab — only the currently-active pane
      // (the one the user is looking at) is suppressed.
      const sessionIsActive = activePanelId === `session-${sessionId}`;
      if (
        !canShowBrowserNotification({
          browserChannelEnabled: settings.notifications.channels.browser,
          permission,
          documentHidden: document.visibilityState !== "visible",
          sessionIsActive,
        })
      ) {
        continue;
      }

      const described = describeEvent(event);
      const notification = new Notification(session.name || session.command || "Mullion", {
        body: described?.text ?? "Needs your attention",
      });
      notification.onclick = () => {
        window.focus();
        useDashboardStore.getState().openNotificationsPanel();
        notification.close();
      };
    }
  }, [events, sessions, settings.notifications, activePanelId]);

  // Rich statuses (issue: extend surfaced session statuses) — a backgrounded
  // tab previously gave no signal at all that something happened (static
  // favicon, document.title never assigned — see documentBadge.ts's own
  // header comment). Runs unconditionally (no Settings gate): unlike a sound
  // or a desktop notification, a tab title/favicon change is not disruptive
  // and costs nothing to always keep current.
  useEffect(() => {
    const count = countAttentionRequired(sessions);
    document.title = formatDocumentTitle(count);
    updateFaviconBadge(count);
  }, [sessions]);
}
