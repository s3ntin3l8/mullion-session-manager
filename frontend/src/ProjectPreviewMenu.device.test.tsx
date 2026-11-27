// @vitest-environment jsdom
// "Open … on <device>" rows of the Dock's Preview menu: iOS Simulators
// (#3429, #3491) and Android emulators/phones (#3559).
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "./api/index.js";
import type { Device, NamedPreviewTarget, Preview, ServerInfo } from "./api/index.js";
import { ProjectPreviewMenu } from "./ProjectPreviewMenu.js";
import { isOpenableDevice } from "./lib/deviceUrl.js";
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

function android(over: Partial<Device>): Device {
  return sim({
    id: 9,
    name: "Pixel 10",
    platform: "android",
    avdName: "pixel_10",
    serial: "emulator-5554",
    udid: null,
    live: { id: "9", status: "streaming" } as unknown as Device["live"],
    ...over,
  });
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

const PREVIEWS_OFF = { previewsEnabled: false, previewBaseHost: "", previewAuthRequired: false };
const PREVIEWS_ON = {
  previewsEnabled: true,
  previewBaseHost: "mullion.example.com",
  previewAuthRequired: false,
};

const STAGING: NamedPreviewTarget = {
  id: "t1",
  name: "Staging",
  destination: "https://staging.example",
  connectionOrigin: "project",
};

async function openMenu(
  devices: Device[],
  stubApi = true,
  devServerHost = "local",
  previews: Partial<ServerInfo> = PREVIEWS_OFF,
  targets: NamedPreviewTarget[] = [],
) {
  vi.spyOn(api, "getBrowserDestinations").mockResolvedValue(destinations(devServerHost));
  vi.spyOn(api, "getServerInfo").mockResolvedValue(previews as ServerInfo);
  if (stubApi) vi.spyOn(api, "openUrlOnDevice").mockResolvedValue({ ok: true });
  resetStore({
    projects: [makeProject({ id: 1, hostId: "local", devServerUrl: "3005" })],
    devices,
  });
  vi.spyOn(api, "getProjectPreviewTargets").mockResolvedValue({
    devServerUrl: "3005",
    targets,
  });
  const user = userEvent.setup();
  render(<ProjectPreviewMenu projectId={1} onOpenDefault={vi.fn()} onManage={vi.fn()} />);
  await waitFor(() => expect(useDashboardStore.getState().projectPreviewConfigs[1]).toBeTruthy());
  if (devices.some(isOpenableDevice)) {
    await waitFor(() => expect(api.getBrowserDestinations).toHaveBeenCalled());
    await waitFor(() => expect(api.getServerInfo).toHaveBeenCalled());
  }
  await user.click(screen.getByRole("button", { name: "Preview" }));
  return user;
}

describe("Preview menu: open on a device", () => {
  afterEach(() => vi.restoreAllMocks());

  it("opens the dev server's loopback URL in a same-host running simulator", async () => {
    const user = await openMenu([sim({})]);
    await user.click(screen.getByRole("menuitem", { name: "Open dev server on iPhone 16" }));
    expect(api.openUrlOnDevice).toHaveBeenCalledWith(7, "http://127.0.0.1:3005/");
  });

  it("lists a simulator on another host disabled, with the reason, when previews are off", async () => {
    const user = await openMenu([sim({ hostId: "mac-1" })]);
    const item = await screen.findByRole("menuitem", {
      name: "Open dev server on iPhone 16 (on another host)",
    });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item.getAttribute("title")).toMatch(/Previews are not enabled/);
    await user.click(item);
    expect(api.openUrlOnDevice).not.toHaveBeenCalled();
  });

  it("opens the dev server's preview URL in a simulator on another host", async () => {
    vi.spyOn(api, "createProjectPreview").mockResolvedValue({ slug: "abc" } as Preview);
    vi.spyOn(api, "mintPreviewToken");
    const user = await openMenu([sim({ hostId: "mac-1" })], true, "local", PREVIEWS_ON);
    await user.click(
      await screen.findByRole("menuitem", { name: "Open dev server on iPhone 16 (via preview)" }),
    );
    await waitFor(() =>
      expect(api.openUrlOnDevice).toHaveBeenCalledWith(
        7,
        `${window.location.protocol}//preview-abc.mullion.example.com/`,
      ),
    );
    expect(api.createProjectPreview).toHaveBeenCalledWith(1);
    // Preview auth off: no token is minted or appended.
    expect(api.mintPreviewToken).not.toHaveBeenCalled();
  });

  it("appends a freshly minted bootstrap token when preview auth is required", async () => {
    vi.spyOn(api, "createProjectPreview").mockResolvedValue({ slug: "abc" } as Preview);
    vi.spyOn(api, "mintPreviewToken").mockResolvedValue({ token: "t/k+n" });
    const user = await openMenu([sim({ hostId: "mac-1" })], true, "local", {
      ...PREVIEWS_ON,
      previewAuthRequired: true,
    });
    await user.click(
      await screen.findByRole("menuitem", { name: "Open dev server on iPhone 16 (via preview)" }),
    );
    await waitFor(() =>
      expect(api.openUrlOnDevice).toHaveBeenCalledWith(
        7,
        `${window.location.protocol}//preview-abc.mullion.example.com/?__mullion_preview=t%2Fk%2Bn`,
      ),
    );
    expect(api.mintPreviewToken).toHaveBeenCalledWith("abc");
  });

  it("opens a named preview target through its preview, even on the dev server's host", async () => {
    vi.spyOn(api, "createTargetPreview").mockResolvedValue({ slug: "tgt" } as Preview);
    const user = await openMenu([sim({})], true, "local", PREVIEWS_ON, [
      {
        id: "t1",
        name: "Staging",
        destination: "https://staging.example",
        connectionOrigin: "project",
      },
    ]);
    await user.click(await screen.findByRole("menuitem", { name: "Open Staging on iPhone 16" }));
    await waitFor(() =>
      expect(api.openUrlOnDevice).toHaveBeenCalledWith(
        7,
        `${window.location.protocol}//preview-tgt.mullion.example.com/`,
      ),
    );
    expect(api.createTargetPreview).toHaveBeenCalledWith(1, "t1");
  });

  it("lists a named target disabled, with the reason, when previews are off", async () => {
    vi.spyOn(api, "createTargetPreview");
    const user = await openMenu([sim({})], true, "local", PREVIEWS_OFF, [
      {
        id: "t1",
        name: "Staging",
        destination: "https://staging.example",
        connectionOrigin: "project",
      },
    ]);
    const item = await screen.findByRole("menuitem", {
      name: "Open Staging on iPhone 16 (unavailable)",
    });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item.getAttribute("title")).toMatch(/Previews are not enabled/);
    await user.click(item);
    expect(api.createTargetPreview).not.toHaveBeenCalled();
    expect(api.openUrlOnDevice).not.toHaveBeenCalled();
  });

  it("follows the dev server's own host, not the project's", async () => {
    // The project is on "local" but its dock control runs on mac-1.
    vi.spyOn(api, "createProjectPreview");
    const user = await openMenu(
      [sim({ hostId: "mac-1" }), sim({ id: 8, name: "Local sim" })],
      true,
      "mac-1",
    );
    expect(
      await screen.findByRole("menuitem", { name: /Local sim .*another host/ }),
    ).toHaveAttribute("aria-disabled", "true");
    await user.click(screen.getByRole("menuitem", { name: "Open dev server on iPhone 16" }));
    expect(api.openUrlOnDevice).toHaveBeenCalledWith(7, "http://127.0.0.1:3005/");
  });

  it("offers nothing for stopped, exited or failed devices", async () => {
    await openMenu([
      sim({ id: 2, status: "killed" }),
      sim({ id: 3, live: null }),
      android({ id: 4, live: { id: "4", status: "exited" } as unknown as Device["live"] }),
      android({ id: 5, live: { id: "5", status: "error" } as unknown as Device["live"] }),
    ]);
    expect(screen.queryByRole("menuitem", { name: /^Open .* on / })).toBeNull();
  });

  it("opens the dev server's loopback URL on a same-host Android device (#3559)", async () => {
    const user = await openMenu([android({})]);
    await user.click(screen.getByRole("menuitem", { name: "Open dev server on Pixel 10" }));
    // The backend maps the port back to this host with `adb reverse`.
    expect(api.openUrlOnDevice).toHaveBeenCalledWith(9, "http://127.0.0.1:3005/");
  });

  it("opens the dev server's preview URL, with the token, on an Android device on another host", async () => {
    vi.spyOn(api, "createProjectPreview").mockResolvedValue({ slug: "abc" } as Preview);
    vi.spyOn(api, "mintPreviewToken").mockResolvedValue({ token: "tok" });
    const user = await openMenu([android({ hostId: "agent-1" })], true, "local", {
      ...PREVIEWS_ON,
      previewAuthRequired: true,
    });
    await user.click(
      await screen.findByRole("menuitem", { name: "Open dev server on Pixel 10 (via preview)" }),
    );
    await waitFor(() =>
      expect(api.openUrlOnDevice).toHaveBeenCalledWith(
        9,
        `${window.location.protocol}//preview-abc.mullion.example.com/?__mullion_preview=tok`,
      ),
    );
  });

  it("opens a named target on an Android device and lists one per running device", async () => {
    vi.spyOn(api, "createTargetPreview").mockResolvedValue({ slug: "tgt" } as Preview);
    const user = await openMenu([sim({}), android({})], true, "local", PREVIEWS_ON, [STAGING]);
    expect(
      await screen.findByRole("menuitem", { name: "Open Staging on iPhone 16" }),
    ).toBeInTheDocument();
    await user.click(await screen.findByRole("menuitem", { name: "Open Staging on Pixel 10" }));
    await waitFor(() =>
      expect(api.openUrlOnDevice).toHaveBeenCalledWith(
        9,
        `${window.location.protocol}//preview-tgt.mullion.example.com/`,
      ),
    );
  });

  it("lists an Android device on another host disabled, with the reason, when previews are off", async () => {
    const user = await openMenu([android({ hostId: "agent-1" })], true, "local", PREVIEWS_OFF, [
      STAGING,
    ]);
    const devServer = await screen.findByRole("menuitem", {
      name: "Open dev server on Pixel 10 (on another host)",
    });
    expect(devServer).toHaveAttribute("aria-disabled", "true");
    expect(devServer.getAttribute("title")).toMatch(/Previews are not enabled/);
    const target = screen.getByRole("menuitem", { name: "Open Staging on Pixel 10 (unavailable)" });
    expect(target.getAttribute("title")).toMatch(/Previews are not enabled/);
    await user.click(devServer);
    await user.click(target);
    expect(api.openUrlOnDevice).not.toHaveBeenCalled();
  });

  it("lists a booting Android device disabled until it is running", async () => {
    const user = await openMenu(
      [android({ live: { id: "9", status: "booting" } as unknown as Device["live"] })],
      true,
      "local",
      PREVIEWS_ON,
      [STAGING],
    );
    const row = await screen.findByRole("menuitem", {
      name: "Open dev server on Pixel 10 (booting)",
    });
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(row.getAttribute("title")).toMatch(/still booting/);
    expect(
      screen.getByRole("menuitem", { name: "Open Staging on Pixel 10 (unavailable)" }),
    ).toHaveAttribute("aria-disabled", "true");
    await user.click(row);
    expect(api.openUrlOnDevice).not.toHaveBeenCalled();
  });

  it("re-resolves the dev server's host when a Dock session starts", async () => {
    await openMenu([sim({})]);
    expect(api.getBrowserDestinations).toHaveBeenCalledTimes(1);
    useDashboardStore.setState({
      sessions: [makeSession({ id: 91, projectId: 1, kind: "dock", status: "active" })],
    });
    await waitFor(() => expect(api.getBrowserDestinations).toHaveBeenCalledTimes(2));
  });

  it("reports a failed preview read as such, not as previews off, and retries it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.spyOn(api, "getBrowserDestinations").mockResolvedValue(destinations("local"));
      const info = vi
        .spyOn(api, "getServerInfo")
        .mockRejectedValueOnce(new Error("rate limited"))
        .mockResolvedValue(PREVIEWS_ON as ServerInfo);
      resetStore({
        projects: [makeProject({ id: 1, hostId: "local", devServerUrl: "3005" })],
        devices: [sim({ hostId: "mac-1" })],
      });
      vi.spyOn(api, "getProjectPreviewTargets").mockResolvedValue({
        devServerUrl: "3005",
        targets: [STAGING],
      });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<ProjectPreviewMenu projectId={1} onOpenDefault={vi.fn()} onManage={vi.fn()} />);
      await waitFor(() => expect(info).toHaveBeenCalledTimes(1));
      await user.click(screen.getByRole("button", { name: "Preview" }));
      const row = await screen.findByRole("menuitem", {
        name: "Open Staging on iPhone 16 (unavailable)",
      });
      expect(row.getAttribute("title")).toMatch(/Could not read the server's preview settings/);
      await vi.advanceTimersByTimeAsync(10_000);
      await waitFor(() => expect(info).toHaveBeenCalledTimes(2));
      expect(
        await screen.findByRole("menuitem", { name: "Open Staging on iPhone 16" }),
      ).not.toHaveAttribute("aria-disabled", "true");
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens a named target from a simulator on another host", async () => {
    vi.spyOn(api, "createTargetPreview").mockResolvedValue({ slug: "tgt" } as Preview);
    const user = await openMenu([sim({ hostId: "mac-1" })], true, "local", PREVIEWS_ON, [STAGING]);
    await user.click(await screen.findByRole("menuitem", { name: "Open Staging on iPhone 16" }));
    await waitFor(() =>
      expect(api.openUrlOnDevice).toHaveBeenCalledWith(
        7,
        `${window.location.protocol}//preview-tgt.mullion.example.com/`,
      ),
    );
  });

  it("lists a simulator on another host disabled when the preview host is loopback", async () => {
    const user = await openMenu([sim({ hostId: "mac-1" })], true, "local", {
      ...PREVIEWS_ON,
      previewBaseHost: "localhost:3000",
    });
    const item = await screen.findByRole("menuitem", {
      name: "Open dev server on iPhone 16 (on another host)",
    });
    expect(item.getAttribute("title")).toMatch(/loopback/);
    await user.click(item);
    expect(api.openUrlOnDevice).not.toHaveBeenCalled();
  });

  it("reports a preview that could not be created", async () => {
    const { fetchMock } = mockFetch({
      "POST /api/previews": () => jsonResponse(409, { message: "no dev server" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const reportError = vi.fn(() => 1);
    const user = await openMenu([sim({ hostId: "mac-1" })], true, "local", PREVIEWS_ON);
    useDashboardStore.setState({ reportError });
    await user.click(
      await screen.findByRole("menuitem", { name: "Open dev server on iPhone 16 (via preview)" }),
    );
    await waitFor(() =>
      expect(reportError).toHaveBeenCalledWith("Could not open on device", "no dev server"),
    );
    expect(api.openUrlOnDevice).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
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
    await user.click(screen.getByRole("menuitem", { name: "Open dev server on iPhone 16" }));
    await waitFor(() =>
      expect(reportError).toHaveBeenCalledWith("Could not open on device", "simctl failed"),
    );
    vi.unstubAllGlobals();
  });
});
