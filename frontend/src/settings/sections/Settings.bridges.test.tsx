// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings } from "../../Settings.js";
import type { BridgeSummary } from "../../api/index.js";
import { jsonResponse } from "../../test/jsonResponse.js";
import { mockFetch } from "../../test/mockFetch.js";
import { resetStore } from "../../test/resetStore.js";

// Issue #820 PR7c — same fake-in-memory-backend shape as
// Settings.hosts.test.tsx's own describe block: exercises Settings ->
// Hosts's new BridgesSection against a fake GET/POST/DELETE /api/bridges
// backend, so the real request()/component wiring is what's under test,
// not a mocked store.

describe("Settings -> Hosts -> SSH agent bridges (issue #820 PR7c)", () => {
  let bridgesDb: BridgeSummary[];
  let bridgesShouldFail: boolean;
  let fetchMock: ReturnType<typeof vi.fn>;
  let unexpectedCalls: string[];
  let pairCounter: number;

  beforeEach(() => {
    bridgesDb = [];
    bridgesShouldFail = false;
    pairCounter = 0;

    ({ fetchMock, unexpectedCalls } = mockFetch({
      "GET /api/hosts": () => jsonResponse(200, []),
      "GET /api/projects": () => jsonResponse(200, []),
      "GET /api/sessions": () => jsonResponse(200, []),
      "GET /api/bridges": () =>
        bridgesShouldFail
          ? jsonResponse(500, { message: "internal error" })
          : jsonResponse(200, bridgesDb),
      "POST /api/bridges": () => {
        pairCounter += 1;
        const id = `bridge-${pairCounter}`;
        // Mirrors what the real route does (issuePairingCode only — see
        // src/routes/agent-bridge.ts): a freshly-issued pairing row has no
        // live session and has never been seen. Getting this wrong here
        // (an earlier version of this mock set hasLiveSession: true) is
        // exactly what let BridgesSection's "revoked session" mislabel of
        // this same state ship unnoticed — self-review caught it.
        bridgesDb = [
          ...bridgesDb,
          {
            id,
            name: null,
            platform: null,
            lastSeenAt: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            hasLiveSession: false,
            connected: false,
          },
        ];
        return jsonResponse(200, {
          bridge_id: id,
          pairing_payload: `payload-${id}`,
          expires_at: "2026-01-01T00:10:00.000Z",
        });
      },
      "DELETE /api/bridges/:id": ({ params }) => {
        const before = bridgesDb.length;
        bridgesDb = bridgesDb.filter((b) => b.id !== params.id);
        if (bridgesDb.length === before) return jsonResponse(404, { message: "not found" });
        return jsonResponse(204);
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    resetStore({ hosts: [] });
  });

  afterEach(() => {
    expect(unexpectedCalls).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("shows the empty state when no bridge is paired", async () => {
    render(<Settings onClose={vi.fn()} initialSection="hosts" />);

    expect(await screen.findByText(/No SSH agent bridges paired/)).toBeInTheDocument();
  });

  // Hermes review, PR #869 — a failed fetch used to fall through to the
  // same "no bridges paired" copy a genuinely empty list gets, reading as
  // confirmed success rather than "couldn't reach the server."
  it("shows a load error instead of the empty state when the list fetch fails", async () => {
    bridgesShouldFail = true;
    render(<Settings onClose={vi.fn()} initialSection="hosts" />);

    expect(await screen.findByText("Couldn't load SSH agent bridges.")).toBeInTheDocument();
    expect(screen.queryByText(/No SSH agent bridges paired/)).not.toBeInTheDocument();
  });

  it("lists a paired, connected bridge with its name/platform and status", async () => {
    bridgesDb = [
      {
        id: "bridge-1",
        name: "laptop-1",
        platform: "darwin",
        lastSeenAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        hasLiveSession: true,
        connected: true,
      },
    ];
    render(<Settings onClose={vi.fn()} initialSection="hosts" />);

    const row = await screen.findByTestId("bridge-row-bridge-1");
    expect(within(row).getByText("laptop-1")).toBeInTheDocument();
    expect(within(row).getByText("darwin")).toBeInTheDocument();
    expect(within(row).getByText("connected")).toBeInTheDocument();
  });

  it("shows 'last seen' instead of 'connected' once the helper disconnects", async () => {
    bridgesDb = [
      {
        id: "bridge-1",
        name: "laptop-1",
        platform: "darwin",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        hasLiveSession: true,
        connected: false,
      },
    ];
    render(<Settings onClose={vi.fn()} initialSection="hosts" />);

    const row = await screen.findByTestId("bridge-row-bridge-1");
    expect(within(row).getByText(/ago$/)).toBeInTheDocument();
    expect(within(row).queryByText("connected")).not.toBeInTheDocument();
  });

  // Self-review (mullion-reviewer) — a freshly-issued, not-yet-redeemed
  // pairing row (exactly what POST /api/bridges creates, and what appears
  // in this list WHILE PairBridgeModal is still open waiting) must never
  // read as "revoked session": DELETE /api/bridges/:id deletes the row
  // outright, so a genuinely revoked bridge disappears from this list
  // entirely — it never shows up with hasLiveSession: false.
  it("labels an unredeemed pairing row 'pairing pending', not 'revoked session'", async () => {
    bridgesDb = [
      {
        id: "bridge-1",
        name: null,
        platform: null,
        lastSeenAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        hasLiveSession: false,
        connected: false,
      },
    ];
    render(<Settings onClose={vi.fn()} initialSection="hosts" />);

    const row = await screen.findByTestId("bridge-row-bridge-1");
    expect(within(row).getByText("pairing pending")).toBeInTheDocument();
    expect(within(row).queryByText(/revoked/)).not.toBeInTheDocument();
  });

  it("labels a bridge whose session has lapsed 'session expired'", async () => {
    bridgesDb = [
      {
        id: "bridge-1",
        name: "laptop-1",
        platform: "darwin",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        hasLiveSession: false,
        connected: false,
      },
    ];
    render(<Settings onClose={vi.fn()} initialSection="hosts" />);

    const row = await screen.findByTestId("bridge-row-bridge-1");
    expect(within(row).getByText("session expired")).toBeInTheDocument();
  });

  it("revokes a bridge and removes it from the list", async () => {
    bridgesDb = [
      {
        id: "bridge-1",
        name: "laptop-1",
        platform: "darwin",
        lastSeenAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        hasLiveSession: true,
        connected: true,
      },
    ];
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="hosts" />);

    const row = await screen.findByTestId("bridge-row-bridge-1");
    await user.click(within(row).getByRole("button", { name: "Revoke" }));

    await waitFor(() =>
      expect(screen.queryByTestId("bridge-row-bridge-1")).not.toBeInTheDocument(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/bridges/bridge-1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("pairs a new bridge via the modal and shows the generated command", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="hosts" />);

    await user.click(await screen.findByText("Pair a new bridge"));

    expect(await screen.findByText("mullion helper pair payload-bridge-1")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/bridges",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
