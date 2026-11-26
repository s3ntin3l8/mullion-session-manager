// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { Presence } from "../../ui/Presence.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DISCOVERY_POLL_MS, DISCOVERY_TIMEOUT_MS, PairDeviceDialog } from "./PairDeviceDialog.js";
import { api, ApiError } from "../../api/index.js";
import type { Device, DeviceHostEntry, DiscoveredDevice } from "../../api/index.js";
import { pickDropdownOption } from "../../test/dropdown.js";
import type * as ApiModule from "../../api/index.js";
import { resetStore } from "../../test/resetStore.js";

vi.mock("../../api/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof ApiModule>();
  return {
    ...original,
    api: {
      ...original.api,
      listDiscoveredDevices: vi.fn(),
      pairAndConnectDevice: vi.fn(),
      listDevices: vi.fn(),
    },
  };
});

function discovered(overrides: Partial<DiscoveredDevice> = {}): DiscoveredDevice {
  return {
    id: "192.168.1.23",
    name: "Pixel 7",
    host: "192.168.1.23",
    pairingAddress: "192.168.1.23:41234",
    connectAddress: "192.168.1.23:37251",
    discoveredAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const pairedDevice: Device = {
  id: 1,
  hostId: "local",
  projectId: null,
  name: null,
  platform: "android",
  kind: "physical",
  avdName: null,
  serial: "192.168.1.23:37251",
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  live: null,
};

const submitButton = () => screen.getByRole("button", { name: "Pair & Connect" });
const typeInto = (placeholder: string, value: string) =>
  fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value } });

