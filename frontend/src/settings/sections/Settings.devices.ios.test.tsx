// @vitest-environment jsdom
// iOS Simulator creation and row rendering in Settings -> Devices (split out of
// Settings.devices.test.tsx, which is at its check:max-file-lines ceiling,
// matching Settings.devices.hosts.test.tsx).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SERVER_INFO_FIXTURE } from "../../test/serverInfoFixture.js";
import { Settings } from "../../Settings.js";
import type { Device, DeviceHostEntry, IosSimulator } from "../../api/index.js";
import { jsonResponse } from "../../test/jsonResponse.js";
import { mockFetch } from "../../test/mockFetch.js";
import { resetStore } from "../../test/resetStore.js";
import * as dd from "../../test/dropdown.js";

const IOS_SIMS_LOCAL: IosSimulator[] = [
  {
    udid: "SIM-UDID-1",
    name: "iPhone 16 Pro",
    runtime: "iOS 18.2",
    state: "Shutdown",
  },
  {
    udid: "SIM-UDID-2",
    name: "iPhone 15",
    runtime: "iOS 17.5",
    state: "Booted",
  },
];

const IOS_SIMS_MAC: IosSimulator[] = [
  {
    udid: "MAC-UDID-1",
    name: "iPad Air",
    runtime: "iOS 18.2",
    state: "Shutdown",
  },
];

