// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { api, type DockerStorageStatus } from "../../api/index.js";
import { StorageSection } from "./StorageSection.js";
import { useDashboardStore } from "../../store/index.js";
import { DEFAULT_SETTINGS } from "../../api/settings.js";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

const docker: DockerStorageStatus = {
  available: true,
  rows: [],
  totalSizeBytes: 10 * GIB,
  reclaimableBytes: 4 * GIB,
  estimates: { safeBytes: 2 * GIB, aggressiveBytes: 3 * GIB },
};

function ready<T>(data: T) {
  return { state: "ready" as const, measuredAt: new Date().toISOString(), durationMs: 1, ...data };
}

function setup(status: DockerStorageStatus) {
  useDashboardStore.setState({ settings: DEFAULT_SETTINGS, settingsLoaded: true });
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
  vi.spyOn(api, "getDockerStorage").mockResolvedValue(ready(status) as never);
}

afterEach(() => vi.restoreAllMocks());

describe("StorageSection Docker volumes line", () => {
  it("shows unused anonymous and named volumes", async () => {
    setup({
      ...docker,
      volumes: {
        anonymousUnused: { count: 115, bytes: 100 * MIB },
        named: { count: 10, bytes: 2 * GIB },
        inUse: { count: 1, bytes: MIB },
      },
    });
    render(<StorageSection />);
    const line = await screen.findByTestId("docker-volumes");
    expect(line.textContent).toBe(
      "Volumes: 115 unused anonymous (100 MiB) · 10 named (2.0 GiB), never removed by cleanup",
    );
  });

  it("says unknown when the volumes could not be read", async () => {
    setup(docker);
    render(<StorageSection />);
    const line = await screen.findByTestId("docker-volumes");
    expect(line.textContent).toMatch(/^Volumes: unknown/);
  });
});
