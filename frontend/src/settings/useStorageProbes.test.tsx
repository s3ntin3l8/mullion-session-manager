// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { api } from "../api/index.js";
import type { DockerStorageStatus } from "../api/index.js";
import { useStorageProbes } from "./useStorageProbes.js";

const GIB = 1024 ** 3;
const dockerWith = (safeBytes: number) =>
  ({
    available: true,
    rows: [],
    totalSizeBytes: 0,
    reclaimableBytes: 0,
    estimates: { safeBytes, aggressiveBytes: safeBytes },
    state: "ready",
    measuredAt: new Date().toISOString(),
  }) as DockerStorageStatus & { state: "ready"; measuredAt: string };

describe("useStorageProbes", () => {
  afterEach(() => vi.restoreAllMocks());

  it("lets only the newest request set a probe, whatever order answers arrive in", async () => {
    const ready = (extra: object) => ({ ...extra, state: "ready", measuredAt: "2026-01-01" });
    vi.spyOn(api, "getSystemStats").mockResolvedValue({
      sampledAt: "",
      cpu: { logicalCores: 1, loadAverage1m: 0 },
      memory: { totalBytes: 1, freeBytes: 1 },
      filesystems: [],
    });
    vi.spyOn(api, "getTempStorage").mockResolvedValue(ready({ available: false }) as never);
    vi.spyOn(api, "getCacheStorage").mockResolvedValue(ready({ available: false }) as never);
    vi.spyOn(api, "getOpencodeStorage").mockResolvedValue(ready({ available: false }) as never);
    vi.spyOn(api, "getDevWorktrees").mockResolvedValue(ready({ available: false }) as never);
    const answers: Array<(value: ReturnType<typeof dockerWith>) => void> = [];
    vi.spyOn(api, "getDockerStorage").mockImplementation(
      () => new Promise((resolve) => answers.push(resolve)),
    );

    const { result } = renderHook(() => useStorageProbes());
    await waitFor(() => expect(answers).toHaveLength(1)); // the mount load
    act(() => void result.current.refresh());
    await waitFor(() => expect(answers).toHaveLength(2)); // the later Refresh

    // The newer request answers first; the older, slower one must not undo it.
    await act(async () => answers[1]!(dockerWith(7 * GIB)));
    await act(async () => answers[0]!(dockerWith(GIB)));
    const docker = result.current.docker as DockerStorageStatus | null;
    expect(docker?.estimates.safeBytes).toBe(7 * GIB);
  });
});