describe("Settings -> Devices iOS Simulator", () => {
  let devicesDb: Device[];
  let deviceHostsDb: DeviceHostEntry[];
  let simulatorsByHostDb: Record<string, IosSimulator[]>;
  let simulatorsErrorByHost: Record<string, { status: number; message: string }>;
  let createBodies: Array<Record<string, unknown>>;
  let createError: { status: number; message: string } | null;
  let createCounter: number;
  let unexpectedCalls: string[];
  let simulatorCreateBodies: Array<Record<string, unknown>>;
  let simulatorCreateError: { status: number; message: string } | null;
  let emptyDeviceTypes: boolean;

  beforeEach(() => {
    devicesDb = [];
    deviceHostsDb = [];
    simulatorsByHostDb = {};
    simulatorsErrorByHost = {};
    createBodies = [];
    createError = null;
    createCounter = 0;
    simulatorCreateBodies = [];
    simulatorCreateError = null;
    emptyDeviceTypes = false;

    const { fetchMock, unexpectedCalls: unexpected } = mockFetch({
      "GET /api/server-info": () => jsonResponse(200, SERVER_INFO_FIXTURE),
      "GET /api/hosts": () => jsonResponse(200, []),
      "GET /api/projects": () => jsonResponse(200, []),
      "GET /api/sessions": () => jsonResponse(200, []),
      "GET /api/devices": () => jsonResponse(200, devicesDb),
      "GET /api/devices/hosts": () => jsonResponse(200, deviceHostsDb),
      "GET /api/devices/discovered": () => jsonResponse(200, []),
      "GET /api/avds": () => jsonResponse(200, { avds: ["pixel_7"] }),
      "GET /api/simulators": ({ url }) => {
        const parsed = new URL(url, "http://localhost");
        const hostId = parsed.searchParams.get("hostId") || "local";
        const err = simulatorsErrorByHost[hostId];
        if (err) return jsonResponse(err.status, { message: err.message });
        return jsonResponse(200, simulatorsByHostDb[hostId] ?? []);
      },
      "GET /api/simulators/catalog": () =>
        jsonResponse(200, {
          deviceTypes: emptyDeviceTypes
            ? []
            : [
                { id: "type-16", name: "iPhone 16" },
                { id: "type-ipad", name: "iPad Air" },
              ],
          runtimes: [
            { id: "rt-17", name: "iOS 17.5" },
            { id: "rt-18", name: "iOS 18.2" },
          ],
        }),
      "POST /api/simulators": ({ init }) => {
        if (simulatorCreateError) {
          return jsonResponse(simulatorCreateError.status, {
            message: simulatorCreateError.message,
          });
        }
        const body = JSON.parse(init?.body as string) as Record<string, unknown>;
        simulatorCreateBodies.push(body);
        return jsonResponse(201, {
          udid: "NEW-UDID",
          name: body.name,
          runtime: "iOS 18.2",
          state: "Shutdown",
        });
      },
      "POST /api/devices": ({ init }) => {
        if (createError) {
          return jsonResponse(createError.status, { message: createError.message });
        }
        const body = JSON.parse(init?.body as string) as {
          platform?: "android" | "ios";
          avdName?: string;
          udid?: string;
          hostId?: string;
          name?: string;
        };
        createBodies.push(body as Record<string, unknown>);
        createCounter += 1;
        const isIos = body.platform === "ios";
        const device: Device = {
          id: createCounter,
          hostId: body.hostId ?? "local",
          projectId: null,
          name: body.name ?? null,
          platform: isIos ? "ios" : "android",
          kind: "emulator",
          avdName: isIos ? null : (body.avdName ?? null),
          serial: null,
          udid: isIos ? (body.udid ?? null) : null,
          status: "active",
          createdAt: "2026-01-01T00:00:00.000Z",
          live: null,
        };
        devicesDb = [...devicesDb, device];
        return jsonResponse(201, device);
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

  it("keeps the form unchanged when no host reports ios", async () => {
    deviceHostsDb = [
      {
        hostId: "local",
        name: "Primary",
        status: "ok",
        deviceKinds: ["emulator", "physical"],
        platforms: ["android"],
      },
    ];
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="devices" />);
    await user.click(await screen.findByText("Create a device"));
    await dd.findDropdownByLabel("pixel_7");
    expect(screen.queryByRole("radio", { name: "iOS Simulator" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ New AVD" })).toBeInTheDocument();
  });

  it("offers iOS Simulator when an ios host exists, filters the host picker, and disables active simulators", async () => {
    deviceHostsDb = [
      {
        hostId: "local",
        name: "Primary",
        status: "ok",
        deviceKinds: ["emulator", "physical"],
        platforms: ["android", "ios"],
      },
      {
        hostId: "h-linux",
        name: "Linux box",
        status: "ok",
        deviceKinds: ["emulator"],
        platforms: ["android"],
      },
      {
        hostId: "h-mac",
        name: "Mac mini",
        status: "ok",
        deviceKinds: ["emulator"],
        platforms: ["android", "ios"],
      },
      {
        hostId: "h-down",
        name: "Down box",
        status: "unreachable",
        deviceKinds: [],
        platforms: [],
      },
    ];
    simulatorsByHostDb = {
      local: IOS_SIMS_LOCAL,
      "h-mac": IOS_SIMS_MAC,
    };
    devicesDb = [
      {
        id: 10,
        hostId: "local",
        projectId: null,
        name: null,
        platform: "ios",
        kind: "emulator",
        avdName: null,
        serial: null,
        udid: "SIM-UDID-1",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        live: null,
      },
    ];

    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="devices" />);
    await user.click(await screen.findByText("Create a device"));

    await user.click(await screen.findByRole("radio", { name: "iOS Simulator" }));

    expect(screen.queryByRole("button", { name: "+ New AVD" })).not.toBeInTheDocument();
    expect(dd.queryDropdownByLabel("pixel_7")).not.toBeInTheDocument();

    const hostPicker = screen.getByRole("combobox", { name: "Host" });
    expect(dd.dropdownOptions(hostPicker).map((o) => o.label)).toEqual(["Primary", "Mac mini"]);

    const simPicker = await screen.findByRole("combobox", { name: "Simulator" });
    expect(dd.dropdownOptions(simPicker).map((o) => [o.label, o.disabled])).toEqual([
      ["iPhone 16 Pro (iOS 18.2 · Shutdown) — already added", true],
      ["iPhone 15 (iOS 17.5 · Booted)", false],
    ]);
    expect(dd.dropdownValue(simPicker)).toBe("SIM-UDID-2");

    dd.pickDropdownOption(hostPicker, "h-mac");
    await waitFor(() => {
      const macSimPicker = screen.getByRole("combobox", { name: "Simulator" });
      expect(dd.dropdownOptions(macSimPicker).map((o) => o.label)).toEqual([
        "iPad Air (iOS 18.2 · Shutdown)",
      ]);
    });
  });

  it("submits { platform: 'ios', udid } on primary (hostId omitted) and includes hostId for remote host", async () => {
    deviceHostsDb = [
      {
        hostId: "local",
        name: "Primary",
        status: "ok",
        deviceKinds: ["emulator"],
        platforms: ["android", "ios"],
      },
      {
        hostId: "h-mac",
        name: "Mac mini",
        status: "ok",
        deviceKinds: ["emulator"],
        platforms: ["android", "ios"],
      },
    ];
    simulatorsByHostDb = {
      local: IOS_SIMS_LOCAL,
      "h-mac": IOS_SIMS_MAC,
    };

    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="devices" />);

    await user.click(await screen.findByText("Create a device"));
    await user.click(await screen.findByRole("radio", { name: "iOS Simulator" }));
    await screen.findByRole("combobox", { name: "Simulator" });
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(createBodies).toHaveLength(1));
    expect(createBodies[0]).toEqual({ platform: "ios", udid: "SIM-UDID-1" });
    expect(createBodies[0]).not.toHaveProperty("hostId");

    await user.click(await screen.findByText("Create a device"));
    await user.click(await screen.findByRole("radio", { name: "iOS Simulator" }));
    dd.pickDropdownOption(screen.getByRole("combobox", { name: "Host" }), "h-mac");
    await waitFor(() => {
      expect(
        dd.dropdownOptions(screen.getByRole("combobox", { name: "Simulator" })).map((o) => o.label),
      ).toEqual(["iPad Air (iOS 18.2 · Shutdown)"]);
    });
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(createBodies).toHaveLength(2));
    expect(createBodies[1]).toEqual({
      platform: "ios",
      udid: "MAC-UDID-1",
      hostId: "h-mac",
    });
  });

  it("shows server 409 conflict message verbatim on submit", async () => {
    deviceHostsDb = [
      {
        hostId: "local",
        name: "Primary",
        status: "ok",
        deviceKinds: ["emulator"],
        platforms: ["android", "ios"],
      },
    ];
    simulatorsByHostDb = { local: IOS_SIMS_LOCAL };
    createError = {
      status: 409,
      message: "device 42 is already active for simulator SIM-UDID-1",
    };

    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="devices" />);
    await user.click(await screen.findByText("Create a device"));
    await user.click(await screen.findByRole("radio", { name: "iOS Simulator" }));
    await screen.findByRole("combobox", { name: "Simulator" });
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(
      await screen.findByText("device 42 is already active for simulator SIM-UDID-1"),
    ).toBeVisible();
  });

  it("shows an error message when /api/simulators fails for an unreachable host", async () => {
    deviceHostsDb = [
      {
        hostId: "h-mac",
        name: "Mac mini",
        status: "ok",
        deviceKinds: ["emulator"],
        platforms: ["ios"],
      },
    ];
    simulatorsErrorByHost = {
      "h-mac": { status: 503, message: "Host h-mac is unreachable while listing iOS simulators" },
    };

    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="devices" />);
    await user.click(await screen.findByText("Create a device"));
    await user.click(await screen.findByRole("radio", { name: "iOS Simulator" }));

    expect(screen.getByText("Mac mini")).toBeVisible();
    expect(
      await screen.findByText("Host h-mac is unreachable while listing iOS simulators"),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  });

  it("shows simulator name and runtime on iOS device rows instead of AVD/serial fields", async () => {
    simulatorsByHostDb = { local: IOS_SIMS_LOCAL };
    devicesDb = [
      {
        id: 11,
        hostId: "local",
        projectId: null,
        name: null,
        platform: "ios",
        kind: "emulator",
        avdName: null,
        serial: null,
        udid: "SIM-UDID-1",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        live: null,
      },
    ];

    render(<Settings onClose={vi.fn()} initialSection="devices" />);
    const row = await screen.findByTestId("device-row-11");
    await within(row).findByText("iPhone 16 Pro · iOS 18.2");
    expect(within(row).getByText("iPhone 16 Pro")).toBeVisible();
  });
  it("creates a new simulator from the catalog, preselects it and registers it", async () => {
    deviceHostsDb = [
      {
        hostId: "local",
        name: "Primary",
        status: "ok",
        deviceKinds: ["emulator"],
        platforms: ["android", "ios"],
      },
    ];
    simulatorsByHostDb = { local: IOS_SIMS_LOCAL };
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="devices" />);
    await user.click(await screen.findByText("Create a device"));
    await user.click(await screen.findByRole("radio", { name: "iOS Simulator" }));
    await screen.findByRole("combobox", { name: "Simulator" });

    await user.click(screen.getByRole("button", { name: "+ New simulator" }));
    const create = await screen.findByRole("button", { name: "Create simulator" });
    expect(create).toBeDisabled();
    await screen.findByRole("combobox", { name: "Device type" });
    expect(dd.dropdownValue(screen.getByRole("combobox", { name: "Runtime" }))).toBe("rt-18");

    const nameInput = screen.getByRole("textbox", { name: "New simulator name" });
    await user.type(nameInput, "-bad");
    expect(await screen.findByText(/starting with a letter or digit/)).toBeInTheDocument();
    expect(create).toBeDisabled();
    await user.clear(nameInput);
    await user.type(nameInput, "QA phone");

    dd.pickDropdownOption(screen.getByRole("combobox", { name: "Device type" }), "type-ipad");
    await user.click(create);

    await waitFor(() => {
      expect(simulatorCreateBodies).toEqual([
        { name: "QA phone", deviceTypeId: "type-ipad", runtimeId: "rt-18" },
      ]);
    });
    await waitFor(() => {
      const picker = screen.getByRole("combobox", { name: "Simulator" });
      expect(dd.dropdownValue(picker)).toBe("NEW-UDID");
      expect(dd.dropdownOptions(picker).map((o) => o.label)).toContain(
        "QA phone (iOS 18.2 · Shutdown)",
      );
    });
    expect(screen.queryByRole("button", { name: "Create simulator" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => {
      expect(createBodies).toEqual([{ platform: "ios", udid: "NEW-UDID" }]);
    });
  });

  it("shows the server's message when creating a simulator fails", async () => {
    deviceHostsDb = [
      {
        hostId: "h-mac",
        name: "Mac mini",
        status: "ok",
        deviceKinds: ["emulator"],
        platforms: ["ios"],
      },
    ];
    simulatorsByHostDb = { "h-mac": IOS_SIMS_MAC };
    simulatorCreateError = { status: 502, message: "Invalid runtime" };
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="devices" />);
    await user.click(await screen.findByText("Create a device"));
    await user.click(await screen.findByRole("radio", { name: "iOS Simulator" }));
    await screen.findByRole("combobox", { name: "Simulator" });

    await user.click(screen.getByRole("button", { name: "+ New simulator" }));
    await screen.findByRole("combobox", { name: "Device type" });
    await user.type(screen.getByRole("textbox", { name: "New simulator name" }), "QA phone");
    await user.click(screen.getByRole("button", { name: "Create simulator" }));

    expect(await screen.findByText("Invalid runtime")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create simulator" })).toBeEnabled();
  });

  it("explains a host that offers no device types", async () => {
    deviceHostsDb = [
      {
        hostId: "local",
        name: "Primary",
        status: "ok",
        deviceKinds: ["emulator"],
        platforms: ["android", "ios"],
      },
    ];
    simulatorsByHostDb = { local: IOS_SIMS_LOCAL };
    emptyDeviceTypes = true;
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="devices" />);
    await user.click(await screen.findByText("Create a device"));
    await user.click(await screen.findByRole("radio", { name: "iOS Simulator" }));
    await screen.findByRole("combobox", { name: "Simulator" });
    await user.click(screen.getByRole("button", { name: "+ New simulator" }));
    expect(await screen.findByText(/No iPhone or iPad device types/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create simulator" })).toBeDisabled();
  });
});
