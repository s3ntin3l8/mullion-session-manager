// @vitest-environment jsdom
// Issue #1430 — direct coverage of the real ackAttention store action
// (store/slices/events.ts). NotificationBell.test.tsx (and the
// useSessionDeepLink.ts/useOpenSessionRequest.ts hook tests) already assert
// this gets CALLED with the right sessionId from every explicit read call
// site, against a fully mocked store — this file instead exercises the
// real action's own body: the actual request it sends, and that it never
// throws regardless of how the server responds.
import { describe, it, expect, vi, afterEach } from "vitest";
import { useDashboardStore } from "./index.js";
import { mockFetch } from "../test/mockFetch.js";
import { jsonResponse } from "../test/jsonResponse.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ackAttention (issue #1430)", () => {
  it("POSTs to the ack-attention route for the given session", async () => {
    const { fetchMock } = mockFetch({
      "POST /api/sessions/:id/attention/ack": () => new Response(null, { status: 204 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    useDashboardStore.getState().ackAttention(7);
    // Fire-and-forget — give the microtask queue a tick to actually send it
    // before asserting.
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/7/attention/ack",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("swallows a 409 (a blocking kind is still pending) SILENTLY — no console.error", async () => {
    const { fetchMock } = mockFetch({
      "POST /api/sessions/:id/attention/ack": () => jsonResponse(409, { message: "blocked" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => useDashboardStore.getState().ackAttention(7)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("logs (but does not throw) a genuine failure, unlike an expected 409", async () => {
    const { fetchMock } = mockFetch({
      "POST /api/sessions/:id/attention/ack": () => jsonResponse(500, { message: "oops" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => useDashboardStore.getState().ackAttention(7)).not.toThrow();
    // A non-ok response's body is parsed (an extra microtask hop —
    // client.ts's request() awaits res.json() before throwing ApiError)
    // before the .catch() below ever runs, so a couple of bare
    // Promise.resolve() ticks aren't reliably enough here.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errorSpy).toHaveBeenCalledWith("ackAttention failed", expect.anything());
  });

  it("logs (but does not throw) a genuine network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => useDashboardStore.getState().ackAttention(7)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(errorSpy).toHaveBeenCalledWith("ackAttention failed", expect.anything());
  });
});
