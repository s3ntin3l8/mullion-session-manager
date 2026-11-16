// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useBusyAction } from "./useBusyAction.js";

const deferred = () => {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("useBusyAction", () => {
  it("is busy from the call until the request settles, and ignores a second call meanwhile", async () => {
    const d = deferred();
    const fn = vi.fn(() => d.promise);
    const { result } = renderHook(() => useBusyAction(fn));
    expect(result.current.busy).toBe(false);

    act(() => result.current.run());
    expect(result.current.busy).toBe(true);
    act(() => result.current.run());
    expect(fn).toHaveBeenCalledTimes(1);

    await act(async () => d.resolve());
    expect(result.current.busy).toBe(false);

    act(() => result.current.run());
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("clears the busy state when the request rejects or throws synchronously", async () => {
    const d = deferred();
    const fn = vi
      .fn()
      .mockReturnValueOnce(d.promise)
      .mockImplementationOnce(() => {
        throw new Error("boom");
      });
    const { result } = renderHook(() => useBusyAction(fn));

    act(() => result.current.run());
    await act(async () => d.reject(new Error("nope")));
    expect(result.current.busy).toBe(false);

    await act(async () => result.current.run());
    expect(result.current.busy).toBe(false);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not set state after unmount", async () => {
    const d = deferred();
    const { result, unmount } = renderHook(() => useBusyAction(() => d.promise));
    act(() => result.current.run());
    unmount();
    await act(async () => d.resolve());
  });
});
