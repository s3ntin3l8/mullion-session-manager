// @vitest-environment jsdom
// "Open in simulator" rows of the Dock's Preview menu (#3429).
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "./api/index.js";
import type { Device } from "./api/index.js";
import { ProjectPreviewMenu } from "./ProjectPreviewMenu.js";
import { useDashboardStore } from "./store/index.js";
import { makeProject, makeSession } from "./test/fixtures.js";
import { resetStore } from "./test/resetStore.js";
import { jsonResponse } from "./test/jsonResponse.js";
import { mockFetch } from "./test/mockFetch.js";

function sim(over: Partial<Device>): Device {
  return {
    id: 7,
    hostId: "local",
    projectId: null,
    name: "iPhone 16",
    platform: "ios",
    kind: "emulator",
    avdName: null,
    serial: null,
    udid: "UDID-1",
    status: "active",
    createdAt: "2026-01-01",
    live: { id: "7" } as unknown as Device["live"],
    ...over,
  };
}

function destinations(hostId: string) {
  return {
    destinations: [
      {
        key: "dev-server",
        group: "saved" as const,
        kind: "dev-server" as const,
        label: "Dev server",
        detail: "3005",
        address: "http://localhost:3005/",
        hostId,
        previewSlug: null,
        targetId: null,
      },
    ],
    runningNote: null,
  };
}

async function openMenu(devices: Device[], stubApi = true, devServerHost = "local") {
  vi.spyOn(api, "getBrowserDestinations").mockResolvedValue(destinations(devServerHost));
  if (stubApi) vi.spyOn(api, "openUrlOnDevice").mockResolvedValue({ ok: true });
  resetStore({
    projects: [makeProject({ id: 1, hostId: "local", devServerUrl: "3005" })],
    devices,
  });
  vi.spyOn(api, "getProjectPreviewTargets").mockResolvedValue({
    devServerUrl: "3005",
    targets: [],
  });
  const user = userEvent.setup();
  render(<ProjectPreviewMenu projectId={1} onOpenDefault={vi.fn()} onManage={vi.fn()} />);
  await waitFor(() => expect(useDashboardStore.getState().projectPreviewConfigs[1]).toBeTruthy());
  if (devices.some((d) => d.platform === "ios" && d.status === "active" && d.live)) {
    await waitFor(() => expect(api.getBrowserDestinations).toHaveBeenCalled());
  }
  await user.click(screen.getByRole("button", { name: "Preview" }));
  return user;
}

describe("Preview menu: Open in simulator", () => {
  afterEach(() => vi.restoreAllMocks());

  it("opens the dev server's loopback URL in a same-host running simulator", async () => {
    const user = await openMenu([sim({})]);
    await user.click(screen.getByRole("menuitem", { name: "Open in simulator — iPhone 16" }));
    expect(api.openUrlOnDevice).toHaveBeenCalledWith(7, "http://127.0.0.1:3005/");
  });

  it("lists a simulator on another host disabled and never calls the API", async () => {
    const user = await openMenu([sim({ hostId: "mac-1" })]);
    const item = screen.getByRole("menuitem", {
      name: "Open in simulator — iPhone 16 (on another host)",
    });
    expect(item).toHaveAttribute("aria-disabled", "true");
    await user.click(item);
    expect(api.openUrlOnDevice).not.toHaveBeenCalled();
  });

  it("follows the dev server's own host, not the project's", async () => {
    // The project is on "local" but its dock control runs on mac-1.
    const user = await openMenu(
      [sim({ hostId: "mac-1" }), sim({ id: 8, name: "Local sim" })],
      true,
      "mac-1",
    );
    expect(screen.getByRole("menuitem", { name: /Local sim .*another host/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.click(screen.getByRole("menuitem", { name: "Open in simulator — iPhone 16" }));
    expect(api.openUrlOnDevice).toHaveBeenCalledWith(7, "http://127.0.0.1:3005/");
  });

  it("offers nothing for Android devices, stopped simulators or none at all", async () => {
    await openMenu([
      sim({ id: 1, platform: "android" }),
      sim({ id: 2, status: "killed" }),
      sim({ id: 3, live: null }),
    ]);
    expect(screen.queryByRole("menuitem", { name: /Open in simulator/ })).toBeNull();
  });

  it("re-resolves the dev server's host when a Dock session starts", async () => {
    await openMenu([sim({})]);
    expect(api.getBrowserDestinations).toHaveBeenCalledTimes(1);
    useDashboardStore.setState({
      sessions: [makeSession({ id: 91, projectId: 1, kind: "dock", status: "active" })],
    });
    await waitFor(() => expect(api.getBrowserDestinations).toHaveBeenCalledTimes(2));
  });

  it("reports a failed open instead of swallowing it", async () => {
    // The real api client over a failing endpoint (a rejecting vi.fn is
    // flagged as an unhandled rejection by the runner before the component's
    // catch sees it).
    const { fetchMock } = mockFetch({
      "POST /api/devices/7/action": () => jsonResponse(500, { message: "simctl failed" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const reportError = vi.fn(() => 1);
    const user = await openMenu([sim({})], false);
    useDashboardStore.setState({ reportError });
    await user.click(screen.getByRole("menuitem", { name: "Open in simulator — iPhone 16" }));
    await waitFor(() =>
      expect(reportError).toHaveBeenCalledWith("Could not open in simulator", "simctl failed"),
    );
    vi.unstubAllGlobals();
  });
});
