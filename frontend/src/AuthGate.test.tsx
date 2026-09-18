// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuthGate } from "./AuthGate.js";
import { jsonResponse } from "./test/jsonResponse.js";

// Stubs `matchMedia("(prefers-color-scheme: dark)")` to a fixed answer —
// the theme-resolution tests below need to control the OS-preference
// fallback independently of testSetup.ts's own `matches: false` default,
// which callers elsewhere in this suite may have already overridden.
function stubPrefersDark(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query === "(prefers-color-scheme: dark)" ? matches : false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })),
  );
}

// App itself is heavy (workspaces/sessions/settings all fetched on mount) and
// already out of scope for this test — AuthGate's own job is deciding
// *whether* to mount it, not what it does once mounted. Stubbing it keeps
// this file focused on the gating logic (issues #19, #30).
vi.mock("./App.js", () => ({
  App: () => <div data-testid="dashboard">dashboard</div>,
}));

const METHODS_NONE = { token: false, oidc: false };
const METHODS_TOKEN = { token: true, oidc: false };
const METHODS_OIDC = { token: false, oidc: true };
const METHODS_BOTH = { token: true, oidc: true };

describe("AuthGate", () => {
  beforeEach(() => {
    localStorage.removeItem("crs.themeHint");
  });

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
    let loggedIn = false;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/auth/me" && method === "GET") {
        return Promise.resolve(
          jsonResponse(200, { methods: METHODS_TOKEN, authenticated: loggedIn }),
        );
      }
      if (url === "/api/auth/login" && method === "POST") {
        loggedIn = true;
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

  it("does not render the old floating identity badge for an OIDC user", async () => {
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
    expect(screen.queryByText("User One")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
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

  describe("theme resolution", () => {
    it("applies the light class when crs.themeHint is 'light'", async () => {
      localStorage.setItem("crs.themeHint", "light");
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve(jsonResponse(200, { methods: METHODS_TOKEN, authenticated: false })),
        ),
      );

      render(<AuthGate />);

      const root = (await screen.findByLabelText("Access token")).closest(".login-root");
      expect(root).toHaveClass("cmux-root", "light");
    });

    it("stays on the bare dark cmux-root class when crs.themeHint is 'dark'", async () => {
      localStorage.setItem("crs.themeHint", "dark");
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve(jsonResponse(200, { methods: METHODS_TOKEN, authenticated: false })),
        ),
      );

      render(<AuthGate />);

      const root = (await screen.findByLabelText("Access token")).closest(".login-root");
      expect(root).toHaveClass("cmux-root");
      expect(root).not.toHaveClass("light");
    });

    it("falls back to the OS preference when no hint has ever been stored", async () => {
      // beforeEach already clears crs.themeHint — this is the genuinely
      // first-ever-visit case theme-hint.js's own absent-key branch mirrors.
      stubPrefersDark(false);
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve(jsonResponse(200, { methods: METHODS_TOKEN, authenticated: false })),
        ),
      );

      render(<AuthGate />);

      const root = (await screen.findByLabelText("Access token")).closest(".login-root");
      expect(root).toHaveClass("cmux-root", "light");
    });
  });

  it("keeps the SSO control a real link, not a button, once restyled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(jsonResponse(200, { methods: METHODS_OIDC, authenticated: false })),
      ),
    );

    render(<AuthGate />);

    const link = await screen.findByRole("link", { name: "Sign in with SSO" });
    expect(link).toHaveAttribute("href", "/api/auth/oidc/login");
    expect(link.tagName).toBe("A");
  });

  it("submits the token form on Enter, via native form submission", async () => {
    let loggedIn = false;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/auth/me" && method === "GET") {
        return Promise.resolve(
          jsonResponse(200, { methods: METHODS_TOKEN, authenticated: loggedIn }),
        );
      }
      if (url === "/api/auth/login" && method === "POST") {
        loggedIn = true;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    render(<AuthGate />);

    await user.type(await screen.findByLabelText("Access token"), "correct-token{Enter}");

    expect(await screen.findByTestId("dashboard")).toBeInTheDocument();
  });
});
