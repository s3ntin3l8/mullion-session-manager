// @vitest-environment jsdom
//
// This suite needs a real `sessionStorage` and `window.location` for the
// auth-expiry reload guard (client.ts) — the frontend's default test
// environment is "node" (vitest.config.ts) precisely to avoid jsdom's setup
// cost where it isn't needed, so this file opts in per-file instead of
// flipping the shared default.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { jsonResponse } from "../test/jsonResponse.js";
import { request, ApiError, AuthExpiredError } from "./client.js";

// Regression coverage for the production incident: behind a gateway
// forward-auth (Traefik + Authentik or similar), an expired session
// resolves every /api/* fetch as either a cross-origin redirect (opaque
// under `redirect: "manual"`) or a same-origin non-JSON interstitial —
// never as a status code the pre-existing ApiError branch could see. See
// client.ts's own comments for the full mechanism.

function opaqueRedirectResponse(): Response {
  // A real fetch() with redirect: "manual" resolves (never constructs via
  // `new Response()`, which can't produce this type) to this exact shape:
  // type "opaqueredirect", status 0, ok false, body unreadable. Mocking the
  // shape directly is the only way to represent it in a unit test.
  return {
    type: "opaqueredirect",
    ok: false,
    status: 0,
    headers: new Headers(),
    json: () => Promise.reject(new Error("opaque response body is unreadable")),
  } as unknown as Response;
}

function htmlInterstitialResponse(): Response {
  return new Response("<html><body>Sign in</body></html>", {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// A sessionStorage stand-in that throws on every access, simulating privacy
// mode / disabled storage (Hermes review — the original guard reloaded
// unconditionally whenever storage threw, an unbounded loop).
function throwingStorage(): Storage {
  const fail = () => {
    throw new DOMException("storage disabled", "SecurityError");
  };
  return {
    getItem: fail,
    setItem: fail,
    removeItem: fail,
    clear: fail,
    key: fail,
    length: 0,
  } as unknown as Storage;
}

describe("request() — forward-auth session expiry", () => {
  const reloadSpy = vi.fn();

  beforeEach(() => {
    reloadSpy.mockClear();
    vi.stubGlobal("location", { reload: reloadSpy });
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reloads the page on a cross-origin (opaque) redirect instead of throwing ApiError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(opaqueRedirectResponse()));

    await expect(request("/api/sessions")).rejects.toBeInstanceOf(AuthExpiredError);
    expect(reloadSpy).toHaveBeenCalledOnce();
  });

  it("reloads the page on a same-origin 200 that isn't JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(htmlInterstitialResponse()));

    await expect(request("/api/sessions")).rejects.toBeInstanceOf(AuthExpiredError);
    expect(reloadSpy).toHaveBeenCalledOnce();
  });

  it("does not reload a second time within the guard window — falls through to AuthExpiredError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(opaqueRedirectResponse()));

    await expect(request("/api/sessions")).rejects.toBeInstanceOf(AuthExpiredError);
    expect(reloadSpy).toHaveBeenCalledOnce();

    await expect(request("/api/sessions")).rejects.toBeInstanceOf(AuthExpiredError);
    // Still exactly one reload — a gateway that keeps redirecting after the
    // reload must not loop forever.
    expect(reloadSpy).toHaveBeenCalledOnce();
  });

  it("reloads again once the guard window has elapsed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(opaqueRedirectResponse()));
    vi.useFakeTimers();

    await expect(request("/api/sessions")).rejects.toBeInstanceOf(AuthExpiredError);
    expect(reloadSpy).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(3 * 60 * 1000 + 1);

    await expect(request("/api/sessions")).rejects.toBeInstanceOf(AuthExpiredError);
    expect(reloadSpy).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it("reloads again immediately after a successful request clears the guard", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    fetchMock.mockResolvedValueOnce(opaqueRedirectResponse());
    await expect(request("/api/sessions")).rejects.toBeInstanceOf(AuthExpiredError);
    expect(reloadSpy).toHaveBeenCalledOnce();

    // A later successful request (e.g. after the reload actually completed
    // the forward-auth dance) must clear the guard rather than leaving it
    // armed for the rest of the 3-minute window — otherwise a second,
    // unrelated expiry shortly after a real recovery would skip straight
    // to the fallback banner instead of getting its own silent reload.
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    await expect(request("/api/sessions")).resolves.toEqual({ ok: true });

    fetchMock.mockResolvedValueOnce(opaqueRedirectResponse());
    await expect(request("/api/sessions")).rejects.toBeInstanceOf(AuthExpiredError);
    expect(reloadSpy).toHaveBeenCalledTimes(2);
  });

  it("does not reload at all when sessionStorage is unavailable — no unbounded loop", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(opaqueRedirectResponse()));
    vi.stubGlobal("sessionStorage", throwingStorage());

    await expect(request("/api/sessions")).rejects.toBeInstanceOf(AuthExpiredError);
    await expect(request("/api/sessions")).rejects.toBeInstanceOf(AuthExpiredError);
    await expect(request("/api/sessions")).rejects.toBeInstanceOf(AuthExpiredError);

    // With no way to remember "already tried," the only loop-safe behavior
    // is never attempting the reload at all — not "reload once" (that
    // requires recording the attempt, which is exactly what's failing) and
    // not "reload every time" (the bug this guards against).
    expect(reloadSpy).not.toHaveBeenCalled();
  });
});

describe("request() — genuine outage path is untouched", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // Narrowed heuristic (Hermes review): only a text/html 200 is treated as
  // an auth-expiry interstitial. A non-JSON, non-HTML 200 is unexpected
  // (the backend never sends one today) but isn't a shape any known
  // gateway interstitial takes either, so it must NOT be reported as a
  // session expiry — it should surface as the genuine parse failure it is.
  it("does not treat a non-JSON, non-HTML 200 as an auth expiry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("plain text", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      ),
    );

    await expect(request("/api/sessions")).rejects.not.toBeInstanceOf(AuthExpiredError);
  });

  it("still throws ApiError for an ordinary 4xx/5xx JSON error response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(500, { message: "boom", code: "INTERNAL" })),
    );

    await expect(request("/api/sessions")).rejects.toMatchObject({
      constructor: ApiError,
      statusCode: 500,
      code: "INTERNAL",
    });
  });

  it("still rejects with a network-level error (no response at all) — the real-outage signal", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    await expect(request("/api/sessions")).rejects.toThrow("Failed to fetch");
  });

  it("still returns undefined for a 204", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(204)));

    await expect(request("/api/sessions", { method: "DELETE" })).resolves.toBeUndefined();
  });

  it("still parses an ordinary application/json 200 body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { id: 1 })));

    await expect(request("/api/sessions")).resolves.toEqual({ id: 1 });
  });
});
