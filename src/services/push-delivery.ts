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
function isNotifiableEvent(event: NotificationEvent): boolean {
  if (event.kind === "attention" && event.payload.attention === true) return true;
  if (event.kind === "status_change" && event.payload.reason === "exited") return true;
  if (event.kind === "review_gate" && event.payload.state === "waiting") return true;
  if (event.kind === "permission_request") return true;
  if (event.kind === "stop_failure") return true;
  if (event.kind === "tool_failure") return true;
  if (event.kind === "plan_ready") return true;
  if (event.kind === "promote_request") return true;
  if (event.kind === "elicitation" && event.payload.state === "started") return true;
  if (event.kind === "question" && event.payload.state === "started") return true;
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
  // nothing left to notify about.
  if (!row) return;

  const liveSession = app.pty.get(String(event.sessionId));
  const info = defaultDeriveStatusInfo(liveSession?.toInfo());
  const { status } = deriveSessionStatus({ dbStatus: row.status, info });
  if (!(settings.notifications.notificationMatrix[status]?.notify ?? false)) return;

  // Checked before touching coalesceState: if nothing gets sent, this
  // event must not count against the coalescing window. Otherwise a burst
  // that fires with zero subscriptions (nothing to deliver to yet) marks
  // the window as "notified" anyway, and the first real event after a
  // device actually subscribes gets silently dropped as coalesced even
  // though no push was ever sent for the earlier burst.
  const subscriptions = getSubscriptionsForSend(app);
  if (subscriptions.length === 0) return;

  const now = Date.now();
  const last = coalesceState.get(event.sessionId);
  if (last !== undefined && now - last < PUSH_COALESCE_MS) return;
  coalesceState.set(event.sessionId, now);

  const { publicKey, privateKey } = getOrCreateVapidKeys(app);
  const payload = JSON.stringify(buildPayload(event.sessionId));

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
