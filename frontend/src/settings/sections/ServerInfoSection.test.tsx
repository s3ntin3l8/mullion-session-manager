// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  api,
  type DockerStorageStatus,
  type ServerInfo,
  type SystemStats,
} from "../../api/index.js";
import { ServerInfoSection } from "./ServerInfoSection.js";

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
};

function setup(overrides: { docker?: DockerStorageStatus } = {}) {
  vi.spyOn(api, "getServerInfo").mockResolvedValue(info);
  vi.spyOn(api, "getSystemStats").mockResolvedValue(stats);
  vi.spyOn(api, "getDockerStorage").mockResolvedValue(overrides.docker ?? docker);
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
    expect(screen.getByText("4.0 GiB")).toBeInTheDocument();
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
    vi.spyOn(api, "pruneDockerStorage").mockResolvedValue({ output: "done" });
    render(<ServerInfoSection />);
    const first = await screen.findByRole("button", { name: "Clean up Docker…" });
    await userEvent.click(first);
    expect(api.pruneDockerStorage).not.toHaveBeenCalled();
    await userEvent.click(first);
    await waitFor(() => expect(api.pruneDockerStorage).toHaveBeenCalledOnce());
    expect(await screen.findByText("Docker cleanup completed.")).toBeInTheDocument();
    await waitFor(() => expect(api.getDockerStorage).toHaveBeenCalledTimes(2));
  });

  it("disables cleanup and explains why when Docker is unavailable", async () => {
    setup({
      docker: {
        available: false,
        rows: [],
        totalSizeBytes: 0,
        reclaimableBytes: 0,
        error: "permission denied",
      },
    });
    render(<ServerInfoSection />);
    expect(
      await screen.findByText(/Docker cleanup unavailable: permission denied/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Clean up Docker/ })).not.toBeInTheDocument();
  });

  it("surfaces a cleanup failure", async () => {
    setup();
    vi.spyOn(api, "pruneDockerStorage").mockRejectedValue(new Error("failed"));
    render(<ServerInfoSection />);
    const button = await screen.findByRole("button", { name: "Clean up Docker…" });
    await userEvent.click(button);
    await userEvent.click(button);
    expect(await screen.findByText("Docker cleanup failed.")).toBeInTheDocument();
    await waitFor(() => expect(api.getDockerStorage).toHaveBeenCalledTimes(2));
  });
});