describe("PairDeviceDialog (issue #1379)", () => {
  beforeEach(() => {
    resetStore({ devices: [] });
    vi.mocked(api.listDiscoveredDevices).mockResolvedValue([]);
    vi.mocked(api.pairAndConnectDevice).mockResolvedValue(pairedDevice);
    vi.mocked(api.listDevices).mockResolvedValue([pairedDevice]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("shows the scanning state first", () => {
    render(<PairDeviceDialog onClose={vi.fn()} onPaired={vi.fn()} />);
    expect(screen.getByText("Looking for nearby devices…")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("192.168.1.23:41234")).not.toBeInTheDocument();
    expect(submitButton()).toBeDisabled();
  });

  it("lists discovered devices and disables connect-only entries", async () => {
    vi.mocked(api.listDiscoveredDevices).mockResolvedValue([
      discovered(),
      discovered({
        id: "192.168.1.40",
        name: "Galaxy Tab",
        host: "192.168.1.40",
        pairingAddress: undefined,
        connectAddress: "192.168.1.40:39000",
      }),
    ]);
    render(<PairDeviceDialog onClose={vi.fn()} onPaired={vi.fn()} />);

    const pixel = await screen.findByRole("radio", { name: /Pixel 7 · 192\.168\.1\.23/ });
    const tab = screen.getByRole("radio", { name: /Galaxy Tab · 192\.168\.1\.40/ });
    expect(pixel).toBeEnabled();
    expect(tab).toBeDisabled();
    expect(screen.getByText(/Open “Pair device with pairing code” on the phone/)).toBeVisible();
    // Only one pairable entry, so it's picked without a click.
    expect(pixel).toBeChecked();
  });

  it("falls back to the host when the entry has no name", async () => {
    vi.mocked(api.listDiscoveredDevices).mockResolvedValue([discovered({ name: "" })]);
    render(<PairDeviceDialog onClose={vi.fn()} onPaired={vi.fn()} />);
    expect(await screen.findByRole("radio", { name: "192.168.1.23" })).toBeInTheDocument();
  });

  it("pairs a discovered device with just its id and the code", async () => {
    vi.mocked(api.listDiscoveredDevices).mockResolvedValue([discovered()]);
    const onPaired = vi.fn();
    render(<PairDeviceDialog onClose={vi.fn()} onPaired={onPaired} />);

    await screen.findByRole("radio", { name: /Pixel 7/ });
    typeInto("123456", "12345");
    expect(submitButton()).toBeDisabled();
    typeInto("123456", "123456");
    fireEvent.click(submitButton());

    await waitFor(() => expect(onPaired).toHaveBeenCalledTimes(1));
    expect(api.pairAndConnectDevice).toHaveBeenCalledWith({
      discoveryId: "192.168.1.23",
      pairingCode: "123456",
      name: undefined,
    });
    // The store refresh is what makes the new row show up in the list.
    await waitFor(() => expect(api.listDevices).toHaveBeenCalled());
  });

  it("sends the picked entry and optional name when several devices are found", async () => {
    vi.mocked(api.listDiscoveredDevices).mockResolvedValue([
      discovered(),
      discovered({ id: "192.168.1.50", name: "Pixel 9", host: "192.168.1.50" }),
    ]);
    render(<PairDeviceDialog onClose={vi.fn()} onPaired={vi.fn()} />);

    const second = await screen.findByRole("radio", { name: /Pixel 9/ });
    // Two candidates — nothing is picked for the user, so no form yet.
    expect(screen.queryByPlaceholderText("123456")).not.toBeInTheDocument();
    fireEvent.click(second);
    typeInto("123456", "654321");
    typeInto("My Pixel", "  Desk phone  ");
    fireEvent.keyDown(screen.getByPlaceholderText("My Pixel"), { key: "Enter" });

    await waitFor(() =>
      expect(api.pairAndConnectDevice).toHaveBeenCalledWith({
        discoveryId: "192.168.1.50",
        pairingCode: "654321",
        name: "Desk phone",
      }),
    );
  });

  it("asks for the device address when discovery never saw the connect service", async () => {
    vi.mocked(api.listDiscoveredDevices).mockResolvedValue([
      discovered({ connectAddress: undefined }),
    ]);
    render(<PairDeviceDialog onClose={vi.fn()} onPaired={vi.fn()} />);

    await screen.findByRole("radio", { name: /Pixel 7/ });
    typeInto("123456", "123456");
    expect(submitButton()).toBeDisabled();
    typeInto("192.168.1.23:37251", " 192.168.1.23:40000 ");
    fireEvent.click(submitButton());

    await waitFor(() =>
      expect(api.pairAndConnectDevice).toHaveBeenCalledWith({
        discoveryId: "192.168.1.23",
        pairingCode: "123456",
        name: undefined,
        connectAddress: "192.168.1.23:40000",
      }),
    );
  });

  it("keeps the auto-picked phone selected when a second one shows up mid-typing", async () => {
    vi.useFakeTimers();
    vi.mocked(api.listDiscoveredDevices)
      .mockResolvedValueOnce([discovered()])
      .mockResolvedValue([
        discovered(),
        discovered({ id: "192.168.1.50", name: "Pixel 9", host: "192.168.1.50" }),
      ]);
    render(<PairDeviceDialog onClose={vi.fn()} onPaired={vi.fn()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    typeInto("123456", "123");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DISCOVERY_POLL_MS);
    });
    expect(screen.getByRole("radio", { name: /Pixel 9/ })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: /Pixel 7/ })).toBeChecked();
    expect(screen.getByPlaceholderText("123456")).toHaveValue("123");
  });

  it("clears the selection when the picked phone drops off the scan", async () => {
    vi.useFakeTimers();
    vi.mocked(api.listDiscoveredDevices)
      .mockResolvedValueOnce([discovered()])
      .mockResolvedValue([discovered({ pairingAddress: undefined })]);
    render(<PairDeviceDialog onClose={vi.fn()} onPaired={vi.fn()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("radio", { name: /Pixel 7/ })).toBeChecked();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DISCOVERY_POLL_MS);
    });
    expect(screen.getByRole("radio", { name: /Pixel 7/ })).not.toBeChecked();
    expect(screen.queryByPlaceholderText("123456")).not.toBeInTheDocument();
  });

  it("hiding the manual form re-selects a lone discovered phone immediately", async () => {
    vi.mocked(api.listDiscoveredDevices).mockResolvedValue([discovered()]);
    render(<PairDeviceDialog onClose={vi.fn()} onPaired={vi.fn()} />);
    const pixel = await screen.findByRole("radio", { name: /Pixel 7/ });
    fireEvent.click(screen.getByRole("button", { name: "Pair manually" }));
    expect(pixel).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Hide manual pairing" }));
    expect(pixel).toBeChecked();
  });

  it("drops a typed device address when the selection migrates to another phone", async () => {
    vi.useFakeTimers();
    vi.mocked(api.listDiscoveredDevices)
      .mockResolvedValueOnce([discovered({ connectAddress: undefined })])
      .mockResolvedValue([
        discovered({ pairingAddress: undefined }),
        discovered({ id: "192.168.1.50", name: "Pixel 9", host: "192.168.1.50" }),
      ]);
    render(<PairDeviceDialog onClose={vi.fn()} onPaired={vi.fn()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    typeInto("192.168.1.23:37251", "192.168.1.23:40000");
    typeInto("123456", "123456");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DISCOVERY_POLL_MS);
    });
    expect(screen.getByRole("radio", { name: /Pixel 9/ })).toBeChecked();
    // Pixel 9 advertised its connect port, so no override field is shown.
    expect(screen.queryByPlaceholderText("192.168.1.23:37251")).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(submitButton());
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(api.pairAndConnectDevice).toHaveBeenCalledWith({
      discoveryId: "192.168.1.50",
      pairingCode: "123456",
      name: undefined,
    });
  });

  it("keeps an auto-opened manual form open when a phone shows up later", async () => {
    vi.useFakeTimers();
    vi.mocked(api.listDiscoveredDevices).mockResolvedValue([]);
    render(<PairDeviceDialog onClose={vi.fn()} onPaired={vi.fn()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DISCOVERY_TIMEOUT_MS);
    });
    typeInto("192.168.1.23:41234", "10.0.0.5:41234");

    vi.mocked(api.listDiscoveredDevices).mockResolvedValue([discovered()]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DISCOVERY_POLL_MS);
    });
    const pixel = screen.getByRole("radio", { name: /Pixel 7/ });
    expect(pixel).not.toBeChecked();
    expect(screen.getByPlaceholderText("192.168.1.23:41234")).toHaveValue("10.0.0.5:41234");

    // Picking the phone is still one click away.
    fireEvent.click(pixel);
    expect(pixel).toBeChecked();
    expect(screen.queryByPlaceholderText("192.168.1.23:41234")).not.toBeInTheDocument();
  });

  it("strips non-digits from the pairing code", async () => {
    vi.mocked(api.listDiscoveredDevices).mockResolvedValue([discovered()]);
    render(<PairDeviceDialog onClose={vi.fn()} onPaired={vi.fn()} />);
    await screen.findByRole("radio", { name: /Pixel 7/ });
    typeInto("123456", "12a-34 5");
    expect(screen.getByPlaceholderText("123456")).toHaveValue("12345");
  });

  it("opens the manual form on its own once the scan times out empty-handed", async () => {
    vi.useFakeTimers();
    render(<PairDeviceDialog onClose={vi.fn()} onPaired={vi.fn()} />);
    expect(screen.queryByPlaceholderText("192.168.1.23:41234")).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DISCOVERY_TIMEOUT_MS);
    });

    expect(screen.getByText(/No devices found yet — still looking/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText("192.168.1.23:41234")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("192.168.1.23:37251")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("123456")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide manual pairing" })).toBeInTheDocument();
  });

  it("manual pairing posts both addresses and the code", async () => {
    vi.mocked(api.listDiscoveredDevices).mockResolvedValue([discovered()]);
    const onPaired = vi.fn();
    render(<PairDeviceDialog onClose={vi.fn()} onPaired={onPaired} />);

    const pixel = await screen.findByRole("radio", { name: /Pixel 7/ });
    fireEvent.click(screen.getByRole("button", { name: "Pair manually" }));
    expect(pixel).not.toBeChecked();

    typeInto("192.168.1.23:41234", " 10.0.0.5:41234 ");
    typeInto("123456", "123456");
    // Both addresses are required by pair-and-connect's manual mode.
    expect(submitButton()).toBeDisabled();
    typeInto("192.168.1.23:37251", "10.0.0.5:37251");
    fireEvent.click(submitButton());

    await waitFor(() => expect(onPaired).toHaveBeenCalled());
    expect(api.pairAndConnectDevice).toHaveBeenCalledWith({
      pairingAddress: "10.0.0.5:41234",
      connectAddress: "10.0.0.5:37251",
      pairingCode: "123456",
      name: undefined,
    });
  });

  it("picking a discovered device again closes the manual form", async () => {
    vi.mocked(api.listDiscoveredDevices).mockResolvedValue([discovered()]);
    render(<PairDeviceDialog onClose={vi.fn()} onPaired={vi.fn()} />);

    const pixel = await screen.findByRole("radio", { name: /Pixel 7/ });
    fireEvent.click(screen.getByRole("button", { name: "Pair manually" }));
    expect(screen.getByPlaceholderText("192.168.1.23:41234")).toBeInTheDocument();
    fireEvent.click(pixel);
    expect(screen.queryByPlaceholderText("192.168.1.23:41234")).not.toBeInTheDocument();
    expect(pixel).toBeChecked();
  });

  it("shows the server's error and keeps the dialog open for a retry", async () => {
    vi.mocked(api.listDiscoveredDevices).mockResolvedValue([discovered()]);
    vi.mocked(api.pairAndConnectDevice).mockRejectedValue(
      new ApiError("adb pair failed: wrong pairing code", 400),
    );
    const onPaired = vi.fn();
    render(<PairDeviceDialog onClose={vi.fn()} onPaired={onPaired} />);

    await screen.findByRole("radio", { name: /Pixel 7/ });
    typeInto("123456", "123456");
    fireEvent.click(submitButton());

    expect(await screen.findByText("adb pair failed: wrong pairing code")).toBeInTheDocument();
    expect(onPaired).not.toHaveBeenCalled();
    // Every error response rolled its row back server-side — nothing to refresh.
    expect(api.listDevices).not.toHaveBeenCalled();
    expect(submitButton()).toBeEnabled();
  });

  it("uses a generic message for non-API errors", async () => {
    vi.mocked(api.listDiscoveredDevices).mockResolvedValue([discovered()]);
    vi.mocked(api.pairAndConnectDevice).mockRejectedValue(new Error("boom"));
    render(<PairDeviceDialog onClose={vi.fn()} onPaired={vi.fn()} />);

    await screen.findByRole("radio", { name: /Pixel 7/ });
    typeInto("123456", "123456");
    fireEvent.click(submitButton());
    expect(await screen.findByText("Could not pair this device")).toBeInTheDocument();
  });

  it("keeps the last snapshot when a scan request fails", async () => {
    vi.useFakeTimers();
    vi.mocked(api.listDiscoveredDevices)
      .mockResolvedValueOnce([discovered()])
      .mockRejectedValueOnce(new Error("network"));
    render(<PairDeviceDialog onClose={vi.fn()} onPaired={vi.fn()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("radio", { name: /Pixel 7/ })).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DISCOVERY_POLL_MS);
    });
    expect(api.listDiscoveredDevices).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("radio", { name: /Pixel 7/ })).toBeInTheDocument();
  });

  it("stops scanning once unmounted", async () => {
    vi.useFakeTimers();
    const { unmount } = render(<PairDeviceDialog onClose={vi.fn()} onPaired={vi.fn()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DISCOVERY_POLL_MS);
    });
    const calls = vi.mocked(api.listDiscoveredDevices).mock.calls.length;
    expect(calls).toBe(2);
    unmount();
    await vi.advanceTimersByTimeAsync(DISCOVERY_POLL_MS * 3);
    expect(api.listDiscoveredDevices).toHaveBeenCalledTimes(calls);
  });

  it("closes from Cancel and the backdrop, but not from a click inside", () => {
    const onClose = vi.fn();
    const { container } = render(<PairDeviceDialog onClose={onClose} onPaired={vi.fn()} />);
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(container.querySelector(".create-modal-backdrop") as Element);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
  describe("host picker (#3399)", () => {
    const hosts: DeviceHostEntry[] = [
      {
        hostId: "local",
        name: "This machine",
        status: "ok",
        deviceKinds: ["physical"],
        platforms: [],
      },
      { hostId: "h-pi", name: "Pi", status: "ok", deviceKinds: ["physical"], platforms: [] },
      { hostId: "h-old", name: "Old", status: "unsupported", deviceKinds: [], platforms: [] },
    ];

    it("shows no picker with a single host and lists on the primary", async () => {
      render(<PairDeviceDialog deviceHosts={[hosts[0]]} onClose={vi.fn()} onPaired={vi.fn()} />);
      await waitFor(() => expect(api.listDiscoveredDevices).toHaveBeenCalledWith("local"));
      expect(screen.queryByRole("combobox", { name: "Host" })).not.toBeInTheDocument();
    });

    it("defaults to the first host that can pair when the primary can't", async () => {
      const noAdbLocal: DeviceHostEntry[] = [{ ...hosts[0], deviceKinds: [] }, hosts[1]];
      render(<PairDeviceDialog deviceHosts={noAdbLocal} onClose={vi.fn()} onPaired={vi.fn()} />);
      await waitFor(() => expect(api.listDiscoveredDevices).toHaveBeenCalledWith("h-pi"));
      expect(api.listDiscoveredDevices).not.toHaveBeenCalledWith("local");
    });

    it("keeps an explicitly chosen host when it later turns unreachable", async () => {
      const { rerender } = render(
        <PairDeviceDialog deviceHosts={hosts} onClose={vi.fn()} onPaired={vi.fn()} />,
      );
      pickDropdownOption(await screen.findByRole("combobox", { name: "Host" }), "h-pi");
      await waitFor(() => expect(api.listDiscoveredDevices).toHaveBeenCalledWith("h-pi"));
      vi.mocked(api.listDiscoveredDevices).mockClear();
      rerender(
        <PairDeviceDialog
          deviceHosts={[hosts[0], { ...hosts[1], status: "unreachable" }]}
          onClose={vi.fn()}
          onPaired={vi.fn()}
        />,
      );
      await waitFor(() => expect(api.listDiscoveredDevices).toHaveBeenCalledWith("h-pi"), {
        timeout: DISCOVERY_POLL_MS * 2,
      });
      expect(api.listDiscoveredDevices).not.toHaveBeenCalledWith("local");
    });

    it("lists on and pairs through the chosen agent host", async () => {
      vi.mocked(api.listDiscoveredDevices).mockImplementation(async (hostId) =>
        hostId === "h-pi" ? [discovered({ name: "Remote Pixel" })] : [],
      );
      render(<PairDeviceDialog deviceHosts={hosts} onClose={vi.fn()} onPaired={vi.fn()} />);
      pickDropdownOption(await screen.findByRole("combobox", { name: "Host" }), "h-pi");

      await screen.findByRole("radio", { name: /Remote Pixel/ });
      expect(api.listDiscoveredDevices).toHaveBeenCalledWith("h-pi");
      typeInto("123456", "123456");
      fireEvent.click(submitButton());
      await waitFor(() =>
        expect(api.pairAndConnectDevice).toHaveBeenCalledWith({
          discoveryId: "192.168.1.23",
          pairingCode: "123456",
          name: undefined,
          hostId: "h-pi",
        }),
      );
    });

    it("shows the backend's message when the agent can't list (503/400) and clears it on a good scan", async () => {
      vi.mocked(api.listDiscoveredDevices).mockImplementation(async (hostId) => {
        if (hostId === "h-pi") throw new ApiError("Host h-pi is unreachable", 503);
        return [];
      });
      render(<PairDeviceDialog deviceHosts={hosts} onClose={vi.fn()} onPaired={vi.fn()} />);
      pickDropdownOption(await screen.findByRole("combobox", { name: "Host" }), "h-pi");
      expect(await screen.findByText("Host h-pi is unreachable")).toBeInTheDocument();
      expect(screen.queryByText(/No devices found yet/)).not.toBeInTheDocument();

      pickDropdownOption(screen.getByRole("combobox", { name: "Host" }), "local");
      await waitFor(() =>
        expect(screen.queryByText("Host h-pi is unreachable")).not.toBeInTheDocument(),
      );
    });

    it("surfaces a 400 (outdated agent) the same way", async () => {
      vi.mocked(api.listDiscoveredDevices).mockRejectedValue(
        new ApiError("Host h-pi does not report device support", 400),
      );
      render(<PairDeviceDialog deviceHosts={hosts} onClose={vi.fn()} onPaired={vi.fn()} />);
      expect(
        await screen.findByText("Host h-pi does not report device support"),
      ).toBeInTheDocument();
    });
  });
  // #3453 — mounted through <Presence> as DevicesSection does.
  describe("exit through Presence (#3453)", () => {
    function Harness({ onPaired }: { onPaired: () => void }) {
      const [open, setOpen] = useState(true);
      return (
        <Presence when={open}>
          <PairDeviceDialog
            onClose={() => setOpen(false)}
            onPaired={() => {
              onPaired();
              setOpen(false);
            }}
          />
        </Presence>
      );
    }
    const pairIt = async (onPaired: () => void) => {
      vi.mocked(api.listDiscoveredDevices).mockResolvedValue([discovered()]);
      render(<Harness onPaired={onPaired} />);
      await screen.findByRole("radio", { name: /Pixel 7/ });
      typeInto("123456", "123456");
      fireEvent.click(submitButton());
    };

    it("plays the exit after a successful pairing, then unmounts; onPaired runs at once", async () => {
      const { installExitAnimations } = await import("../../test/exitAnimations.js");
      const exits = installExitAnimations();
      try {
        const onPaired = vi.fn();
        await pairIt(onPaired);
        const dialog = await screen.findByRole("dialog", { name: "Pair a phone or tablet" });
        const backdrop = dialog.closest(".create-modal-backdrop") as HTMLElement;
        await waitFor(() => expect(backdrop).toHaveAttribute("data-presence", "leaving"));
        expect(onPaired).toHaveBeenCalledTimes(1);
        expect(backdrop).toHaveAttribute("inert");
        await exits.finishExits();
        expect(backdrop).not.toBeInTheDocument();
      } finally {
        exits.restore();
      }
    });

    it("its own dismiss controls call onClose directly and Presence plays the exit", async () => {
      const { installExitAnimations } = await import("../../test/exitAnimations.js");
      const exits = installExitAnimations();
      try {
        render(<Harness onPaired={vi.fn()} />);
        const backdrop = (await screen.findByRole("dialog")).closest(
          ".create-modal-backdrop",
        ) as HTMLElement;
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(backdrop).toHaveAttribute("data-presence", "leaving");
        await exits.finishExits();
        expect(backdrop).not.toBeInTheDocument();
      } finally {
        exits.restore();
      }
    });

    it("closes at once under reduced motion", async () => {
      const { installExitAnimations } = await import("../../test/exitAnimations.js");
      const exits = installExitAnimations();
      vi.stubGlobal("matchMedia", (query: string) => ({
        matches: query === "(prefers-reduced-motion: reduce)",
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
      }));
      try {
        await pairIt(vi.fn());
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      } finally {
        vi.unstubAllGlobals();
        exits.restore();
      }
    });
  });
});
