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
});

describe("request() — genuine outage path is untouched", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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
