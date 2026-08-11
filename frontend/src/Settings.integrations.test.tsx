// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings } from "./Settings.js";
import type { GitHubIntegration } from "./api.js";
import { jsonResponse } from "./test/jsonResponse.js";

// Mirrors Settings.hosts.test.tsx's fake-in-memory-backend pattern — a fake
// server over global fetch, not a mocked store, so the real request()
// wiring is what's under test (issue #27).

const DISCONNECTED: GitHubIntegration = {
  connected: false,
  tokenType: null,
  login: null,
  scopes: null,
  connectedAt: null,
  deviceFlowAvailable: false,
  webhookEnabled: false,
  webhookBaseUrl: "",
  webhookRegisteredCount: 0,
  githubApp: {
    configured: false,
    appId: null,
    installationCount: null,
    keyFingerprint: null,
    keyRotatedAt: null,
  },
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
          webhookEnabled: false,
          webhookBaseUrl: "",
          webhookRegisteredCount: 0,
          githubApp: {
            configured: false,
            appId: null,
            installationCount: null,
            keyFingerprint: null,
            keyRotatedAt: null,
          },
        };
        return Promise.resolve(jsonResponse(200, integration));
      }
      if (url === "/api/integrations/github" && method === "DELETE") {
        integration = { ...DISCONNECTED };
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url === "/api/integrations/github/webhooks/status" && method === "GET") {
        return Promise.resolve(jsonResponse(200, { enabled: false }));
      }
      if (url === "/api/integrations/github/webhooks" && method === "POST") {
        return Promise.resolve(jsonResponse(200, { reposSucceeded: 3, reposFailed: 0 }));
      }
      if (url === "/api/integrations/github/webhooks" && method === "DELETE") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url === "/api/integrations/github/device/start" && method === "POST") {
        return Promise.resolve(
          jsonResponse(200, {
            status: "pending",
            userCode: "ABCD-1234",
            verificationUri: "https://github.com/login/device",
          }),
        );
      }
      if (url === "/api/integrations/github/app" && method === "PUT") {
        const { appId } = JSON.parse(String(init?.body)) as { appId: string; privateKey: string };
        const keyFingerprint = `fingerprint-for-${appId}`;
        integration = {
          ...integration,
          githubApp: {
            configured: true,
            appId,
            installationCount: 2,
            keyFingerprint,
            keyRotatedAt: "2026-01-01T00:00:00.000Z",
          },
        };
        // #514 — no longer an empty 204: the route now verifies the
        // credential against GitHub first and reports the result.
        return Promise.resolve(
          jsonResponse(200, { verified: true, appSlug: "test-app", keyFingerprint }),
        );
      }
      if (url === "/api/integrations/github/app" && method === "DELETE") {
        integration = {
          ...integration,
          githubApp: {
            configured: false,
            appId: null,
            installationCount: null,
            keyFingerprint: null,
            keyRotatedAt: null,
          },
        };
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
      webhookEnabled: false,
      webhookBaseUrl: "",
      webhookRegisteredCount: 0,
      githubApp: {
        configured: false,
        appId: null,
        installationCount: null,
        keyFingerprint: null,
        keyRotatedAt: null,
      },
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

  it("hides the device-flow button when deviceFlowAvailable is false", async () => {
    render(<Settings onClose={vi.fn()} initialSection="integrations" />);
    await screen.findByText("Not connected");
    expect(screen.queryByText("Connect with GitHub")).not.toBeInTheDocument();
  });

  it("opens the device-flow modal when deviceFlowAvailable is true", async () => {
    integration = { ...DISCONNECTED, deviceFlowAvailable: true };
    const user = userEvent.setup();
    const { unmount } = render(<Settings onClose={vi.fn()} initialSection="integrations" />);

    await user.click(await screen.findByText("Connect with GitHub"));
    expect(await screen.findByText("ABCD-1234")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/integrations/github/device/start",
      expect.objectContaining({ method: "POST" }),
    );
    // Unmount before the modal's own 2s poll interval fires — this
    // describe's fake backend doesn't stub /device/status, and a stray
    // poll after this test ends would otherwise hit `unexpectedCalls` on
    // whichever later test's afterEach happens to run next.
    unmount();
  });

  // #489 remaining scope
  describe("GitHub App", () => {
    it("shows 'Not configured' and configures a new App", async () => {
      const user = userEvent.setup();
      render(<Settings onClose={vi.fn()} initialSection="integrations" />);

      expect(await screen.findByText("Not configured")).toBeInTheDocument();

      await user.type(screen.getByPlaceholderText("123456"), "987654");
      await user.type(screen.getByPlaceholderText(/BEGIN RSA PRIVATE KEY/), "fake-pem-contents"); // pragma: allowlist secret
      await user.click(screen.getByRole("button", { name: "Configure" }));

      expect(await screen.findByText("App #987654")).toBeInTheDocument();
      expect(screen.getByText(/Installed on 2 accounts/)).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/integrations/github/app",
        expect.objectContaining({ method: "PUT" }),
      );
      // #514 — the PUT response's verification result is rendered.
      expect(await screen.findByText(/Verified — test-app/)).toBeInTheDocument();
    });

    it("is independent of the PAT/OAuth connection — visible while disconnected", async () => {
      render(<Settings onClose={vi.fn()} initialSection="integrations" />);
      expect(await screen.findByText("Not connected")).toBeInTheDocument();
      expect(screen.getByText("GitHub App")).toBeInTheDocument();
      expect(screen.getByText("Not configured")).toBeInTheDocument();
    });

    it("clears an already-configured App", async () => {
      integration = {
        ...DISCONNECTED,
        githubApp: {
          configured: true,
          appId: "111",
          installationCount: 1,
          keyFingerprint: "fingerprint-111",
          keyRotatedAt: "2026-01-01T00:00:00.000Z",
        },
      };
      const user = userEvent.setup();
      render(<Settings onClose={vi.fn()} initialSection="integrations" />);

      expect(await screen.findByText("App #111")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Clear" }));

      expect(await screen.findByText("Not configured")).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/integrations/github/app",
        expect.objectContaining({ method: "DELETE" }),
      );
    });

    it("shows an unavailable installation count without failing", async () => {
      integration = {
        ...DISCONNECTED,
        githubApp: {
          configured: true,
          appId: "222",
          installationCount: null,
          keyFingerprint: null,
          keyRotatedAt: null,
        },
      };
      render(<Settings onClose={vi.fn()} initialSection="integrations" />);

      expect(await screen.findByText("App #222")).toBeInTheDocument();
      expect(screen.getByText("Installation count unavailable")).toBeInTheDocument();
    });

    // #514 — the panel used to unmount its whole form once configured,
    // forcing destroy-then-reconfigure to rotate a key. This is the new
    // reachable-while-configured path.
    it("reaches the form via 'Rotate key' while already configured, and shows the fingerprint after rotating", async () => {
      integration = {
        ...DISCONNECTED,
        githubApp: {
          configured: true,
          appId: "111",
          installationCount: 1,
          keyFingerprint: "old-fingerprint",
          keyRotatedAt: "2026-01-01T00:00:00.000Z",
        },
      };
      const user = userEvent.setup();
      render(<Settings onClose={vi.fn()} initialSection="integrations" />);

      expect(await screen.findByText("App #111")).toBeInTheDocument();
      // The form is unreachable until "Rotate key" is clicked.
      expect(screen.queryByPlaceholderText("123456")).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Rotate key" }));
      // App id is prefilled from the currently-configured App.
      expect(screen.getByPlaceholderText("123456")).toHaveValue("111");

      await user.type(screen.getByPlaceholderText(/BEGIN RSA PRIVATE KEY/), "new-fake-pem"); // pragma: allowlist secret
      await user.click(screen.getByRole("button", { name: "Rotate" }));

      expect(await screen.findByText(/Verified — test-app/)).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/integrations/github/app",
        expect.objectContaining({ method: "PUT" }),
      );
      // The form collapses again after a successful rotation.
      expect(screen.queryByPlaceholderText("123456")).not.toBeInTheDocument();
    });

    it("cancels a rotation without calling the API", async () => {
      integration = {
        ...DISCONNECTED,
        githubApp: {
          configured: true,
          appId: "111",
          installationCount: 1,
          keyFingerprint: "old-fingerprint",
          keyRotatedAt: "2026-01-01T00:00:00.000Z",
        },
      };
      const user = userEvent.setup();
      render(<Settings onClose={vi.fn()} initialSection="integrations" />);

      await screen.findByText("App #111");
      await user.click(screen.getByRole("button", { name: "Rotate key" }));
      expect(screen.getByPlaceholderText("123456")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Cancel" }));

      expect(screen.queryByPlaceholderText("123456")).not.toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalledWith(
        "/api/integrations/github/app",
        expect.objectContaining({ method: "PUT" }),
      );
    });

    // Hermes review, PR #519: clearing while the rotate form was open used
    // to leave it open afterward — in "Rotate" mode, with the just-cleared
    // App's id still prefilled, for what is now an unconfigured App.
    it("clearing while the rotate form is open closes it too, not just clearing the App", async () => {
      integration = {
        ...DISCONNECTED,
        githubApp: {
          configured: true,
          appId: "111",
          installationCount: 1,
          keyFingerprint: "old-fingerprint",
          keyRotatedAt: "2026-01-01T00:00:00.000Z",
        },
      };
      const user = userEvent.setup();
      render(<Settings onClose={vi.fn()} initialSection="integrations" />);

      await screen.findByText("App #111");
      await user.click(screen.getByRole("button", { name: "Rotate key" }));
      expect(screen.getByPlaceholderText("123456")).toHaveValue("111");

      await user.click(screen.getByRole("button", { name: "Clear" }));

      expect(await screen.findByText("Not configured")).toBeInTheDocument();
      // Not left open in "Rotate" mode with the stale appId — the only
      // form now reachable is the plain "Configure" one, empty.
      expect(screen.queryByRole("button", { name: "Rotate" })).not.toBeInTheDocument();
      expect(screen.getByPlaceholderText("123456")).toHaveValue("");
    });
  });
});
