// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings } from "./Settings.js";
import type { GitHubIntegration } from "./api.js";

// Mirrors Settings.hosts.test.tsx's fake-in-memory-backend pattern — a fake
// server over global fetch, not a mocked store, so the real request()
// wiring is what's under test (issue #27).

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const DISCONNECTED: GitHubIntegration = {
  connected: false,
  tokenType: null,
  login: null,
  scopes: null,
  connectedAt: null,
  deviceFlowAvailable: false,
};

describe("Settings -> Integrations", () => {
  let integration: GitHubIntegration;
  let fetchMock: ReturnType<typeof vi.fn>;
  let unexpectedCalls: string[];

  beforeEach(() => {
    integration = { ...DISCONNECTED };
    unexpectedCalls = [];

    fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url === "/api/integrations/github" && method === "GET") {
        return Promise.resolve(jsonResponse(200, integration));
      }
      if (url === "/api/integrations/github/token" && method === "PUT") {
        const { token } = JSON.parse(String(init?.body)) as { token: string };
        if (token === "bad-token") {
          return Promise.resolve(jsonResponse(400, { message: "GitHub rejected this token" }));
        }
        integration = {
          connected: true,
          tokenType: "pat",
          login: "octocat",
          scopes: ["repo"],
          connectedAt: "2026-01-01T00:00:00.000Z",
          deviceFlowAvailable: false,
        };
        return Promise.resolve(jsonResponse(200, integration));
      }
      if (url === "/api/integrations/github" && method === "DELETE") {
        integration = { ...DISCONNECTED };
        return Promise.resolve(new Response(null, { status: 204 }));
      }

      unexpectedCalls.push(`${method} ${url}`);
      return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    expect(unexpectedCalls).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("shows disconnected, connects with a token, then shows the connected login", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="integrations" />);

    expect(await screen.findByText("Not connected")).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("github_pat_…"), "ghp_good_token");
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByText("octocat")).toBeInTheDocument();
    expect(screen.getByText("Connected via personal access token")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/integrations/github/token",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("shows an inline error when GitHub rejects the token, without connecting", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="integrations" />);
    await screen.findByText("Not connected");

    await user.type(screen.getByPlaceholderText("github_pat_…"), "bad-token");
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByText(/GitHub rejected this token/)).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
  });

  it("disconnects an already-connected account", async () => {
    integration = {
      connected: true,
      tokenType: "pat",
      login: "octocat",
      scopes: ["repo"],
      connectedAt: "2026-01-01T00:00:00.000Z",
      deviceFlowAvailable: false,
    };
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="integrations" />);

    expect(await screen.findByText("octocat")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Disconnect" }));

    await waitFor(() => expect(screen.getByText("Not connected")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/integrations/github",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
