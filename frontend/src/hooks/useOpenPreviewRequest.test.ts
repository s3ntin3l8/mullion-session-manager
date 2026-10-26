// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { DockviewApi } from "dockview-react";
import { useDashboardStore } from "../store/index.js";
import { useOpenPreviewRequest } from "./useOpenPreviewRequest.js";

describe("useOpenPreviewRequest (#2016)", () => {
  afterEach(() => useDashboardStore.setState({ openPreviewRequest: null }));

  it("opens a requested preview once the dock is ready, then clears the request", () => {
    const onOpenPreview = vi.fn();
    const restoringRef = { current: true };
    const dockviewApi = {} as DockviewApi;
    const { rerender } = renderHook(
      ({ api }: { api: DockviewApi | null }) =>
        useOpenPreviewRequest({ dockviewApi: api, restoringRef, onOpenPreview }),
      { initialProps: { api: null as DockviewApi | null } },
    );
    act(() =>
      useDashboardStore.getState().requestOpenPreview({ projectId: 1, slug: "s", branch: "b" }),
    );
    expect(onOpenPreview).not.toHaveBeenCalled();
    // Still restoring a workspace: wait.
    rerender({ api: dockviewApi });
    expect(onOpenPreview).not.toHaveBeenCalled();
    restoringRef.current = false;
    act(() =>
      useDashboardStore.getState().requestOpenPreview({ projectId: 1, slug: "s", branch: "b" }),
    );
    expect(onOpenPreview).toHaveBeenCalledWith(1, "s", "b");
    expect(useDashboardStore.getState().openPreviewRequest).toBeNull();
  });
});
