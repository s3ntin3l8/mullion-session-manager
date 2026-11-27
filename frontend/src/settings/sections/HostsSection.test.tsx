// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HostsSection } from "./HostsSection.js";
import { useDashboardStore } from "../../store/index.js";
import { jsonResponse } from "../../test/jsonResponse.js";
import { makeHost, makeServerInfo } from "../../test/fixtures.js";
import type { PlacementCapability } from "../../../../src/shared/constants.js";

// Token rotation and the "waiting for the agent" row state. The rest of the
// section is exercised through its own components' tests.

function stubFetch(opts: {
  rotate?: () => Response;
  acknowledge?: () => Response;
  approve?: () => Response;
  deleteHost?: () => Response;
  createPairing?: (body: unknown) => Response | Promise<Response>;
  createHost?: (body: unknown) => Response;
  revoke?: () => Response;
  // Issue #3477 — what the server reports on /api/server-info. The default
  // is the legacy gate OPEN, so the tests that exercise the token flow keep
  // seeing it; the gate-off test passes its own value.
  serverInfo?: Record<string, unknown>;
}) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (url === "/api/server-info" && method === "GET") {
        return Promise.resolve(
          jsonResponse(200, makeServerInfo({ allowLegacyHosts: true, ...(opts.serverInfo ?? {}) })),
        );
      }
      if (url === "/api/hosts" && method === "GET") {
        return Promise.resolve(jsonResponse(200, useDashboardStore.getState().hosts));
      }
      if (url === "/api/hosts" && method === "POST" && opts.createHost) {
        return Promise.resolve(opts.createHost(JSON.parse(String(init?.body))));
      }
      if (url.endsWith("/revoke") && method === "POST" && opts.revoke) {
        return Promise.resolve(opts.revoke());
      }
      if (url === "/api/host-pairings" && method === "GET") {
        return Promise.resolve(jsonResponse(200, []));
      }
      if (url === "/api/automation-tokens" && method === "GET") {
        return Promise.resolve(jsonResponse(200, []));
      }
      if (url === "/api/host-pairings" && method === "POST" && opts.createPairing) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        return Promise.resolve(opts.createPairing(body));
      }
      if (url.endsWith("/rotate-token") && method === "POST" && opts.rotate) {
        return Promise.resolve(opts.rotate());
      }
      if (url.endsWith("/identity-events/acknowledge") && method === "POST" && opts.acknowledge) {
        return Promise.resolve(opts.acknowledge());
      }
      if (url.endsWith("/approve") && method === "POST" && opts.approve) {
        return Promise.resolve(opts.approve());
      }
      if (url.startsWith("/api/hosts/") && method === "DELETE" && opts.deleteHost) {
        return Promise.resolve(opts.deleteHost());
      }
      // Per-host update status etc.: unavailable here, which the section swallows.
      return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
    }),
  );
  return calls;
}

async function openRotate(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "More…" }));
  await user.click(screen.getByText("Rotate token"));
  await user.click(screen.getByText("Click again to rotate"));
}

