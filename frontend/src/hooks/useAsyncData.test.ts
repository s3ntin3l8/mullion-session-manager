// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useAsyncData } from "./useAsyncData.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useAsyncData", () => {
  it("calls onSuccess with the resolved value", async () => {
    const onSuccess = vi.fn();
    const onError = vi.fn();
    renderHook(() => useAsyncData(() => Promise.resolve("hello"), onSuccess, onError, []));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith("hello"));
    expect(onError).not.toHaveBeenCalled();
  });

  it("calls onError with the rejection reason", async () => {
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const err = new Error("boom");
    renderHook(() => useAsyncData(() => Promise.reject(err), onSuccess, onError, []));

    await waitFor(() => expect(onError).toHaveBeenCalledWith(err));
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("does not call the fetcher at all when enabled: false", async () => {
    const fetcher = vi.fn(() => Promise.resolve("x"));
    const onSuccess = vi.fn();
    renderHook(() =>
      useAsyncData(fetcher, onSuccess, vi.fn(), [], {
        enabled: false,
      }),
    );

    await new Promise((r) => setTimeout(r, 0));
    expect(fetcher).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("calls onStart synchronously, before the fetcher resolves", async () => {
    const order: string[] = [];
    const onSuccess = vi.fn(() => order.push("success"));
    renderHook(() =>
      useAsyncData(() => Promise.resolve("x"), onSuccess, vi.fn(), [], {
        onStart: () => order.push("start"),
      }),
    );

    expect(order).toEqual(["start"]);
    await waitFor(() => expect(order).toEqual(["start", "success"]));
  });

  it("does not apply a stale response after `deps` change before it resolves", async () => {
    // Two in-flight requests race; the first (from the torn-down effect
    // instance) resolves AFTER the second — its result must never land.
    let resolveFirst!: (v: string) => void;
    let resolveSecond!: (v: string) => void;
    const first = new Promise<string>((r) => (resolveFirst = r));
    const second = new Promise<string>((r) => (resolveSecond = r));
    const onSuccess = vi.fn();

    const { rerender } = renderHook(
      ({ dep }: { dep: number }) =>
        useAsyncData(() => (dep === 1 ? first : second), onSuccess, vi.fn(), [dep]),
      { initialProps: { dep: 1 } },
    );

    rerender({ dep: 2 });
    resolveSecond("second-value");
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith("second-value"));

    resolveFirst("first-value");
    await new Promise((r) => setTimeout(r, 0));
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalledWith("first-value");
  });

  it("does not call onSuccess/onError after unmount", async () => {
    let resolve!: (v: string) => void;
    const pending = new Promise<string>((r) => (resolve = r));
    const onSuccess = vi.fn();
    const onError = vi.fn();

    const { unmount } = renderHook(() => useAsyncData(() => pending, onSuccess, onError, []));
    unmount();
    resolve("too-late");
    await new Promise((r) => setTimeout(r, 0));

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not re-run the effect when only the fetcher/callbacks' identity changes", async () => {
    const fetcher = vi.fn(() => Promise.resolve("x"));
    const { rerender } = renderHook(
      ({ n }: { n: number }) => useAsyncData(fetcher, vi.fn(), vi.fn(), [], { onStart: () => n }),
      { initialProps: { n: 1 } },
    );
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    rerender({ n: 2 });
    await new Promise((r) => setTimeout(r, 0));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
