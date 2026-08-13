// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useDashboardStore } from "./store/index.js";
import { api } from "./api/index.js";

// Independent review finding (PR #430) — App.tsx's auto-open-child-panel
// effect needs to tell "sessions is [] because nothing has loaded yet" apart
// from "sessions is [] because there are none," the same reason
// settingsLoaded exists. Without sessionsLoaded, that effect's one-time seed
// could latch against an empty list before the initial GET /api/sessions
// resolves, then treat every real pre-existing child as newly-arrived on the
// very next successful fetch and force-open all of their panels at once.
describe("store.sessionsLoaded", () => {
  beforeEach(() => {
    useDashboardStore.setState({ sessions: [], sessionsLoaded: false });
    vi.restoreAllMocks();
  });

  it("starts false before any fetch resolves", () => {
    expect(useDashboardStore.getState().sessionsLoaded).toBe(false);
  });

  it("flips true once refreshSessions() resolves, even with an empty list", async () => {
    vi.spyOn(api, "listSessions").mockResolvedValue([]);
    await useDashboardStore.getState().refreshSessions();
    expect(useDashboardStore.getState().sessionsLoaded).toBe(true);
    expect(useDashboardStore.getState().sessions).toEqual([]);
  });

  it("stays false if the first fetch rejects", async () => {
    vi.spyOn(api, "listSessions").mockRejectedValue(new Error("network error"));
    await expect(useDashboardStore.getState().refreshSessions()).rejects.toThrow();
    expect(useDashboardStore.getState().sessionsLoaded).toBe(false);
  });
});
