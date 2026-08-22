// @vitest-environment jsdom
// #719 — per-session mute persistence. Exercises the real store's
// `toggleSessionMute` action end to end: it must flip membership in
// `mutedSessionIds` AND write the new list through to localStorage
// (persistedState.ts's readMutedSessionIds/writeMutedSessionIds), so the
// preference survives a reload.
import { describe, it, expect, beforeEach } from "vitest";
import { useDashboardStore } from "./index.js";

const STORAGE_KEY = "crs.mutedSessions";

beforeEach(() => {
  localStorage.clear();
  // Reset the singleton store's mute set so tests don't leak into each other.
  useDashboardStore.setState({ mutedSessionIds: [] });
});

describe("per-session mute (#719)", () => {
  it("adds a session id and persists it to localStorage on first toggle", () => {
    expect(useDashboardStore.getState().mutedSessionIds).toEqual([]);

    useDashboardStore.getState().toggleSessionMute(42);

    expect(useDashboardStore.getState().mutedSessionIds).toEqual([42]);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("[42]");
  });

  it("removes the session id and persists the empty list on a second toggle", () => {
    const { toggleSessionMute } = useDashboardStore.getState();
    toggleSessionMute(42);
    toggleSessionMute(7);
    expect(useDashboardStore.getState().mutedSessionIds).toEqual([42, 7]);

    toggleSessionMute(42);

    expect(useDashboardStore.getState().mutedSessionIds).toEqual([7]);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("[7]");
  });

  it("does not duplicate a session id already muted", () => {
    const { toggleSessionMute } = useDashboardStore.getState();
    // Toggling the same id twice must remove it (not append a duplicate):
    // a second toggle on an already-muted session returns to the empty set.
    toggleSessionMute(42);
    expect(useDashboardStore.getState().mutedSessionIds).toEqual([42]);
    toggleSessionMute(42);

    expect(useDashboardStore.getState().mutedSessionIds).toEqual([]);
  });
});
