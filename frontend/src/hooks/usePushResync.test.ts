// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { AppSettings } from "../api/index.js";
import { DEFAULT_SETTINGS } from "../api/index.js";
import { usePushResync } from "./usePushResync.js";

const { ensurePushSubscribed } = vi.hoisted(() => ({
  ensurePushSubscribed: vi.fn(() => Promise.resolve()),
}));

vi.mock("../pushClient.js", () => ({ ensurePushSubscribed }));

function settings(push: boolean): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    notifications: {
      ...DEFAULT_SETTINGS.notifications,
      channels: { ...DEFAULT_SETTINGS.notifications.channels, push },
    },
  };
}

beforeEach(() => {
  ensurePushSubscribed.mockClear();
});

describe("usePushResync", () => {
  it("subscribes once when settings have loaded with push enabled", () => {
    const attempted = { current: false };
    const { rerender } = renderHook(
      (p: { loaded: boolean; push: boolean }) =>
        usePushResync({
          pushResyncAttemptedRef: attempted,
          settingsLoaded: p.loaded,
          settings: settings(p.push),
        }),
      { initialProps: { loaded: false, push: true } },
    );
    expect(ensurePushSubscribed).not.toHaveBeenCalled();
    expect(attempted.current).toBe(false);

    rerender({ loaded: true, push: false });
    expect(ensurePushSubscribed).not.toHaveBeenCalled();

    rerender({ loaded: true, push: true });
    expect(ensurePushSubscribed).toHaveBeenCalledTimes(1);
    expect(attempted.current).toBe(true);

    rerender({ loaded: true, push: true });
    expect(ensurePushSubscribed).toHaveBeenCalledTimes(1);
  });

  it("does not run when a previous attempt already claimed the page load", () => {
    renderHook(() =>
      usePushResync({
        pushResyncAttemptedRef: { current: true },
        settingsLoaded: true,
        settings: settings(true),
      }),
    );
    expect(ensurePushSubscribed).not.toHaveBeenCalled();
  });
});
