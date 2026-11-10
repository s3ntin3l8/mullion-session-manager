// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { DockviewApi } from "dockview-react";
import type { AppSettings } from "../api/index.js";
import { DEFAULT_SETTINGS } from "../api/index.js";
import { makeSession } from "../test/fixtures.js";
import { useAutoFocusOnAttention } from "./useAutoFocusOnAttention.js";
import type { UseAutoFocusOnAttentionParams } from "./useAutoFocusOnAttention.js";

const setViewMode = vi.fn();

function storeState() {
  return { setViewMode };
}

vi.mock("../store/index.js", () => {
  const useDashboardStore = (selector?: (s: unknown) => unknown) => {
    const state = storeState();
    return selector ? selector(state) : state;
  };
  useDashboardStore.getState = storeState;
  return { useDashboardStore };
});

function focusSettings(autoFocusOnAttention: boolean, needsInputAutoFocus: boolean): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    notifications: {
      ...DEFAULT_SETTINGS.notifications,
      autoFocusOnAttention,
      notificationMatrix: {
        ...DEFAULT_SETTINGS.notifications.notificationMatrix,
        needs_input: {
          ...DEFAULT_SETTINGS.notifications.notificationMatrix.needs_input,
          autoFocus: needsInputAutoFocus,
        },
      },
    },
  };
}

function fakePanel(id: string) {
  const setActive = vi.fn();
  return {
    id,
    setActive,
    api: {
      setActive,
      close: vi.fn(),
      location: { type: "grid" as const },
      updateParameters: vi.fn(),
    },
  };
}

function makeApi(panels: ReturnType<typeof fakePanel>[]) {
  return {
    panels,
    getPanel: (id: string) => panels.find((panel) => panel.id === id),
    maximizeGroup: vi.fn(),
  };
}

beforeEach(() => {
  setViewMode.mockClear();
});

describe("useAutoFocusOnAttention", () => {
  it("records attention without focusing when the setting or the dock is not ready", () => {
    const seen = { current: new Set<number>() };
    const sessions = [makeSession({ id: 5, attention: true, sessionStatus: "needs_input" })];
    const { rerender } = renderHook(
      (p: UseAutoFocusOnAttentionParams) => useAutoFocusOnAttention(p),
      {
        initialProps: {
          sessions,
          settings: focusSettings(false, true),
          dockviewApi: {} as DockviewApi,
          layoutTier: "desktop",
          seenAttentionForFocusRef: seen,
        },
      },
    );
    expect([...seen.current]).toEqual([5]);
    expect(setViewMode).not.toHaveBeenCalled();

    const seenAgain = { current: new Set<number>() };
    rerender({
      sessions,
      settings: focusSettings(true, true),
      dockviewApi: null,
      layoutTier: "desktop",
      seenAttentionForFocusRef: seenAgain,
    });
    expect([...seenAgain.current]).toEqual([5]);
  });

  it("focuses a new attention panel on desktop when the status column allows it", () => {
    const working = makeSession({ id: 1, attention: true, sessionStatus: "working" });
    const waiting = makeSession({ id: 2, attention: true, sessionStatus: "needs_input" });
    const workingPanel = fakePanel("session-1");
    const waitingPanel = fakePanel("session-2");
    const api = makeApi([workingPanel, waitingPanel]);
    const seen = { current: new Set<number>() };
    const base = {
      settings: focusSettings(true, true),
      dockviewApi: api as unknown as DockviewApi,
      layoutTier: "desktop" as const,
      seenAttentionForFocusRef: seen,
    };
    const { rerender } = renderHook(
      (p: UseAutoFocusOnAttentionParams) => useAutoFocusOnAttention(p),
      { initialProps: { ...base, sessions: [working, waiting] } },
    );

    // "working" is not an auto-focus column; needs_input is.
    expect(workingPanel.setActive).not.toHaveBeenCalled();
    expect(waitingPanel.setActive).toHaveBeenCalledTimes(1);
    expect(api.maximizeGroup).not.toHaveBeenCalled();
    expect(setViewMode).not.toHaveBeenCalled();
    expect([...seen.current].sort()).toEqual([1, 2]);

    rerender({ ...base, sessions: [working, waiting] });
    expect(waitingPanel.setActive).toHaveBeenCalledTimes(1);
  });

  it("skips a transition whose panel is not open", () => {
    const seen = { current: new Set<number>() };
    const api = makeApi([]);
    renderHook(() =>
      useAutoFocusOnAttention({
        sessions: [makeSession({ id: 3, attention: true, sessionStatus: "needs_input" })],
        settings: focusSettings(true, true),
        dockviewApi: api as unknown as DockviewApi,
        layoutTier: "desktop",
        seenAttentionForFocusRef: seen,
      }),
    );
    expect([...seen.current]).toEqual([3]);
    expect(api.maximizeGroup).not.toHaveBeenCalled();
  });

  it("leaves the Tasks board and maximizes the pane on phone", () => {
    const panel = fakePanel("session-9");
    const api = makeApi([panel]);
    renderHook(() =>
      useAutoFocusOnAttention({
        sessions: [makeSession({ id: 9, attention: true, sessionStatus: "needs_input" })],
        settings: focusSettings(true, true),
        dockviewApi: api as unknown as DockviewApi,
        layoutTier: "phone",
        seenAttentionForFocusRef: { current: new Set() },
      }),
    );
    expect(setViewMode).toHaveBeenCalledWith("list");
    expect(panel.setActive).toHaveBeenCalledTimes(1);
    expect(api.maximizeGroup).toHaveBeenCalledWith(panel);
  });
});
