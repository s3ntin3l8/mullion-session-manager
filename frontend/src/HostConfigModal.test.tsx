// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { HostConfigModal } from "./HostConfigModal.js";
import { api } from "./api/index.js";
import type { HostConfig } from "./api/index.js";
import type * as ApiModule from "./api/index.js";

vi.mock("./api/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    api: { ...actual.api, getHostConfig: vi.fn() },
  };
});

function makeConfig(overrides: Partial<HostConfig> = {}): HostConfig {
  return {
    role: "agent",
    version: "0.2.46",
    projectsRoots: [],
    sessionsDir: "/home/bjoern/opt/mullion/data/sessions",
    crsConfigDir: "",
    browserEnabled: false,
    sshAuthSock: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(api.getHostConfig).mockReset();
});

// #819/#822 SSH-agent follow-up — three distinct sshAuthSock states, each
// meaning something different to whoever's debugging a session's missing
// SSH agent: unconfigured, configured-but-dangling (the mgmt steady state
// whenever its tunnel is down), and a response from a host build that
// predates this field entirely (must read as "unknown", not as either of
// the other two — see HostConfig's own comment on why `undefined` !== `null`).
describe("HostConfigModal — sshAuthSock diagnostics", () => {
  it("renders 'not configured' when sshAuthSock is null", async () => {
    vi.mocked(api.getHostConfig).mockResolvedValue(makeConfig({ sshAuthSock: null }));
    render(<HostConfigModal hostId="mgmt-id" hostName="mgmt" onClose={vi.fn()} />);

    expect(await screen.findByText("not configured")).toBeInTheDocument();
  });

  it("renders the path and 'not present' when the socket is configured but dangling", async () => {
    vi.mocked(api.getHostConfig).mockResolvedValue(
      makeConfig({
        sshAuthSock: {
          path: "/home/bjoern/.local/state/mullion-ssh-agent/agent.sock",
          present: false,
        },
      }),
    );
    render(<HostConfigModal hostId="mgmt-id" hostName="mgmt" onClose={vi.fn()} />);

    expect(
      await screen.findByText(
        "/home/bjoern/.local/state/mullion-ssh-agent/agent.sock (not present — no tunnel up?)",
      ),
    ).toBeInTheDocument();
  });

  it("renders the path and 'present' when the socket is live", async () => {
    vi.mocked(api.getHostConfig).mockResolvedValue(
      makeConfig({
        sshAuthSock: {
          path: "/home/bjoern/.local/state/mullion-ssh-agent/agent.sock",
          present: true,
        },
      }),
    );
    render(<HostConfigModal hostId="mgmt-id" hostName="mgmt" onClose={vi.fn()} />);

    expect(
      await screen.findByText("/home/bjoern/.local/state/mullion-ssh-agent/agent.sock (present)"),
    ).toBeInTheDocument();
  });

  it("renders 'unknown' when the responding host predates this field (sshAuthSock absent, not null)", async () => {
    const staleConfig = makeConfig();
    delete (staleConfig as Partial<HostConfig>).sshAuthSock;
    vi.mocked(api.getHostConfig).mockResolvedValue(staleConfig);
    render(<HostConfigModal hostId="mgmt-id" hostName="mgmt" onClose={vi.fn()} />);

    expect(await screen.findByText("unknown (agent predates this field)")).toBeInTheDocument();
  });
});
