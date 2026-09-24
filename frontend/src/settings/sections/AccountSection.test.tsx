// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api, type AuthStatus } from "../../api/index.js";
import { AuthStatusContext } from "../../authContext.js";
import { AccountSection } from "./AccountSection.js";

function renderAccount(status: AuthStatus) {
  render(
    <AuthStatusContext.Provider value={status}>
      <AccountSection />
    </AuthStatusContext.Provider>,
  );
}

describe("Settings -> Account", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows only the requested Authentik identity fields and authentication method", () => {
    renderAccount({
      methods: { token: false, oidc: false },
      authenticated: true,
      authSource: "authentik",
      user: { username: "alice", name: "Alice Example", email: "alice@example.com" },
      logout: { kind: "unavailable" },
    });
    expect(screen.getByText("Alice Example")).toBeInTheDocument();
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.getByText("alice@example.com")).toBeInTheDocument();
    expect(screen.getByText("Authentik gateway")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
  });

  it("does not claim single-user mode when trusted gateway details are absent", () => {
    renderAccount({
      methods: { token: false, oidc: false },
      authenticated: true,
      authSource: "gateway",
      logout: { kind: "unavailable" },
    });
    expect(screen.getByText("Identity details are not available.")).toBeInTheDocument();
    expect(screen.queryByText(/single-user/i)).not.toBeInTheDocument();
  });

  it("reports unavailable details when Authentik sends only its trusted UID marker", () => {
    renderAccount({
      methods: { token: false, oidc: false },
      authenticated: true,
      authSource: "authentik",
      user: {},
      logout: { kind: "unavailable" },
    });
    expect(screen.getByText("Identity details are not available.")).toBeInTheDocument();
  });

  it("explains Mullion-local logout and clears it through the API", async () => {
    vi.spyOn(api, "logout").mockResolvedValue();
    const reload = vi.fn();
    vi.stubGlobal("location", { reload });
    renderAccount({
      methods: { token: true, oidc: false },
      authenticated: true,
      authSource: "token",
      logout: { kind: "local" },
    });
    expect(screen.getByText(/Mullion session only/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(api.logout).toHaveBeenCalledOnce();
  });

  it("explains gateway-wide logout separately", () => {
    renderAccount({
      methods: { token: false, oidc: false },
      authenticated: true,
      authSource: "authentik",
      user: { username: "alice" },
      logout: { kind: "gateway", url: "/outpost.goauthentik.io/sign_out" },
    });
    expect(screen.getByText(/same outpost/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });
});
