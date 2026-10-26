// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useProjectUploads } from "./useProjectUploads.js";
import { api, ApiError, RateLimitedError } from "../api/index.js";
import type * as ApiModule from "../api/index.js";

vi.mock("../api/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, api: { ...actual.api, uploadProjectFile: vi.fn() } };
});

const item = (name: string, size = 10) => ({
  file: new File([new Uint8Array(size)], name),
  relativePath: name,
});

// An upload the test settles by hand, so concurrency can be observed mid-flight.
function deferredUploads() {
  const pending: {
    path: string;
    resolve: () => void;
    reject: (e: unknown) => void;
    signal?: AbortSignal;
    onProgress?: (n: number) => void;
  }[] = [];
  vi.mocked(api.uploadProjectFile).mockImplementation(
    (_id, path, _file, opts) =>
      new Promise((resolve, reject) => {
        pending.push({
          path,
          resolve: () => resolve({ path, size: 1 }),
          reject,
          signal: opts?.signal,
          onProgress: opts?.onProgress as ((n: number) => void) | undefined,
        });
        opts?.signal?.addEventListener("abort", () =>
          reject(new DOMException("cancelled", "AbortError")),
        );
      }),
  );
  return pending;
}

// Braces matter: a returned function is run by vitest as a teardown.
beforeEach(() => {
  vi.mocked(api.uploadProjectFile).mockReset();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("useProjectUploads", () => {
  it("uploads every item under the target folder, then reports the folder", async () => {
    vi.mocked(api.uploadProjectFile).mockResolvedValue({ path: "x", size: 1 });
    const onUploaded = vi.fn();
    const { result } = renderHook(() =>
      useProjectUploads({ projectId: 4, sessionId: 9, onUploaded }),
    );
    await act(() => result.current.upload([item("a.txt"), item("sub/b.txt")], "src"));
    const calls = vi.mocked(api.uploadProjectFile).mock.calls;
    expect(calls.map((c) => c[1]).sort()).toEqual(["src/a.txt", "src/sub/b.txt"]);
    expect(calls.find((c) => c[1] === "src/a.txt")![3]).toMatchObject({
      sessionId: 9,
      mkdirs: false,
    });
    expect(calls.find((c) => c[1] === "src/sub/b.txt")![3]).toMatchObject({ mkdirs: true });
    expect(onUploaded).toHaveBeenCalledWith("src");
    expect(result.current.progress).toBeNull();
    expect(result.current.errors).toEqual([]);
  });

  it("targets the project root without a leading slash", async () => {
    vi.mocked(api.uploadProjectFile).mockResolvedValue({ path: "x", size: 1 });
    const { result } = renderHook(() => useProjectUploads({ projectId: 4 }));
    await act(() => result.current.upload([item("a.txt")], ""));
    expect(vi.mocked(api.uploadProjectFile).mock.calls[0]![1]).toBe("a.txt");
  });

  it("keeps at most three uploads in flight", async () => {
    const pending = deferredUploads();
    const { result } = renderHook(() => useProjectUploads({ projectId: 4 }));
    let done!: Promise<void>;
    act(() => {
      done = result.current.upload(
        ["a", "b", "c", "d", "e"].map((n) => item(n)),
        "",
      );
    });
    await waitFor(() => expect(pending).toHaveLength(3));
    expect(result.current.busy).toBe(true);
    expect(result.current.progress).toMatchObject({ files: 5, filesDone: 0 });
    await act(async () => pending[0]!.resolve());
    await waitFor(() => expect(pending).toHaveLength(4));
    for (const p of pending.slice(1)) await act(async () => p.resolve());
    await waitFor(() => expect(pending).toHaveLength(5));
    await act(async () => pending[4]!.resolve());
    await act(() => done);
    expect(result.current.busy).toBe(false);
  });

  it("tracks byte progress across files", async () => {
    const pending = deferredUploads();
    const { result } = renderHook(() => useProjectUploads({ projectId: 4 }));
    act(() => {
      void result.current.upload([item("a", 100), item("b", 100)], "");
    });
    await waitFor(() => expect(pending).toHaveLength(2));
    act(() => pending[0]!.onProgress?.(40));
    act(() => pending[1]!.onProgress?.(10));
    expect(result.current.progress).toMatchObject({ bytes: 200, bytesDone: 50 });
    for (const p of pending) await act(async () => p.resolve());
  });

  it("reports a refused name as 'already exists' and carries on with the rest", async () => {
    vi.mocked(api.uploadProjectFile).mockImplementation(async (_id, path) => {
      if (path === "a.txt") throw new ApiError("exists", 409, "conflict");
      if (path === "big.bin") throw new ApiError("too big", 413, "too_large");
      if (path === "odd.txt") throw new ApiError("Permission denied", 503);
      if (path === "net.txt") throw new Error("boom");
      return { path, size: 1 };
    });
    const { result } = renderHook(() => useProjectUploads({ projectId: 4 }));
    await act(() =>
      result.current.upload(
        ["a.txt", "big.bin", "odd.txt", "net.txt", "ok.txt"].map((n) => item(n)),
        "",
      ),
    );
    expect(result.current.errors.sort()).toEqual([
      "a.txt already exists",
      "big.bin is too large",
      "net.txt: upload failed",
      "odd.txt: Permission denied",
    ]);
    expect(vi.mocked(api.uploadProjectFile)).toHaveBeenCalledTimes(5);
    act(() => result.current.dismissErrors());
    expect(result.current.errors).toEqual([]);
  });

  it("cancel aborts in-flight uploads, starts no more, and reports no errors", async () => {
    const pending = deferredUploads();
    const onUploaded = vi.fn();
    const { result } = renderHook(() => useProjectUploads({ projectId: 4, onUploaded }));
    let done!: Promise<void>;
    act(() => {
      done = result.current.upload(
        ["a", "b", "c", "d", "e"].map((n) => item(n)),
        "",
      );
    });
    await waitFor(() => expect(pending).toHaveLength(3));
    act(() => result.current.cancel());
    await act(() => done);
    expect(pending).toHaveLength(3); // d and e never started
    expect(pending.every((p) => p.signal?.aborted)).toBe(true);
    expect(result.current.errors).toEqual([]);
    expect(result.current.busy).toBe(false);
    expect(onUploaded).toHaveBeenCalledTimes(1); // the folder is still re-listed
  });

  it("refuses a second batch while one is running", async () => {
    const pending = deferredUploads();
    const { result } = renderHook(() => useProjectUploads({ projectId: 4 }));
    act(() => {
      void result.current.upload([item("a")], "");
    });
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(() => result.current.upload([item("b")], ""));
    expect(pending).toHaveLength(1);
    expect(result.current.errors[0]).toMatch(/already running/);
    await act(async () => pending[0]!.resolve());
  });

  it("ignores an empty batch", async () => {
    const { result } = renderHook(() => useProjectUploads({ projectId: 4 }));
    await act(() => result.current.upload([], ""));
    expect(api.uploadProjectFile).not.toHaveBeenCalled();
    expect(result.current.busy).toBe(false);
  });

  it("aborts what is in flight when the host component unmounts", async () => {
    const pending = deferredUploads();
    const { result, unmount } = renderHook(() => useProjectUploads({ projectId: 4 }));
    act(() => {
      void result.current.upload([item("a")], "");
    });
    await waitFor(() => expect(pending).toHaveLength(1));
    unmount();
    expect(pending[0]!.signal?.aborted).toBe(true);
  });

  describe("an existing-name hint", () => {
    it("refuses a hinted name without sending its body, and uploads the rest", async () => {
      vi.mocked(api.uploadProjectFile).mockResolvedValue({ path: "x", size: 1 });
      const { result } = renderHook(() =>
        useProjectUploads({ projectId: 4, existsHint: (p) => p === "src/a.txt" }),
      );
      await act(() => result.current.upload([item("a.txt"), item("b.txt")], "src"));
      expect(api.uploadProjectFile).toHaveBeenCalledTimes(1);
      expect(vi.mocked(api.uploadProjectFile).mock.calls[0]![1]).toBe("src/b.txt");
      expect(result.current.errors).toEqual(["a.txt already exists"]);
      expect(result.current.progress).toBeNull();
    });
  });

  describe("rate limiting", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("waits out Retry-After and retries the same file", async () => {
      vi.mocked(api.uploadProjectFile)
        .mockRejectedValueOnce(new RateLimitedError(429, 2000))
        .mockResolvedValueOnce({ path: "x", size: 1 });
      const { result } = renderHook(() => useProjectUploads({ projectId: 4 }));
      let done!: Promise<void>;
      act(() => {
        done = result.current.upload([item("a.txt")], "");
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1999);
      });
      expect(api.uploadProjectFile).toHaveBeenCalledTimes(1); // still waiting
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2);
      });
      await act(() => done);
      expect(api.uploadProjectFile).toHaveBeenCalledTimes(2);
      expect(result.current.errors).toEqual([]);
    });

    it("gives up after a few attempts with an actionable message", async () => {
      vi.mocked(api.uploadProjectFile).mockRejectedValue(new RateLimitedError(429, 10));
      const { result } = renderHook(() => useProjectUploads({ projectId: 4 }));
      let done!: Promise<void>;
      act(() => {
        done = result.current.upload([item("a.txt")], "");
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      await act(() => done);
      expect(api.uploadProjectFile).toHaveBeenCalledTimes(6); // first try + 5 retries
      expect(result.current.errors).toEqual([
        "a.txt: the server is rate-limiting uploads — try again in a minute",
      ]);
    });

    it("never waits longer than a minute-ish, whatever Retry-After says", async () => {
      vi.mocked(api.uploadProjectFile)
        .mockRejectedValueOnce(new RateLimitedError(429, 3_600_000))
        .mockResolvedValueOnce({ path: "x", size: 1 });
      const { result } = renderHook(() => useProjectUploads({ projectId: 4 }));
      let done!: Promise<void>;
      act(() => {
        done = result.current.upload([item("a.txt")], "");
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(65_000);
      });
      await act(() => done);
      expect(api.uploadProjectFile).toHaveBeenCalledTimes(2);
    });

    it("cancel ends the wait and does not retry", async () => {
      vi.mocked(api.uploadProjectFile).mockRejectedValue(new RateLimitedError(429, 30_000));
      const { result } = renderHook(() => useProjectUploads({ projectId: 4 }));
      let done!: Promise<void>;
      act(() => {
        done = result.current.upload([item("a.txt")], "");
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      act(() => result.current.cancel());
      await act(() => done);
      expect(api.uploadProjectFile).toHaveBeenCalledTimes(1);
      expect(result.current.errors).toEqual([]);
    });
  });

  it("does not report a finished batch to a host that has unmounted", async () => {
    const pending = deferredUploads();
    const onUploaded = vi.fn();
    const { result, unmount } = renderHook(() => useProjectUploads({ projectId: 4, onUploaded }));
    act(() => {
      void result.current.upload([item("a")], "");
    });
    await waitFor(() => expect(pending).toHaveLength(1));
    unmount();
    await act(async () => pending[0]!.resolve());
    expect(onUploaded).not.toHaveBeenCalled();
  });
});
