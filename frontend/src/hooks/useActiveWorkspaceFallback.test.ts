// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { makeWorkspace } from "../test/fixtures.js";
import { useActiveWorkspaceFallback } from "./useActiveWorkspaceFallback.js";

const setActiveWorkspaceId = vi.fn();

function storeState() {
  return { setActiveWorkspaceId };
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
  setActiveWorkspaceId.mockClear();
});

describe("useActiveWorkspaceFallback", () => {
  it("does nothing while the list is empty or the active id is still in it", () => {
    const first = makeWorkspace({ id: 3 });
    const second = makeWorkspace({ id: 4 });
    const { rerender } = renderHook(
      (p: { ids: number[]; active: number | null }) =>
        useActiveWorkspaceFallback({
          workspaces: p.ids.map((id) => makeWorkspace({ id })),
          activeWorkspaceId: p.active,
        }),
      { initialProps: { ids: [] as number[], active: 3 } },
    );
    expect(setActiveWorkspaceId).not.toHaveBeenCalled();

    rerender({ ids: [first.id, second.id], active: first.id });
    expect(setActiveWorkspaceId).not.toHaveBeenCalled();
  });

  it("selects the first workspace when the active id is missing", () => {
    const { rerender } = renderHook(
      (p: { active: number | null }) =>
        useActiveWorkspaceFallback({
          workspaces: [makeWorkspace({ id: 3 }), makeWorkspace({ id: 4 })],
          activeWorkspaceId: p.active,
        }),
      { initialProps: { active: 9 as number | null } },
    );
    expect(setActiveWorkspaceId).toHaveBeenCalledWith(3);

    setActiveWorkspaceId.mockClear();
    rerender({ active: null });
    expect(setActiveWorkspaceId).toHaveBeenCalledWith(3);
  });
});