describe("HostsSection", () => {
  beforeEach(() => {
    useDashboardStore.setState({
      hosts: [makeHost({ id: "h1", name: "win-pc", baseUrl: null })],
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows a host that has no baseUrl yet as waiting for its agent", () => {
    stubFetch({});
    render(<HostsSection />);
    expect(screen.getByText(/waiting for the agent to register/)).toBeInTheDocument();
  });

  it("shows an outbound-only host as connected without an address (issue #2572)", () => {
    stubFetch({});
    useDashboardStore.setState({
      hosts: [
        makeHost({
          id: "h1",
          name: "laptop",
          baseUrl: null,
          health: "online",
          hasMachineIdentity: true,
        }),
      ],
    });
    render(<HostsSection />);
    expect(screen.getByText(/connected over the outbound channel/)).toBeInTheDocument();
    expect(screen.queryByText(/waiting for the agent/)).not.toBeInTheDocument();
  });

  it("shows a saturated channel's reason on the row, with an explanation on hover (issue #2702)", () => {
    stubFetch({});
    useDashboardStore.setState({
      hosts: [
        makeHost({
          id: "h",
          name: "busy-box",
          health: "degraded",
          healthReason: "channel saturated",
          lastCheckedAt: "2026-01-01T00:00:10.000Z",
        }),
      ],
    });
    render(<HostsSection />);
    expect(screen.getByText("channel saturated")).toHaveAttribute(
      "title",
      expect.stringMatching(/every request slot has been busy/),
    );
  });

  it("flags a host with leaked browsers (issue #2641)", () => {
    stubFetch({});
    useDashboardStore.setState({ hosts: [makeHost({ id: "h", name: "ctr", leakedBrowsers: 2 })] });
    render(<HostsSection />);
    expect(screen.getByText("2 leaked browsers")).toBeInTheDocument();
  });

  it("flags an outdated agent with both versions in the explanation (issue #2969)", () => {
    stubFetch({});
    useDashboardStore.setState({
      hosts: [
        makeHost({ id: "local", name: "This machine", isLocal: true, mullionVersion: "0.3.62" }),
        makeHost({
          id: "old",
          name: "macbook",
          baseUrl: "http://192.168.2.92:3000",
          legacyAgent: true,
          mullionVersion: "0.3.50",
        }),
        makeHost({ id: "new", name: "current", legacyAgent: false }),
      ],
    });
    render(<HostsSection />);
    const badge = screen.getByText("Outdated agent — upgrade");
    expect(badge).toHaveAttribute("title", expect.stringMatching(/v0\.3\.50.*v0\.3\.62/s));
    expect(screen.getAllByText("Outdated agent — upgrade")).toHaveLength(1);
  });

  it("tells a current-build legacy agent to set MULLION_PRIMARY_URL, not to upgrade (issue #2969)", () => {
    stubFetch({});
    useDashboardStore.setState({
      hosts: [makeHost({ id: "h", name: "mac", legacyAgent: true, mullionVersion: "0.3.62" })],
    });
    render(<HostsSection />);
    const label = screen.getByText("Not registered — set primary URL");
    expect(label).toHaveAttribute("title", expect.stringMatching(/MULLION_PRIMARY_URL/));
    expect(screen.queryByText("Outdated agent — upgrade")).toBeNull();
  });

  it("sends a cleared address as null for a host with a machine identity (issue #3091)", async () => {
    const patches: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "PATCH") {
          patches.push(JSON.parse(String(init.body)));
          return Promise.resolve(jsonResponse(200, useDashboardStore.getState().hosts[0]));
        }
        if (url === "/api/hosts") {
          return Promise.resolve(jsonResponse(200, useDashboardStore.getState().hosts));
        }
        return Promise.reject(new Error(`unhandled fetch in test: ${url}`));
      }),
    );
    useDashboardStore.setState({
      hosts: [
        makeHost({
          id: "mac",
          name: "macbook",
          baseUrl: "http://192.168.2.92:3000",
          hasMachineIdentity: true,
          hasLiveMachineIdentity: true,
        }),
      ],
    });
    const user = userEvent.setup();
    render(<HostsSection />);
    await user.click(screen.getByRole("button", { name: "More…" }));
    await user.click(screen.getByText("Edit"));
    await user.clear(screen.getByLabelText(/^Base URL/));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await vi.waitFor(() => expect(patches).toEqual([{ name: "macbook", baseUrl: null }]));
  });

  it("flags a possible duplicate and offers Remove stale host on the older row only (issue #2582)", async () => {
    stubFetch({});
    useDashboardStore.setState({
      hosts: [
        makeHost({ id: "old", name: "ctr-old", health: "offline" }),
        makeHost({ id: "new", name: "ctr-new", possibleDuplicateOf: ["old"] }),
      ],
    });
    const user = userEvent.setup();
    render(<HostsSection />);
    expect(screen.getByText(/Possible duplicate of ctr-old/)).toBeInTheDocument();
    const [oldMenu, newMenu] = screen.getAllByRole("button", { name: "More…" });
    await user.click(oldMenu);
    expect(screen.getByText("Remove stale host")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(newMenu);
    expect(screen.queryByText("Remove stale host")).not.toBeInTheDocument();
    expect(screen.getByText("Delete host")).toBeInTheDocument();
  });

  it("shows capability chips, or says capabilities are unknown", () => {
    stubFetch({});
    useDashboardStore.setState({
      hosts: [
        makeHost({ id: "h1", name: "mac", capabilities: ["xcode", "android-emulator"] }),
        makeHost({ id: "h2", name: "old", capabilities: null }),
        makeHost({ id: "h3", name: "bare", capabilities: [] }),
        // A newer agent may report an id this build has no label for.
        makeHost({
          id: "h4",
          name: "newer",
          capabilities: ["xcode", "future-cap"] as unknown as PlacementCapability[],
        }),
      ],
    });
    render(<HostsSection />);
    expect(screen.getByText("Xcode · future-cap")).toBeInTheDocument();
    expect(screen.getByText("Xcode · Android emulator")).toBeInTheDocument();
    expect(screen.getByText("capabilities unknown")).toBeInTheDocument();
    expect(screen.getByText("no extra capabilities")).toBeInTheDocument();
  });

  it("shows the session environment, a fallback warning, and 'not reported' (#3156)", () => {
    stubFetch({});
    useDashboardStore.setState({
      hosts: [
        makeHost({
          id: "h1",
          name: "mac",
          sessionEnv: {
            shell: "/bin/zsh",
            interactiveResolve: "fallback",
            reason: "timeout",
            retryAt: Date.now() + 4 * 60_000,
            path: ["/usr/bin", "/bin"],
            recoveredKeys: [],
          },
        }),
        makeHost({ id: "h2", name: "old", sessionEnv: null }),
        makeHost({
          id: "h3",
          name: "fine",
          sessionEnv: {
            shell: "/bin/bash",
            interactiveResolve: "ok",
            reason: null,
            path: ["/opt/bin"],
            recoveredKeys: ["ANDROID_HOME"],
          },
        }),
        makeHost({
          id: "h4",
          name: "desktop",
          sessionEnv: {
            shell: null,
            interactiveResolve: "not-applicable",
            reason: null,
            path: ["C:\\Windows\\system32"],
            recoveredKeys: [],
          },
        }),
      ],
    });
    render(<HostsSection />);
    const warning = screen.getByTestId("host-session-env-warning-h1");
    expect(warning).toHaveTextContent("PATH recovery fell back: timeout — will retry in 4m");
    expect(screen.getByTestId("host-session-env-h1")).not.toHaveAttribute("open");
    expect(screen.getByText("/usr/bin")).toBeInTheDocument();
    expect(screen.getByTestId("host-session-env-h2")).toHaveTextContent("not reported");
    expect(screen.queryByTestId("host-session-env-warning-h3")).not.toBeInTheDocument();
    // Windows never resolves, by design: no warning, and it says so.
    expect(screen.queryByTestId("host-session-env-warning-h4")).not.toBeInTheDocument();
    expect(screen.getByTestId("host-session-env-h4")).toHaveTextContent(
      "Interactive resolve: not applicable (Windows)",
    );
    expect(screen.getByText("Recovered: ANDROID_HOME")).toBeInTheDocument();
  });

  it("shows the protocol version, legacy hosts, incompatibility and missing operations", () => {
    stubFetch({});
    useDashboardStore.setState({
      hosts: [
        makeHost({
          id: "ok",
          name: "ok",
          protocol: {
            protocolVersion: 1,
            incompatible: false,
            missingOperations: [],
            missingLaunchOptions: [],
            legacy: false,
          },
        }),
        makeHost({
          id: "old",
          name: "old",
          protocol: {
            protocolVersion: null,
            incompatible: false,
            missingOperations: ["updates"],
            missingLaunchOptions: ["model"],
            legacy: true,
          },
        }),
        makeHost({
          id: "bad",
          name: "bad",
          protocol: {
            protocolVersion: 9,
            incompatible: true,
            missingOperations: [],
            missingLaunchOptions: [],
            legacy: false,
          },
        }),
        makeHost({ id: "unk", name: "unk", protocol: null }),
      ],
    });
    render(<HostsSection />);
    expect(screen.getByTestId("host-protocol-ok")).toHaveTextContent("protocol v1");
    expect(screen.getByTestId("host-protocol-old")).toHaveTextContent(
      "protocol: legacy · missing: updates — update this host · launch options: model unavailable",
    );
    expect(screen.getByTestId("host-protocol-bad")).toHaveTextContent(
      "protocol v9 · incompatible — update this host",
    );
    expect(screen.queryByTestId("host-protocol-unk")).not.toBeInTheDocument();
  });

  it("rotates after a second click and shows the new token once", async () => {
    const user = userEvent.setup();
    const calls = stubFetch({ rotate: () => jsonResponse(200, { token: "new-token-abc" }) });
    render(<HostsSection />);

    await openRotate(user);

    expect(await screen.findByText("New token for win-pc")).toBeInTheDocument();
    expect(screen.getAllByText(/new-token-abc/).length).toBeGreaterThan(0);
    expect(calls).toContain("POST /api/hosts/h1/rotate-token");

    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText("New token for win-pc")).not.toBeInTheDocument();
  });

  it("surfaces a failed rotation instead of showing a token", async () => {
    const user = userEvent.setup();
    stubFetch({ rotate: () => jsonResponse(500, { message: "boom" }) });
    render(<HostsSection />);

    await openRotate(user);

    expect(await screen.findByText(/boom/)).toBeInTheDocument();
    expect(screen.queryByText(/New token for/)).not.toBeInTheDocument();
  });

  it.each([
    { kind: "live identity", host: { hasLiveMachineIdentity: true }, rotates: false },
    { kind: "manual with token", host: { origin: "manual", hasToken: true }, rotates: true },
    { kind: "manual without token", host: { origin: "manual", hasToken: false }, rotates: false },
    { kind: "enrolled", host: { origin: "enrolled", hasToken: false }, rotates: false },
  ] as const)("shows the allowed actions for a $kind host", async ({ host, rotates }) => {
    const user = userEvent.setup();
    useDashboardStore.setState({ hosts: [makeHost(host)] });
    stubFetch({});
    render(<HostsSection />);

    await user.click(screen.getByRole("button", { name: "More…" }));
    const menu = within(screen.getByRole("menu"));
    for (const action of [
      "View config",
      "Edit",
      "Park host",
      "Re-pair",
      "Revoke identity",
      "Delete host",
    ]) {
      expect(menu.getByText(action, { exact: action !== "Park host" })).toBeInTheDocument();
    }
    expect(screen.queryByText("Identity revoked")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Test" })).toBeEnabled();
    expect(menu.queryByText(/rotate token and discard/i)).not.toBeInTheDocument();
    expect(menu.queryAllByText("Rotate token")).toHaveLength(rotates ? 1 : 0);
  });

  it.each([null, "http://worker.test"])(
    "shows a revoked identity and recovery actions (address: %s)",
    async (baseUrl) => {
      const user = userEvent.setup();
      useDashboardStore.setState({
        hosts: [
          makeHost({
            id: "h1",
            baseUrl,
            health: "pending",
            paired: true,
            machineIdentityRevoked: true,
            hasMachineIdentity: false,
            hasLiveMachineIdentity: false,
          }),
        ],
      });
      stubFetch({});
      render(<HostsSection />);

      const row = within(screen.getByTestId("host-row-h1"));
      expect(row.getByText("Identity revoked")).toHaveAttribute(
        "title",
        expect.stringMatching(/agent can no longer connect.*Re-pair/),
      );
      expect(row.queryByText(/paired — waiting for the agent to connect/)).not.toBeInTheDocument();
      expect(row.getByRole("button", { name: "Test" })).toBeDisabled();
      await user.click(row.getByRole("button", { name: "More…" }));
      const menu = within(screen.getByRole("menu"));
      for (const action of ["View config", "Edit", "Park host", "Re-pair", "Delete host"]) {
        expect(menu.getByText(action, { exact: action !== "Park host" })).toBeInTheDocument();
      }
      expect(menu.queryByText("Revoke identity")).not.toBeInTheDocument();
    },
  );

  it("can revoke a manual host that has no machine identity", async () => {
    const user = userEvent.setup();
    const calls = stubFetch({ revoke: () => new Response(null, { status: 204 }) });
    render(<HostsSection />);

    await user.click(screen.getByRole("button", { name: "More…" }));
    await user.click(screen.getByText("Revoke identity"));
    await user.click(screen.getByText("Click again to revoke"));
    expect(calls).toContain("POST /api/hosts/h1/revoke");
  });

  it("renders identity replacement badge and detail when recentIdentityReplacement is set, and Acknowledge clears it", async () => {
    const user = userEvent.setup();
    const recentAt = new Date(Date.now() - 5 * 60_000).toISOString();
    useDashboardStore.setState({
      hosts: [
        makeHost({
          id: "h1",
          name: "worker-1",
          recentIdentityReplacement: { id: 10, at: recentAt, peer: "10.0.0.42" },
        }),
        makeHost({
          id: "h2",
          name: "worker-2",
          recentIdentityReplacement: null,
        }),
      ],
    });
    const calls = stubFetch({
      acknowledge: () => {
        useDashboardStore.setState((state) => ({
          hosts: state.hosts.map((h) =>
            h.id === "h1" ? { ...h, recentIdentityReplacement: null } : h,
          ),
        }));
        return jsonResponse(200, { ok: true });
      },
    });

    render(<HostsSection />);

    expect(screen.getByTestId("host-row-h1")).toHaveClass("stacked");
    expect(screen.getByTestId("host-row-h2")).not.toHaveClass("stacked");
    expect(screen.getByTestId("host-identity-replaced-h1")).toHaveTextContent(
      /Identity replaced 5 min ago/,
    );
    expect(screen.getByTestId("host-identity-replaced-h1")).toHaveAttribute(
      "title",
      expect.stringContaining("Re-pairing is the operator's way to replace an agent"),
    );
    expect(screen.getByTestId("host-identity-replaced-h1").getAttribute("title")).not.toContain(
      "rotate the per-host token",
    );
    expect(screen.getByTestId("host-identity-replaced-detail-h1")).toHaveTextContent("10.0.0.42");
    expect(screen.queryByTestId("host-identity-replaced-h2")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Acknowledge" }));

    await vi.waitFor(() =>
      expect(calls).toContain("POST /api/hosts/h1/identity-events/acknowledge"),
    );
    await vi.waitFor(() =>
      expect(screen.queryByTestId("host-identity-replaced-h1")).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId("host-row-h1")).not.toHaveClass("stacked");
  });

  it("shows Awaiting approval with peer address, Approve, and Reject on pending hosts (issue #3441)", async () => {
    const user = userEvent.setup();
    useDashboardStore.setState({
      hosts: [
        makeHost({
          id: "h-pending",
          name: "new-worker",
          baseUrl: null,
          health: "online",
          approvalPending: true,
          enrollmentPeer: "10.0.0.55",
        }),
        makeHost({
          id: "h-reject",
          name: "bad-worker",
          baseUrl: null,
          approvalPending: true,
          enrollmentPeer: "10.0.0.99",
        }),
      ],
    });
    const calls = stubFetch({
      approve: () => {
        useDashboardStore.setState((state) => ({
          hosts: state.hosts.map((h) =>
            h.id === "h-pending" ? { ...h, approvalPending: false, enrollmentPeer: null } : h,
          ),
        }));
        return jsonResponse(200, { ok: true });
      },
      deleteHost: () => jsonResponse(204, null),
    });

    render(<HostsSection />);

    expect(screen.getByTestId("host-approval-pending-h-pending")).toHaveTextContent(
      "Awaiting approval",
    );
    expect(screen.getByTestId("host-approval-detail-h-pending")).toHaveTextContent("10.0.0.55");

    const pendingDetail = screen.getByTestId("host-approval-detail-h-pending");
    await user.click(within(pendingDetail).getByRole("button", { name: "Approve" }));
    await vi.waitFor(() => expect(calls).toContain("POST /api/hosts/h-pending/approve"));
    await vi.waitFor(() =>
      expect(screen.queryByTestId("host-approval-pending-h-pending")).not.toBeInTheDocument(),
    );

    const rejectDetail = screen.getByTestId("host-approval-detail-h-reject");
    await user.click(within(rejectDetail).getByRole("button", { name: "Reject" }));
    await vi.waitFor(() => expect(calls).toContain("DELETE /api/hosts/h-reject"));
  });

  const code = "a".repeat(64);
  const pairingLink = `mullion://pair?url=http%3A%2F%2Fprimary.test&code=${code}`;
  const pairingResponse = () =>
    jsonResponse(200, {
      id: "pair-1",
      pairing_link: pairingLink,
      url: "http://primary.test",
      code,
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    });

  it("confirms Re-pair before issuing a host-bound code and showing its install command", async () => {
    const user = userEvent.setup();
    const createPairing = vi.fn(pairingResponse);
    stubFetch({ createPairing });
    render(<HostsSection />);

    await user.click(screen.getByRole("button", { name: "More…" }));
    await user.click(screen.getByText("Re-pair"));
    const dialog = within(screen.getByRole("dialog", { name: "Re-pair win-pc" }));
    expect(dialog.getByText(/disconnects the running agent immediately/)).toBeInTheDocument();
    expect(createPairing).not.toHaveBeenCalled();

    await user.click(dialog.getByRole("button", { name: "Generate pairing code" }));
    expect(createPairing).toHaveBeenCalledExactlyOnceWith({ hostId: "h1" });
    const panel = await dialog.findByTestId("pairing-link-panel");
    expect(panel).toHaveTextContent(code);
    expect(panel).toHaveTextContent("MULLION_AGENT_PAIRING_FORCE=1");
  });

  it("adds a host with a one-time code, the Helper link and the headless install command", async () => {
    const user = userEvent.setup();
    const createPairing = vi.fn(pairingResponse);
    stubFetch({ createPairing });
    render(<HostsSection />);

    expect(screen.queryByText("Pair a desktop")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add host" }));
    const dialog = within(screen.getByRole("dialog", { name: "Add host" }));
    await user.click(dialog.getByRole("button", { name: "Generate pairing code" }));

    expect(createPairing).toHaveBeenCalledExactlyOnceWith({});
    const panel = await dialog.findByTestId("pairing-link-panel");
    expect(panel).toHaveTextContent("http://primary.test");
    expect(within(panel).getByText(code)).toBeInTheDocument();
    expect(within(panel).getByRole("link", { name: "Open in Helper" })).toHaveAttribute(
      "href",
      pairingLink,
    );
    expect(
      within(panel).getByRole("link", { name: "Download Mullion Helper" }),
    ).toBeInTheDocument();
    expect(panel).toHaveTextContent("MULLION_AGENT_PAIRING_CODE_STDIN=1");
    expect(panel).not.toHaveTextContent("MULLION_AGENT_PAIRING_FORCE=1");
    await user.click(within(panel).getByRole("button", { name: "Copy Pairing code" }));
    expect(await navigator.clipboard.readText()).toBe(code);
    await user.click(
      within(panel).getByRole("button", { name: "Copy Install command (Linux / macOS)" }),
    );
    const command = await navigator.clipboard.readText();
    const stdin = `<<'MULLION_PAIRING_CODE'\n${code}\nMULLION_PAIRING_CODE`;
    expect(command.endsWith(stdin)).toBe(true);
    expect(command.slice(0, -stdin.length)).not.toContain(code);
  });

  it("keeps the pending pairing dialog open and sends only one request", async () => {
    const user = userEvent.setup();
    let resolvePairing!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolvePairing = resolve;
    });
    const createPairing = vi.fn(() => pending);
    stubFetch({ createPairing });
    render(<HostsSection />);

    await user.click(screen.getByRole("button", { name: "Add host" }));
    const dialog = within(screen.getByRole("dialog", { name: "Add host" }));
    await user.click(
      await dialog.findByText("Advanced: host the primary dials directly (deprecated)"),
    );
    await user.click(dialog.getByRole("button", { name: "Generate pairing code" }));

    await user.click(dialog.getByRole("button", { name: "Generating…" }));
    await user.click(dialog.getByRole("button", { name: "Cancel" }));
    await user.click(dialog.getByRole("button", { name: "Add with a token" }));
    await user.keyboard("{Escape}");
    expect(dialog.queryByRole("textbox", { name: "Name" })).not.toBeInTheDocument();
    expect(createPairing).toHaveBeenCalledTimes(1);

    resolvePairing(pairingResponse());
    expect(await dialog.findByTestId("pairing-link-panel")).toBeInTheDocument();
  });

  it("shows pairing errors and allows retry", async () => {
    const user = userEvent.setup();
    const createPairing = vi
      .fn(pairingResponse)
      .mockReturnValueOnce(jsonResponse(500, { message: "Pairing failed" }));
    stubFetch({ createPairing });
    render(<HostsSection />);

    await user.click(screen.getByRole("button", { name: "Add host" }));
    const generate = screen.getByRole("button", { name: "Generate pairing code" });
    await user.click(generate);
    expect(await screen.findByText("Pairing failed")).toBeInTheDocument();
    await user.click(generate);
    expect(await screen.findByTestId("pairing-link-panel")).toBeInTheDocument();
  });

  it.each([false, true])(
    "keeps the advanced token-host flow on POST /api/hosts (own token: %s)",
    async (ownToken) => {
      const user = userEvent.setup();
      const host = makeHost({ id: "h2", name: "legacy-host" });
      const createHost = vi.fn(() =>
        jsonResponse(201, { ...host, ...(ownToken ? {} : { token: "generated-token" }) }),
      );
      const createPairing = vi.fn(pairingResponse);
      stubFetch({ createHost, createPairing });
      render(<HostsSection />);

      await user.click(screen.getByRole("button", { name: "Add host" }));
      const dialog = within(screen.getByRole("dialog", { name: "Add host" }));
      await user.click(
        await dialog.findByText("Advanced: host the primary dials directly (deprecated)"),
      );
      await user.click(dialog.getByRole("button", { name: "Add with a token" }));
      const form = within(screen.getByRole("dialog", { name: "Add host" }));
      await user.type(form.getByRole("textbox", { name: "Name" }), "legacy-host");
      if (ownToken) {
        await user.click(form.getByRole("checkbox", { name: "Use my own token" }));
        await user.type(form.getByLabelText(/^Token/), "provided-token");
      }
      await user.click(form.getByRole("button", { name: "Add host" }));

      expect(createPairing).not.toHaveBeenCalled();
      expect(createHost).toHaveBeenCalledExactlyOnceWith({
        name: "legacy-host",
        ...(ownToken ? { token: "provided-token" } : {}),
      });
      if (!ownToken) expect(await screen.findByText("generated-token")).toBeInTheDocument();
    },
  );

  // Issue #3477 — the token flow is the legacy one, and the server refuses it
  // while MULLION_ALLOW_LEGACY_HOSTS is off. The entry that offers it is
  // shown only when the server says the path is still open, so the operator
  // is not walked into a 400.
  it.each([
    { allowLegacyHosts: true, expectVisible: true },
    { allowLegacyHosts: false, expectVisible: false },
    // A primary that predates the gate — or a bundle cached from before it —
    // does not report the field at all. "Not reported" is not "open", so the
    // entry stays hidden: the server would refuse the request anyway.
    { allowLegacyHosts: undefined, expectVisible: false },
  ])(
    "offers the advanced token-host disclosure only when the server reports the legacy gate on (allowLegacyHosts: $allowLegacyHosts)",
    async ({ allowLegacyHosts, expectVisible }) => {
      const user = userEvent.setup();
      const calls = stubFetch({ serverInfo: { allowLegacyHosts } });
      render(<HostsSection />);

      await user.click(screen.getByRole("button", { name: "Add host" }));
      const dialog = within(screen.getByRole("dialog", { name: "Add host" }));
      // The pairing flow itself is untouched either way.
      expect(dialog.getByRole("button", { name: "Generate pairing code" })).toBeInTheDocument();
      // The server was asked which paths it still takes.
      await vi.waitFor(() => expect(calls).toContain("GET /api/server-info"));

      if (expectVisible) {
        expect(
          await dialog.findByText("Advanced: host the primary dials directly (deprecated)"),
        ).toBeInTheDocument();
        expect(dialog.getByRole("button", { name: "Add with a token" })).toBeInTheDocument();
      } else {
        await vi.waitFor(() =>
          expect(
            dialog.queryByText("Advanced: host the primary dials directly (deprecated)"),
          ).toBeNull(),
        );
        expect(dialog.queryByRole("button", { name: "Add with a token" })).toBeNull();
      }
    },
  );
});
