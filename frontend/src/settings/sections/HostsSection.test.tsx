// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HostsSection } from "./HostsSection.js";
import { useDashboardStore } from "../../store/index.js";
import { jsonResponse } from "../../test/jsonResponse.js";
import { makeHost } from "../../test/fixtures.js";
import type { PlacementCapability } from "../../../../src/shared/constants.js";

// Token rotation and the "waiting for the agent" row state. The rest of the
// section is exercised through its own components' tests.

function stubFetch(opts: { rotate?: () => Response }) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (url === "/api/hosts" && method === "GET") {
        return Promise.resolve(jsonResponse(200, useDashboardStore.getState().hosts));
      }
      if (url.endsWith("/rotate-token") && method === "POST" && opts.rotate) {
        return Promise.resolve(opts.rotate());
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

describe("HostsSection token rotation", () => {
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

  it("for a live-identity host says the agent is unaffected and offers rotate-and-discard", async () => {
    const user = userEvent.setup();
    useDashboardStore.setState({
      hosts: [
        makeHost({
          id: "h1",
          name: "win-pc",
          baseUrl: null,
          hasMachineIdentity: true,
          hasLiveMachineIdentity: true,
        }),
      ],
    });
    stubFetch({ rotate: () => jsonResponse(200, { token: "new-token-abc" }) });
    render(<HostsSection />);
    await user.click(screen.getByRole("button", { name: "More…" }));
    await user.click(screen.getByText("Rotate token"));
    await user.click(screen.getByText("Click again to rotate (agent unaffected)"));

    expect(await screen.findByText("New token for win-pc")).toBeInTheDocument();
    expect(screen.getByTestId("rotate-unaffected")).toHaveTextContent(/keeps working/);
    expect(screen.getByTestId("rotate-unaffected")).toHaveTextContent(/leaked/);
    expect(screen.getByTestId("rotate-unaffected")).toHaveTextContent(/another rotation/);
    expect(screen.queryByText(/can no longer reach this primary/)).not.toBeInTheDocument();
  });

  it("rotate-and-discard never renders the token and keeps no dialog open", async () => {
    const user = userEvent.setup();
    useDashboardStore.setState({
      hosts: [
        makeHost({
          id: "h1",
          name: "win-pc",
          baseUrl: null,
          hasMachineIdentity: true,
          hasLiveMachineIdentity: true,
        }),
      ],
    });
    const calls = stubFetch({ rotate: () => jsonResponse(200, { token: "secret-token-xyz" }) });
    render(<HostsSection />);
    await user.click(screen.getByRole("button", { name: "More…" }));
    await user.click(screen.getByText("Rotate token and discard it"));
    await user.click(screen.getByText("Click again to rotate (token not shown)"));

    await vi.waitFor(() => expect(calls).toContain("POST /api/hosts/h1/rotate-token"));
    expect(screen.queryByText(/New token for/)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("secret-token-xyz");
    expect(JSON.stringify(useDashboardStore.getState())).not.toContain("secret-token-xyz");
  });

  it("for a host without a live identity keeps the lockout copy and offers no discard", async () => {
    const user = userEvent.setup();
    useDashboardStore.setState({
      hosts: [makeHost({ id: "h1", name: "win-pc", baseUrl: null })],
    });
    stubFetch({ rotate: () => jsonResponse(200, { token: "new-token-abc" }) });
    render(<HostsSection />);
    await user.click(screen.getByRole("button", { name: "More…" }));
    expect(screen.queryByText("Rotate token and discard it")).not.toBeInTheDocument();
    await user.click(screen.getByText("Rotate token"));
    await user.click(screen.getByText("Click again to rotate"));

    expect(await screen.findByText("New token for win-pc")).toBeInTheDocument();
    expect(screen.queryByTestId("rotate-unaffected")).not.toBeInTheDocument();
    expect(screen.getByText(/can no longer reach this primary/)).toBeInTheDocument();
  });
});
