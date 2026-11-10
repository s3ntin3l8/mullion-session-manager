// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { DockviewApi } from "dockview-react";
import { useActivePanelTracking } from "./useActivePanelTracking.js";

const setActivePanelId = vi.fn();

function storeState() {
  return { setActivePanelId };
}

vi.mock("../store/index.js", () => {
  const useDashboardStore = (selector?: (s: unknown) => unknown) => {
    const state = storeState();
    return selector ? selector(state) : state;
  };
  useDashboardStore.getState = storeState;
  return { useDashboardStore };
});

beforeEach(() => {
  setActivePanelId.mockClear();
});

describe("useActivePanelTracking", () => {
  it("does nothing until dockview exists", () => {
    renderHook(() => useActivePanelTracking({ dockviewApi: null, panelsVersion: 0 }));
    expect(setActivePanelId).not.toHaveBeenCalled();
  });

  it("records the active panel, follows changes, and disposes the subscription", () => {
    const disposers: ReturnType<typeof vi.fn>[] = [];
    let onChange: (event: { panel?: { id?: string } }) => void = () => {};
    const api = {
      activePanel: { id: "session-1" } as { id?: string } | undefined,
      onDidActivePanelChange: (cb: typeof onChange) => {
        onChange = cb;
        const dispose = vi.fn();
        disposers.push(dispose);
        return { dispose };
      },
    };
    const { rerender, unmount } = renderHook(
      (p: { version: number; activeId: string | null }) => {
        api.activePanel = p.activeId == null ? undefined : { id: p.activeId };
        return useActivePanelTracking({
          dockviewApi: api as unknown as DockviewApi,
          panelsVersion: p.version,
        });
      },
      { initialProps: { version: 0, activeId: "session-1" as string | null } },
    );
    expect(setActivePanelId).toHaveBeenCalledWith("session-1");

    onChange({ panel: { id: "session-2" } });
    expect(setActivePanelId).toHaveBeenLastCalledWith("session-2");
    onChange({ panel: {} });
    expect(setActivePanelId).toHaveBeenLastCalledWith(null);
    onChange({});
    expect(setActivePanelId).toHaveBeenLastCalledWith(null);

    rerender({ version: 1, activeId: null });
    expect(disposers[0]).toHaveBeenCalledTimes(1);
    expect(setActivePanelId).toHaveBeenLastCalledWith(null);

    unmount();
    expect(disposers[1]).toHaveBeenCalledTimes(1);
  });
});
