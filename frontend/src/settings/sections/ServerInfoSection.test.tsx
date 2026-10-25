// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  // Audit finding 13 — `info === null` used to mean both "still loading"
  // and "the request failed", so a failed fetch rendered "Loading…"
  // forever and the user was never told anything was wrong.
  it("shows a skeleton instead of the word Loading… while the server status is still in flight", () => {
    setup();
    vi.spyOn(api, "getServerInfo").mockReturnValue(new Promise(() => {}));
    const { container } = render(<ServerInfoSection />);
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    const bones = container.querySelectorAll(".ui-skeleton");
    expect(bones.length).toBeGreaterThan(0);
    for (const bone of bones) {
      expect(bone).toHaveAttribute("aria-hidden", "true");
    }
    expect(container.querySelector("[aria-busy='true']")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveClass("visually-hidden");
  });

  it("shows an error instead of the loading state when the server status can't be loaded", async () => {
    setup();
    vi.spyOn(api, "getServerInfo").mockRejectedValue(new Error("boom"));
    render(<ServerInfoSection />);
    expect(await screen.findByText(/Could not load the server status/)).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    expect(document.querySelector(".ui-skeleton")).not.toBeInTheDocument();
  });

  it("retries the failed server status and shows the data once the retry succeeds", async () => {
    setup();
    const getServerInfo = vi
      .spyOn(api, "getServerInfo")
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(info);
    render(<ServerInfoSection />);
    expect(await screen.findByText(/Could not load the server status/)).toBeInTheDocument();

    const callsBeforeRetry = getServerInfo.mock.calls.length;
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("1.2.3")).toBeInTheDocument();
    expect(screen.queryByText(/Could not load the server status/)).not.toBeInTheDocument();
    // The click re-fetched. (Not an exact count: the section's own LogLevel
    // setting mounts once the status loads and asks for the server info a
    // second time on its own.)
    expect(getServerInfo.mock.calls.length).toBeGreaterThan(callsBeforeRetry);
  });

  it("shows the rest of the page when the CPU and RAM figures can't be loaded", async () => {
    setup();
    vi.spyOn(api, "getSystemStats").mockRejectedValue(new Error("boom"));
    render(<ServerInfoSection />);
    expect(await screen.findByText("1.2.3")).toBeInTheDocument();
    expect(screen.queryByText("CPU")).not.toBeInTheDocument();
    // The failed probe says so instead of leaving the CPU and RAM cards
    // silently missing.
    expect(screen.getByText(/Could not load the CPU and RAM figures/)).toBeInTheDocument();
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
