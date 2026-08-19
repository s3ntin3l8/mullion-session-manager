import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import webpush from "web-push";
import { sessions } from "../db/schema.js";
import type { NotificationEvent } from "./pty-manager.js";
import { defaultDeriveStatusInfo, deriveSessionStatus } from "./session-status.js";
import { getStoredSettings } from "./settings.js";
import {
  getOrCreateVapidKeys,
  getSubscriptionsForSend,
  recordSendFailure,
  recordSendSuccess,
  removeSubscription,
} from "./push-store.js";

// Per-session coalescing window — mirrors frontend/src/desktopNotify.ts's
// NOTIFICATION_COALESCE_MS exactly, so a busy session storming several
// notifiable events in quick succession doesn't also storm push
// notifications on top of whatever the in-page channel already coalesced.
// In-memory, reset on a backend restart — same tradeoff the frontend's own
// per-tab ref makes, acceptable since this only ever widens (never narrows)
// the window a burst could otherwise slip through right after a restart.
export const PUSH_COALESCE_MS = 10_000;

// web-push send option, in seconds (not ms, matching the Push API's own
// TTL header unit) — see its use below for why this isn't the library's
// 4-week default.
export const PUSH_TTL_SECONDS = 60;

// web-push's own socket timeout, in ms — see its use below for why this
// must be set explicitly (the library has no default).
export const PUSH_SEND_TIMEOUT_MS = 10_000;

// Server-side mirror of frontend/src/eventDescriptions.ts's notifyKind —
// deliberately NOT a full port. The server only needs "is this event kind
// notifiable at all" to gate a generic push; it doesn't need notifyKind's
// return value (the frontend uses "attention" vs "exited" to route through
// different UI treatments this server has no equivalent of) or
// describeEvent's per-kind body text (this notification's body is
// intentionally generic — see deliverPushNotification below). Also does NOT
// port pickNewNotifiableEvents — that function exists solely to solve
// /ws/events' replay-on-reconnect backlog problem; PtyManager.onEvent
// delivers each event exactly once, live, so there's no backlog to filter
// here.
//
// Shorter than it used to be: `permission_request`, `stop_failure`,
// `tool_failure`, `plan_ready`, `promote_request`, `elicitation`, and
// `question` are gone. Every one of those NotificationEvent kinds is always
// accompanied by a paired `attention` event carrying the same information
// (see hook-handlers.ts's raise sites and attention-tracker.ts's
// emitAttentionSignalWithExtras/emitAttentionSignalDeferred, which now emit
// BOTH from one call), and the `attention` case just below already matches
// it — keeping both here meant a single agent action pushed the phone
// twice. `promote_request` in particular was doubly wrong: its OTHER raise
// site (pty-manager.ts's resolvePromote) fires with no paired attention
// signal at all, so it was pushing a notification for the RESOLUTION of a
// promote request, not just the request itself.
function isNotifiableEvent(event: NotificationEvent): boolean {
  if (event.kind === "attention" && event.payload.attention === true) return true;
  if (event.kind === "status_change" && event.payload.reason === "exited") return true;
  if (event.kind === "review_gate" && event.payload.state === "waiting") return true;
  // dev_server_detected deliberately excluded, not ported with its
  // "state === undefined" pending check like the frontend's notifyKind has:
  // this kind has no matching SessionStatus (see session-status.ts), so a
  // notificationMatrix lookup keyed by session status would check whatever
  // ELSE the session happens to be doing right now — the wrong axis
  // entirely. Same reasoning as frontend/src/App.tsx's own explicit skip
  // for this kind in its events effect.
  return false;
}

interface PushPayload {
  title: string;
  body: string;
  sessionId: number;
}

// Deliberately generic, not a port of eventDescriptions.ts's describeEvent —
// this is a "go look at Mullion" nudge, not a transcript. A push payload is
// visible in the OS notification tray outside this app's own access control,
// so it also avoids leaking session/command details into that surface.
function buildPayload(sessionId: number): PushPayload {
  return { title: "Mullion", body: "A session needs your attention.", sessionId };
}

// One Map per app instance, mirroring plugins/hooks.ts's own
// pendingGates/pendingPromotes convention — never module-level, so it can't
// leak coalescing state across separate app instances within a single test
// run.
export type CoalesceState = Map<number, number>;

export function createCoalesceState(): CoalesceState {
  return new Map();
}

