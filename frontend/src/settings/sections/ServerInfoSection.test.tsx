// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  api,
  type DockerStorageStatus,
  type ServerInfo,
  type SystemStats,
  type OpencodeStorageStatus,
  type TempStorageStatus,
  type CacheStorageStatus,
} from "../../api/index.js";
import { ServerInfoSection } from "./ServerInfoSection.js";
import { useDashboardStore } from "../../store/index.js";
import { DEFAULT_SETTINGS } from "../../api/settings.js";

const GIB = 1024 ** 3;
const info = {
  version: "1.2.3",
  role: "primary",
  nodeEnv: "production",
  port: 3000,
  encryptionEnabled: true,
  sessionsDir: "/data/sessions",
  dbPath: "/data/app.db",
  uptimeSeconds: 3600,
  rateLimit: { max: 300, window: "1 minute" },
  projectsRoots: "/projects",
  crsConfigDir: "/config",
  previewsEnabled: false,
  previewBaseHost: "",
  previewAuthRequired: false,
  taskMasterEnabled: false,
  taskMasterEnv: {},
  running: { browserMaxInstances: 4, deviceDiscoveryEnabled: true },
  features: { browser: true, devices: false, deviceDiscovery: false },
} as ServerInfo;

const stats: SystemStats = {
  sampledAt: "2026-09-13T12:00:00.000Z",
  cpu: { logicalCores: 8, loadAverage1m: 2.5 },
  memory: { totalBytes: 64 * GIB, freeBytes: 16 * GIB },
  filesystems: [
    {
      labels: ["Home", "Working directory"],
      paths: ["/home", "/work"],
      available: true,
      totalBytes: 100 * GIB,
      freeBytes: 12 * GIB,
      freePercent: 12,
      severity: "warning",
    },
  ],
};

const docker: DockerStorageStatus = {
  available: true,
  rows: [],
  totalSizeBytes: 10 * GIB,
  reclaimableBytes: 4 * GIB,
  estimates: { safeBytes: 2 * GIB, aggressiveBytes: 3 * GIB },
};

const tempUnavailable: TempStorageStatus = {
  available: false,
  root: "/tmp",
  estimates: { safeBytes: 0, aggressiveBytes: 0 },
  candidates: { safe: 0, aggressive: 0 },
  claudeScratch: { warnings: [] },
};

const noOpencode: OpencodeStorageStatus = {
  available: false,
  path: "/home/me/.local/share/opencode/opencode.db",
  fileBytes: 0,
  reclaimableBytes: 0,
  liveBytes: 0,
  inUse: false,
  holdersUnknown: false,
  compacting: false,
};

const noCaches: CacheStorageStatus = { available: true, root: "/home/me/.cache", caches: [] };

function setup(
  overrides: {
    docker?: DockerStorageStatus;
    temp?: TempStorageStatus;
    caches?: CacheStorageStatus;
    opencode?: OpencodeStorageStatus;
  } = {},
) {
  useDashboardStore.setState({ settings: DEFAULT_SETTINGS, settingsLoaded: true });
  vi.spyOn(api, "getCacheStorage").mockResolvedValue(overrides.caches ?? noCaches);
  vi.spyOn(api, "getOpencodeStorage").mockResolvedValue(overrides.opencode ?? noOpencode);
  vi.spyOn(api, "getServerInfo").mockResolvedValue(info);
  vi.spyOn(api, "getSystemStats").mockResolvedValue(stats);
  vi.spyOn(api, "getDockerStorage").mockResolvedValue(overrides.docker ?? docker);
  vi.spyOn(api, "getTempStorage").mockResolvedValue(overrides.temp ?? tempUnavailable);
  vi.spyOn(api, "checkForUpdate").mockReturnValue(new Promise(() => {}));
}

