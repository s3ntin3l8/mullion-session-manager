import { api } from "./api.js";
import { requestNotificationPermission } from "./desktopNotify.js";

// Issue #95 — the browser half of web push. The backend (push-store.ts,
// push-delivery.ts, routes/push.ts) shipped in #549/#550 with zero
// subscribers; this file is what actually creates one. Split out from
// Settings.tsx/App.tsx (rather than inlined) for the same reason
// desktopNotify.ts's decision functions are: so the parts that don't touch
// the DOM (base64url decoding, subscription-shape comparison) are
// unit-testable without mounting a live ServiceWorkerRegistration. The
// actual public/push-sw.js service worker script is the DOM/SW-effecting
// glue this stays deliberately separate from — see that file's own header
// comment for why it has no equivalent test coverage.

export function isPushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    typeof Notification !== "undefined"
  );
}

// The Push API's applicationServerKey wants a raw Uint8Array, but the VAPID
// public key travels as URL-safe base64 (RFC 4648 §5, no padding) over the
// wire — atob() alone throws InvalidCharacterError on '-'/'_' and mis-pads
// on non-multiple-of-4 input. This is the standard conversion (see the
// Web Push RFC 8292 examples); getting either step wrong is a classic
// silent InvalidAccessError at subscribe() time, not at this call site.
// Return type is explicitly Uint8Array<ArrayBuffer>, not the bare
// `Uint8Array` (which defaults its generic to ArrayBufferLike, erasing the
// more specific type `new Uint8Array(length)` actually produces) — the DOM
// lib's PushSubscriptionOptionsInit.applicationServerKey requires a
// BufferSource backed by a concrete ArrayBuffer, and TS's typed-array
// generics (since ~5.7) are strict about ArrayBuffer vs. the wider
// ArrayBufferLike (which also covers SharedArrayBuffer).
export function urlBase64ToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

// Byte-for-byte comparison of an existing subscription's own
// applicationServerKey against the key the server currently hands out —
// they can legitimately differ (a fresh VAPID keypair minted by a restored/
// migrated backend, see push-store.ts's getOrCreateVapidKeys) and a stale
// subscription created under an old key must be torn down and recreated,
// not reused.
function sameKey(a: ArrayBuffer | null, b: Uint8Array): boolean {
  if (!a) return false;
  const bytesA = new Uint8Array(a);
  if (bytesA.length !== b.length) return false;
  return bytesA.every((byte, i) => byte === b[i]);
}

// navigator.serviceWorker.ready has no built-in timeout — if registration
// failed at app load (Hermes review), the promise never settles, and
// Settings.tsx's optimistic toggle would stay stuck "busy" forever with
// nothing to revert it. 10s is generous for a same-origin SW that's
// already meant to be registered by the time a user reaches for this
// toggle.
const SERVICE_WORKER_READY_TIMEOUT_MS = 10_000;

function serviceWorkerReady(): Promise<ServiceWorkerRegistration> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<ServiceWorkerRegistration>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("Service worker did not become ready in time.")),
      SERVICE_WORKER_READY_TIMEOUT_MS,
    );
  });
  return Promise.race([navigator.serviceWorker.ready, timeout]).finally(() => clearTimeout(timer));
}

async function toPayload(
  subscription: PushSubscription,
): Promise<Parameters<typeof api.subscribePush>[0]> {
  // subscription.toJSON() is the standard shape and exactly what
  // src/routes/push.ts's schema (additionalProperties: false) accepts —
  // round-tripping through JSON strips PushSubscription's non-enumerable/
  // prototype members rather than risking a hand-built object drifting
  // from the real shape.
  return JSON.parse(JSON.stringify(subscription));
}

// The shared post-permission body of enablePush/ensurePushSubscribed below
// — split out (independent-reviewer suggestion on this PR) so
// ensurePushSubscribed's app-load resync never routes through
// requestNotificationPermission() at all, rather than relying on the fact
// that calling it with permission already decided merely happens to be a
// no-op UI-wise. Removes any doubt and lets a test assert the resync path
// never touches Notification.requestPermission.
//
// Module-level in-flight guard (Hermes review, third pass): the app-load
// resync (ensurePushSubscribed, fired once from App.tsx on mount) and a
// user immediately toggling the Settings switch can genuinely overlap —
// without this, both would call registration.pushManager.subscribe()
// concurrently, and the loser rejects with InvalidStateError, reverting
// the toggle with a confusing error even though the winner's subscribe may
// have succeeded moments earlier. A concurrent caller now awaits the
// already-in-flight attempt instead of starting a second one.
let subscribeInFlight: Promise<void> | null = null;

