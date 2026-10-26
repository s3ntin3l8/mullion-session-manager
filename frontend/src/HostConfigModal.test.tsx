// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HostConfigModal } from "./HostConfigModal.js";
import { api } from "./api/index.js";
import type { HostConfig } from "./api/index.js";
import type * as ApiModule from "./api/index.js";

vi.mock("./api/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    api: { ...actual.api, getHostConfig: vi.fn(), setHostProjectsRoots: vi.fn() },
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
  vi.mocked(api.setHostProjectsRoots).mockReset();
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

// Issue #820 PR7a/PR7c — `source` distinguishes WHY sshAuthSock has the
// path it does, layered onto the three states above rather than a
// standalone fifth branch. A build between PR5d and PR7a still reports
// `{path, present}` with no `source` key at all (covered by the "live"
// test above, which renders unchanged with no trailing label) — these
// tests cover the three tagged cases plus that no-`source` passthrough.
describe("HostConfigModal — sshAuthSock source label", () => {
  const path = "/home/bjoern/.local/state/mullion-ssh-agent/agent.sock";

  it("labels a configured (MULLION_SSH_AUTH_SOCK) source", async () => {
    vi.mocked(api.getHostConfig).mockResolvedValue(
      makeConfig({ sshAuthSock: { path, present: true, source: "configured" } }),
    );
    render(<HostConfigModal hostId="mgmt-id" hostName="mgmt" onClose={vi.fn()} />);

    expect(
      await screen.findByText(`${path} (present) — configured via MULLION_SSH_AUTH_SOCK`),
    ).toBeInTheDocument();
  });

  it("labels an ambient source", async () => {
    vi.mocked(api.getHostConfig).mockResolvedValue(
      makeConfig({ sshAuthSock: { path, present: true, source: "ambient" } }),
    );
    render(<HostConfigModal hostId="mgmt-id" hostName="mgmt" onClose={vi.fn()} />);

    expect(
      await screen.findByText(
        `${path} (present) — ambient (inherited on that host, not managed by Mullion)`,
      ),
    ).toBeInTheDocument();
  });

  it("labels a bridge-backed source", async () => {
    vi.mocked(api.getHostConfig).mockResolvedValue(
      makeConfig({ sshAuthSock: { path, present: true, source: "bridge" } }),
    );
    render(<HostConfigModal hostId="mgmt-id" hostName="mgmt" onClose={vi.fn()} />);

    expect(
      await screen.findByText(`${path} (present) — SSH agent bridge (Settings > Hosts)`),
    ).toBeInTheDocument();
  });

  it("renders no trailing label when source is absent (agent predates PR7a's source tag)", async () => {
    vi.mocked(api.getHostConfig).mockResolvedValue(
      makeConfig({ sshAuthSock: { path, present: true } }),
    );
    render(<HostConfigModal hostId="mgmt-id" hostName="mgmt" onClose={vi.fn()} />);

    expect(await screen.findByText(`${path} (present)`)).toBeInTheDocument();
  });
});

// Issue #1951 follow-up — editing a REMOTE host's project roots. The agent
// decides (it validates, and its operator may pin the roots); the dialog only
// offers editing when the host says it can be edited.
describe("HostConfigModal — editable projects roots", () => {
  const editable = (over: Partial<HostConfig> = {}) =>
    makeConfig({
      projectsRoots: ["/Users/x/mullion-projects"],
      projectsRootsSource: "env",
      projectsRootsEnv: ["/Users/x/mullion-projects"],
      projectsRootsLocked: false,
      ...over,
    });
  const renderRemote = (hostId = "mac-1") =>
    render(<HostConfigModal hostId={hostId} hostName="macbook" onClose={vi.fn()} />);

  it("offers Edit roots on a remote host that reports it is not pinned", async () => {
    vi.mocked(api.getHostConfig).mockResolvedValue(editable());
    renderRemote();
    expect(await screen.findByRole("button", { name: "Edit roots" })).toBeInTheDocument();
    expect(screen.getByText(/From the host's own PROJECTS_ROOTS/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset to default" })).toBeNull();
  });

  it("offers no editing for this machine (its roots are Settings → Projects & discovery's)", async () => {
    vi.mocked(api.getHostConfig).mockResolvedValue(editable());
    renderRemote("local");
    await screen.findByText("/Users/x/mullion-projects");
    expect(screen.queryByRole("button", { name: "Edit roots" })).toBeNull();
  });

  it("says why it cannot be edited when the host's operator pinned the roots", async () => {
    vi.mocked(api.getHostConfig).mockResolvedValue(editable({ projectsRootsLocked: true }));
    renderRemote();
    expect(await screen.findByText(/PROJECTS_ROOTS_LOCKED/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit roots" })).toBeNull();
  });

  it("says to upgrade a host whose Mullion predates the field", async () => {
    vi.mocked(api.getHostConfig).mockResolvedValue(
      makeConfig({ projectsRoots: ["/Users/x/mullion-projects"] }),
    );
    renderRemote();
    expect(await screen.findByText(/too old to change its roots/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit roots" })).toBeNull();
  });

  it("saves an edited list, trimmed, and shows the host's fresh config", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getHostConfig).mockResolvedValue(editable());
    vi.mocked(api.setHostProjectsRoots).mockResolvedValue(
      editable({
        projectsRoots: ["/Users/x/a", "/Users/x/b"],
        projectsRootsSource: "override",
      }),
    );
    renderRemote();
    await user.click(await screen.findByRole("button", { name: "Edit roots" }));
    const first = screen.getByRole("textbox", { name: "Root 1" });
    await user.clear(first);
    await user.type(first, "  /Users/x/a  ");
    await user.click(screen.getByRole("button", { name: /Add a root directory/ }));
    await user.type(screen.getByRole("textbox", { name: "Root 2" }), "/Users/x/b");
    await user.click(screen.getByRole("button", { name: "Save roots" }));

    await waitFor(() =>
      expect(api.setHostProjectsRoots).toHaveBeenCalledWith("mac-1", ["/Users/x/a", "/Users/x/b"]),
    );
    expect(await screen.findByText("/Users/x/a, /Users/x/b")).toBeInTheDocument();
    expect(screen.getByText(/Set from this dialog/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset to default" })).toBeInTheDocument();
  });

  it("removes a root, and refuses to save an empty list", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getHostConfig).mockResolvedValue(editable());
    renderRemote();
    await user.click(await screen.findByRole("button", { name: "Edit roots" }));
    await user.click(screen.getByRole("button", { name: "Remove root 1" }));
    await user.click(screen.getByRole("button", { name: "Save roots" }));
    expect(await screen.findByText(/Add at least one directory/)).toBeInTheDocument();
    expect(api.setHostProjectsRoots).not.toHaveBeenCalled();
  });

  it("shows the host's refusal and keeps the draft open", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getHostConfig).mockResolvedValue(editable());
    vi.mocked(api.setHostProjectsRoots).mockRejectedValue(
      new Error('"/nope" does not exist on this host'),
    );
    renderRemote();
    await user.click(await screen.findByRole("button", { name: "Edit roots" }));
    const first = screen.getByRole("textbox", { name: "Root 1" });
    await user.clear(first);
    await user.type(first, "/nope");
    await user.click(screen.getByRole("button", { name: "Save roots" }));
    expect(await screen.findByText(/does not exist on this host/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Root 1" })).toHaveValue("/nope");
  });

  it("cancel discards the draft", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getHostConfig).mockResolvedValue(editable());
    renderRemote();
    await user.click(await screen.findByRole("button", { name: "Edit roots" }));
    await user.type(screen.getByRole("textbox", { name: "Root 1" }), "/junk");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("textbox", { name: "Root 1" })).toBeNull();
    expect(screen.getByText("/Users/x/mullion-projects")).toBeInTheDocument();
    expect(api.setHostProjectsRoots).not.toHaveBeenCalled();
  });

  it("Reset to default removes the saved override and shows what it goes back to", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getHostConfig).mockResolvedValue(
      editable({ projectsRoots: ["/Users/x/saved"], projectsRootsSource: "override" }),
    );
    vi.mocked(api.setHostProjectsRoots).mockResolvedValue(editable());
    renderRemote();
    expect(
      await screen.findByText(/Reset goes back to the host's own setting/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reset to default" }));
    await waitFor(() => expect(api.setHostProjectsRoots).toHaveBeenCalledWith("mac-1", null));
    expect(await screen.findByText(/From the host's own PROJECTS_ROOTS/)).toBeInTheDocument();
  });
});
