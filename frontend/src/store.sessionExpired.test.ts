// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useDashboardStore } from "./store/index.js";
import { api, AuthExpiredError } from "./api/index.js";

// Regression coverage for the production incident: a gateway forward-auth
// (Traefik + Authentik or similar) session expiry must drive its own
// `sessionExpired` state, not the generic `backendReachable` one — see
// AuthExpiredError's doc comment (api/client.ts) and sessionExpired's
// (store/types.ts) for why the two must never be conflated. App.tsx renders
// a distinct banner for each.
describe("store.sessionExpired", () => {
  beforeEach(() => {
    useDashboardStore.setState({
      sessions: [],
      sessionsLoaded: false,
      backendReachable: true,
      sessionExpired: false,
    });
    vi.restoreAllMocks();
  });

  it("starts false", () => {
    expect(useDashboardStore.getState().sessionExpired).toBe(false);
  });

  it("flips true on an AuthExpiredError, and leaves backendReachable alone", async () => {
    vi.spyOn(api, "listSessions").mockRejectedValue(new AuthExpiredError());

    await expect(useDashboardStore.getState().refreshSessions()).rejects.toBeInstanceOf(
      AuthExpiredError,
    );

    expect(useDashboardStore.getState().sessionExpired).toBe(true);
    // The genuine-outage banner's whole premise (backend process down,
    // "unix socket · retry in Ns…") is wrong for a gateway auth expiry — it
    // must not also flip, even after multiple consecutive AuthExpiredErrors
    // (which, unlike an ordinary network failure, never accumulate toward
    // BACKEND_UNREACHABLE_THRESHOLD).
    expect(useDashboardStore.getState().backendReachable).toBe(true);
  });

  it("a single AuthExpiredError does not touch backendReachable even below the threshold", async () => {
    vi.spyOn(api, "listSessions").mockRejectedValue(new AuthExpiredError());

    await expect(useDashboardStore.getState().refreshSessions()).rejects.toBeInstanceOf(
      AuthExpiredError,
    );
    await expect(useDashboardStore.getState().refreshSessions()).rejects.toBeInstanceOf(
      AuthExpiredError,
    );

    expect(useDashboardStore.getState().backendReachable).toBe(true);
  });

  it("an ordinary network failure still drives backendReachable, not sessionExpired", async () => {
    vi.spyOn(api, "listSessions").mockRejectedValue(new TypeError("Failed to fetch"));

    // BACKEND_UNREACHABLE_THRESHOLD is 2 (store/constants.ts) — two
    // consecutive failures are needed before backendReachable flips.
    await expect(useDashboardStore.getState().refreshSessions()).rejects.toThrow();
    await expect(useDashboardStore.getState().refreshSessions()).rejects.toThrow();

    expect(useDashboardStore.getState().backendReachable).toBe(false);
    expect(useDashboardStore.getState().sessionExpired).toBe(false);
  });

  it("clears once a subsequent refreshSessions() succeeds, same as backendReachable", async () => {
    vi.spyOn(api, "listSessions").mockRejectedValueOnce(new AuthExpiredError());
    await expect(useDashboardStore.getState().refreshSessions()).rejects.toBeInstanceOf(
      AuthExpiredError,
    );
    expect(useDashboardStore.getState().sessionExpired).toBe(true);

    // If the gateway session gets refreshed some other way (a background
    // poll happens to land after the user re-authenticated in another tab,
    // for instance) without the user ever clicking this tab's "Sign in"
    // button, the banner shouldn't keep asserting a problem that's already
    // resolved — same auto-clear-on-success behavior as backendReachable.
    vi.spyOn(api, "listSessions").mockResolvedValue([]);
    await useDashboardStore.getState().refreshSessions();

    expect(useDashboardStore.getState().sessionExpired).toBe(false);
  });
});
