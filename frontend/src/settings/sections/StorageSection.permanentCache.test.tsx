// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { api, type CacheStorageStatus } from "../../api/index.js";
import { StorageSection } from "./StorageSection.js";
import { useDashboardStore } from "../../store/index.js";
import { DEFAULT_SETTINGS } from "../../api/settings.js";

// Kept apart from StorageSection.test.tsx, which is at its size ceiling.
const GIB = 1024 ** 3;
const ready = <T extends object>(value: T) => ({
  ...value,
  state: "ready" as const,
  measuredAt: new Date().toISOString(),
});

function setup(caches: CacheStorageStatus) {
  useDashboardStore.setState({ settings: DEFAULT_SETTINGS, settingsLoaded: true });
  vi.spyOn(api, "getCacheStorage").mockResolvedValue(ready(caches));
  vi.spyOn(api, "getOpencodeStorage").mockResolvedValue(
    ready({
      available: false,
      path: "/x/opencode.db",
      fileBytes: 0,
      reclaimableBytes: 0,
      liveBytes: 0,
      inUse: false,
      holdersUnknown: false,
      compacting: false,
    }),
  );
  vi.spyOn(api, "getDevWorktrees").mockResolvedValue(
    ready({ available: true, candidates: [], totalBytes: 0 }),
  );
  vi.spyOn(api, "getSpaceReport").mockResolvedValue(
    ready({
      available: true,
      root: "/home/me",
      entries: [],
      scannedBytes: 0,
      filesystemUsedBytes: 0,
      outsideBytes: 0,
      unreadableEntries: 0,
    }),
  );
  vi.spyOn(api, "getCleanupStatus").mockResolvedValue({ state: "idle" });
  vi.spyOn(api, "getOrphanRemoval").mockResolvedValue({ job: { state: "idle" }, recoveries: [] });
  vi.spyOn(api, "getSystemStats").mockResolvedValue({
    sampledAt: "2026-09-13T12:00:00.000Z",
    cpu: { logicalCores: 8, loadAverage1m: 1 },
    memory: { totalBytes: 64 * GIB, freeBytes: 16 * GIB },
    filesystems: [],
  });
  vi.spyOn(api, "getDockerStorage").mockResolvedValue(
    ready({
      available: true,
      rows: [],
      totalSizeBytes: 0,
      reclaimableBytes: 0,
      estimates: { safeBytes: 0, aggressiveBytes: 0 },
    }),
  );
  vi.spyOn(api, "getTempStorage").mockResolvedValue(
    ready({
      available: false,
      root: "/tmp",
      estimates: { safeBytes: 0, aggressiveBytes: 0, npmCacheBytes: 0 },
      candidates: { safe: 0, aggressive: 0 },
      claudeScratch: { warnings: [] },
    }),
  );
}

const pip = { id: "pip", label: "pip", bytes: GIB, exists: true };
const trash = {
  id: "trash",
  label: "Trash (emptied permanently)",
  bytes: GIB,
  exists: true,
  permanent: true,
};

describe("Settings -> Storage: permanent caches", () => {
  afterEach(() => vi.restoreAllMocks());

  it("says Trash can't be restored, instead of calling every cache re-downloadable", async () => {
    setup({ available: true, root: "/home/me/.cache", caches: [pip, trash] });
    render(<StorageSection />);
    expect(await screen.findByText(/Trash is the exception/)).toBeInTheDocument();
    expect(screen.getByText(/emptied for good, with no way to get it back/)).toBeInTheDocument();
  });

  it("doesn't mention an exception when every listed cache is rebuildable", async () => {
    setup({ available: true, root: "/home/me/.cache", caches: [pip] });
    render(<StorageSection />);
    await screen.findByRole("button", { name: "Clean pip in aggressive cleanup" });
    expect(screen.queryByText(/exception/)).not.toBeInTheDocument();
  });
});
