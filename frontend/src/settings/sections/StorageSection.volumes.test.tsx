// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api, type DockerStorageStatus } from "../../api/index.js";
import { StorageSection } from "./StorageSection.js";
import { useDashboardStore } from "../../store/index.js";
import { DEFAULT_SETTINGS } from "../../api/settings.js";

const GIB = 1024 ** 3;

const docker: DockerStorageStatus = {
  available: true,
  rows: [],
  totalSizeBytes: 10 * GIB,
  reclaimableBytes: 4 * GIB,
  estimates: { safeBytes: 2 * GIB, aggressiveBytes: 3 * GIB },
  volumes: {
    anonymousUnused: { count: 3, bytes: GIB },
    named: { count: 1, bytes: GIB },
    inUse: { count: 0, bytes: 0 },
  },
};

function ready<T>(data: T) {
  return { state: "ready" as const, measuredAt: new Date().toISOString(), durationMs: 1, ...data };
}

function setup(optIns: string[] = []) {
  useDashboardStore.setState({
    settings: { ...DEFAULT_SETTINGS, diskCleanup: { cacheDirs: [], optIns } },
    settingsLoaded: true,
  });
  const empty = ready({ available: false });
  vi.spyOn(api, "getCacheStorage").mockResolvedValue(empty as never);
  vi.spyOn(api, "getOpencodeStorage").mockResolvedValue(empty as never);
  vi.spyOn(api, "getDevWorktrees").mockResolvedValue(empty as never);
  vi.spyOn(api, "getSpaceReport").mockResolvedValue(empty as never);
  vi.spyOn(api, "getTempStorage").mockResolvedValue(empty as never);
  vi.spyOn(api, "getCleanupStatus").mockResolvedValue({ state: "idle" });
  vi.spyOn(api, "getOrphanRemoval").mockResolvedValue({ job: { state: "idle" }, recoveries: [] });
  vi.spyOn(api, "getSystemStats").mockResolvedValue({
    sampledAt: "2026-09-13T12:00:00.000Z",
    cpu: { logicalCores: 8, loadAverage1m: 1 },
    memory: { totalBytes: GIB, freeBytes: GIB },
    filesystems: [],
  });
  vi.spyOn(api, "getDockerStorage").mockResolvedValue(ready(docker) as never);
  return vi
    .spyOn(api, "startCleanup")
    .mockResolvedValue({ state: "running", mode: "aggressive", steps: [] } as never);
}

afterEach(() => vi.restoreAllMocks());

describe("StorageSection anonymous volumes opt-in", () => {
  it("persists the id into diskCleanup.optIns and back out", async () => {
    setup();
    const update = vi.spyOn(useDashboardStore.getState(), "updateSettings");
    useDashboardStore.setState({ updateSettings: update });
    render(<StorageSection />);
    const toggle = await screen.findByLabelText("Also remove unused anonymous volumes");
    expect(screen.getByText(/Named volumes are never removed/)).toBeTruthy();
    fireEvent.click(toggle);
    expect(update).toHaveBeenLastCalledWith({
      diskCleanup: { cacheDirs: [], optIns: ["docker-volumes"] },
    });
  });

  it("sends the saved opt-ins with an aggressive cleanup", async () => {
    const start = setup(["docker-volumes"]);
    render(<StorageSection />);
    await screen.findByLabelText("Also remove unused anonymous volumes");
    fireEvent.click(screen.getByText("Aggressive cleanup…"));
    fireEvent.click(await screen.findByText("Confirm aggressive cleanup"));
    await waitFor(() => expect(start).toHaveBeenCalledWith("aggressive", [], ["docker-volumes"]));
  });
});
