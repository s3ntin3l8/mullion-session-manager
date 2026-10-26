// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { DockviewApi } from "dockview";
import { useBalanceOnDrop } from "./useBalanceOnDrop.js";

const balanceSiblingsOf = vi.fn();
vi.mock("../panelUtils.js", () => ({
  balanceSiblingsOf: (...args: unknown[]) => balanceSiblingsOf(...args),
  isTiledGroup: (g: { api: { location: { type: string } } }) => g.api.location.type === "grid",
}));

type Handler = (e: { kind: string; origin: string }) => void;

function setup(initial: string[]) {
  let tiled = initial;
  let will: Handler = () => {};
  let did: Handler = () => {};
  const dispose = vi.fn();
  const api = {
    get groups() {
      return tiled.map((id) => ({ id, api: { location: { type: "grid" } } }));
    },
    onWillMutateLayout: (h: Handler) => ((will = h), { dispose }),
    onDidMutateLayout: (h: Handler) => ((did = h), { dispose }),
  } as unknown as DockviewApi;
  const mutate = (kind: string, origin: string, after: string[]) => {
    will({ kind, origin });
    tiled = after;
    did({ kind, origin });
  };
  return { api, mutate, dispose };
}

beforeEach(() => balanceSiblingsOf.mockClear());

describe("useBalanceOnDrop", () => {
  it("balances around the one newly tiled group after a user move", () => {
    const { api, mutate } = setup(["a", "b"]);
    renderHook(() => useBalanceOnDrop({ dockviewApi: api, enabled: true }));
    mutate("move", "user", ["a", "b", "c"]);
    expect(balanceSiblingsOf).toHaveBeenCalledWith(api, "c");
  });

  it("does nothing for a tab-strip drop, an api move, or another kind", () => {
    const { api, mutate } = setup(["a", "b"]);
    renderHook(() => useBalanceOnDrop({ dockviewApi: api, enabled: true }));
    mutate("move", "user", ["a", "b"]);
    mutate("move", "api", ["a", "b", "c"]);
    mutate("add", "user", ["a", "b", "c", "d"]);
    expect(balanceSiblingsOf).not.toHaveBeenCalled();
  });

  it("does nothing when more than one group appeared", () => {
    const { api, mutate } = setup(["a"]);
    renderHook(() => useBalanceOnDrop({ dockviewApi: api, enabled: true }));
    mutate("move", "user", ["a", "b", "c"]);
    expect(balanceSiblingsOf).not.toHaveBeenCalled();
  });

  it("does not subscribe when disabled or without an api, and disposes on unmount", () => {
    const { api, mutate, dispose } = setup(["a"]);
    const off = renderHook(() => useBalanceOnDrop({ dockviewApi: api, enabled: false }));
    mutate("move", "user", ["a", "b"]);
    expect(balanceSiblingsOf).not.toHaveBeenCalled();
    off.unmount();
    renderHook(() => useBalanceOnDrop({ dockviewApi: null, enabled: true }));
    const on = renderHook(() => useBalanceOnDrop({ dockviewApi: api, enabled: true }));
    on.unmount();
    expect(dispose).toHaveBeenCalledTimes(2);
  });
});
