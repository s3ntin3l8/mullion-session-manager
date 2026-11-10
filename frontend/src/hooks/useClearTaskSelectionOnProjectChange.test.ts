// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useDashboardStore } from "../store/index.js";
import { useClearTaskSelectionOnProjectChange } from "./useClearTaskSelectionOnProjectChange.js";

beforeEach(() => useDashboardStore.setState({ selectedTaskId: null, taskSelectionSeq: 0 }));

const selected = () => useDashboardStore.getState().selectedTaskId;

describe("useClearTaskSelectionOnProjectChange", () => {
  it("keeps a selection that was there when the sidebar mounted", () => {
    useDashboardStore.setState({ selectedTaskId: 2 });
    renderHook(({ p }) => useClearTaskSelectionOnProjectChange(p), { initialProps: { p: 4 } });
    expect(selected()).toBe(2);
  });

  it("clears a selection that predates a project change", () => {
    const { rerender } = renderHook(({ p }) => useClearTaskSelectionOnProjectChange(p), {
      initialProps: { p: 4 },
    });
    act(() => useDashboardStore.getState().selectTask(2));
    expect(selected()).toBe(2);
    rerender({ p: 9 });
    expect(selected()).toBeNull();
  });

  it("keeps a selection that arrives together with the project change", () => {
    const { rerender } = renderHook(({ p }) => useClearTaskSelectionOnProjectChange(p), {
      initialProps: { p: 4 },
    });
    act(() => {
      useDashboardStore.getState().openRightSidebarTask(42);
      rerender({ p: 9 });
    });
    expect(selected()).toBe(42);
  });

  it("keeps the same task selected again together with the project change", () => {
    const { rerender } = renderHook(({ p }) => useClearTaskSelectionOnProjectChange(p), {
      initialProps: { p: 4 },
    });
    act(() => useDashboardStore.getState().selectTask(7));
    act(() => {
      useDashboardStore.getState().openRightSidebarTask(7);
      rerender({ p: 9 });
    });
    expect(selected()).toBe(7);
  });

  it("does not treat the first project resolving as a change", () => {
    const { rerender } = renderHook(
      ({ p }: { p: number | null }) => useClearTaskSelectionOnProjectChange(p),
      { initialProps: { p: null as number | null } },
    );
    act(() => useDashboardStore.getState().selectTask(3));
    rerender({ p: 4 });
    expect(selected()).toBe(3);
    // A later change from a real project does clear it.
    rerender({ p: 9 });
    expect(selected()).toBeNull();
  });

  it("leaves an empty selection alone and ignores re-renders on the same project", () => {
    const { rerender } = renderHook(({ p }) => useClearTaskSelectionOnProjectChange(p), {
      initialProps: { p: 4 as number | null },
    });
    rerender({ p: null });
    expect(selected()).toBeNull();
    act(() => useDashboardStore.getState().selectTask(5));
    rerender({ p: null });
    expect(selected()).toBe(5);
  });
});