describe("Settings -> Server info resources", () => {
  afterEach(() => vi.restoreAllMocks());

  it("formats CPU, RAM, deduplicated filesystem, and Docker usage", async () => {
    setup();
    render(<ServerInfoSection />);
    expect(await screen.findByText("2.50 1m load / 8 logical cores")).toBeInTheDocument();
    expect(screen.getByText("16 GiB free / 64 GiB")).toBeInTheDocument();
    expect(screen.getByText("Home, Working directory")).toBeInTheDocument();
    expect(screen.getByText("12 GiB free / 100 GiB (12.0%)")).toBeInTheDocument();
    expect(screen.getByText("10 GiB")).toBeInTheDocument();
    expect(screen.getByText("2.0 GiB")).toBeInTheDocument();
    expect(screen.getByText("3.0 GiB")).toBeInTheDocument();
  });

  it("shows which host features are on and offers the log level setting", async () => {
    setup();
    render(<ServerInfoSection />);
    const browserKey = await screen.findByText("Browser pane");
    expect(browserKey.nextElementSibling).toHaveTextContent("On");
    expect(screen.getByText("Android devices").nextElementSibling).toHaveTextContent("Off");
    expect(screen.getByText("Log level")).toBeInTheDocument();
    expect(screen.queryByText(/\/health/)).toBeNull();
  });

  it("requires two clicks, prunes once, and refreshes figures after success", async () => {
    setup();
    vi.spyOn(api, "pruneDockerStorage").mockResolvedValue({
      output: "done",
      reclaimedBytes: GIB,
    });
    render(<ServerInfoSection />);
    const first = await screen.findByRole("button", { name: "Clean up (safe)…" });
    await userEvent.click(first);
    expect(api.pruneDockerStorage).not.toHaveBeenCalled();
    await userEvent.click(first);
    await waitFor(() => expect(api.pruneDockerStorage).toHaveBeenCalledOnce());
    expect(api.pruneDockerStorage).toHaveBeenCalledWith("safe");
    expect(await screen.findByText("Freed 1.0 GiB.")).toBeInTheDocument();
    await waitFor(() => expect(api.getDockerStorage).toHaveBeenCalledTimes(2));
  });

  it("runs the aggressive tier with its own mode", async () => {
    setup();
    vi.spyOn(api, "pruneDockerStorage").mockResolvedValue({
      output: "done",
      reclaimedBytes: 3 * GIB,
      error: "step failed",
    });
    render(<ServerInfoSection />);
    const button = await screen.findByRole("button", { name: "Aggressive cleanup…" });
    await userEvent.click(button);
    await userEvent.click(button);
    await waitFor(() => expect(api.pruneDockerStorage).toHaveBeenCalledWith("aggressive"));
    expect(await screen.findByText("Freed 3.0 GiB, then stopped: step failed")).toBeInTheDocument();
  });

  it("disables cleanup and explains why when Docker is unavailable", async () => {
    setup({
      docker: {
        available: false,
        rows: [],
        totalSizeBytes: 0,
        reclaimableBytes: 0,
        estimates: { safeBytes: null, aggressiveBytes: 0 },
        error: "permission denied",
      },
    });
    render(<ServerInfoSection />);
    expect(
      await screen.findByText(/Docker cleanup unavailable: permission denied/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Clean up/ })).not.toBeInTheDocument();
  });

  it("surfaces a cleanup failure", async () => {
    setup();
    vi.spyOn(api, "pruneDockerStorage").mockRejectedValue(new Error("failed"));
    render(<ServerInfoSection />);
    const button = await screen.findByRole("button", { name: "Clean up (safe)…" });
    await userEvent.click(button);
    await userEvent.click(button);
    expect(await screen.findByText("Docker cleanup failed.")).toBeInTheDocument();
    await waitFor(() => expect(api.getDockerStorage).toHaveBeenCalledTimes(2));
  });

  it("labels the armed safe button without moving or arming the aggressive one", async () => {
    setup();
    render(<ServerInfoSection />);
    const safe = await screen.findByRole("button", { name: "Clean up (safe)…" });
    await userEvent.click(safe);
    expect(screen.getByRole("button", { name: /Confirm safe cleanup/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Aggressive cleanup…" })).not.toHaveClass("armed");
  });

  it("prunes Docker and temp files together and reports both", async () => {
    setup({
      temp: {
        available: true,
        root: "/tmp",
        estimates: { safeBytes: GIB / 2, aggressiveBytes: GIB },
        candidates: { safe: 1, aggressive: 2 },
        claudeScratch: { warnings: [] },
      },
    });
    vi.spyOn(api, "pruneDockerStorage").mockResolvedValue({ output: "", reclaimedBytes: GIB });
    vi.spyOn(api, "pruneTempStorage").mockResolvedValue({ output: "", reclaimedBytes: GIB / 2 });
    render(<ServerInfoSection />);
    const button = await screen.findByRole("button", { name: "Clean up (safe)…" });
    await userEvent.click(button);
    await userEvent.click(button);
    expect(
      await screen.findByText("Freed 1.5 GiB (Docker 1.0 GiB, temp files 512 MiB)."),
    ).toBeInTheDocument();
    expect(api.pruneTempStorage).toHaveBeenCalledWith("safe");
  });

  it("offers temp cleanup when Docker is unavailable", async () => {
    setup({
      docker: { ...docker, available: false, error: "no docker" },
      temp: {
        available: true,
        root: "/tmp",
        estimates: { safeBytes: 0, aggressiveBytes: 0 },
        candidates: { safe: 0, aggressive: 0 },
        claudeScratch: { warnings: [] },
      },
    });
    vi.spyOn(api, "pruneTempStorage").mockResolvedValue({
      output: "",
      reclaimedBytes: 2,
      error: "boom",
    });
    render(<ServerInfoSection />);
    const button = await screen.findByRole("button", { name: "Clean up (safe)…" });
    await userEvent.click(button);
    await userEvent.click(button);
    expect(await screen.findByText("Freed 2 B, then stopped: boom")).toBeInTheDocument();
  });

  it("says when Claude scratch is left alone, and which registry files were skipped", async () => {
    setup({
      temp: {
        available: true,
        root: "/tmp",
        estimates: { safeBytes: 0, aggressiveBytes: 0 },
        candidates: { safe: 0, aggressive: 0 },
        claudeScratch: {
          skipped: "/home/me/.claude/sessions/x.json is unparseable and its process may be running",
          warnings: [
            "/home/me/.claude/sessions/9.json is unparseable; skipped (its process is gone)",
          ],
        },
      },
    });
    render(<ServerInfoSection />);
    expect(await screen.findByText(/is being left alone:/)).toHaveTextContent(
      "x.json is unparseable and its process may be running",
    );
    expect(screen.getByText(/9\.json is unparseable; skipped/)).toBeInTheDocument();
  });

  describe("opencode database compaction (#1604)", () => {
    const opencode: OpencodeStorageStatus = {
      available: true,
      path: "/home/me/.local/share/opencode/opencode.db",
      fileBytes: 17 * GIB,
      reclaimableBytes: 15 * GIB,
      liveBytes: 2 * GIB,
      inUse: false,
      holdersUnknown: false,
      compacting: false,
    };

    it("shows the file size and what compacting returns, and nothing when opencode is absent", async () => {
      setup({ opencode });
      const { unmount } = render(<ServerInfoSection />);
      expect(await screen.findByText("17 GiB")).toBeInTheDocument();
      expect(screen.getByText("15 GiB")).toBeInTheDocument();
      expect(screen.getByText(/skipped whenever opencode is running/)).toBeInTheDocument();
      unmount();
      vi.restoreAllMocks();
      setup();
      render(<ServerInfoSection />);
      await screen.findByText("Disk cleanup");
      expect(screen.queryByText("opencode database")).not.toBeInTheDocument();
    });

    it("compacts only in aggressive mode and reports it", async () => {
      setup({ opencode });
      vi.spyOn(api, "pruneDockerStorage").mockResolvedValue({ output: "", reclaimedBytes: 0 });
      vi.spyOn(api, "pruneTempStorage").mockResolvedValue({ output: "", reclaimedBytes: 0 });
      vi.spyOn(api, "pruneOpencodeStorage").mockResolvedValue({
        output: "Compacted opencode.db.",
        reclaimedBytes: 15 * GIB,
      });
      render(<ServerInfoSection />);
      const safe = await screen.findByRole("button", { name: "Clean up (safe)…" });
      await userEvent.click(safe);
      await userEvent.click(safe);
      await screen.findByText(/Freed/);
      expect(api.pruneOpencodeStorage).not.toHaveBeenCalled();
      const aggressive = await screen.findByRole("button", { name: "Aggressive cleanup…" });
      await userEvent.click(aggressive);
      await userEvent.click(aggressive);
      expect(await screen.findByText(/opencode database 15 GiB/)).toBeInTheDocument();
      expect(api.pruneOpencodeStorage).toHaveBeenCalledTimes(1);
    });

    it("doesn't try when it can't tell whether opencode is running, and says why", async () => {
      setup({
        opencode: {
          ...opencode,
          holdersUnknown: true,
          holdersUnknownReason: "cannot list /proc/1234/fd (EACCES)",
        },
      });
      vi.spyOn(api, "pruneDockerStorage").mockResolvedValue({ output: "", reclaimedBytes: 0 });
      vi.spyOn(api, "pruneOpencodeStorage").mockResolvedValue({ output: "", reclaimedBytes: 0 });
      render(<ServerInfoSection />);
      expect(
        await screen.findByText(/couldn't tell whether opencode is running/),
      ).toHaveTextContent("(cannot list /proc/1234/fd (EACCES))");
      const aggressive = await screen.findByRole("button", { name: "Aggressive cleanup…" });
      await userEvent.click(aggressive);
      await userEvent.click(aggressive);
      await screen.findByText(/Freed/);
      expect(api.pruneOpencodeStorage).not.toHaveBeenCalled();
    });

    it("shows a compaction in progress and doesn't start another", async () => {
      setup({ opencode: { ...opencode, compacting: true } });
      vi.spyOn(api, "pruneDockerStorage").mockResolvedValue({ output: "", reclaimedBytes: 0 });
      vi.spyOn(api, "pruneOpencodeStorage").mockResolvedValue({ output: "", reclaimedBytes: 0 });
      render(<ServerInfoSection />);
      expect(await screen.findByText(/being compacted right now/)).toBeInTheDocument();
      const aggressive = await screen.findByRole("button", { name: "Aggressive cleanup…" });
      await userEvent.click(aggressive);
      await userEvent.click(aggressive);
      await screen.findByText(/Freed/);
      expect(api.pruneOpencodeStorage).not.toHaveBeenCalled();
    });

    it("tells you a dropped connection doesn't mean the compaction failed", async () => {
      setup({ opencode });
      vi.spyOn(api, "pruneDockerStorage").mockResolvedValue({ output: "", reclaimedBytes: 0 });
      vi.spyOn(api, "pruneOpencodeStorage").mockRejectedValue(new Error("network"));
      render(<ServerInfoSection />);
      const aggressive = await screen.findByRole("button", { name: "Aggressive cleanup…" });
      await userEvent.click(aggressive);
      await userEvent.click(aggressive);
      expect(await screen.findByText(/it may still be running/)).toBeInTheDocument();
    });

    it("doesn't try while opencode is running, and says why", async () => {
      setup({ opencode: { ...opencode, inUse: true } });
      vi.spyOn(api, "pruneDockerStorage").mockResolvedValue({ output: "", reclaimedBytes: 0 });
      vi.spyOn(api, "pruneOpencodeStorage").mockResolvedValue({ output: "", reclaimedBytes: 0 });
      render(<ServerInfoSection />);
      expect(await screen.findByText(/opencode is running right now/)).toBeInTheDocument();
      const aggressive = await screen.findByRole("button", { name: "Aggressive cleanup…" });
      await userEvent.click(aggressive);
      await userEvent.click(aggressive);
      await screen.findByText(/Freed/);
      expect(api.pruneOpencodeStorage).not.toHaveBeenCalled();
    });
  });

  describe("opt-in ~/.cache cleanup (#1606)", () => {
    const caches: CacheStorageStatus = {
      available: true,
      root: "/home/me/.cache",
      caches: [
        { id: "ms-playwright", label: "Playwright browsers", bytes: 2 * GIB, exists: true },
        { id: "pip", label: "pip", bytes: GIB, exists: true },
        { id: "go-build", label: "Go build cache", bytes: 0, exists: false },
      ],
    };

    it("lists existing caches, hides missing ones, and saves the opted-in ids", async () => {
      setup({ caches });
      render(<ServerInfoSection />);
      const toggle = await screen.findByRole("button", {
        name: "Clean Playwright browsers in aggressive cleanup",
      });
      expect(screen.queryByText("Go build cache")).not.toBeInTheDocument();
      await userEvent.click(toggle);
      expect(useDashboardStore.getState().settings.diskCleanup.cacheDirs).toEqual([
        "ms-playwright",
      ]);
    });

    it("prunes caches only in aggressive mode and only when something is ticked", async () => {
      setup({ caches });
      useDashboardStore.setState({
        settings: { ...DEFAULT_SETTINGS, diskCleanup: { cacheDirs: ["pip"] } },
      });
      vi.spyOn(api, "pruneDockerStorage").mockResolvedValue({ output: "", reclaimedBytes: GIB });
      vi.spyOn(api, "pruneCacheStorage").mockResolvedValue({ output: "", reclaimedBytes: GIB });
      render(<ServerInfoSection />);

      const safe = await screen.findByRole("button", { name: "Clean up (safe)…" });
      await userEvent.click(safe);
      await userEvent.click(safe);
      await screen.findByText("Freed 1.0 GiB.");
      expect(api.pruneCacheStorage).not.toHaveBeenCalled();

      const aggressive = await screen.findByRole("button", { name: "Aggressive cleanup…" });
      await userEvent.click(aggressive);
      await userEvent.click(aggressive);
      expect(
        await screen.findByText("Freed 2.0 GiB (Docker 1.0 GiB, caches 1.0 GiB)."),
      ).toBeInTheDocument();
      expect(api.pruneCacheStorage).toHaveBeenCalledOnce();
      expect(api.pruneCacheStorage).toHaveBeenCalledWith(["pip"]);
    });

    it("keeps an opted-in cache that vanished from disk listed so the stale opt-in can be cleared", async () => {
      setup({ caches });
      useDashboardStore.setState({
        settings: { ...DEFAULT_SETTINGS, diskCleanup: { cacheDirs: ["go-build"] } },
      });
      render(<ServerInfoSection />);
      const toggle = await screen.findByRole("button", {
        name: "Clean Go build cache in aggressive cleanup",
      });
      expect(screen.getByText("not found")).toBeInTheDocument();
      await userEvent.click(toggle);
      expect(useDashboardStore.getState().settings.diskCleanup.cacheDirs).toEqual([]);
    });

    it("does not call the caches prune when nothing is ticked", async () => {
      setup({ caches });
      vi.spyOn(api, "pruneDockerStorage").mockResolvedValue({ output: "", reclaimedBytes: GIB });
      vi.spyOn(api, "pruneCacheStorage");
      render(<ServerInfoSection />);
      const aggressive = await screen.findByRole("button", { name: "Aggressive cleanup…" });
      await userEvent.click(aggressive);
      await userEvent.click(aggressive);
      await screen.findByText("Freed 1.0 GiB.");
      expect(api.pruneCacheStorage).not.toHaveBeenCalled();
    });
  });
});
