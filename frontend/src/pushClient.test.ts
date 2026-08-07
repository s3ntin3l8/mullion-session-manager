// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  disablePush,
  enablePush,
  ensurePushSubscribed,
  isPushSupported,
  urlBase64ToUint8Array,
} from "./pushClient.js";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function emptyResponse(status: number) {
  return new Response(null, { status });
}

// Encodes bytes the way a real browser would hand back a VAPID public key
// (URL-safe base64, RFC 4648 §5, no padding) — used to build round-trip
// fixtures rather than hardcoding a byte sequence from memory, which is
// exactly the kind of thing that's easy to get subtly wrong by hand.
function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("urlBase64ToUint8Array", () => {
  it("round-trips a known string vector", () => {
    // "SGVsbG8" is standard base64 for "Hello" with the trailing "=" padding
    // stripped and no -/_ substitution needed — the simplest possible case.
    expect(Array.from(urlBase64ToUint8Array("SGVsbG8"))).toEqual(
      Array.from(new TextEncoder().encode("Hello")),
    );
  });

  it.each([
    ["needs no padding (byte length % 3 === 0)", 3],
    ["needs one '=' (byte length % 3 === 2)", 5],
    ["needs two '=' (byte length % 3 === 1)", 4],
    // A real VAPID applicationServerKey is 65 raw bytes (uncompressed P-256
    // point) — the length this function is actually exercised against.
    ["a real VAPID-key-shaped 65 bytes", 65],
  ])("round-trips %s", (_label, byteLength) => {
    const original = new Uint8Array(byteLength);
    for (let i = 0; i < byteLength; i++) original[i] = (i * 7 + 3) % 256;
    const decoded = urlBase64ToUint8Array(toBase64Url(original));
    expect(Array.from(decoded)).toEqual(Array.from(original));
  });

  it("handles a URL-safe '-'/'_' vector atob() alone would reject", () => {
    // Bytes chosen so the standard-base64 encoding contains both '+' and
    // '/', which toBase64Url above converts to '-'/'_' — atob() on the
    // un-substituted string would either throw or silently decode wrong.
    const original = new Uint8Array([251, 255, 191, 254]);
    const encoded = toBase64Url(original);
    expect(encoded).toMatch(/[-_]/);
    expect(Array.from(urlBase64ToUint8Array(encoded))).toEqual(Array.from(original));
  });
});

describe("isPushSupported", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("true when serviceWorker, PushManager, and Notification are all present", () => {
    vi.stubGlobal("navigator", { serviceWorker: {} });
    vi.stubGlobal("PushManager", class {});
    vi.stubGlobal("Notification", { permission: "default" });
    expect(isPushSupported()).toBe(true);
  });

  it("false when PushManager is absent", () => {
    vi.stubGlobal("navigator", { serviceWorker: {} });
    vi.stubGlobal("Notification", { permission: "default" });
    // Intentionally do not stub PushManager.
    expect(isPushSupported()).toBe(false);
  });

  it("false when navigator.serviceWorker is absent", () => {
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("PushManager", class {});
    vi.stubGlobal("Notification", { permission: "default" });
    expect(isPushSupported()).toBe(false);
  });

  it("false when Notification is undefined", () => {
    vi.stubGlobal("navigator", { serviceWorker: {} });
    vi.stubGlobal("PushManager", class {});
    vi.stubGlobal("Notification", undefined);
    expect(isPushSupported()).toBe(false);
  });
});

// Byte-fixture for the VAPID key returned by /api/push/vapid-public-key in
// every test below — deliberately not all-zero so a same-length-different-
// content mismatch (the key-rotation tests) is a genuine content check.
const VAPID_KEY_BYTES = new Uint8Array(65);
for (let i = 0; i < 65; i++) VAPID_KEY_BYTES[i] = (i * 3 + 1) % 256;
const VAPID_PUBLIC_KEY = toBase64Url(VAPID_KEY_BYTES);

const ROTATED_KEY_BYTES = new Uint8Array(65);
for (let i = 0; i < 65; i++) ROTATED_KEY_BYTES[i] = (i * 5 + 2) % 256;

function mockSubscription(
  applicationServerKeyBytes: Uint8Array,
  endpoint = "https://push.example/ep1",
) {
  return {
    endpoint,
    options: { applicationServerKey: applicationServerKeyBytes.buffer },
    unsubscribe: vi.fn(() => Promise.resolve(true)),
    toJSON: () => ({
      endpoint,
      expirationTime: null,
      keys: { p256dh: "p256dh-fixture", auth: "auth-fixture" }, // pragma: allowlist secret
    }),
  };
}

