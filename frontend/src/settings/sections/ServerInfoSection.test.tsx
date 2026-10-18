// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { api, type ServerInfo, type SystemStats } from "../../api/index.js";
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
  filesystems: [],
};

function setup() {
  vi.spyOn(api, "getServerInfo").mockResolvedValue(info);
  vi.spyOn(api, "getSystemStats").mockResolvedValue(stats);
  vi.spyOn(api, "checkForUpdate").mockReturnValue(new Promise(() => {}));
}

describe("Settings -> Server", () => {
  afterEach(() => vi.restoreAllMocks());

  it("formats CPU and RAM", async () => {
    setup();
    render(<ServerInfoSection />);
    expect(await screen.findByText("2.50 1m load / 8 logical cores")).toBeInTheDocument();
    expect(screen.getByText("16 GiB free / 64 GiB")).toBeInTheDocument();
  });

  it("shows the rest of the page when the CPU and RAM figures can't be loaded", async () => {
    setup();
    vi.spyOn(api, "getSystemStats").mockRejectedValue(new Error("boom"));
    render(<ServerInfoSection />);
    expect(await screen.findByText("1.2.3")).toBeInTheDocument();
    expect(screen.queryByText("CPU")).not.toBeInTheDocument();
  });

  it("no longer carries the storage and cleanup controls", async () => {
    setup();
    render(<ServerInfoSection />);
    await screen.findByText("1.2.3");
    expect(screen.queryByText("Disk cleanup")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Clean up/ })).not.toBeInTheDocument();
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
});
