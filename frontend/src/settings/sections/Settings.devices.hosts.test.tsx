// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SERVER_INFO_FIXTURE } from "../../test/serverInfoFixture.js";
import { Settings } from "../../Settings.js";
import { useDashboardStore } from "../../store/index.js";
import type { Device, DeviceHostEntry } from "../../api/index.js";
import { jsonResponse } from "../../test/jsonResponse.js";
import { mockFetch } from "../../test/mockFetch.js";
import { makeHost } from "../../test/fixtures.js";
import { resetStore } from "../../test/resetStore.js";

// Host picker and unreachable state in Settings -> Devices, against a small
// fake backend (the big one lives in Settings.devices.test.tsx, which is at its
// size ceiling).
const AT = "2026-01-01T00:00:00.000Z";
const device = (over: Partial<Device>): Device => ({
  id: 1,
  hostId: "local",
  projectId: null,
  name: "Dev",
  kind: "emulator",
  avdName: "pixel_7",
  serial: null,
  status: "active",
  createdAt: AT,
  live: null,
  ...over,
});
const FOUR_HOSTS: DeviceHostEntry[] = [
  {
    hostId: "local",
    name: "Primary",
    status: "ok",
    deviceKinds: ["emulator", "physical"],
    platforms: ["android"],
  },
  {
    hostId: "h-mac",
    name: "Mac mini",
    status: "ok",
    deviceKinds: ["emulator"],
    platforms: ["android"],
  },
  {
    hostId: "h-phone",
    name: "Phone rack",
    status: "ok",
    deviceKinds: ["physical"],
    platforms: ["android"],
  },
  {
    hostId: "h-old",
    name: "Old agent",
    status: "unsupported",
    deviceKinds: [],
    platforms: [],
  },
  {
    hostId: "h-down",
    name: "Down box",
    status: "unreachable",
    deviceKinds: [],
    platforms: [],
  },
];

describe("Settings -> Devices host picker", () => {
  let devicesDb: Device[];
  let hostsDb: DeviceHostEntry[];
  let createBodies: Array<Record<string, unknown>>;
  let unexpectedCalls: string[];

  beforeEach(() => {
    devicesDb = [];
    hostsDb = [FOUR_HOSTS[0]!];
    createBodies = [];
    const { fetchMock, unexpectedCalls: unexpected } = mockFetch({
      "GET /api/server-info": () => jsonResponse(200, SERVER_INFO_FIXTURE),
      "GET /api/hosts": () => jsonResponse(200, []),
      "GET /api/projects": () => jsonResponse(200, []),
      "GET /api/sessions": () => jsonResponse(200, []),
      "GET /api/devices": () => jsonResponse(200, devicesDb),
      "GET /api/devices/hosts": () => jsonResponse(200, hostsDb),
      "GET /api/devices/discovered": () => jsonResponse(200, []),
      "GET /api/avds": () => jsonResponse(200, { avds: ["pixel_7"] }),
      "POST /api/devices": ({ init }) => {
        const body = JSON.parse(init?.body as string) as Record<string, unknown>;
        createBodies.push(body);
        return jsonResponse(201, device({ id: 9 }));
      },
    });
    unexpectedCalls = unexpected;
    vi.stubGlobal("fetch", fetchMock);
    resetStore({ devices: [] });
  });

  afterEach(() => {
    expect(unexpectedCalls).toEqual([]);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const openForm = async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="devices" />);
    await user.click(await screen.findByText("Create a device"));
    await screen.findByDisplayValue("pixel_7");
    return user;
  };

  it("shows no picker with only the primary registered, and sends no hostId", async () => {
    const user = await openForm();
    expect(screen.queryByRole("combobox", { name: "Host" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(createBodies).toHaveLength(1));
    expect(createBodies[0]).not.toHaveProperty("hostId");
  });

  it("filters hosts by kind and disables unusable ones with the reason", async () => {
    hostsDb = FOUR_HOSTS;
    await openForm();
    const picker = await screen.findByRole("combobox", { name: "Host" });
    const options = within(picker).getAllByRole("option") as HTMLOptionElement[];
    expect(options.map((o) => [o.textContent, o.disabled])).toEqual([
      ["Primary", false],
      ["Mac mini", false],
      ["Old agent — unsupported (agent needs an update)", true],
      ["Down box — unreachable", true],
    ]);
  });

  it("sends the chosen hostId", async () => {
    hostsDb = FOUR_HOSTS;
    const user = await openForm();
    await user.selectOptions(await screen.findByRole("combobox", { name: "Host" }), "h-mac");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(createBodies).toHaveLength(1));
    expect(createBodies[0]).toMatchObject({ avdName: "pixel_7", hostId: "h-mac" });
  });

  it("names a non-primary host on its device row", async () => {
    devicesDb = [device({ id: 1, hostId: "h-mac" }), device({ id: 2, avdName: "pixel_8" })];
    useDashboardStore.setState({
      hosts: [makeHost({ id: "h-mac", name: "Mac mini", isLocal: false })],
    });
    render(<Settings onClose={vi.fn()} initialSection="devices" />);
    expect(within(await screen.findByTestId("device-row-1")).getByText(/Mac mini/)).toBeVisible();
    expect(within(screen.getByTestId("device-row-2")).queryByText(/Mac mini/)).toBeNull();
  });

  it("renders a device on an unreachable host as unavailable and disables Start", async () => {
    devicesDb = [device({ hostId: "h-mac", status: "killed", hostUnreachable: true })];
    render(<Settings onClose={vi.fn()} initialSection="devices" />);
    const row = await screen.findByTestId("device-row-1");
    expect(within(row).getByText("unavailable — host unreachable")).toBeInTheDocument();
    expect(within(row).queryByText("stopped")).not.toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Start" })).toBeDisabled();
  });
});