// The PtyManager.onEvent listener itself. Exported (not just used via
// registerPushDelivery below) so tests can drive it directly with a
// synthetic NotificationEvent instead of a real PTY session.
export async function deliverPushNotification(
  app: FastifyInstance,
  event: NotificationEvent,
  coalesceState: CoalesceState,
): Promise<void> {
  if (!isNotifiableEvent(event)) return;

  const settings = getStoredSettings(app.db);
  if (!settings.notifications.channels.push) return;

  const [row] = app.db.select().from(sessions).where(eq(sessions.id, event.sessionId)).all();
  // The session row can be gone by the time this runs (e.g. deleted
  // immediately after emitting an "exited" event) — not an error, just
  // nothing left to notify about. Also the natural point to evict this
  // session's coalesceState entry: it's confirmed gone, so its window will
  // never be needed again — otherwise coalesceState accumulates one entry
  // per session id ever seen for the whole process lifetime.
  if (!row) {
    coalesceState.delete(event.sessionId);
    return;
  }

  // A status_change/"exited" event is itself the authoritative signal that
  // the session just ended — deriveSessionStatus's dbStatus axis lags this
  // by up to the reconciler's 30s sweep (session-reconciler.ts only flips
  // the DB row's status column there, deliberately never off live-process
  // liveness — see session-status.ts's own comment), so re-deriving status
  // from `row.status` here would see stale "active" + dead-process
  // defaults and very likely compute "idle" instead — silently defeating
  // a user's own exited.notify=true setting for the exact case it exists
  // for. Use "exited" directly for this one event kind instead of paying
  // that race; every other notifiable kind's DerivedSessionStatus really
  // is live at the instant its event fires (see isNotifiableEvent's own
  // gating), so this special case doesn't generalize further.
  const status =
    event.kind === "status_change" && event.payload.reason === "exited"
      ? "exited"
      : deriveSessionStatus({
          dbStatus: row.status,
          info: defaultDeriveStatusInfo(
            app.pty
              .get(String(event.sessionId))
              // Live idle threshold, not toInfo()'s hardcoded 2s fallback
              // (issue #674) — every other production caller of toInfo()
              // already passes this same value; push-delivery was the one
              // silent omission, so "working" vs "idle" here disagreed with
              // what Settings -> Notifications & status actually says.
              ?.toInfo(settings.notifications.idleThresholdSeconds * 1000),
          ),
        }).status;
  if (!(settings.notifications.notificationMatrix[status]?.notify ?? false)) return;

  // Checked first, before any of the work below: an event that's going to
  // be coalesced away shouldn't pay for decrypting every subscription's
  // auth key (getSubscriptionsForSend) or touching the VAPID keys, only to
  // discover it was a no-op.
  const now = Date.now();
  const last = coalesceState.get(event.sessionId);
  if (last !== undefined && now - last < PUSH_COALESCE_MS) return;

  const subscriptions = getSubscriptionsForSend(app);
  if (subscriptions.length === 0) return;

  const { publicKey, privateKey } = getOrCreateVapidKeys(app);
  const payload = JSON.stringify(buildPayload(event.sessionId));

  // Marked only now, after every failure-capable step above has already
  // succeeded (subscriptions fetched, VAPID keys obtained) — marking any
  // earlier would drop the next event within the window even though this
  // one never actually reached a send attempt (e.g. getOrCreateVapidKeys
  // throwing on a first-ever call).
  coalesceState.set(event.sessionId, now);

  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
          {
            vapidDetails: {
              // Not a real mailto — this app has no operator contact
              // configured anywhere else either; push services accept any
              // syntactically valid subject and this is a single-user
              // self-hosted deployment, not a service with an abuse contact
              // to publish.
              subject: "mailto:push@mullion.invalid",
              publicKey,
              privateKey,
            },
            // web-push's own default TTL is 4 weeks — fine for a message
            // meant to eventually arrive, wrong for an "attention now"
            // nudge. A device that's offline longer than this should just
            // never receive this specific stale push, not get it a month
            // later after the moment it was about has long passed.
            TTL: PUSH_TTL_SECONDS,
            // web-push (3.6.7) only applies a socket timeout when this is
            // explicitly a number — there's no default. Without it, a
            // blackholed endpoint pins this send's promise (and its
            // underlying socket) indefinitely.
            timeout: PUSH_SEND_TIMEOUT_MS,
          },
        );
        recordSendSuccess(app, sub.endpoint);
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          // The push service itself is telling us this endpoint is gone —
          // the only garbage collection this table gets.
          removeSubscription(app, sub.endpoint);
        } else {
          recordSendFailure(app, sub.endpoint);
          app.log.warn({ err, endpoint: sub.endpoint }, "[push-delivery] send failed");
        }
      }
    }),
  );
}

// Wires deliverPushNotification into the same manager-level event seam
// /ws/events uses (PtyManager.onEvent, pty-manager.ts:2964) — see
// plugins/push.ts for registration/ordering.
export function registerPushDelivery(app: FastifyInstance): () => void {
  const coalesceState = createCoalesceState();
  return app.pty.onEvent((event) => {
    void deliverPushNotification(app, event, coalesceState).catch((err) => {
      app.log.error({ err, sessionId: event.sessionId }, "[push-delivery] unhandled error");
    });
  });
}