describe("enablePush / disablePush / ensurePushSubscribed", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let getSubscription: ReturnType<typeof vi.fn>;
  let subscribe: ReturnType<typeof vi.fn>;
  let requestPermission: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/push/vapid-public-key" && method === "GET") {
        return Promise.resolve(jsonResponse(200, { publicKey: VAPID_PUBLIC_KEY }));
      }
      if (url === "/api/push/subscribe" && method === "POST") {
        return Promise.resolve(emptyResponse(204));
      }
      if (url === "/api/push/unsubscribe" && method === "DELETE") {
        return Promise.resolve(emptyResponse(204));
      }
      return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    getSubscription = vi.fn(() => Promise.resolve(null));
    subscribe = vi.fn((opts: { applicationServerKey: Uint8Array }) =>
      Promise.resolve(mockSubscription(opts.applicationServerKey)),
    );
    vi.stubGlobal("navigator", {
      serviceWorker: {
        ready: Promise.resolve({
          pushManager: { getSubscription, subscribe },
        }),
      },
    });
    vi.stubGlobal("PushManager", class {});
    requestPermission = vi.fn(() => Promise.resolve("granted" as NotificationPermission));
    vi.stubGlobal("Notification", { permission: "default", requestPermission });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects instead of hanging forever when navigator.serviceWorker.ready never settles (Hermes review)", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", {
      serviceWorker: {
        ready: new Promise(() => {}), // never resolves — simulates a failed SW registration
      },
    });
    const promise = enablePush();
    // Attach a rejection handler synchronously so Node doesn't flag this as
    // an unhandled rejection while fake timers are advanced below.
    const assertion = expect(promise).rejects.toThrow(/did not become ready/i);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    vi.useRealTimers();
  });

  it("throws when push is unsupported", async () => {
    // vi.stubGlobal(name, undefined) still leaves the property present (an
    // "in" check would still see it) — actually remove it so
    // isPushSupported()'s "PushManager" in window check sees it as absent,
    // matching how a real unsupported browser looks.
    Reflect.deleteProperty(globalThis, "PushManager");
    await expect(enablePush()).rejects.toThrow(/not supported/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bails without proceeding to subscribe when permission is not granted", async () => {
    requestPermission.mockResolvedValue("denied" as NotificationPermission);
    await expect(enablePush()).rejects.toThrow(/denied/i);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("subscribes fresh when there is no existing subscription, and POSTs a body matching the routes/push.ts schema", async () => {
    await enablePush();

    expect(subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: VAPID_KEY_BYTES,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/push/subscribe",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          endpoint: "https://push.example/ep1",
          expirationTime: null,
          keys: { p256dh: "p256dh-fixture", auth: "auth-fixture" }, // pragma: allowlist secret
        }),
      }),
    );
  });

  it("reuses an existing subscription whose key still matches, without calling subscribe again", async () => {
    getSubscription.mockResolvedValue(
      mockSubscription(VAPID_KEY_BYTES, "https://push.example/existing"),
    );

    await enablePush();

    expect(subscribe).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/push/subscribe",
      expect.objectContaining({
        body: expect.stringContaining("https://push.example/existing"),
      }),
    );
  });

  it("unsubscribes and resubscribes when the existing subscription's key has rotated, deleting the stale endpoint server-side", async () => {
    const stale = mockSubscription(ROTATED_KEY_BYTES, "https://push.example/stale");
    getSubscription.mockResolvedValue(stale);

    await enablePush();

    expect(stale.unsubscribe).toHaveBeenCalled();
    expect(subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: VAPID_KEY_BYTES,
    });
    // Hermes review: mirrors push-sw.js's handleSubscriptionChange, which
    // explicitly deletes the stale endpoint rather than relying solely on
    // push-delivery.ts's 404/410 pruning.
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/push/unsubscribe",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ endpoint: "https://push.example/stale" }),
      }),
    );
  });

  it("disablePush DELETEs the server-side row before calling unsubscribe()", async () => {
    const order: string[] = [];
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/push/unsubscribe") order.push("delete");
      return Promise.resolve(emptyResponse(204));
    });
    const subscription = mockSubscription(VAPID_KEY_BYTES, "https://push.example/to-remove");
    subscription.unsubscribe.mockImplementation(() => {
      order.push("unsubscribe");
      return Promise.resolve(true);
    });
    getSubscription.mockResolvedValue(subscription);

    await disablePush();

    expect(order).toEqual(["delete", "unsubscribe"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/push/unsubscribe",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ endpoint: "https://push.example/to-remove" }),
      }),
    );
  });

  it("disablePush no-ops when there is no existing subscription", async () => {
    getSubscription.mockResolvedValue(null);
    await disablePush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ensurePushSubscribed no-ops when permission is not already granted", async () => {
    vi.stubGlobal("Notification", { permission: "default", requestPermission });
    await ensurePushSubscribed();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getSubscription).not.toHaveBeenCalled();
  });

  it("ensurePushSubscribed subscribes when permission is already granted", async () => {
    // requestNotificationPermission's underlying Notification.requestPermission()
    // call is safe to make even when permission is already decided — real
    // browsers resolve it immediately with the current value with no UI
    // shown, so this isn't asserting "never called," only that the actual
    // subscribe goes through without ensurePushSubscribed's own bail (which
    // only triggers on a *not yet decided* "default" permission).
    vi.stubGlobal("Notification", { permission: "granted", requestPermission });
    await ensurePushSubscribed();
    expect(subscribe).toHaveBeenCalled();
  });

  it("ensurePushSubscribed swallows a subscribe failure rather than throwing", async () => {
    vi.stubGlobal("Notification", { permission: "granted", requestPermission });
    subscribe.mockRejectedValue(new Error("network down"));
    await expect(ensurePushSubscribed()).resolves.toBeUndefined();
  });
});
