// @vitest-environment jsdom
// iOS Simulator creation and row rendering in Settings -> Devices (split out of
// Settings.devices.test.tsx, which is at its check:max-file-lines ceiling,
// matching Settings.devices.hosts.test.tsx).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SERVER_INFO_FIXTURE } from "../../test/serverInfoFixture.js";
import { Settings } from "../../Settings.js";
import { DEVICES_POLL_MS } from "../../SidebarDevices.js";
import { HOSTS_REFRESH_TICKS } from "./DevicesSection.js";
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
  let longDeviceTypeName: boolean;
  let devicesFail: boolean;
  let hostsFail: boolean;
  let avdsList: string[];

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
    longDeviceTypeName = false;
    devicesFail = false;
    hostsFail = false;
    avdsList = ["pixel_7"];

    const { fetchMock, unexpectedCalls: unexpected } = mockFetch({
      "GET /api/server-info": () => jsonResponse(200, SERVER_INFO_FIXTURE),
      "GET /api/hosts": () => jsonResponse(200, []),
      "GET /api/projects": () => jsonResponse(200, []),
      "GET /api/sessions": () => jsonResponse(200, []),
      "GET /api/devices": () =>
        devicesFail ? jsonResponse(500, { message: "boom" }) : jsonResponse(200, devicesDb),
      "GET /api/devices/hosts": () =>
        hostsFail ? jsonResponse(500, { message: "boom" }) : jsonResponse(200, deviceHostsDb),
      "GET /api/devices/discovered": () => jsonResponse(200, []),
      "GET /api/avds": () => jsonResponse(200, { avds: avdsList }),
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
                {
                  id: "type-16",
                  name: longDeviceTypeName
                    ? `iPhone ${"Very Long Model Name ".repeat(4)}`
                    : "iPhone 16",
                },
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

  it("shows no iOS section when no host reports ios", async () => {
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
    await user.click(await screen.findByText("Create an emulator"));
    await dd.findDropdownByLabel("pixel_7");
    expect(screen.queryByRole("region", { name: "iOS Simulator" })).not.toBeInTheDocument();
    expect(screen.queryByText("Add a simulator")).not.toBeInTheDocument();
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
    await user.click(await screen.findByText("Add a simulator"));

    expect(screen.queryByRole("button", { name: "+ New AVD" })).not.toBeInTheDocument();
    expect(dd.queryDropdownByLabel("pixel_7")).not.toBeInTheDocument();

    const hostPicker = screen.getByRole("combobox", { name: "Host" });
    expect(dd.dropdownOptions(hostPicker).map((o) => o.label)).toEqual(["Primary", "Mac mini"]);

    const simPicker = await screen.findByRole("radiogroup", { name: "Simulator" });
    // Grouped by runtime, newest first; the one already added is not selectable.
    expect(
      within(simPicker)
        .getAllByRole("group")
        .map((g) => g.getAttribute("aria-label")),
    ).toEqual(["iOS 18.2", "iOS 17.5"]);
    expect(within(simPicker).getByRole("radio", { name: /iPhone 16 Pro/ })).toBeDisabled();
    expect(within(simPicker).getByRole("radio", { name: /iPhone 15/ })).toBeChecked();

    dd.pickDropdownOption(hostPicker, "h-mac");
    await waitFor(() => {
      const macSimPicker = screen.getByRole("radiogroup", { name: "Simulator" });
      expect(within(macSimPicker).getAllByRole("radio")).toHaveLength(1);
      expect(within(macSimPicker).getByRole("radio", { name: /iPad Air/ })).toBeInTheDocument();
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

    await user.click(await screen.findByText("Add a simulator"));
    await screen.findByRole("radiogroup", { name: "Simulator" });
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(createBodies).toHaveLength(1));
    // The booted simulator is preselected, not the first one simctl lists.
    expect(createBodies[0]).toEqual({ platform: "ios", udid: "SIM-UDID-2" });
    expect(createBodies[0]).not.toHaveProperty("hostId");

    await user.click(await screen.findByText("Add a simulator"));
    dd.pickDropdownOption(screen.getByRole("combobox", { name: "Host" }), "h-mac");
    await waitFor(() => {
      const macSimPicker = screen.getByRole("radiogroup", { name: "Simulator" });
      expect(within(macSimPicker).getByRole("radio", { name: /iPad Air/ })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(createBodies).toHaveLength(2));
    expect(createBodies[1]).toEqual({
      platform: "ios",
      udid: "MAC-UDID-1",
      hostId: "h-mac",
    });
  });

  // #3516: the Name placeholder is the name an empty field falls back to.
  it("shows the selected simulator's name as the Name placeholder and creates with it when left empty", async () => {
    deviceHostsDb = [
      {
        hostId: "local",
        name: "Primary",
        status: "ok",
        deviceKinds: ["emulator"],
        platforms: ["ios"],
      },
    ];
    // Both booted, so the picker lists both without "show all".
    simulatorsByHostDb = { local: IOS_SIMS_LOCAL.map((sim) => ({ ...sim, state: "Booted" })) };
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="devices" />);
    await user.click(await screen.findByText("Add a simulator"));
    const simPicker = await screen.findByRole("radiogroup", { name: "Simulator" });

    const nameInput = screen.getByRole("textbox", { name: "Name" });
    // The newest runtime's is preselected; never a fixed example like "iPhone 16".
    expect(within(simPicker).getByRole("radio", { name: /iPhone 16 Pro/ })).toBeChecked();
    expect(nameInput).toHaveAttribute("placeholder", "iPhone 16 Pro");

    await user.click(within(simPicker).getByRole("radio", { name: /iPhone 15/ }));
    expect(nameInput).toHaveAttribute("placeholder", "iPhone 15");

    // Left empty, no name is sent: the server names the device after the
    // simulator the placeholder showed.
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(createBodies).toEqual([{ platform: "ios", udid: "SIM-UDID-2" }]));
  });

  it("shows no Name placeholder when no simulator can be selected", async () => {
    deviceHostsDb = [
      {
        hostId: "local",
        name: "Primary",
        status: "ok",
        deviceKinds: ["emulator"],
        platforms: ["ios"],
      },
    ];
    simulatorsByHostDb = { local: [] };
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="devices" />);
    await user.click(await screen.findByText("Add a simulator"));
    await screen.findByText("No iOS simulators available on this machine.");
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveAttribute("placeholder", "");
  });

  it("shows the selected AVD's name as the Android Name placeholder", async () => {
    deviceHostsDb = [
      {
        hostId: "local",
        name: "Primary",
        status: "ok",
        deviceKinds: ["emulator"],
        platforms: ["android"],
      },
    ];
    avdsList = ["pixel_7", "pixel_9_pro"];
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="devices" />);
    await user.click(await screen.findByText("Create an emulator"));
    const avdPicker = await dd.findDropdownByLabel("pixel_7");

    const nameInput = screen.getByRole("textbox", { name: "Name" });
    expect(nameInput).toHaveAttribute("placeholder", "pixel_7");
    dd.pickDropdownOption(avdPicker, "pixel_9_pro");
    await waitFor(() => expect(nameInput).toHaveAttribute("placeholder", "pixel_9_pro"));
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
    await user.click(await screen.findByText("Add a simulator"));
    await screen.findByRole("radiogroup", { name: "Simulator" });
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
    await user.click(await screen.findByText("Add a simulator"));

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
    await user.click(await screen.findByText("Add a simulator"));
    await screen.findByRole("radiogroup", { name: "Simulator" });

    await user.click(screen.getByRole("button", { name: "+ New simulator" }));
    const create = await screen.findByRole("button", { name: "Create simulator" });
    await screen.findByRole("button", { name: "Device type" });
    // Newest runtime preselected; the name defaults to "<device type> (<runtime>)".
    expect(dd.dropdownValue(screen.getByRole("combobox", { name: "Runtime" }))).toBe("rt-18");
    expect(screen.getByRole("textbox", { name: "New simulator name" })).toHaveAttribute(
      "placeholder",
      "iPhone 16 (iOS 18.2)",
    );
    expect(create).toBeEnabled();

    const nameInput = screen.getByRole("textbox", { name: "New simulator name" });
    // The placeholder follows the device type and runtime it would be named after.
    dd.pickDropdownOption(screen.getByRole("combobox", { name: "Runtime" }), "rt-17");
    await waitFor(() => expect(nameInput).toHaveAttribute("placeholder", "iPhone 16 (iOS 17.5)"));
    await user.click(screen.getByRole("button", { name: "Device type" }));
    await user.click(await screen.findByRole("option", { name: "iPad Air" }));
    await waitFor(() => expect(nameInput).toHaveAttribute("placeholder", "iPad Air (iOS 17.5)"));

    await user.type(nameInput, "-bad");
    expect(await screen.findByText(/starting with a letter or digit/)).toBeInTheDocument();
    expect(create).toBeDisabled();
    await user.clear(nameInput);
    await user.type(nameInput, "QA phone");

    await user.click(screen.getByRole("button", { name: "Device type" }));
    await user.click(await screen.findByRole("option", { name: "iPad Air" }));
    await user.click(create);

    await waitFor(() => {
      expect(simulatorCreateBodies).toEqual([
        { name: "QA phone", deviceTypeId: "type-ipad", runtimeId: "rt-17" },
      ]);
    });
    await waitFor(() => {
      const picker = screen.getByRole("radiogroup", { name: "Simulator" });
      // Never booted, so only the selection keeps it in the "used" view.
      expect(within(picker).getByRole("radio", { name: /QA phone/ })).toBeChecked();
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
    await user.click(await screen.findByText("Add a simulator"));
    await screen.findByRole("radiogroup", { name: "Simulator" });

    await user.click(screen.getByRole("button", { name: "+ New simulator" }));
    await screen.findByRole("button", { name: "Device type" });
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
    await user.click(await screen.findByText("Add a simulator"));
    await screen.findByRole("radiogroup", { name: "Simulator" });
    await user.click(screen.getByRole("button", { name: "+ New simulator" }));
    expect(await screen.findByText(/No iPhone or iPad device types/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create simulator" })).toBeDisabled();
  });

  describe("platform sections", () => {
    const dev = (over: Partial<Device> & { id: number }): Device => ({
      hostId: "local",
      projectId: null,
      name: null,
      platform: "android",
      kind: "emulator",
      avdName: null,
      serial: null,
      udid: null,
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      live: null,
      ...over,
    });

    it("picks up a platform a host starts reporting after the page opened", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        deviceHostsDb = [
          {
            hostId: "local",
            name: "Primary",
            status: "ok",
            deviceKinds: ["emulator"],
            platforms: ["android"],
          },
        ];
        render(<Settings onClose={vi.fn()} initialSection="devices" />);
        await screen.findByRole("region", { name: "Android" });
        expect(screen.queryByRole("region", { name: "iOS Simulator" })).toBeNull();

        // The Mac wakes up (or its agent is updated) and now reports simulators.
        deviceHostsDb = [{ ...deviceHostsDb[0], platforms: ["android", "ios"] }];
        await vi.advanceTimersByTimeAsync(HOSTS_REFRESH_TICKS * DEVICES_POLL_MS + 500);
        expect(await screen.findByRole("region", { name: "iOS Simulator" })).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps the iOS section, and an open add form, when a later host read fails or the Mac goes quiet", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
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
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        render(<Settings onClose={vi.fn()} initialSection="devices" />);
        await user.click(await screen.findByText("Add a simulator"));
        await screen.findByRole("radiogroup", { name: "Simulator" });

        // The host list fails once: what was known stays.
        hostsFail = true;
        await vi.advanceTimersByTimeAsync(HOSTS_REFRESH_TICKS * DEVICES_POLL_MS + 500);
        expect(screen.getByRole("region", { name: "iOS Simulator" })).toBeInTheDocument();
        expect(screen.getByRole("radiogroup", { name: "Simulator" })).toBeInTheDocument();

        // Then the Mac reports nothing (asleep): the section and the open form stay.
        hostsFail = false;
        deviceHostsDb = [
          { ...deviceHostsDb[0], status: "unreachable", deviceKinds: [], platforms: [] },
        ];
        await vi.advanceTimersByTimeAsync(HOSTS_REFRESH_TICKS * DEVICES_POLL_MS + 500);
        expect(screen.getByRole("region", { name: "iOS Simulator" })).toBeInTheDocument();
        expect(screen.getByRole("radiogroup", { name: "Simulator" })).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it("falls back to showing Android when the first host read fails, then follows the hosts", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        hostsFail = true;
        render(<Settings onClose={vi.fn()} initialSection="devices" />);
        // Hosts unknown: the page is what it was before it had platform sections.
        expect(await screen.findByRole("region", { name: "Android" })).toBeInTheDocument();
        expect(screen.queryByRole("region", { name: "iOS Simulator" })).toBeNull();

        hostsFail = false;
        deviceHostsDb = [
          {
            hostId: "local",
            name: "Primary",
            status: "ok",
            deviceKinds: ["emulator"],
            platforms: ["android", "ios"],
          },
        ];
        await vi.advanceTimersByTimeAsync(HOSTS_REFRESH_TICKS * DEVICES_POLL_MS + 500);
        expect(await screen.findByRole("region", { name: "iOS Simulator" })).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it("shows the device-load error once, even with both sections on screen", async () => {
      deviceHostsDb = [
        {
          hostId: "local",
          name: "Primary",
          status: "ok",
          deviceKinds: ["emulator"],
          platforms: ["android", "ios"],
        },
      ];
      devicesFail = true;
      render(<Settings onClose={vi.fn()} initialSection="devices" />);
      await screen.findByRole("region", { name: "iOS Simulator" });
      expect(await screen.findAllByText("Couldn't load devices.")).toHaveLength(1);
    });

    it("offers no way to add a simulator when no host can run one, but keeps the rows", async () => {
      deviceHostsDb = [
        {
          hostId: "local",
          name: "Primary",
          status: "ok",
          deviceKinds: ["emulator"],
          platforms: ["android"],
        },
      ];
      devicesDb = [dev({ id: 2, platform: "ios", udid: "SIM-UDID-2" })];
      render(<Settings onClose={vi.fn()} initialSection="devices" />);
      const ios = await screen.findByRole("region", { name: "iOS Simulator" });
      expect(within(ios).getByTestId("device-row-2")).toBeInTheDocument();
      expect(within(ios).queryByText("Add a simulator")).toBeNull();
      expect(within(ios).getByText(/No host can run simulators right now/)).toBeInTheDocument();
    });

    it("keeps Create disabled, with the reason, when the default simulator name is not valid", async () => {
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
      longDeviceTypeName = true;
      const user = userEvent.setup();
      render(<Settings onClose={vi.fn()} initialSection="devices" />);
      await user.click(await screen.findByText("Add a simulator"));
      await screen.findByRole("radiogroup", { name: "Simulator" });
      await user.click(screen.getByRole("button", { name: "+ New simulator" }));
      await screen.findByRole("button", { name: "Device type" });
      expect(await screen.findByText(/At most 64 characters/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Create simulator" })).toBeDisabled();
      // Typing a short name of one's own clears it.
      await user.type(screen.getByRole("textbox", { name: "New simulator name" }), "QA");
      expect(screen.getByRole("button", { name: "Create simulator" })).toBeEnabled();
    });

    it("keeps each platform's devices, controls and SDK images in its own section", async () => {
      deviceHostsDb = [
        {
          hostId: "local",
          name: "Primary",
          status: "ok",
          deviceKinds: ["emulator", "physical"],
          platforms: ["android", "ios"],
        },
      ];
      simulatorsByHostDb = { local: IOS_SIMS_LOCAL };
      devicesDb = [
        dev({ id: 1, avdName: "pixel_7" }),
        dev({ id: 2, platform: "ios", udid: "SIM-UDID-2" }),
      ];
      render(<Settings onClose={vi.fn()} initialSection="devices" />);
      const android = await screen.findByRole("region", { name: "Android" });
      const ios = await screen.findByRole("region", { name: "iOS Simulator" });

      expect(within(android).getByTestId("device-row-1")).toBeInTheDocument();
      expect(within(android).queryByTestId("device-row-2")).toBeNull();
      expect(within(ios).getByTestId("device-row-2")).toBeInTheDocument();
      expect(within(ios).queryByTestId("device-row-1")).toBeNull();

      expect(within(android).getByText("Create an emulator")).toBeInTheDocument();
      expect(within(android).getByText("Pair a phone or tablet")).toBeInTheDocument();
      expect(within(android).getByText("SDK system images")).toBeInTheDocument();
      expect(within(ios).getByText("Add a simulator")).toBeInTheDocument();
      expect(within(ios).queryByText("SDK system images")).toBeNull();
      expect(within(ios).queryByText("Create an emulator")).toBeNull();
    });

    it("shows no Android section or SDK images on a host that only runs simulators", async () => {
      deviceHostsDb = [
        {
          hostId: "local",
          name: "Primary",
          status: "ok",
          deviceKinds: [],
          platforms: ["ios"],
        },
      ];
      simulatorsByHostDb = { local: IOS_SIMS_LOCAL };
      render(<Settings onClose={vi.fn()} initialSection="devices" />);
      expect(await screen.findByRole("region", { name: "iOS Simulator" })).toBeInTheDocument();
      expect(screen.queryByRole("region", { name: "Android" })).toBeNull();
      expect(screen.queryByText("SDK system images")).toBeNull();
    });

    it("says so when no simulator has been added yet", async () => {
      deviceHostsDb = [
        {
          hostId: "local",
          name: "Primary",
          status: "ok",
          deviceKinds: ["emulator"],
          platforms: ["android", "ios"],
        },
      ];
      render(<Settings onClose={vi.fn()} initialSection="devices" />);
      const ios = await screen.findByRole("region", { name: "iOS Simulator" });
      expect(await within(ios).findByText(/No simulators added yet/)).toBeInTheDocument();
      expect(
        within(await screen.findByRole("region", { name: "Android" })).getByText(
          /No Android devices yet/,
        ),
      ).toBeInTheDocument();
    });
  });
});
