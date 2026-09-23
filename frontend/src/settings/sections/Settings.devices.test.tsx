// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within, act } from "@testing-library/react";
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
// Mock WebSocket for the install/license WS hooks.
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
  triggerOpen() {
    this.readyState = 1;
    this.onopen?.();
  }
  triggerMessage(data: string) {
    this.onmessage?.({ data });
  }
  triggerError() {
    this.onerror?.();
  }
  triggerClose() {
    this.readyState = 3;
    this.onclose?.();
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.triggerClose();
  }
}

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
  let availableImagesDb: Array<{
    packagePath: string;
    apiLevel: string;
    tag: string;
    tagDisplay: string;
    abi: string;
    installed: boolean;
  }>;
  let availableImagesShouldFail: boolean;
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
    availableImagesDb = [
      {
        packagePath: "system-images;android-35;google_apis;x86_64",
        apiLevel: "35",
        tag: "google_apis",
        tagDisplay: "Google APIs",
        abi: "x86_64",
        installed: true,
      },
    ];
    availableImagesShouldFail = false;

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
      "PATCH /api/devices/:id": ({ params, init }) => {
        const id = Number(params.id);
        const existing = devicesDb.find((d) => d.id === id);
        if (!existing) return jsonResponse(404, { message: "not found" });
        const body = JSON.parse(init?.body as string) as { address?: string };
        // Mirrors routes/devices.ts's own PATCH handler: rewrites `serial`
        // in place, keeps `id`/`name`/`status`/`createdAt` unchanged.
        const updated: Device = { ...existing, serial: body.address ?? existing.serial };
        devicesDb = devicesDb.map((d) => (d.id === id ? updated : d));
        return jsonResponse(200, updated);
      },
      "GET /api/system-images/available": () =>
        availableImagesShouldFail
          ? jsonResponse(500, { message: "sdkmanager not found" })
          : jsonResponse(200, { systemImages: availableImagesDb }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    resetStore({ devices: [] });

    // Mock WebSocket for the system image install and SDK license hooks.
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
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

  // Issue #1347 — the regression this feature exists to prevent: editing a
  // physical device's address must update the SAME shared-store row (same
  // id/name), not delete-and-recreate it.
  it("editing a physical device's address updates the shared store's serial in place, keeping id/name unchanged", async () => {
    devicesDb = [
      {
        id: 1,
        hostId: "local",
        projectId: null,
        name: "My Pixel",
        kind: "physical",
        avdName: null,
        serial: "192.168.1.23:37251",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        live: null,
      },
    ];
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="devices" />);

    const row = await screen.findByTestId("device-row-1");
    await user.click(within(row).getByRole("button", { name: "Edit address" }));
    // Pre-filled with the existing address — clear before typing the new one.
    const input = screen.getByPlaceholderText("192.168.1.23:37251");
    await user.clear(input);
    await user.type(input, "192.168.1.23:41999");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(useDashboardStore.getState().devices).toEqual([
        expect.objectContaining({
          id: 1,
          name: "My Pixel",
          kind: "physical",
          serial: "192.168.1.23:41999",
          status: "active",
        }),
      ]);
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/devices/1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ address: "192.168.1.23:41999" }),
      }),
    );
  });

  it("an emulator device row shows no 'Edit address' button", async () => {
    devicesDb = [
      {
        id: 1,
        hostId: "local",
        projectId: null,
        name: "My Emulator",
        kind: "emulator",
        avdName: "pixel_7",
        serial: null,
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        live: null,
      },
    ];
    render(<Settings onClose={vi.fn()} initialSection="devices" />);

    const row = await screen.findByTestId("device-row-1");
    expect(within(row).queryByRole("button", { name: "Edit address" })).not.toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // SDK system images section
  // ---------------------------------------------------------------------------

  it("SDK section shows 'Load available images' button initially", async () => {
    render(<Settings onClose={vi.fn()} initialSection="devices" />);
    expect(
      await screen.findByRole("button", { name: "Load available images" }),
    ).toBeInTheDocument();
  });

  it("clicking 'Load available images' fetches and shows the list with Install/Uninstall buttons", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="devices" />);

    await user.click(await screen.findByRole("button", { name: "Load available images" }));

    // The installed image shows an Uninstall button; filter tabs appear.
    await waitFor(() => {
      expect(screen.getByText(/Google APIs/)).toBeInTheDocument();
    });
    expect(screen.getByText("Not installed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Uninstall/ })).toBeInTheDocument();
  });

  it("shows available images error when the fetch fails", async () => {
    availableImagesShouldFail = true;
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="devices" />);

    await user.click(screen.getByRole("button", { name: "Load available images" }));

    expect(await screen.findByText("sdkmanager not found")).toBeInTheDocument();
  });

  it("filter tabs switch between All / Not installed / Installed", async () => {
    availableImagesDb = [
      {
        packagePath: "system-images;android-35;google_apis;x86_64",
        apiLevel: "35",
        tag: "google_apis",
        tagDisplay: "Google APIs",
        abi: "x86_64",
        installed: true,
      },
      {
        packagePath: "system-images;android-35;google_apis;arm64-v8a",
        apiLevel: "35",
        tag: "google_apis",
        tagDisplay: "Google APIs",
        abi: "arm64-v8a",
        installed: false,
      },
    ];
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="devices" />);

    await user.click(await screen.findByRole("button", { name: "Load available images" }));

    // "All" is default — both images visible (wait for the list to load)
    await waitFor(() => {
      expect(screen.getAllByText(/Google APIs/).length).toBeGreaterThanOrEqual(2);
    });

    // "Not installed" filter — only arm64-v8a image remains
    await user.click(screen.getByRole("button", { name: "Not installed" }));
    await waitFor(() => {
      expect(screen.getAllByText(/arm64-v8a/).length).toBeGreaterThanOrEqual(1);
      expect(screen.queryByText(/x86_64.*Uninstall/)).not.toBeInTheDocument();
    });

    // "Installed" filter — only x86_64 image remains
    await user.click(screen.getByRole("button", { name: "Installed" }));
    await waitFor(() => {
      expect(screen.getAllByText(/x86_64/).length).toBeGreaterThanOrEqual(1);
      expect(screen.queryByText(/arm64-v8a.*Install/)).not.toBeInTheDocument();
    });
  });

  it("empty filter state shows correct message when no images match", async () => {
    availableImagesDb = [];
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="devices" />);

    await user.click(await screen.findByRole("button", { name: "Load available images" }));

    expect(await screen.findByText("No system images available.")).toBeInTheDocument();
  });

  it("installing an image opens the WS connection and shows progress", async () => {
    availableImagesDb = [
      {
        packagePath: "system-images;android-35;google_apis;x86_64",
        apiLevel: "35",
        tag: "google_apis",
        tagDisplay: "Google APIs",
        abi: "x86_64",
        installed: false,
      },
    ];
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="devices" />);

    await user.click(await screen.findByRole("button", { name: "Load available images" }));
    await user.click(await screen.findByRole("button", { name: "Install" }));

    // WS should have been created for the install operation
    await waitFor(() => {
      expect(
        MockWebSocket.instances.some((ws) => ws.url.includes("/ws/system-image-install")),
      ).toBe(true);
    });

    // Trigger the WS open and progress
    const installWs = MockWebSocket.instances.find((ws) =>
      ws.url.includes("/ws/system-image-install"),
    )!;
    act(() => installWs.triggerOpen());
    act(() =>
      installWs.triggerMessage(JSON.stringify({ type: "progress", message: "Installing..." })),
    );
    act(() => installWs.triggerMessage(JSON.stringify({ type: "progress", message: "Done." })));

    expect(screen.getByText("Installing...")).toBeInTheDocument();
    expect(screen.getByText("Done.")).toBeInTheDocument();
  });

  it("install done shows completion message", async () => {
    availableImagesDb = [
      {
        packagePath: "system-images;android-35;google_apis;x86_64",
        apiLevel: "35",
        tag: "google_apis",
        tagDisplay: "Google APIs",
        abi: "x86_64",
        installed: false,
      },
    ];
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="devices" />);

    await user.click(await screen.findByRole("button", { name: "Load available images" }));
    await user.click(await screen.findByRole("button", { name: "Install" }));

    const installWs = MockWebSocket.instances.find((ws) =>
      ws.url.includes("/ws/system-image-install"),
    )!;
    act(() => installWs.triggerOpen());
    act(() => installWs.triggerMessage(JSON.stringify({ type: "done" })));

    expect(await screen.findByText("Operation complete.")).toBeInTheDocument();
  });

  // Issue #1373 — a successful install must refresh the installed-image list
  // the New-AVD dropdown reads, so a freshly installed image appears without
  // reopening the form. Keep the previously selected image when it's still
  // present; fall back to the first entry when it isn't.
  it("install done refreshes the New-AVD system image dropdown without dropping the selection", async () => {
    availableImagesDb = [
      {
        packagePath: "system-images;android-36;google_apis_playstore;x86_64",
        apiLevel: "36",
        tag: "google_apis_playstore",
        tagDisplay: "Google Play Store",
        abi: "x86_64",
        installed: false,
      },
    ];
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="devices" />);

    await user.click(await screen.findByText("New device"));
    await user.click(screen.getByRole("button", { name: "+ New AVD" }));
    await screen.findByDisplayValue("API 35 — Google APIs (x86_64)"); // form loaded, selection = android-35

    await user.click(screen.getByRole("button", { name: "Load available images" }));
    await user.click(await screen.findByRole("button", { name: "Install" }));
    const installWs = MockWebSocket.instances.find((ws) =>
      ws.url.includes("/ws/system-image-install"),
    )!;
    act(() => installWs.triggerOpen());

    // Backend now has the new image on disk; done triggers the refetch.
    systemImagesDb = [
      ...systemImagesDb,
      {
        packagePath: "system-images;android-36;google_apis_playstore;x86_64",
        apiLevel: "36",
        tagDisplay: "Google Play Store",
        abi: "x86_64",
      },
    ];
    act(() => installWs.triggerMessage(JSON.stringify({ type: "done" })));

    expect(await screen.findByText("Operation complete.")).toBeInTheDocument();
    // Selection kept (still present), new image now offered in the dropdown.
    await waitFor(() => {
      const select = screen.getByDisplayValue("API 35 — Google APIs (x86_64)");
      expect(
        within(select).getByRole("option", {
          name: /API 36 — Google Play Store \(x86_64\)/,
        }),
      ).toBeInTheDocument();
    });
  });

  it("install done falls back to the first image when the previous selection vanished", async () => {
    availableImagesDb = [
      {
        packagePath: "system-images;android-36;google_apis;x86_64",
        apiLevel: "36",
        tag: "google_apis",
        tagDisplay: "Google APIs",
        abi: "x86_64",
        installed: false,
      },
    ];
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="devices" />);

    await user.click(await screen.findByText("New device"));
    await user.click(screen.getByRole("button", { name: "+ New AVD" }));
    await screen.findByDisplayValue("API 35 — Google APIs (x86_64)");

    await user.click(screen.getByRole("button", { name: "Load available images" }));
    await user.click(await screen.findByRole("button", { name: "Install" }));
    const installWs = MockWebSocket.instances.find((ws) =>
      ws.url.includes("/ws/system-image-install"),
    )!;
    act(() => installWs.triggerOpen());

    // Previous selection is no longer installed — only the new image remains.
    systemImagesDb = [
      {
        packagePath: "system-images;android-36;google_apis;x86_64",
        apiLevel: "36",
        tagDisplay: "Google APIs",
        abi: "x86_64",
      },
    ];
    act(() => installWs.triggerMessage(JSON.stringify({ type: "done" })));

    expect(await screen.findByText("Operation complete.")).toBeInTheDocument();
    expect(await screen.findByDisplayValue("API 36 — Google APIs (x86_64)")).toBeInTheDocument();
  });

  it("empty-state copy points at the SDK system images section when none are installed", async () => {
    systemImagesDb = [];
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="devices" />);

    await user.click(await screen.findByText("New device"));
    await user.click(screen.getByRole("button", { name: "+ New AVD" }));

    expect(
      await screen.findByText(/open “SDK system images” below and use Install to fetch one first/),
    ).toBeInTheDocument();
    expect(screen.queryByDisplayValue("API 35 — Google APIs (x86_64)")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create AVD" })).toBeDisabled();
  });

  // A name with spaces (e.g. "Pixel 10 Pro XL") fails AVD_NAME_PATTERN and
  // silently disables Create AVD — surface an inline error that names what's
  // wrong with this value (the Row desc already states the allowed set).
  it("shows an inline AVD-name validation error while the name has disallowed characters", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="devices" />);

    await user.click(await screen.findByText("New device"));
    await user.click(screen.getByRole("button", { name: "+ New AVD" }));
    await screen.findByDisplayValue("pixel_6");

    const nameInput = screen.getByPlaceholderText("Pixel_8_API_35");
    await user.type(nameInput, "Pixel 10 Pro XL");
    expect(await screen.findByText(/contains space — remove it\./)).toBeInTheDocument();
    expect(nameInput).toHaveAttribute("aria-invalid", "true");
    expect(nameInput).toHaveAttribute("aria-describedby", "new-avd-name-error");
    expect(screen.getByRole("button", { name: "Create AVD" })).toBeDisabled();

    // Clearing back to a valid name hides the error again.
    await user.clear(nameInput);
    await user.type(nameInput, "Pixel_10_Pro_XL");
    await waitFor(() => {
      expect(screen.queryByText(/contains/)).not.toBeInTheDocument();
    });
    expect(nameInput).toHaveAttribute("aria-invalid", "false");
    expect(nameInput).not.toHaveAttribute("aria-describedby");
    expect(screen.getByRole("button", { name: "Create AVD" })).toBeEnabled();
  });

  it("names the value when it has no letter or digit", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="devices" />);

    await user.click(await screen.findByText("New device"));
    await user.click(screen.getByRole("button", { name: "+ New AVD" }));
    await screen.findByDisplayValue("pixel_6");

    // "___" passes AVD_NAME_PATTERN but fails AVD_NAME_HAS_ALPHANUMERIC.
    await user.type(screen.getByPlaceholderText("Pixel_8_API_35"), "___");
    expect(
      await screen.findByText(/“___” needs at least one letter or digit\./),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create AVD" })).toBeDisabled();
  });

  it("does not show the name validation error while the field is still empty", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="devices" />);

    await user.click(await screen.findByText("New device"));
    await user.click(screen.getByRole("button", { name: "+ New AVD" }));
    await screen.findByDisplayValue("pixel_6");

    expect(screen.queryByText(/contains|needs at least one/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create AVD" })).toBeDisabled();
  });

  it("install error shows the error message", async () => {
    availableImagesDb = [
      {
        packagePath: "system-images;android-35;google_apis;x86_64",
        apiLevel: "35",
        tag: "google_apis",
        tagDisplay: "Google APIs",
        abi: "x86_64",
        installed: false,
      },
    ];
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="devices" />);

    await user.click(await screen.findByRole("button", { name: "Load available images" }));
    await user.click(await screen.findByRole("button", { name: "Install" }));

    const installWs = MockWebSocket.instances.find((ws) =>
      ws.url.includes("/ws/system-image-install"),
    )!;
    act(() => installWs.triggerOpen());
    act(() =>
      installWs.triggerMessage(JSON.stringify({ type: "error", message: "Package not found" })),
    );

    expect(await screen.findByText("Package not found")).toBeInTheDocument();
  });
  it("license modal appears on license rejection error from install", async () => {
    availableImagesDb = [
      {
        packagePath: "system-images;android-35;google_apis;x86_64",
        apiLevel: "35",
        tag: "google_apis",
        tagDisplay: "Google APIs",
        abi: "x86_64",
        installed: false,
      },
    ];
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="devices" />);

    await user.click(await screen.findByRole("button", { name: "Load available images" }));
    await user.click(await screen.findByRole("button", { name: "Install" }));

    // Install WS opens first
    await waitFor(() => {
      expect(
        MockWebSocket.instances.some((ws) => ws.url.includes("/ws/system-image-install")),
      ).toBe(true);
    });
    const installWs = MockWebSocket.instances.find((ws) =>
      ws.url.includes("/ws/system-image-install"),
    )!;
    act(() => installWs.triggerOpen());
    act(() =>
      installWs.triggerMessage(
        JSON.stringify({ type: "error", message: "licenses not accepted", code: "license" }),
      ),
    );

    // License modal should appear after the license-related error
    expect(await screen.findByText("Accept SDK licenses")).toBeInTheDocument();
    expect(screen.getByText(/Some SDK packages require accepting/)).toBeInTheDocument();
  });

  it("clicking 'Accept licenses' in modal opens the license WS", async () => {
    availableImagesDb = [
      {
        packagePath: "system-images;android-35;google_apis;x86_64",
        apiLevel: "35",
        tag: "google_apis",
        tagDisplay: "Google APIs",
        abi: "x86_64",
        installed: false,
      },
    ];
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="devices" />);

    await user.click(await screen.findByRole("button", { name: "Load available images" }));
    await user.click(await screen.findByRole("button", { name: "Install" }));

    // Trigger install WS with license error
    await waitFor(() => {
      expect(
        MockWebSocket.instances.some((ws) => ws.url.includes("/ws/system-image-install")),
      ).toBe(true);
    });
    const installWs = MockWebSocket.instances.find((ws) =>
      ws.url.includes("/ws/system-image-install"),
    )!;
    act(() => installWs.triggerOpen());
    act(() =>
      installWs.triggerMessage(
        JSON.stringify({
          type: "error",
          message: "Accept? (y/N): licenses not accepted",
          code: "license",
        }),
      ),
    );
    await screen.findByText("Accept SDK licenses");

    await user.click(screen.getByRole("button", { name: "Accept licenses" }));

    // License WS should have been created for the license operation
    await waitFor(() => {
      expect(MockWebSocket.instances.some((ws) => ws.url.includes("/ws/sdk-licenses"))).toBe(true);
    });

    const licenseWs = MockWebSocket.instances.find((ws) => ws.url.includes("/ws/sdk-licenses"))!;
    act(() => licenseWs.triggerOpen());
    expect(licenseWs.sent).toEqual([JSON.stringify({ type: "accept-licenses" })]);
  });

  it("license accept done closes modal and triggers install retry", async () => {
    availableImagesDb = [
      {
        packagePath: "system-images;android-35;google_apis;x86_64",
        apiLevel: "35",
        tag: "google_apis",
        tagDisplay: "Google APIs",
        abi: "x86_64",
        installed: false,
      },
    ];
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="devices" />);

    await user.click(await screen.findByRole("button", { name: "Load available images" }));
    await user.click(await screen.findByRole("button", { name: "Install" }));

    // Trigger install WS with license error
    await waitFor(() => {
      expect(
        MockWebSocket.instances.some((ws) => ws.url.includes("/ws/system-image-install")),
      ).toBe(true);
    });
    const installWs = MockWebSocket.instances.find((ws) =>
      ws.url.includes("/ws/system-image-install"),
    )!;
    act(() => installWs.triggerOpen());
    act(() =>
      installWs.triggerMessage(
        JSON.stringify({ type: "error", message: "license acceptance required", code: "license" }),
      ),
    );
    await screen.findByText("Accept SDK licenses");

    await user.click(screen.getByRole("button", { name: "Accept licenses" }));

    const licenseWs = MockWebSocket.instances.find((ws) => ws.url.includes("/ws/sdk-licenses"))!;
    act(() => licenseWs.triggerOpen());
    act(() => licenseWs.triggerMessage(JSON.stringify({ type: "done" })));

    // Modal should close, license WS done triggers install retry
    await waitFor(() => {
      expect(screen.queryByText("Accept SDK licenses")).not.toBeInTheDocument();
    });

    // A second install WS should have been created for the retry
    await waitFor(() => {
      const installWsInstances = MockWebSocket.instances.filter((ws) =>
        ws.url.includes("/ws/system-image-install"),
      );
      expect(installWsInstances.length).toBe(2);
    });
  });

  it("non-license install error does not open the license modal", async () => {
    availableImagesDb = [
      {
        packagePath: "system-images;android-35;google_apis;x86_64",
        apiLevel: "35",
        tag: "google_apis",
        tagDisplay: "Google APIs",
        abi: "x86_64",
        installed: false,
      },
    ];
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="devices" />);

    await user.click(await screen.findByRole("button", { name: "Load available images" }));
    await user.click(await screen.findByRole("button", { name: "Install" }));

    // Trigger install WS with a non-license error
    await waitFor(() => {
      expect(
        MockWebSocket.instances.some((ws) => ws.url.includes("/ws/system-image-install")),
      ).toBe(true);
    });
    const installWs = MockWebSocket.instances.find((ws) =>
      ws.url.includes("/ws/system-image-install"),
    )!;
    act(() => installWs.triggerOpen());
    act(() =>
      installWs.triggerMessage(
        JSON.stringify({ type: "error", message: "Package not found in repository" }),
      ),
    );

    // No license modal should appear for a non-license error
    await waitFor(() => {
      expect(screen.queryByText("Accept SDK licenses")).not.toBeInTheDocument();
    });
  });
});
