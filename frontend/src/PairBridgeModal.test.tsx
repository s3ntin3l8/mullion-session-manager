// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PairBridgeModal } from "./PairBridgeModal.js";
import { jsonResponse } from "./test/jsonResponse.js";

// Real timers throughout — same reasoning as GitHubDeviceFlowModal.test.tsx:
// the component's 2s poll interval collides with fake timers, so tests
// that need a poll tick accept the real ~2s wall-clock cost via a bumped
// waitFor timeout.

const PAIRING = {
  bridge_id: "bridge-1",
  // Not a real base64url payload — this test never decodes it, only
  // asserts it round-trips into the copy-command text verbatim.
  pairing_payload: "fake-pairing-payload-for-tests-only",
  expires_at: "2026-01-01T00:10:00.000Z",
};

// Mirrors what the real backend actually returns for a freshly-issued,
// not-yet-redeemed pairing row (issuePairingCode only sets pairing
// fields — see src/routes/agent-bridge.ts) — hasLiveSession/lastSeenAt
// both flip together, in the same DB transaction, only once the helper
// actually redeems the code (bridge-registry.ts's redeemPairingCode).
function bridgeList(overrides: Partial<Record<string, unknown>> = {}) {
  return [
    {
      id: "bridge-1",
      name: null,
      platform: null,
      lastSeenAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      hasLiveSession: false,
      connected: false,
      ...overrides,
    },
  ];
}

describe("PairBridgeModal", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let listResponses: Array<Array<Record<string, unknown>>>;

  beforeEach(() => {
    listResponses = [];
    fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/bridges" && method === "POST") {
        return Promise.resolve(jsonResponse(200, PAIRING));
      }
      if (url === "/api/bridges" && method === "GET") {
        const next = listResponses.shift() ?? bridgeList();
        return Promise.resolve(jsonResponse(200, next));
      }
      return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("generates a pairing code on mount and shows the paste-able command", async () => {
    render(<PairBridgeModal onClose={vi.fn()} onPaired={vi.fn()} />);

    expect(
      await screen.findByText(`mullion helper pair ${PAIRING.pairing_payload}`),
    ).toBeInTheDocument();
  });

  it("polls GET /api/bridges and calls onPaired once this bridge id shows connected", async () => {
    const onPaired = vi.fn();
    render(<PairBridgeModal onClose={vi.fn()} onPaired={onPaired} />);
    await screen.findByText(`mullion helper pair ${PAIRING.pairing_payload}`);

    listResponses.push(
      bridgeList({ connected: true, hasLiveSession: true, lastSeenAt: "2026-01-01T00:00:00.000Z" }),
    );
    await waitFor(() => expect(onPaired).toHaveBeenCalled(), { timeout: 4000 });
    expect(
      await screen.findByText(/Connected — this bridge is ready to forward/, {}, { timeout: 4000 }),
    ).toBeInTheDocument();
  }, 8000);

  it("does not call onPaired for a different bridge id showing connected", async () => {
    const onPaired = vi.fn();
    render(<PairBridgeModal onClose={vi.fn()} onPaired={onPaired} />);
    await screen.findByText(`mullion helper pair ${PAIRING.pairing_payload}`);

    listResponses.push([
      {
        id: "some-other-bridge",
        name: null,
        platform: null,
        lastSeenAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        hasLiveSession: true,
        connected: true,
      },
    ]);
    // Give the poll a couple of real ticks to prove it stayed silent,
    // rather than asserting an absence immediately (which would pass
    // trivially before the first poll tick even fires).
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(onPaired).not.toHaveBeenCalled();
  }, 8000);

  it("shows an inline error when generating the pairing code fails", async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(jsonResponse(500, { message: "could not reach the bridge registry" })),
    );
    render(<PairBridgeModal onClose={vi.fn()} onPaired={vi.fn()} />);

    expect(await screen.findByText("could not reach the bridge registry")).toBeInTheDocument();
  });

  it("closes when Close is clicked", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<PairBridgeModal onClose={onClose} onPaired={vi.fn()} />);
    await screen.findByText(`mullion helper pair ${PAIRING.pairing_payload}`);

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("copies the payload to the clipboard when Copy command is clicked", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    // userEvent.setup() installs its own jsdom clipboard stub, which wins
    // over a defineProperty called BEFORE it — so this must run after
    // setup() (unlike TerminalPane.test.tsx's stubClipboardWrite(), which
    // never calls userEvent.setup() at all in the same test).
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<PairBridgeModal onClose={vi.fn()} onPaired={vi.fn()} />);
    await screen.findByText(`mullion helper pair ${PAIRING.pairing_payload}`);

    await user.click(screen.getByRole("button", { name: "Copy command" }));
    expect(writeText).toHaveBeenCalledWith(PAIRING.pairing_payload);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });
});