async function subscribeCurrent(): Promise<void> {
  if (subscribeInFlight) return subscribeInFlight;
  subscribeInFlight = subscribeCurrentUnguarded().finally(() => {
    subscribeInFlight = null;
  });
  return subscribeInFlight;
}

async function subscribeCurrentUnguarded(): Promise<void> {
  const registration = await serviceWorkerReady();
  const { publicKey } = await api.getVapidPublicKey();
  const applicationServerKey = urlBase64ToUint8Array(publicKey);

  const existing = await registration.pushManager.getSubscription();
  let subscription = existing;
  // The endpoint to DELETE server-side once the new subscription is
  // confirmed registered — deliberately not deleted up front. The local
  // existing.unsubscribe() below still has to happen before subscribe()
  // can register a new key (a registration only holds one active local
  // subscription at a time), but the *server-side* DELETE is held back
  // until after api.subscribePush() below succeeds (Hermes review, second
  // pass) — new-then-old, mirroring push-sw.js's handleSubscriptionChange
  // ordering. Deleting the old row first would leave zero server-side
  // subscribers if subscribe()/subscribePush() then failed, until the next
  // resync.
  let staleEndpoint: string | null = null;
  if (existing && !sameKey(existing.options.applicationServerKey, applicationServerKey)) {
    staleEndpoint = existing.endpoint;
    await existing.unsubscribe();
    subscription = null;
  }
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    });
  }

  await api.subscribePush(await toPayload(subscription));
  if (staleEndpoint) {
    await api.unsubscribePush(staleEndpoint).catch(() => {});
  }
}

// Called when the user turns the push channel toggle on (Settings.tsx).
// Throws on any failure (permission denied, subscribe rejected, network) so
// the caller can surface it inline rather than leaving the toggle showing
// "on" with no real subscription behind it.
export async function enablePush(): Promise<void> {
  if (!isPushSupported()) throw new Error("Push notifications are not supported in this browser.");

  const permission = await requestNotificationPermission();
  if (permission !== "granted") {
    throw new Error(`Notification permission ${permission}.`);
  }

  await subscribeCurrent();
}

// Called when the user turns the push channel toggle off. Unsubscribes
// locally regardless of whether the server DELETE succeeds — a subscription
// left registered with the browser but unknown to the server is silently
// harmless (push-delivery.ts simply never sends to an endpoint it doesn't
// have), while the reverse (server row survives, browser subscription
// gone) is what leaves the toggle lying about its own state.
export async function disablePush(): Promise<void> {
  if (!isPushSupported()) return;
  const registration = await serviceWorkerReady();
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  // DELETE before unsubscribe(): if the network call fails, the server
  // still has a — now orphaned but harmless — row that push-delivery.ts's
  // 404/410 pruning will clean up on the next send; the alternative
  // ordering risks a local unsubscribe succeeding while the server keeps
  // sending to a dead endpoint indefinitely.
  await api.unsubscribePush(subscription.endpoint).catch(() => {});
  // Deliberately not wrapped in try/catch (unlike the DELETE above): if
  // unsubscribe() itself rejects after the server-side row is already
  // gone, Settings.tsx's caller reverts the toggle back to "on" even
  // though the server has already forgotten this endpoint — a state a
  // user could only clear by toggling again. Rare (unsubscribe() failing
  // is uncommon). Retrying disablePush() self-heals only if
  // getSubscription() still returns this same subscription to retry
  // against (Hermes review, third pass: not guaranteed — some browsers may
  // tear a subscription down locally despite the rejection); if it
  // doesn't, disablePush()'s own `if (!subscription) return;` makes the
  // retry a silent no-op, leaving the toggle "on" until the user notices
  // and the mismatch is otherwise harmless (push-delivery.ts simply keeps
  // sending to a real, working endpoint the toggle merely believes is off).
  await subscription.unsubscribe();
}

// Re-sync on app load (App.tsx, gated on settings.notifications.channels
// .push already being true) — recovers a subscription lost to a
// pushsubscriptionchange the service worker missed, or to the browser
// clearing site data without the toggle ever being flipped off. Must never
// itself prompt for permission: an app-load call site is not a direct
// response to user action, and Chrome/Safari's own anti-spam heuristics
// aside, silently prompting on load would be a bad experience regardless.
export async function ensurePushSubscribed(): Promise<void> {
  if (!isPushSupported()) return;
  if (Notification.permission !== "granted") return;
  try {
    await subscribeCurrent();
  } catch {
    // Best-effort — enablePush's own errors are for the explicit
    // user-initiated toggle path to surface; a background resync failure
    // just means the user tries the toggle again themselves.
  }
}
