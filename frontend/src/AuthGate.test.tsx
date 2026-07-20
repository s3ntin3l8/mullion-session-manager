// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuthGate } from "./AuthGate.js";

// App itself is heavy (workspaces/sessions/settings all fetched on mount) and
// already out of scope for this test — AuthGate's own job is deciding
// *whether* to mount it, not what it does once mounted. Stubbing it keeps
// this file focused on the gating logic (issues #19, #30).
vi.mock("./App.js", () => ({
  App: () => <div data-testid="dashboard">dashboard</div>,
}));

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const METHODS_NONE = { token: false, oidc: false };
const METHODS_TOKEN = { token: true, oidc: false };
const METHODS_OIDC = { token: false, oidc: true };
const METHODS_BOTH = { token: true, oidc: true };

describe("AuthGate", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the dashboard directly when in-process auth is off (both methods false)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(jsonResponse(200, { methods: METHODS_NONE, authenticated: true })),
      ),
    );

    render(<AuthGate />);

    expect(await screen.findByTestId("dashboard")).toBeInTheDocument();
  });

  it("renders the dashboard directly when the session cookie is already valid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(jsonResponse(200, { methods: METHODS_TOKEN, authenticated: true })),
      ),
    );

    render(<AuthGate />);

    expect(await screen.findByTestId("dashboard")).toBeInTheDocument();
  });

  it("renders a login form instead of the dashboard when auth is on and not yet authenticated", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(jsonResponse(200, { methods: METHODS_TOKEN, authenticated: false })),
      ),
    );

    render(<AuthGate />);

    expect(await screen.findByLabelText("Access token")).toBeInTheDocument();
    expect(screen.queryByTestId("dashboard")).not.toBeInTheDocument();
  });

  it("shows only the SSO link, no token field, when OIDC is the only configured method", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(jsonResponse(200, { methods: METHODS_OIDC, authenticated: false })),
      ),
    );

    render(<AuthGate />);

    expect(await screen.findByRole("link", { name: "Sign in with SSO" })).toHaveAttribute(
      "href",
      "/api/auth/oidc/login",
    );
    expect(screen.queryByLabelText("Access token")).not.toBeInTheDocument();
  });

  it("shows both the SSO link and the token field when both methods are configured", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(jsonResponse(200, { methods: METHODS_BOTH, authenticated: false })),
      ),
    );

    render(<AuthGate />);

    expect(await screen.findByRole("link", { name: "Sign in with SSO" })).toBeInTheDocument();
    expect(screen.getByLabelText("Access token")).toBeInTheDocument();
  });

  it("shows an inline error and stays on the login form when the token is wrong", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/auth/me" && method === "GET") {
        return Promise.resolve(jsonResponse(200, { methods: METHODS_TOKEN, authenticated: false }));
      }
      if (url === "/api/auth/login" && method === "POST") {
        return Promise.resolve(jsonResponse(401, { message: "invalid token" }));
      }
      return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    render(<AuthGate />);

    await user.type(await screen.findByLabelText("Access token"), "wrong-token");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid token.");
    expect(screen.queryByTestId("dashboard")).not.toBeInTheDocument();
  });

  it("proceeds to the dashboard after a successful token login", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/auth/me" && method === "GET") {
        return Promise.resolve(jsonResponse(200, { methods: METHODS_TOKEN, authenticated: false }));
      }
      if (url === "/api/auth/login" && method === "POST") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    render(<AuthGate />);

    await user.type(await screen.findByLabelText("Access token"), "correct-token");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByTestId("dashboard")).toBeInTheDocument();
  });

  it("shows an identity badge with sign-out once an OIDC session carries a user", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse(200, {
            methods: METHODS_OIDC,
            authenticated: true,
            user: { sub: "user-1", email: "user@example.com", name: "User One" },
          }),
        ),
      ),
    );

    render(<AuthGate />);

    expect(await screen.findByTestId("dashboard")).toBeInTheDocument();
    expect(screen.getByText("User One")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("does not render an identity badge for a token-only session (no user identity)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(jsonResponse(200, { methods: METHODS_TOKEN, authenticated: true })),
      ),
    );

    render(<AuthGate />);

    expect(await screen.findByTestId("dashboard")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
  });
});
