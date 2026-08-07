// Issue #95 — web push handlers, imported into the vite-plugin-pwa-generated
// service worker via workbox.importScripts (frontend/vite.config.ts). Plain
// JS, not TypeScript — importScripts loads a script into the SW's own
// global scope, it can't resolve a module import, so this can't reuse
// pushClient.ts's logic directly. Kept deliberately small (~three
// listeners) and untested, matching desktopNotify.ts's own documented split
// between pure/tested decision logic and DOM/SW-effecting glue that stays
// untested — see pushClient.ts's header comment for the fuller rationale,
// including why this wasn't rewritten as an injectManifest TS service
// worker (that would mean replacing the auto-update config whose real-
// device correctness is itself unverified — see issue #552).

self.addEventListener("push", (event) => {
  event.waitUntil(handlePush(event));
});

async function handlePush(event) {
  let payload = { title: "Mullion", body: "A session needs your attention.", sessionId: null };
  if (event.data) {
    try {
      payload = { ...payload, ...event.data.json() };
    } catch {
      // Malformed/non-JSON payload — fall through to the generic default
      // above rather than dropping the push. A push handler that resolves
      // without ever calling showNotification() gets Chrome's own "This
      // site has been updated in the background" penalty notification
      // under userVisibleOnly:true — strictly worse than a generic one.
    }
  }

  const tag = payload.sessionId != null ? `mullion-session-${payload.sessionId}` : "mullion";

  // Always show first, then close if a visible tab already owns this event
  // (below) — never an early return. userVisibleOnly:true requires a
  // notification to be showing when this handler's promise settles; an
  // early return here would trade a real duplicate for Chrome's own
  // context-free penalty notification instead, which is worse.
  await self.registration.showNotification(payload.title, {
    body: payload.body,
    tag,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { sessionId: payload.sessionId },
  });

  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const hasVisibleClient = clients.some((c) => c.visibilityState === "visible");
  if (hasVisibleClient) {
    const shown = await self.registration.getNotifications({ tag });
    shown.forEach((n) => n.close());
  }
}

self.addEventListener("notificationclick", (event) => {
  const sessionId = event.notification.data && event.notification.data.sessionId;
  event.notification.close();
  event.waitUntil(handleNotificationClick(sessionId));
});

async function handleNotificationClick(sessionId) {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const existing = clients[0];
  if (existing) {
    // focus() + postMessage, never navigate() — navigating a live Mullion
    // tab would tear down every open xterm WebSocket. App.tsx listens for
    // this message and opens the session panel in-place.
    await existing.focus();
    existing.postMessage({ type: "mullion-open-session", sessionId });
    return;
  }
  const url = sessionId != null ? `/?session=${sessionId}` : "/";
  await self.clients.openWindow(url);
}

// The push service can invalidate a subscription's endpoint at any time
// (key rotation, expiry) and notifies via this event rather than just
// letting the next push silently fail. Re-subscribing with the same
// applicationServerKey when the browser supplies the old subscription's
// options (not all browsers do); falling back to re-fetching the current
// key from the server otherwise. Server-side 404/410 pruning
// (push-delivery.ts) is the backstop for when this can't run at all (SW not
// active, fetch failure).
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(handleSubscriptionChange(event));
});

async function handleSubscriptionChange(event) {
  let applicationServerKey =
    event.oldSubscription && event.oldSubscription.options.applicationServerKey;
  if (!applicationServerKey) {
    const res = await fetch("/api/push/vapid-public-key");
    if (!res.ok) return;
    const { publicKey } = await res.json();
    applicationServerKey = urlBase64ToUint8Array(publicKey);
  }

  const subscription = await self.registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey,
  });

  const registerRes = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(subscription.toJSON()),
  }).catch(() => null);
  // Only DELETE the old row once the new subscription is actually
  // registered server-side (Hermes review) — a failed/network-error POST
  // here (transient outage, expired session cookie) followed by an
  // unconditional DELETE would leave zero subscribers with no push
  // delivered until the app happens to reopen and ensurePushSubscribed
  // resyncs, which defeats the entire point of a feature meant to deliver
  // while the app is closed.
  if (!registerRes || !registerRes.ok) return;

  const oldEndpoint = event.oldSubscription && event.oldSubscription.endpoint;
  if (oldEndpoint) {
    await fetch("/api/push/unsubscribe", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: oldEndpoint }),
    }).catch(() => {});
  }
}

// Duplicated from pushClient.ts (importScripts can't import a TS module —
// see this file's header) — keep in sync if the encoding ever changes.
function urlBase64ToUint8Array(base64Url) {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
