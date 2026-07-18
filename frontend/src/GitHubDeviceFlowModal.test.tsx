// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GitHubDeviceFlowModal } from "./GitHubDeviceFlowModal.js";

// Real timers throughout — the component's 2s poll interval collides with
// fake timers (testing-library's own findBy/waitFor polling relies on
// setTimeout too, so faking it starves those), so tests that need a poll
// tick just accept the real ~2s wall-clock cost via a bumped waitFor timeout.

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const PENDING = {
  status: "pending",
  userCode: "ABCD-1234",
  verificationUri: "https://github.com/login/device",
};

describe("GitHubDeviceFlowModal", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let statusResponses: Array<Record<string, unknown>>;

  beforeEach(() => {
    statusResponses = [];
    fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/integrations/github/device/start" && method === "POST") {
        return Promise.resolve(jsonResponse(200, PENDING));
      }
      if (url === "/api/integrations/github/device/status" && method === "GET") {
        const next = statusResponses.shift() ?? PENDING;
        return Promise.resolve(jsonResponse(200, next));
      }
      return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts the flow on mount and shows the user_code + verification link", async () => {
    render(<GitHubDeviceFlowModal onClose={vi.fn()} onConnected={vi.fn()} />);

    expect(await screen.findByText("ABCD-1234")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Open GitHub" });
    expect(link).toHaveAttribute("href", "https://github.com/login/device");
  });

  it("polls the status endpoint and calls onConnected once authorized", async () => {
    const onConnected = vi.fn();
    render(<GitHubDeviceFlowModal onClose={vi.fn()} onConnected={onConnected} />);
    await screen.findByText("ABCD-1234");

    statusResponses.push({ ...PENDING, status: "connected" });
    await waitFor(() => expect(onConnected).toHaveBeenCalled(), { timeout: 4000 });
  }, 8000);

  it("shows an error message when the status moves to expired", async () => {
    render(<GitHubDeviceFlowModal onClose={vi.fn()} onConnected={vi.fn()} />);
    await screen.findByText("ABCD-1234");

    statusResponses.push({ ...PENDING, status: "expired" });
    expect(
      await screen.findByText(/expired before it was used/, {}, { timeout: 4000 }),
    ).toBeInTheDocument();
  }, 8000);

  it("shows a message when the status moves to denied", async () => {
    render(<GitHubDeviceFlowModal onClose={vi.fn()} onConnected={vi.fn()} />);
    await screen.findByText("ABCD-1234");

    statusResponses.push({ ...PENDING, status: "denied" });
    expect(
      await screen.findByText(/Authorization was denied/, {}, { timeout: 4000 }),
    ).toBeInTheDocument();
  }, 8000);

  it("shows the server's errorMessage when the status moves to error", async () => {
    render(<GitHubDeviceFlowModal onClose={vi.fn()} onConnected={vi.fn()} />);
    await screen.findByText("ABCD-1234");

    statusResponses.push({ ...PENDING, status: "error", errorMessage: "bad client id" });
    expect(await screen.findByText("bad client id", {}, { timeout: 4000 })).toBeInTheDocument();
  }, 8000);

  it("shows an inline error when starting the flow fails", async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(jsonResponse(400, { message: "Device flow is not configured" })),
    );
    render(<GitHubDeviceFlowModal onClose={vi.fn()} onConnected={vi.fn()} />);

    expect(await screen.findByText("Device flow is not configured")).toBeInTheDocument();
  });

  it("closes when Close is clicked", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<GitHubDeviceFlowModal onClose={onClose} onConnected={vi.fn()} />);
    await screen.findByText("ABCD-1234");

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });
});
