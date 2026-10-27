// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectsSection } from "./ProjectsSection.js";
import { useDashboardStore } from "../../store/index.js";
import { api, DEFAULT_SETTINGS } from "../../api/index.js";
import type * as ApiModule from "../../api/index.js";
import { makeHost } from "../../test/fixtures.js";

// Issue #2090 — the opt-in "auto-detect checkouts on other hosts" setting and
// its "Detect now" button, in Settings -> Projects & discovery.

vi.mock("../../api/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getServerInfo: vi.fn(),
      detectHostCheckouts: vi.fn(),
      discoverProjects: vi.fn(),
    },
  };
});

describe("ProjectsSection: auto-detect checkouts", () => {
  const updateSettings = vi.fn();
  const refreshProjects = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    updateSettings.mockReset();
    refreshProjects.mockClear();
    vi.mocked(api.getServerInfo).mockRejectedValue(new Error("no server info in this test"));
    vi.mocked(api.detectHostCheckouts).mockReset();
    useDashboardStore.setState({
      settings: { ...DEFAULT_SETTINGS },
      projects: [],
      hosts: [
        makeHost({ id: "local", name: "Local", isLocal: true }),
        makeHost({ id: "mac-1", name: "macbook" }),
      ],
      updateSettings,
      refreshProjects,
    });
  });

  it("shows the setting off by default and turns it on with one click", async () => {
    const user = userEvent.setup();
    render(<ProjectsSection />);

    const toggle = screen.getByRole("button", {
      name: "Auto-detect checkouts on other hosts",
      pressed: false,
    });
    await user.click(toggle);

    expect(updateSettings).toHaveBeenCalledWith({ autoDetectHostCheckouts: true });
  });

  it("reflects the stored setting", () => {
    useDashboardStore.setState({
      settings: { ...DEFAULT_SETTINGS, autoDetectHostCheckouts: true },
    });
    render(<ProjectsSection />);

    expect(
      screen.getByRole("button", { name: "Auto-detect checkouts on other hosts", pressed: true }),
    ).toBeInTheDocument();
  });

  it("Detect asks every host and reports how many mappings were added, then reloads the projects", async () => {
    vi.mocked(api.detectHostCheckouts).mockImplementation(async (id) => ({
      enabled: true,
      added: id === "mac-1" ? [{ projectId: 1, hostId: "mac-1", cwd: "/Users/x/app" }] : [],
    }));
    const user = userEvent.setup();
    render(<ProjectsSection />);

    await user.click(screen.getByRole("button", { name: "Detect" }));

    await waitFor(() => expect(screen.getByText("1 mapping added")).toBeInTheDocument());
    expect(
      vi
        .mocked(api.detectHostCheckouts)
        .mock.calls.map((c) => c[0])
        .sort(),
    ).toEqual(["local", "mac-1"]);
    expect(refreshProjects).toHaveBeenCalled();
  });

  it("says so when nothing new was found, without reloading", async () => {
    vi.mocked(api.detectHostCheckouts).mockResolvedValue({ enabled: true, added: [] });
    const user = userEvent.setup();
    render(<ProjectsSection />);

    await user.click(screen.getByRole("button", { name: "Detect" }));

    await waitFor(() => expect(screen.getByText("Nothing new found")).toBeInTheDocument());
    expect(refreshProjects).not.toHaveBeenCalled();
  });

  it("tells the user to turn the setting on when the server says it is off", async () => {
    vi.mocked(api.detectHostCheckouts).mockResolvedValue({ enabled: false, added: [] });
    const user = userEvent.setup();
    render(<ProjectsSection />);

    await user.click(screen.getByRole("button", { name: "Detect" }));

    await waitFor(() => expect(screen.getByText("Turn on auto-detect first")).toBeInTheDocument());
  });

  it("does not let an unreachable host read as 'nothing to find there'", async () => {
    vi.mocked(api.detectHostCheckouts).mockImplementation(async (id) => {
      if (id === "mac-1") throw new Error("offline");
      return { enabled: true, added: [] };
    });
    const user = userEvent.setup();
    render(<ProjectsSection />);

    await user.click(screen.getByRole("button", { name: "Detect" }));

    await waitFor(() =>
      expect(screen.getByText("Nothing new found (1 host unreachable)")).toBeInTheDocument(),
    );
  });

  it("reports when no host answered", async () => {
    vi.mocked(api.detectHostCheckouts).mockRejectedValue(new Error("offline"));
    const user = userEvent.setup();
    render(<ProjectsSection />);

    await user.click(screen.getByRole("button", { name: "Detect" }));

    await waitFor(() => expect(screen.getByText("No host answered")).toBeInTheDocument());
  });
});
