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
    // Restores the navigator.userAgent spy the platform-detection test
    // installs — otherwise it would leak into every later test in this
    // file, since it's set on the real jsdom `navigator`, not a stub.
    vi.restoreAllMocks();
  });

  it("generates a pairing code on mount and shows the bare payload", async () => {
    render(<PairBridgeModal onClose={vi.fn()} onPaired={vi.fn()} />);

    expect(await screen.findByText(PAIRING.pairing_payload)).toBeInTheDocument();
  });

  it("shows the Windows command form by default when the user agent looks like Windows", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    );
    render(<PairBridgeModal onClose={vi.fn()} onPaired={vi.fn()} />);

    expect(
      await screen.findByText(
        `& "$env:LOCALAPPDATA\\Mullion\\mullion-helper.exe" helper pair ${PAIRING.pairing_payload}`,
      ),
    ).toBeInTheDocument();
  });

  it("switches the displayed command when a different platform is selected", async () => {
    const user = userEvent.setup();
    render(<PairBridgeModal onClose={vi.fn()} onPaired={vi.fn()} />);
    await screen.findByText(PAIRING.pairing_payload);

    await user.click(screen.getByRole("button", { name: "macOS" }));
    expect(
      await screen.findByText(`mullion-helper helper pair ${PAIRING.pairing_payload}`),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Linux" }));
    expect(
      await screen.findByText(`mullion helper pair '${PAIRING.pairing_payload}'`),
    ).toBeInTheDocument();
  });

  it("polls GET /api/bridges and calls onPaired once this bridge id shows connected", async () => {
    const onPaired = vi.fn();
    render(<PairBridgeModal onClose={vi.fn()} onPaired={onPaired} />);
    await screen.findByText(PAIRING.pairing_payload);

    listResponses.push(
      bridgeList({ connected: true, hasLiveSession: true, lastSeenAt: "2026-01-01T00:00:00.000Z" }),
    );
    await waitFor(() => expect(onPaired).toHaveBeenCalled(), { timeout: 4000 });
    expect(
      await screen.findByText(/Connected — this bridge is ready to forward/, {}, { timeout: 4000 }),
    ).toBeInTheDocument();
  }, 8000);

  // The bug this responds to: `helper pair` only redeems the code and
  // persists a credential — it never opens the forwarding connection
  // itself, so `hasLiveSession` flips true well before `connected` does.
  // Before this fix, that gap rendered identically to "haven't paired at
  // all yet" (the same static "Waiting for the helper to connect…" text),
  // giving no sign the pair step had actually landed.
  it("shows a distinct 'paired, now run it' state once hasLiveSession flips before connected", async () => {
    const onPaired = vi.fn();
    const user = userEvent.setup();
    render(<PairBridgeModal onClose={vi.fn()} onPaired={onPaired} />);
    await screen.findByText(PAIRING.pairing_payload);

    listResponses.push(
      bridgeList({ hasLiveSession: true, lastSeenAt: "2026-01-01T00:00:00.000Z" }),
    );
    expect(
      await screen.findByText(/Paired — the credential is saved/, {}, { timeout: 4000 }),
    ).toBeInTheDocument();
    expect(screen.getByText("mullion helper run")).toBeInTheDocument();
    expect(onPaired).not.toHaveBeenCalled();
    expect(screen.queryByText(PAIRING.pairing_payload)).not.toBeInTheDocument();

    // Hermes review, PR #1175 — the Linux string above was the only
    // platform this test asserted; the headline Windows form (the one
    // that actually needed the `&` fix this PR makes) went unasserted.
    await user.click(screen.getByRole("button", { name: "Windows" }));
    expect(
      screen.getByText('& "$env:LOCALAPPDATA\\Mullion\\mullion-helper.exe" helper run'),
    ).toBeInTheDocument();
  }, 8000);

  it("does not call onPaired for a different bridge id showing connected", async () => {
    const onPaired = vi.fn();
    render(<PairBridgeModal onClose={vi.fn()} onPaired={onPaired} />);
    await screen.findByText(PAIRING.pairing_payload);

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
    await screen.findByText(PAIRING.pairing_payload);

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("copies the bare payload to the clipboard when Copy payload is clicked", async () => {
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
    await screen.findByText(PAIRING.pairing_payload);

    await user.click(screen.getByRole("button", { name: "Copy payload" }));
    expect(writeText).toHaveBeenCalledWith(PAIRING.pairing_payload);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  // Round 4 (issue #871's own installer UX cleanup) — "Copy payload" and
  // "Copy command" must put DIFFERENT strings on the clipboard: the
  // payload alone is what the Windows/macOS installer wizard wants, while
  // the command is the platform-specific CLI invocation. A prior version
  // of this modal had one button labeled "Copy command" that actually
  // copied only the bare payload — this test would have caught that.
  it("copies the full platform command, not the bare payload, when Copy command is clicked", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<PairBridgeModal onClose={vi.fn()} onPaired={vi.fn()} />);
    await screen.findByText(PAIRING.pairing_payload);

    await user.click(screen.getByRole("button", { name: "Linux" }));
    await user.click(screen.getByRole("button", { name: "Copy command" }));
    expect(writeText).toHaveBeenCalledWith(`mullion helper pair '${PAIRING.pairing_payload}'`);
    expect(writeText).not.toHaveBeenCalledWith(PAIRING.pairing_payload);
  });
});
