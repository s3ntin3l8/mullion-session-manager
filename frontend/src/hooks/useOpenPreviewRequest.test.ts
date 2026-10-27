// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { DockviewApi } from "dockview-react";
import { useDashboardStore } from "../store/index.js";
import { useOpenPreviewRequest } from "./useOpenPreviewRequest.js";

const request = () =>
  act(() =>
    useDashboardStore.getState().requestOpenPreview({ projectId: 1, slug: "s", branch: "b" }),
  );

describe("useOpenPreviewRequest (#2016)", () => {
  afterEach(() => {
    useDashboardStore.setState({ openPreviewRequest: null });
    vi.useRealTimers();
  });

  it("waits for the workspace's first restore, then opens once and clears the request", () => {
    vi.useFakeTimers();
    const onOpenPreview = vi.fn();
    const restoredWorkspaceIdRef = { current: null as number | null };
    const { rerender } = renderHook(
      ({ api }: { api: DockviewApi | null }) =>
        useOpenPreviewRequest({
          dockviewApi: api,
          activeWorkspaceId: 1,
          onOpenPreview,
          restoringRef: { current: false },
          restoredWorkspaceIdRef,
        }),
      { initialProps: { api: null as DockviewApi | null } },
    );
    request();
    rerender({ api: {} as DockviewApi });
    act(() => vi.advanceTimersByTime(10));
    // Not restored yet: a restore's clear() would wipe the pane.
    expect(onOpenPreview).not.toHaveBeenCalled();
    restoredWorkspaceIdRef.current = 1;
    rerender({ api: {} as DockviewApi });
    act(() => vi.advanceTimersByTime(10));
    expect(onOpenPreview).toHaveBeenCalledTimes(1);
    expect(onOpenPreview).toHaveBeenCalledWith(1, "s", "b");
    expect(useDashboardStore.getState().openPreviewRequest).toBeNull();
  });

  it("retries a request that lands mid-restore without another re-render", () => {
    vi.useFakeTimers();
    const onOpenPreview = vi.fn();
    const restoringRef = { current: true };
    renderHook(() =>
      useOpenPreviewRequest({
        dockviewApi: {} as DockviewApi,
        activeWorkspaceId: 1,
        onOpenPreview,
        restoringRef,
        restoredWorkspaceIdRef: { current: 1 },
      }),
    );
    request();
    act(() => vi.advanceTimersByTime(5));
    expect(onOpenPreview).not.toHaveBeenCalled();
    restoringRef.current = false;
    // The pending retry re-renders, and that render's effect schedules the open.
    act(() => vi.advanceTimersByTime(5));
    act(() => vi.advanceTimersByTime(5));
    expect(onOpenPreview).toHaveBeenCalledTimes(1);
    // A later request (nonce restarts at 1) is not mistaken for the resolved one.
    request();
    act(() => vi.advanceTimersByTime(5));
    expect(onOpenPreview).toHaveBeenCalledTimes(2);
  });
});
