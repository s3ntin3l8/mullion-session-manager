// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings } from "../../Settings.js";
import { useDashboardStore } from "../../store/index.js";
import type { Device, SystemImage } from "../../api/index.js";
import { jsonResponse } from "../../test/jsonResponse.js";
import { mockFetch } from "../../test/mockFetch.js";
import { resetStore } from "../../test/resetStore.js";

// Issue #1326 — same fake-in-memory-backend shape as Settings.bridges.test.tsx:
// exercises Settings -> Devices against a fake GET/POST/DELETE /api/devices
// backend (through the real `devices` store slice, not a mocked one), so the
// component/store/api wiring the plan's own risk list calls out is what's
// under test here, not a hand-picked mock.
describe("Settings -> Devices (issue #1326)", () => {
  let devicesDb: Device[];
  let devicesShouldFail: boolean;
  let deviceEnabled: boolean;
  let createCounter: number;
  let pairCalls: unknown[];
  let avdsDb: string[];
  let avdsShouldFail: boolean;
  let avdsRefreshShouldFailAfterCreate: boolean;
  let systemImagesDb: SystemImage[];
  let deviceProfilesDb: string[];
  let avdCreateCalls: unknown[];
  let fetchMock: ReturnType<typeof vi.fn>;
  let unexpectedCalls: string[];

  beforeEach(() => {
    devicesDb = [];
    devicesShouldFail = false;
    deviceEnabled = true;
    createCounter = 0;
    pairCalls = [];
    // Seeded with one AVD by default so the picker isn't empty in tests
    // that don't specifically exercise the empty-AVDs state.
    avdsDb = ["pixel_7"];
    avdsShouldFail = false;
    avdsRefreshShouldFailAfterCreate = false;
    systemImagesDb = [
      {
        packagePath: "system-images;android-35;google_apis;x86_64",
        apiLevel: "35",
        tagDisplay: "Google APIs",
        abi: "x86_64",
      },
    ];
    deviceProfilesDb = ["pixel_6"];
    avdCreateCalls = [];

    ({ fetchMock, unexpectedCalls } = mockFetch({
      "GET /api/hosts": () => jsonResponse(200, []),
      "GET /api/projects": () => jsonResponse(200, []),
      "GET /api/sessions": () => jsonResponse(200, []),
      "GET /api/devices": () =>
        devicesShouldFail
          ? jsonResponse(500, { message: "internal error" })
          : jsonResponse(200, devicesDb),
      // Deliberately unconditional on `deviceEnabled`, unlike the POST
      // routes below — the real backend does gate these too (see
      // test/routes/avds.test.ts for that coverage), but this file's own
      // "create surfaces DEVICE_ENABLED=false" test needs the picker
      // populated to even reach a POST /api/devices attempt.
      "GET /api/avds": () =>
        avdsShouldFail
          ? jsonResponse(400, { message: "DEVICE_AVDMANAGER_PATH is not configured." })
          : jsonResponse(200, { avds: avdsDb }),
      "GET /api/system-images": () => jsonResponse(200, { systemImages: systemImagesDb }),
      "GET /api/device-profiles": () => jsonResponse(200, { deviceProfiles: deviceProfilesDb }),
      "POST /api/avds": ({ init }) => {
        if (!deviceEnabled) {
          return jsonResponse(400, {
            message: "Device panel is disabled — set DEVICE_ENABLED=true.",
          });
        }
        const body = JSON.parse(init?.body as string) as {
          name: string;
          systemImage: string;
          deviceProfile: string;
        };
        avdCreateCalls.push(body);
        avdsDb = [...avdsDb, body.name];
        // Simulates creation succeeding but the picker's own post-create
        // refresh failing — a separate failure mode from creation itself.
        if (avdsRefreshShouldFailAfterCreate) avdsShouldFail = true;
        return jsonResponse(201, { name: body.name });
      },
      "POST /api/devices": ({ init }) => {
        if (!deviceEnabled) {
          return jsonResponse(400, {
            message: "Device panel is disabled — set DEVICE_ENABLED=true.",
          });
        }
        const body = JSON.parse(init?.body as string) as {
          kind?: "physical";
          avdName?: string;
          address?: string;
          name?: string;
        };
        createCounter += 1;
        const isPhysical = body.kind === "physical";
        const device: Device = {
          id: createCounter,
          hostId: "local",
          projectId: null,
          name: body.name ?? null,
          kind: isPhysical ? "physical" : "emulator",
          avdName: isPhysical ? null : (body.avdName ?? null),
          serial: isPhysical ? (body.address ?? null) : null,
          status: "active",
          createdAt: "2026-01-01T00:00:00.000Z",
          live: null,
        };
        devicesDb = [...devicesDb, device];
        return jsonResponse(201, device);
      },
      "POST /api/devices/pair": ({ init }) => {
        if (!deviceEnabled) {
          return jsonResponse(400, {
            message: "Device panel is disabled — set DEVICE_ENABLED=true.",
          });
        }
        pairCalls.push(JSON.parse(init?.body as string));
        return jsonResponse(200, { ok: true });
      },
      "DELETE /api/devices/:id": ({ params }) => {
        const id = Number(params.id);
        if (!devicesDb.some((d) => d.id === id)) return jsonResponse(404, { message: "not found" });
        // Mirrors routes/devices.ts's own DELETE handler: it flips `status`
        // to "killed" in place, it never removes the row — the killed-row
        // regression test below depends on this exact shape.
        devicesDb = devicesDb.map((d) => (d.id === id ? { ...d, status: "killed" } : d));
        return jsonResponse(204);
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    resetStore({ devices: [] });
  });

  afterEach(() => {
    expect(unexpectedCalls).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("shows the empty state when no device exists", async () => {
    render(<Settings onClose={vi.fn()} initialSection="devices" />);

    expect(await screen.findByText(/No Android devices yet/)).toBeInTheDocument();
  });

  it("shows a load error instead of the empty state when the list fetch fails", async () => {
    devicesShouldFail = true;
    render(<Settings onClose={vi.fn()} initialSection="devices" />);

    expect(await screen.findByText("Couldn't load devices.")).toBeInTheDocument();
    expect(screen.queryByText(/No Android devices yet/)).not.toBeInTheDocument();
  });

  it("lists a streaming device with its name, avd name, and status", async () => {
    devicesDb = [
      {
        id: 1,
        hostId: "local",
        projectId: null,
        name: "My Pixel",
        kind: "emulator",
        avdName: "pixel_7",
        serial: null,
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        live: {
          id: "1",
          kind: "emulator",
          avdName: "pixel_7",
          label: "My Pixel",
          status: "streaming",
          serial: "emulator-5554",
          error: null,
        },
      },
    ];
    render(<Settings onClose={vi.fn()} initialSection="devices" />);

    const row = await screen.findByTestId("device-row-1");
    expect(within(row).getByText("My Pixel")).toBeInTheDocument();
    expect(within(row).getByText("pixel_7")).toBeInTheDocument();
    expect(within(row).getByText("streaming")).toBeInTheDocument();
  });

  it("create surfaces the server's DEVICE_ENABLED=false message verbatim", async () => {
    deviceEnabled = false;
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="devices" />);

    await user.click(await screen.findByText("New device"));
    await screen.findByDisplayValue("pixel_7"); // wait for the AVD picker to load
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(
      await screen.findByText("Device panel is disabled — set DEVICE_ENABLED=true."),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/devices",
      expect.objectContaining({ method: "POST" }),
    );
  });

  // The regression this plan exists to prevent (BridgesSection's own local-
  // state pattern would NOT do this): creating a device from Settings must
  // update the shared `devices` store slice, not a copy local to this
  // component — that's what lets SidebarDevices.tsx's section appear
  // without depending on Settings ever having been open.
  it("creating a device updates the shared store, not just local component state", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="devices" />);

    await user.click(await screen.findByText("New device"));
    await screen.findByDisplayValue("pixel_7"); // wait for the AVD picker to load
    await user.click(screen.getByRole("button", { name: "Create" }));

    await screen.findByTestId("device-row-1");
    expect(useDashboardStore.getState().devices).toEqual([
      expect.objectContaining({ id: 1, avdName: "pixel_7", status: "active" }),
    ]);
  });

  it("deleting the last active device renders it dimmed instead of removing it", async () => {
    devicesDb = [
      {
        id: 1,
        hostId: "local",
        projectId: null,
        name: "My Pixel",
        kind: "emulator",
        avdName: "pixel_7",
        serial: null,
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        live: {
          id: "1",
          kind: "emulator",
          avdName: "pixel_7",
          label: "My Pixel",
          status: "streaming",
          serial: "emulator-5554",
          error: null,
        },
      },
    ];
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="devices" />);

    const row = await screen.findByTestId("device-row-1");
    const deleteButton = within(row).getByRole("button", { name: "Delete" });
    await user.click(deleteButton);
    await user.click(deleteButton);

    await waitFor(() => {
      expect(within(screen.getByTestId("device-row-1")).getByText("stopped")).toBeInTheDocument();
    });
    // Still the SAME row, not removed — Settings is the one surface that
    // shows a killed device's final state (unlike SidebarDevices, which
    // filters it out entirely). No "Delete" button on an already-killed row.
    expect(
      within(screen.getByTestId("device-row-1")).queryByRole("button", { name: "Delete" }),
    ).not.toBeInTheDocument();
    expect(useDashboardStore.getState().devices).toEqual([
      expect.objectContaining({ id: 1, status: "killed" }),
    ]);
  });

  it("switching to Physical mode shows the pairing/connect fields instead of the AVD name field", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="devices" />);

    await user.click(await screen.findByText("New device"));
    await screen.findByDisplayValue("pixel_7"); // emulator mode's AVD picker, before switching away
    await user.click(screen.getByRole("button", { name: "Physical" }));

    expect(screen.queryByText("+ New AVD")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("pixel_7")).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("192.168.1.23:41234")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("123456")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("192.168.1.23:37251")).toBeInTheDocument();
  });

  it("pairing posts to /api/devices/pair with the entered address and code, without creating a device row", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="devices" />);

    await user.click(await screen.findByText("New device"));
    await user.click(screen.getByRole("button", { name: "Physical" }));
    await user.type(screen.getByPlaceholderText("192.168.1.23:41234"), "192.168.1.23:41234");
    await user.type(screen.getByPlaceholderText("123456"), "123456");
    await user.click(screen.getByRole("button", { name: "Pair" }));

    await screen.findByText("Paired — connect below.");
    expect(pairCalls).toEqual([{ pairingAddress: "192.168.1.23:41234", pairingCode: "123456" }]);
    // Pairing alone creates no device row — see api/device.ts's own comment.
    expect(useDashboardStore.getState().devices).toEqual([]);
  });

  it("connecting a physical device updates the shared store with kind: physical and its address", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="devices" />);

    await user.click(await screen.findByText("New device"));
    await user.click(screen.getByRole("button", { name: "Physical" }));
    await user.type(screen.getByPlaceholderText("192.168.1.23:37251"), "192.168.1.23:37251");
    await user.type(screen.getByPlaceholderText("My Pixel"), "My Pixel");
    await user.click(screen.getByRole("button", { name: "Connect" }));

    await screen.findByTestId("device-row-1");
    expect(useDashboardStore.getState().devices).toEqual([
      expect.objectContaining({
        id: 1,
        kind: "physical",
        serial: "192.168.1.23:37251",
        avdName: null,
        name: "My Pixel",
        status: "active",
      }),
    ]);
  });

  it("AVD picker lists the host's installed AVDs", async () => {
    avdsDb = ["pixel_7", "pixel_6_tablet"];
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="devices" />);

    await user.click(await screen.findByText("New device"));
    const picker = await screen.findByDisplayValue("pixel_7");
    expect(within(picker).getByText("pixel_6_tablet")).toBeInTheDocument();
  });

  it("shows an empty-AVDs message and no picker when the host has no AVDs", async () => {
    avdsDb = [];
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="devices" />);

    await user.click(await screen.findByText("New device"));
    expect(await screen.findByText(/No AVDs on this host yet/)).toBeInTheDocument();
    expect(screen.queryByDisplayValue("pixel_7")).not.toBeInTheDocument();
  });

  // Hermes review (round 1) — a load failure used to leave `avds` empty
  // while `avdsLoaded` was still set true, so the empty-state text ("No
  // AVDs on this host yet") rendered ALONGSIDE the actual error, telling
  // the user to "create one below" when the real problem is a
  // misconfigured DEVICE_AVDMANAGER_PATH.
  it("shows only the error, not the empty-AVDs message, when GET /api/avds fails", async () => {
    avdsShouldFail = true;
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="devices" />);

    await user.click(await screen.findByText("New device"));
    expect(
      await screen.findByText("DEVICE_AVDMANAGER_PATH is not configured."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No AVDs on this host yet/)).not.toBeInTheDocument();
  });

  it("+ New AVD reveals the system image and device profile pickers", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="devices" />);

    await user.click(await screen.findByText("New device"));
    await user.click(screen.getByRole("button", { name: "+ New AVD" }));

    expect(await screen.findByDisplayValue("API 35 — Google APIs (x86_64)")).toBeInTheDocument();
    expect(screen.getByDisplayValue("pixel_6")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Pixel_8_API_35")).toBeInTheDocument();
  });

  it("creating a new AVD posts to /api/avds, then selects it in the picker and closes the sub-form", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="devices" />);

    await user.click(await screen.findByText("New device"));
    await user.click(screen.getByRole("button", { name: "+ New AVD" }));
    await screen.findByDisplayValue("pixel_6"); // wait for device profiles to load
    await user.type(screen.getByPlaceholderText("Pixel_8_API_35"), "pixel_9_new");
    await user.click(screen.getByRole("button", { name: "Create AVD" }));

    // Sub-form closes and the picker now shows the freshly created AVD as
    // selected — proving the frontend re-fetched GET /api/avds rather than
    // just optimistically appending a local guess.
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Create AVD" })).not.toBeInTheDocument();
    });
    expect(screen.getByDisplayValue("pixel_9_new")).toBeInTheDocument();
    expect(avdCreateCalls).toEqual([
      {
        name: "pixel_9_new",
        systemImage: "system-images;android-35;google_apis;x86_64",
        deviceProfile: "pixel_6",
      },
    ]);
  });

  // Hermes review — a failure of the post-create picker refresh used to be
  // reported as "Could not create this AVD" even though creation itself
  // succeeded, leaving the sub-form open with a stale picker (a retry would
  // then hit a duplicate-name 400 from the server). Creation succeeding
  // must close the sub-form and select the new AVD regardless of whether
  // the refresh that follows succeeds.
  it("still closes the sub-form and selects the new AVD when creation succeeds but the picker refresh fails", async () => {
    avdsRefreshShouldFailAfterCreate = true;
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="devices" />);

    await user.click(await screen.findByText("New device"));
    await user.click(screen.getByRole("button", { name: "+ New AVD" }));
    await screen.findByDisplayValue("pixel_6");
    await user.type(screen.getByPlaceholderText("Pixel_8_API_35"), "pixel_9_new");
    await user.click(screen.getByRole("button", { name: "Create AVD" }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Create AVD" })).not.toBeInTheDocument();
    });
    expect(avdCreateCalls).toEqual([
      {
        name: "pixel_9_new",
        systemImage: "system-images;android-35;google_apis;x86_64",
        deviceProfile: "pixel_6",
      },
    ]);
    // The refresh failure surfaces as avdsError, not createAvdError — the
    // AVD was created; only the picker's own list is stale.
    expect(
      await screen.findByText("DEVICE_AVDMANAGER_PATH is not configured."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Could not create this AVD")).not.toBeInTheDocument();
  });
});
