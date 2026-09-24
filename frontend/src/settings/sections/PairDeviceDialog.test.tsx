// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DISCOVERY_POLL_MS, DISCOVERY_TIMEOUT_MS, PairDeviceDialog } from "./PairDeviceDialog.js";
import { api, ApiError } from "../../api/index.js";
import type { Device, DiscoveredDevice } from "../../api/index.js";
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
});
