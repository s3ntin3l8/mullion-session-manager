// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PairBridgeModal } from "./PairBridgeModal.js";
import { api } from "./api/index.js";
import type * as ApiModule from "./api/index.js";

vi.mock("./api/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof ApiModule>();
  return { ...original, api: { ...original.api, pairBridge: vi.fn(), listBridges: vi.fn() } };
});

const pairing = {
  bridge_id: "bridge-1",
  pairing_payload: "test-pairing-payload",
  expires_at: new Date(Date.now() + 600_000).toISOString(),
};

describe("PairBridgeModal", () => {
  afterEach(() => vi.useRealTimers());

  beforeEach(() => {
    vi.mocked(api.pairBridge).mockResolvedValue(pairing);
    vi.mocked(api.listBridges).mockResolvedValue([]);
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  it("directs users to Mullion Helper and copies only the payload", async () => {
    render(<PairBridgeModal onClose={vi.fn()} onPaired={vi.fn()} />);
    expect(await screen.findByText(pairing.pairing_payload)).toBeVisible();
    expect(screen.getByRole("link", { name: "Install Mullion Helper" })).toHaveAttribute(
      "href",
      "https://github.com/s3ntin3l8/mullion-helper/releases/latest",
    );
    expect(screen.queryByText(/helper pair/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy payload" }));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(pairing.pairing_payload),
    );
  });

  it("reports the paired and connected transitions", async () => {
    vi.useFakeTimers();
    const onPaired = vi.fn();
    vi.mocked(api.listBridges).mockResolvedValue([
      {
        id: "bridge-1",
        name: "Laptop",
        platform: "darwin",
        connected: true,
        hasLiveSession: true,
        lastSeenAt: null,
        createdAt: new Date().toISOString(),
      },
    ]);
    render(<PairBridgeModal onClose={vi.fn()} onPaired={onPaired} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText(pairing.pairing_payload)).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByText(/Connected/)).toBeVisible();
    expect(onPaired).toHaveBeenCalledOnce();
  });
});
