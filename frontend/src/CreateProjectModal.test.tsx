// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreateProjectModal } from "./CreateProjectModal.js";
import { api, ApiError } from "./api/index.js";
import type { Launcher } from "./api/index.js";
import { makeHost, makeProject } from "./test/fixtures.js";
import { useDashboardStore } from "./store/index.js";
import type * as ApiModule from "./api/index.js";

vi.mock("./api/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listProjectActions: vi.fn(),
      recheckReleasePlease: vi.fn(),
      getPlacementPreview: vi.fn(),
      previewPlacement: vi.fn(),
      getHostSuggestions: vi.fn(),
      listProjects: vi.fn(),
      getProject: vi.fn(),
      attachHostCheckout: vi.fn(),
    },
  };
});

function makeLauncher(overrides: Partial<Launcher>): Launcher {
  return { id: "agent:claude", title: "claude", command: "claude", kind: "agent", ...overrides };
}

// Both dropdowns share the same detected-launcher options, so a page-wide
// role/label query is ambiguous — scope to the specific field's own <select>
// via its field-label span, same .closest()+querySelector precedent
// Settings.sessions.test.tsx already uses for disambiguating repeated rows.
function fieldSelect(labelText: string): HTMLSelectElement {
  return screen
    .getByText(labelText, { selector: ".create-modal-field-label" })
    .closest(".create-modal-field")!
    .querySelector("select")!;
}

beforeEach(() => {
  vi.mocked(api.listProjectActions).mockReset();
  vi.mocked(api.getPlacementPreview).mockReset();
  vi.mocked(api.previewPlacement).mockReset();
  vi.mocked(api.getHostSuggestions).mockReset();
  vi.mocked(api.listProjects).mockReset();
  vi.mocked(api.getProject).mockReset();
  // Default answers, so a test that renders the modal without caring about
  // one of these fetches still has a promise to await (the hook calls
  // .then() on whatever the fetcher returns).
  vi.mocked(api.listProjectActions).mockResolvedValue([]);
  vi.mocked(api.getHostSuggestions).mockResolvedValue({ hosts: [] });
  vi.mocked(api.listProjects).mockResolvedValue([]);
  const preview = {
    placement: "auto" as const,
    hostId: "local",
    reason: "the only eligible host",
    considered: [],
    excluded: [],
    fellBack: false,
  };
  vi.mocked(api.getPlacementPreview).mockResolvedValue(preview);
  vi.mocked(api.previewPlacement).mockResolvedValue(preview);
});

// Issue #1726 / roadmap 8.12 — the placement control: "pinned" (today's
// behaviour) vs "automatic" (the policy chooses), and the LIVE preview that
// answers "where would a new session land right now, and why?".
describe("CreateProjectModal — the placement control (issue #1726)", () => {
  it("defaults to PINNED — every existing project behaves exactly as before", () => {
    render(
      <CreateProjectModal
        mode="create"
        onClose={vi.fn()}
        onCreate={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const pinned = screen.getByRole("radio", { name: /on a chosen host/i });
    const automatic = screen.getByRole("radio", { name: /automatic/i });
    expect(pinned).toBeChecked();
    expect(automatic).not.toBeChecked();
  });

  it("opens showing the project's OWN mode", () => {
    render(
      <CreateProjectModal
        mode="edit"
        initialName="mullion"
        initialPath="/home/x/mullion"
        projectId={1}
        initialPlacement="auto"
        onClose={vi.fn()}
        onCreate={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByRole("radio", { name: /automatic/i })).toBeChecked();
  });

  it("sends 'auto' when the user picks Automatic", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <CreateProjectModal
        mode="edit"
        initialName="mullion"
        initialPath="/home/x/mullion"
        projectId={1}
        onClose={vi.fn()}
        onCreate={onCreate}
      />,
    );

    await user.click(screen.getByRole("radio", { name: /automatic/i }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ placement: "auto" }));
  });

  it("shows WHERE a new session would land, and WHY", async () => {
    vi.mocked(api.getPlacementPreview).mockResolvedValue({
      placement: "auto",
      hostId: "mac-mini",
      reason: "least loaded of the eligible hosts",
      considered: [],
      excluded: [{ hostId: "laptop", reason: "burst host (only an explicit target uses it)" }],
      fellBack: false,
    });

    render(
      <CreateProjectModal
        mode="edit"
        initialName="mullion"
        initialPath="/home/x/mullion"
        projectId={1}
        initialPlacement="auto"
        hosts={[
          {
            id: "mac-mini",
            name: "mac-mini",
            baseUrl: "http://mac",
            isLocal: false,
            hasToken: true,
            createdAt: "2026-01-01T00:00:00.000Z",
            health: "online",
            lastSeenAt: null,
            lastCheckedAt: null,
            // Issue #1725 — the field is required on the type, so every
            // fixture carries it.
            drained: false,
            role: "worker",
          },
        ]}
        onClose={vi.fn()}
        onCreate={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await waitFor(() => expect(screen.getByText(/mac-mini/)).toBeInTheDocument());
    expect(screen.getByText(/least loaded of the eligible hosts/)).toBeInTheDocument();
    // Issue #2239 — the hosts left out, with the rule that left them out.
    expect(screen.getByText(/Not considered: laptop \(burst host/)).toBeInTheDocument();
    // It is a NOW reading, and the UI says so — load moves between the
    // preview and the spawn.
    expect(screen.getByText(/right now/i)).toBeInTheDocument();
  });

  it("shows NO preview for a pinned project — there is no decision to explain", () => {
    render(
      <CreateProjectModal
        mode="edit"
        initialName="mullion"
        initialPath="/home/x/mullion"
        projectId={1}
        onClose={vi.fn()}
        onCreate={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.queryByText(/right now/i)).not.toBeInTheDocument();
    expect(api.getPlacementPreview).not.toHaveBeenCalled();
  });

  it("says so when the preview cannot be read, rather than showing nothing", async () => {
    vi.mocked(api.getPlacementPreview).mockRejectedValue(new Error("boom"));

    render(
      <CreateProjectModal
        mode="edit"
        initialName="mullion"
        initialPath="/home/x/mullion"
        projectId={1}
        initialPlacement="auto"
        onClose={vi.fn()}
        onCreate={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText(/couldn't read the placement preview/i)).toBeInTheDocument(),
    );
  });

  it("previews by HOST in create mode — the project does not exist yet", async () => {
    const user = userEvent.setup();

    render(
      <CreateProjectModal
        mode="create"
        onClose={vi.fn()}
        onCreate={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await user.click(screen.getByRole("radio", { name: /automatic/i }));
    await waitFor(() => expect(api.previewPlacement).toHaveBeenCalled());
    expect(vi.mocked(api.previewPlacement).mock.calls[0][0]).toEqual({
      hostId: "local",
      placement: "auto",
    });
  });

  it("asks about the mode the user PICKED, not the one the project is stored as", async () => {
    // The bug this pins: the project is stored as "pinned", the user picks
    // "Automatic" — so the preview must be asked about "auto". Asking the
    // stored mode would answer the opposite of the question, and the user
    // would see "pinned to the project's host" while choosing automatic.
    const user = userEvent.setup();

    render(
      <CreateProjectModal
        mode="edit"
        initialName="mullion"
        initialPath="/home/x/mullion"
        projectId={1}
        initialPlacement="pinned"
        onClose={vi.fn()}
        onCreate={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await user.click(screen.getByRole("radio", { name: /automatic/i }));

    await waitFor(() => expect(api.getPlacementPreview).toHaveBeenCalled());
    expect(vi.mocked(api.getPlacementPreview).mock.calls[0]).toEqual([1, "auto"]);
  });
});

// Focused on the issue #28 phase 7 "use detected port" suggestion — the
// field's own pre-fill/edit/clear behavior predates this and isn't
// re-tested here.
// Issue #1951 follow-up — the per-host paths (`hostCwds`): where this
// project's checkout lives on the OTHER hosts. A host with no path is never a
// placement candidate, so this is what makes "spawn a child on the Mac" work.
describe("CreateProjectModal — paths on other hosts (hostCwds)", () => {
  const hosts = [
    makeHost({ id: "local", name: "Local", isLocal: true }),
    makeHost({ id: "mac-1", name: "macbook", platform: "darwin" }),
    makeHost({ id: "box-2", name: "builder", platform: "linux" }),
  ];

  function renderEdit(
    over: Partial<React.ComponentProps<typeof CreateProjectModal>> = {},
    onCreate = vi.fn().mockResolvedValue(undefined),
  ) {
    render(
      <CreateProjectModal
        mode="edit"
        initialName="mullion"
        initialPath="/home/x/mullion"
        projectId={1}
        hosts={hosts}
        projectHostId="local"
        onClose={vi.fn()}
        onCreate={onCreate}
        {...over}
      />,
    );
    return onCreate;
  }

  // Issue #2090 — "Detected: <path> · Use" for a host the project has no path
  // on yet, and the "auto-detected" badge for a path Mullion filled in itself.
  describe("detected checkouts", () => {
    const suggest = (over: Partial<{ ambiguous: boolean; declined: boolean }> = {}) =>
      vi.mocked(api.getHostSuggestions).mockResolvedValue({
        hosts: [
          {
            hostId: "mac-1",
            hostName: "macbook",
            candidates: [{ cwd: "/Users/x/mullion", match: "origin" }],
            ambiguous: false,
            declined: false,
            ...over,
          },
        ],
      });

    it("asks the server once for this project and offers the path as a one-click Use", async () => {
      suggest();
      const user = userEvent.setup();
      const onCreate = renderEdit();

      const use = await screen.findByRole("button", { name: "Use /Users/x/mullion on macbook" });
      expect(vi.mocked(api.getHostSuggestions)).toHaveBeenCalledWith(1);
      // Nothing is filled in until the user clicks.
      expect(screen.getByRole("textbox", { name: "Path on macbook" })).toHaveValue("");

      await user.click(use);
      expect(screen.getByRole("textbox", { name: "Path on macbook" })).toHaveValue(
        "/Users/x/mullion",
      );
      // The suggestion goes away once the row has a value.
      expect(screen.queryByRole("button", { name: /Use \/Users\/x\/mullion/ })).toBeNull();

      await user.click(screen.getByRole("button", { name: "Save changes" }));
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ hostCwds: { "mac-1": "/Users/x/mullion" } }),
      );
    });

    it("does not suggest for a host that already has a path", async () => {
      suggest();
      renderEdit({ initialHostCwds: { "mac-1": "/Users/x/mullion" } });

      await waitFor(() => expect(vi.mocked(api.getHostSuggestions)).toHaveBeenCalled());
      expect(screen.queryByTestId("host-suggestion-mac-1")).toBeNull();
    });

    it("says when the clone is only a name match, when several clones match, and when the host was declined", async () => {
      vi.mocked(api.getHostSuggestions).mockResolvedValue({
        hosts: [
          {
            hostId: "mac-1",
            hostName: "macbook",
            candidates: [
              { cwd: "/Users/x/a", match: "origin" },
              { cwd: "/Users/x/b", match: "name" },
            ],
            ambiguous: true,
            declined: true,
          },
        ],
      });
      renderEdit();

      const line = await screen.findByTestId("host-suggestion-mac-1");
      expect(line).toHaveTextContent("/Users/x/b (same name only)");
      expect(line).toHaveTextContent("More than one clone has this project's origin.");
      expect(line).toHaveTextContent("You removed this host's path earlier.");
    });

    it("stays quiet when the lookup fails", async () => {
      vi.mocked(api.getHostSuggestions).mockRejectedValue(new Error("503"));
      renderEdit();

      await waitFor(() => expect(vi.mocked(api.getHostSuggestions)).toHaveBeenCalled());
      expect(screen.queryByTestId("host-suggestion-mac-1")).toBeNull();
      expect(screen.getByRole("textbox", { name: "Path on macbook" })).toBeInTheDocument();
    });

    it("does not look anything up when creating a project, or when there is no other host", async () => {
      render(
        <CreateProjectModal mode="create" hosts={hosts} onClose={vi.fn()} onCreate={vi.fn()} />,
      );
      expect(vi.mocked(api.getHostSuggestions)).not.toHaveBeenCalled();

      renderEdit({ hosts: [hosts[0]] });
      expect(vi.mocked(api.getHostSuggestions)).not.toHaveBeenCalled();
    });

    it("flags an auto-detected path, and saving acknowledges it by sending the map unchanged", async () => {
      const user = userEvent.setup();
      const onCreate = renderEdit({
        initialHostCwds: { "mac-1": "/Users/x/mullion" },
        initialHostCwdsMeta: { auto: ["mac-1"], declined: [] },
      });

      expect(screen.getByText("auto-detected")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Save changes" }));

      // Not edited, but still sent: that is what clears the flag server-side.
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ hostCwds: { "mac-1": "/Users/x/mullion" } }),
      );
    });

    // The map is sent whole, so a host the sweep added AFTER the dialog opened
    // would read as removed (and be declined) unless the dialog re-reads first.
    it("keeps a host the server gained since the dialog opened, instead of removing it on save", async () => {
      vi.mocked(api.getProject).mockResolvedValue(
        makeProject({
          id: 1,
          hostCwds: { "mac-1": "/Users/x/mullion", "box-2": "/srv/found-meanwhile" },
        }),
      );
      const user = userEvent.setup();
      const onCreate = renderEdit({
        initialHostCwds: { "mac-1": "/Users/x/mullion" },
        initialHostCwdsMeta: { auto: ["mac-1"], declined: [] },
      });

      await user.click(screen.getByRole("button", { name: "Save changes" }));

      expect(api.getProject).toHaveBeenCalledWith(1);
      expect(api.listProjects).not.toHaveBeenCalled();
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          hostCwds: { "mac-1": "/Users/x/mullion", "box-2": "/srv/found-meanwhile" },
        }),
      );
    });

    it("does not override a host the user set themselves, and still removes one they cleared", async () => {
      vi.mocked(api.getProject).mockResolvedValue(
        makeProject({
          id: 1,
          hostCwds: { "mac-1": "/Users/x/mullion", "box-2": "/srv/found-meanwhile" },
        }),
      );
      const user = userEvent.setup();
      const onCreate = renderEdit({
        initialHostCwds: { "mac-1": "/Users/x/mullion" },
        initialHostCwdsMeta: { auto: ["mac-1"], declined: [] },
      });

      await user.type(screen.getByRole("textbox", { name: "Path on builder" }), "/mine");
      await user.clear(screen.getByRole("textbox", { name: "Path on macbook" }));
      await user.click(screen.getByRole("button", { name: "Save changes" }));

      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ hostCwds: { "box-2": "/mine" } }),
      );
    });

    it("falls back to its own map when the project cannot be re-read", async () => {
      vi.mocked(api.getProject).mockRejectedValue(new Error("offline"));
      const user = userEvent.setup();
      const onCreate = renderEdit({
        initialHostCwds: { "mac-1": "/Users/x/mullion" },
        initialHostCwdsMeta: { auto: ["mac-1"], declined: [] },
      });

      await user.click(screen.getByRole("button", { name: "Save changes" }));

      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ hostCwds: { "mac-1": "/Users/x/mullion" } }),
      );
    });

    it("an auto flag for a host the dialog does not show does not force a save of the map", async () => {
      const user = userEvent.setup();
      const onCreate = renderEdit({
        initialHostCwds: { "mac-1": "/Users/x/mullion" },
        // "gone-9" was deleted (or the project moved off it): there is no row for it.
        initialHostCwdsMeta: { auto: ["gone-9"], declined: [] },
      });

      await user.click(screen.getByRole("button", { name: "Save changes" }));

      expect(onCreate.mock.calls[0][0]).not.toHaveProperty("hostCwds");
    });

    it("shows no badge for a flagged host that has no path", () => {
      renderEdit({ initialHostCwds: {}, initialHostCwdsMeta: { auto: ["mac-1"], declined: [] } });
      expect(screen.queryByText("auto-detected")).toBeNull();
    });

    it("drops the badge once the path is edited, and never shows it for an operator's own path", async () => {
      const user = userEvent.setup();
      renderEdit({
        initialHostCwds: { "mac-1": "/Users/x/mullion", "box-2": "/srv/mullion" },
        initialHostCwdsMeta: { auto: ["mac-1"], declined: [] },
      });
      expect(screen.getAllByText("auto-detected")).toHaveLength(1);

      await user.type(screen.getByRole("textbox", { name: "Path on macbook" }), "2");

      expect(screen.queryByText("auto-detected")).toBeNull();
    });

    it("without any auto-detected path, an unedited save still leaves the map alone", async () => {
      const user = userEvent.setup();
      const onCreate = renderEdit({ initialHostCwds: { "mac-1": "/Users/x/mullion" } });

      await user.click(screen.getByRole("button", { name: "Save changes" }));

      expect(onCreate.mock.calls[0][0]).not.toHaveProperty("hostCwds");
    });
  });

  it("lists every host except the project's own, with its platform", () => {
    renderEdit();
    expect(screen.getByRole("textbox", { name: "Path on macbook" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Path on builder" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /Path on this machine/i })).toBeNull();
    expect(screen.getByText(/darwin/)).toBeInTheDocument();
  });

  it("offers this machine to a project that lives on a remote host", () => {
    renderEdit({ projectHostId: "mac-1" });
    expect(screen.getByRole("textbox", { name: "Path on this machine" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Path on macbook" })).toBeNull();
  });

  it("is not shown when creating a project", () => {
    render(<CreateProjectModal mode="create" hosts={hosts} onClose={vi.fn()} onCreate={vi.fn()} />);
    expect(screen.queryByRole("group", { name: "Paths on other hosts" })).toBeNull();
  });

  it("explains why there is nothing to set when no other host is registered", () => {
    renderEdit({ hosts: [hosts[0]] });
    expect(screen.queryByRole("group", { name: "Paths on other hosts" })).toBeNull();
    expect(screen.getByText(/No other host is registered/)).toBeInTheDocument();
  });

  it("does not wipe the stored map when the host list has not loaded (a rename must not delete it)", async () => {
    const user = userEvent.setup();
    const onCreate = renderEdit({
      hosts: [],
      initialHostCwds: { "mac-1": "/Users/x/mullion" },
    });
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0][0]).not.toHaveProperty("hostCwds");
  });

  it("opens filled with the project's existing paths", () => {
    renderEdit({ initialHostCwds: { "mac-1": "/Users/x/mullion" } });
    expect(screen.getByRole("textbox", { name: "Path on macbook" })).toHaveValue(
      "/Users/x/mullion",
    );
    expect(screen.getByRole("textbox", { name: "Path on builder" })).toHaveValue("");
  });

  it("sends the FULL map (the API replaces it) once a path is typed", async () => {
    const user = userEvent.setup();
    const onCreate = renderEdit({ initialHostCwds: { "box-2": "/srv/mullion" } });
    await user.type(
      screen.getByRole("textbox", { name: "Path on macbook" }),
      "  /Users/x/mullion  ",
    );
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0][0].hostCwds).toEqual({
      "box-2": "/srv/mullion",
      "mac-1": "/Users/x/mullion",
    });
  });

  it("sends {} when the last path is cleared, so the map is emptied", async () => {
    const user = userEvent.setup();
    const onCreate = renderEdit({ initialHostCwds: { "mac-1": "/Users/x/mullion" } });
    await user.clear(screen.getByRole("textbox", { name: "Path on macbook" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0][0].hostCwds).toEqual({});
  });

  // Issue #2241 — the steering flags in Edit project → Placement.
  it("opens with the project's placement flags and sends them once changed", async () => {
    const user = userEvent.setup();
    const onCreate = renderEdit({
      initialPlacementConstraints: { platform: ["darwin"], allowBurst: false },
    });
    expect(screen.getByRole("checkbox", { name: "macOS" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Linux" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Allow burst hosts" })).not.toBeChecked();

    await user.click(screen.getByRole("checkbox", { name: "Linux" }));
    await user.click(screen.getByRole("checkbox", { name: "Allow burst hosts" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0][0].placementConstraints).toEqual({
      platform: ["darwin", "linux"],
      allowBurst: true,
      capabilities: [],
    });
  });

  it("leaves the flags out of the save when unchanged", async () => {
    const user = userEvent.setup();
    const unchanged = renderEdit({});
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(unchanged).toHaveBeenCalled());
    expect(unchanged.mock.calls[0][0]).not.toHaveProperty("placementConstraints");
  });

  it("sends an emptied platform list when the last platform is unticked", async () => {
    const user = userEvent.setup();
    const onCreate = renderEdit({
      initialPlacementConstraints: { platform: ["win32"], allowBurst: false },
    });
    await user.click(screen.getByRole("checkbox", { name: "Windows" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0][0].placementConstraints).toEqual({
      platform: [],
      allowBurst: false,
      capabilities: [],
    });
  });

  it("edits the required capabilities and sends them (#2306)", async () => {
    const user = userEvent.setup();
    const onCreate = renderEdit({
      initialPlacementConstraints: {
        platform: [],
        allowBurst: false,
        capabilities: ["android-emulator"],
      },
    });
    const xcode = screen.getByRole("checkbox", { name: "Needs Xcode (iOS Simulator)" });
    expect(xcode).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Needs an Android emulator" })).toBeChecked();

    await user.click(xcode);
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0][0].placementConstraints).toEqual({
      platform: [],
      allowBurst: false,
      capabilities: ["xcode", "android-emulator"],
    });
  });

  it("leaves pre-provision out of the save when unchanged", async () => {
    const user = userEvent.setup();
    const onCreate = renderEdit({});
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0][0]).not.toHaveProperty("preProvision");
  });

  it("sends the pre-provision choice once it changed", async () => {
    const user = userEvent.setup();
    const onCreate = renderEdit({});
    await user.selectOptions(screen.getByLabelText("Pre-provision checkouts"), "all");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0][0].preProvision).toBe("all");
  });

  it("lists the hosts to pick from for a selected-hosts pre-provision", async () => {
    const user = userEvent.setup();
    const onCreate = renderEdit({ initialPreProvision: ["mac-1"] });
    expect(screen.getByRole("checkbox", { name: "macbook" })).toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: "macbook" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0][0].preProvision).toEqual([]);
  });

  it("does not show the flags when creating a project", () => {
    render(<CreateProjectModal onClose={vi.fn()} onCreate={vi.fn()} />);
    expect(screen.queryByRole("checkbox", { name: "macOS" })).toBeNull();
  });

  it("leaves hostCwds out entirely when nothing changed", async () => {
    const user = userEvent.setup();
    const onCreate = renderEdit({ initialHostCwds: { "mac-1": "/Users/x/mullion" } });
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0][0]).not.toHaveProperty("hostCwds");
  });

  it("drops an entry for a host that no longer exists instead of sending it", async () => {
    // The API rejects the whole PATCH on an unknown host id.
    const user = userEvent.setup();
    const onCreate = renderEdit({
      initialHostCwds: { "mac-1": "/Users/x/mullion", "gone-9": "/old" },
    });
    await user.type(screen.getByRole("textbox", { name: "Path on builder" }), "/srv/mullion");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0][0].hostCwds).toEqual({
      "mac-1": "/Users/x/mullion",
      "box-2": "/srv/mullion",
    });
  });

  it("refuses a relative path without calling onCreate", async () => {
    const user = userEvent.setup();
    const onCreate = renderEdit();
    await user.type(screen.getByRole("textbox", { name: "Path on macbook" }), "code/mullion");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onCreate).not.toHaveBeenCalled();
    expect(await screen.findByText(/must be absolute/)).toBeInTheDocument();
    expect(
      screen.getByText(/macbook/, { selector: ".create-modal-field-hint.error" }),
    ).toBeTruthy();
  });

  it("shows the server's rejection inline", async () => {
    const user = userEvent.setup();
    const onCreate = vi
      .fn()
      .mockRejectedValue(new ApiError("hostCwds names an unknown host: mac-1", 400));
    renderEdit({}, onCreate);
    await user.type(screen.getByRole("textbox", { name: "Path on macbook" }), "/Users/x/m");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/names an unknown host/)).toBeInTheDocument();
  });
});

// Hermes review, PR #477 — Default Agent / Default Review Agent dropdowns
// (Phase 6 Task Master, 6.5/#218). Both dropdowns share the same detected
// launchers, so every query below is scoped to one via the fieldSelect
// helper rather than an ambiguous page-wide role query.
describe("CreateProjectModal — Default Agent / Default Review Agent dropdowns", () => {
  it("lists detected agent launchers as options", async () => {
    vi.mocked(api.listProjectActions).mockResolvedValue([
      makeLauncher({ id: "agent:claude", title: "claude" }),
      makeLauncher({ id: "agent:codex", title: "codex" }),
    ]);

    render(
      <CreateProjectModal
        mode="edit"
        initialName="mullion"
        initialPath="/home/x/mullion"
        projectId={1}
        onClose={vi.fn()}
        onCreate={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const select = fieldSelect("Default agent");
    await waitFor(() =>
      expect(within(select).getByRole("option", { name: "claude" })).toBeInTheDocument(),
    );
    expect(within(select).getByRole("option", { name: "codex" })).toBeInTheDocument();
  });

  it("keeps a saved defaultAgent selected even when it's not among the detected launchers", async () => {
    vi.mocked(api.listProjectActions).mockResolvedValue([
      makeLauncher({ id: "agent:codex", title: "codex" }),
    ]);

    render(
      <CreateProjectModal
        mode="edit"
        initialName="mullion"
        initialPath="/home/x/mullion"
        projectId={1}
        initialDefaultAgent="claude"
        onClose={vi.fn()}
        onCreate={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const select = fieldSelect("Default agent");
    await waitFor(() =>
      expect(within(select).getByRole("option", { name: "codex" })).toBeInTheDocument(),
    );

    // The saved value gets its own synthetic option rather than the
    // <select> silently falling back to displaying "Use global default"
    // while state still holds "claude" underneath.
    expect(within(select).getByRole("option", { name: "claude (not detected)" })).toHaveProperty(
      "selected",
      true,
    );
  });

  it("shows a retry hint when the launchers fetch fails, and retries on click", async () => {
    vi.mocked(api.listProjectActions).mockRejectedValueOnce(new Error("network down"));

    render(
      <CreateProjectModal
        mode="edit"
        initialName="mullion"
        initialPath="/home/x/mullion"
        projectId={1}
        onClose={vi.fn()}
        onCreate={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText(/Couldn't load this project's detected agents/)).toBeInTheDocument(),
    );

    vi.mocked(api.listProjectActions).mockResolvedValue([
      makeLauncher({ id: "agent:claude", title: "claude" }),
    ]);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() =>
      expect(
        screen.queryByText(/Couldn't load this project's detected agents/),
      ).not.toBeInTheDocument(),
    );
    const select = fieldSelect("Default agent");
    expect(within(select).getByRole("option", { name: "claude" })).toBeInTheDocument();
  });

  it("does not fetch launchers in create mode (no projectId yet)", () => {
    render(
      <CreateProjectModal
        mode="create"
        onClose={vi.fn()}
        onCreate={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(api.listProjectActions).not.toHaveBeenCalled();
  });

  it("passes defaultAgent/defaultReviewAgent through to onCreate on save", async () => {
    vi.mocked(api.listProjectActions).mockResolvedValue([
      makeLauncher({ id: "agent:claude", title: "claude" }),
    ]);
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <CreateProjectModal
        mode="edit"
        initialName="mullion"
        initialPath="/home/x/mullion"
        projectId={1}
        onClose={vi.fn()}
        onCreate={onCreate}
      />,
    );

    const select = fieldSelect("Default agent");
    await waitFor(() =>
      expect(within(select).getByRole("option", { name: "claude" })).toBeInTheDocument(),
    );
    await user.selectOptions(select, "claude");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onCreate).toHaveBeenCalledWith({
      name: "mullion",
      cwd: "/home/x/mullion",
      hostId: undefined,
      defaultAgent: "claude",
      defaultReviewAgent: null,
      mergeOnApprove: false,
      autoApprove: false,
      allowCrossProjectSpawn: false,
      maxAutoReturnRounds: null,
      conventionalCommitTitles: false,
      autoTagRelease: false,
      // Issue #1726 / roadmap 8.12 — the placement mode travels with
      // the payload in both modes (pinned is the default).
      placement: "pinned",
    });
  });

  it("passes conventionalCommitTitles through to onCreate on save, toggled on", async () => {
    vi.mocked(api.listProjectActions).mockResolvedValue([]);
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <CreateProjectModal
        mode="edit"
        initialName="mullion"
        initialPath="/home/x/mullion"
        projectId={1}
        onClose={vi.fn()}
        onCreate={onCreate}
      />,
    );

    await user.click(
      screen.getByRole("checkbox", {
        name: /Let the worker write the PR title/,
      }),
    );
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onCreate).toHaveBeenCalledWith({
      name: "mullion",
      cwd: "/home/x/mullion",
      hostId: undefined,
      defaultAgent: null,
      defaultReviewAgent: null,
      mergeOnApprove: false,
      autoApprove: false,
      allowCrossProjectSpawn: false,
      maxAutoReturnRounds: null,
      conventionalCommitTitles: true,
      autoTagRelease: false,
      // Issue #1726 / roadmap 8.12 — the placement mode travels with
      // the payload in both modes (pinned is the default).
      placement: "pinned",
    });
  });

  it("passes autoTagRelease through to onCreate on save, toggled on", async () => {
    vi.mocked(api.listProjectActions).mockResolvedValue([]);
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <CreateProjectModal
        mode="edit"
        initialName="mullion"
        initialPath="/home/x/mullion"
        projectId={1}
        onClose={vi.fn()}
        onCreate={onCreate}
      />,
    );

    await user.click(
      screen.getByRole("checkbox", {
        name: /Trigger release-please automatically after a task's PR merges/,
      }),
    );
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onCreate).toHaveBeenCalledWith({
      name: "mullion",
      cwd: "/home/x/mullion",
      hostId: undefined,
      defaultAgent: null,
      defaultReviewAgent: null,
      mergeOnApprove: false,
      autoApprove: false,
      allowCrossProjectSpawn: false,
      maxAutoReturnRounds: null,
      conventionalCommitTitles: false,
      autoTagRelease: true,
      // Issue #1726 / roadmap 8.12 — the placement mode travels with
      // the payload in both modes (pinned is the default).
      placement: "pinned",
    });
  });

  it("passes mergeOnApprove/autoApprove through to onCreate on save, toggled on", async () => {
    vi.mocked(api.listProjectActions).mockResolvedValue([]);
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <CreateProjectModal
        mode="edit"
        initialName="mullion"
        initialPath="/home/x/mullion"
        projectId={1}
        onClose={vi.fn()}
        onCreate={onCreate}
      />,
    );

    await user.click(
      screen.getByRole("checkbox", { name: /Merge a task's PR automatically once it's approved/ }),
    );
    await user.click(
      screen.getByRole("checkbox", { name: /Approve a task automatically on a clean review/ }),
    );
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onCreate).toHaveBeenCalledWith({
      name: "mullion",
      cwd: "/home/x/mullion",
      hostId: undefined,
      defaultAgent: null,
      defaultReviewAgent: null,
      mergeOnApprove: true,
      autoApprove: true,
      allowCrossProjectSpawn: false,
      maxAutoReturnRounds: null,
      conventionalCommitTitles: false,
      autoTagRelease: false,
      // Issue #1726 / roadmap 8.12 — the placement mode travels with
      // the payload in both modes (pinned is the default).
      placement: "pinned",
    });
  });

  it("passes a typed maxAutoReturnRounds through to onCreate as a number", async () => {
    vi.mocked(api.listProjectActions).mockResolvedValue([]);
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <CreateProjectModal
        mode="edit"
        initialName="mullion"
        initialPath="/home/x/mullion"
        projectId={1}
        onClose={vi.fn()}
        onCreate={onCreate}
      />,
    );

    await user.type(screen.getByPlaceholderText("install default"), "5");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ maxAutoReturnRounds: 5 }));
  });

  it("sends 0 for the Unlimited checkbox, and pre-checks it for a project already at 0", async () => {
    vi.mocked(api.listProjectActions).mockResolvedValue([]);
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <CreateProjectModal
        mode="edit"
        initialName="mullion"
        initialPath="/home/x/mullion"
        projectId={1}
        initialMaxAutoReturnRounds={0}
        onClose={vi.fn()}
        onCreate={onCreate}
      />,
    );

    const unlimited = screen.getByRole("checkbox", { name: "Unlimited" });
    expect(unlimited).toBeChecked();
    expect(screen.getByPlaceholderText("install default")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ maxAutoReturnRounds: 0 }));

    // Unchecking falls back to inherit (blank), not to a stale number.
    await user.click(unlimited);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({ maxAutoReturnRounds: null }),
    );
  });

  it("typing 0 in the rounds field flips the Unlimited checkbox instead of leaving a 0 behind", async () => {
    vi.mocked(api.listProjectActions).mockResolvedValue([]);
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <CreateProjectModal
        mode="edit"
        initialName="mullion"
        initialPath="/home/x/mullion"
        projectId={1}
        onClose={vi.fn()}
        onCreate={onCreate}
      />,
    );

    await user.type(screen.getByPlaceholderText("install default"), "0");

    expect(screen.getByRole("checkbox", { name: "Unlimited" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ maxAutoReturnRounds: 0 }));
  });

  // Issue #2110 — the coordinator checkbox: edit mode only, off by default.
  it("passes allowCrossProjectSpawn through to onCreate, toggled on (#2110)", async () => {
    vi.mocked(api.listProjectActions).mockResolvedValue([]);
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <CreateProjectModal
        mode="edit"
        initialName="mullion"
        initialPath="/home/x/mullion"
        projectId={1}
        onClose={vi.fn()}
        onCreate={onCreate}
      />,
    );

    const box = screen.getByRole("checkbox", { name: /This project coordinates/ });
    expect(box).not.toBeChecked();
    await user.click(box);
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ allowCrossProjectSpawn: true }),
    );
  });

  it("pre-fills the coordinator checkbox from the project, and hides it when creating (#2110)", () => {
    vi.mocked(api.listProjectActions).mockResolvedValue([]);
    const { unmount } = render(
      <CreateProjectModal
        mode="edit"
        initialName="mullion"
        initialPath="/home/x/mullion"
        projectId={1}
        initialAllowCrossProjectSpawn={true}
        onClose={vi.fn()}
        onCreate={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.getByRole("checkbox", { name: /This project coordinates/ })).toBeChecked();
    unmount();

    render(
      <CreateProjectModal
        mode="create"
        onClose={vi.fn()}
        onCreate={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.queryByRole("checkbox", { name: /This project coordinates/ })).toBeNull();
  });

  // Issues #2123 / #2124 — which projects a coordinator reaches, and whether this
  // project takes children from other projects' coordinators.
  describe("cross-project consent controls", () => {
    const others = [makeProject({ id: 2, name: "runway" }), makeProject({ id: 3, name: "harbor" })];

    function renderEdit(props: Partial<React.ComponentProps<typeof CreateProjectModal>> = {}) {
      vi.mocked(api.listProjectActions).mockResolvedValue([]);
      useDashboardStore.setState({
        projects: [makeProject({ id: 1, name: "mullion" }), ...others],
      });
      const onCreate = vi.fn().mockResolvedValue(undefined);
      render(
        <CreateProjectModal
          mode="edit"
          initialName="mullion"
          initialPath="/home/x/mullion"
          projectId={1}
          onClose={vi.fn()}
          onCreate={onCreate}
          {...props}
        />,
      );
      return onCreate;
    }

    it("shows the target picker only for a coordinator, and sends the picked projects", async () => {
      const user = userEvent.setup();
      const onCreate = renderEdit();
      expect(
        screen.queryByRole("button", { name: "Projects this coordinator may reach" }),
      ).toBeNull();

      await user.click(screen.getByRole("checkbox", { name: /This project coordinates/ }));
      const picker = screen.getByRole("button", { name: "Projects this coordinator may reach" });
      expect(picker).toHaveTextContent("Every project");
      await user.click(picker);
      // The project being edited is not offered as its own target.
      expect(screen.queryByRole("checkbox", { name: "mullion" })).toBeNull();
      await user.click(screen.getByRole("checkbox", { name: "runway" }));
      await user.click(screen.getByRole("button", { name: "Save changes" }));
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ allowCrossProjectSpawn: true, crossProjectTargets: [2] }),
      );
    });

    it("does not send a target list while the coordinator toggle is off", async () => {
      const user = userEvent.setup();
      const onCreate = renderEdit({ initialCrossProjectTargets: [2] });
      await user.click(screen.getByRole("button", { name: "Save changes" }));
      expect(onCreate.mock.calls[0]![0].crossProjectTargets).toBeUndefined();
    });

    it("sends the consent mode, and the list only for 'listed'", async () => {
      const user = userEvent.setup();
      const onCreate = renderEdit();
      const select = screen.getByRole("combobox", { name: "Accepts children from other projects" });
      expect(select).toHaveValue("any");

      await user.selectOptions(select, "none");
      await user.click(screen.getByRole("button", { name: "Save changes" }));
      expect(onCreate).toHaveBeenLastCalledWith(
        expect.objectContaining({
          acceptsChildrenFrom: "none",
          acceptsChildrenFromList: undefined,
        }),
      );

      await user.selectOptions(select, "listed");
      await user.click(
        screen.getByRole("button", { name: "Projects whose coordinators may start children here" }),
      );
      await user.click(screen.getByRole("checkbox", { name: "harbor" }));
      await user.click(screen.getByRole("button", { name: "Save changes" }));
      expect(onCreate).toHaveBeenLastCalledWith(
        expect.objectContaining({ acceptsChildrenFrom: "listed", acceptsChildrenFromList: [3] }),
      );
    });

    it("refuses to save 'listed' with nobody on the list", async () => {
      const user = userEvent.setup();
      const onCreate = renderEdit({ initialAcceptsChildrenFrom: "listed" });
      await user.click(screen.getByRole("button", { name: "Save changes" }));
      expect(onCreate).not.toHaveBeenCalled();
      expect(
        screen.getByText(/Pick at least one project to accept children from/),
      ).toBeInTheDocument();
    });

    it("sends the messaging consent only when changed, and guards an empty 'listed' (#2270)", async () => {
      const user = userEvent.setup();
      const onCreate = renderEdit();
      const select = screen.getByRole("combobox", { name: "Accepts messages from other projects" });
      expect(select).toHaveValue("none");
      await user.click(screen.getByRole("button", { name: "Save changes" }));
      expect(onCreate.mock.calls[0]![0].acceptsMessagesFrom).toBeUndefined();

      await user.selectOptions(select, "listed");
      await user.click(screen.getByRole("button", { name: "Save changes" }));
      expect(onCreate).toHaveBeenCalledTimes(1);
      expect(
        screen.getByText(/Pick at least one project to accept messages from/),
      ).toBeInTheDocument();

      await user.click(
        screen.getByRole("button", {
          name: "Projects whose coordinators may message a running session here",
        }),
      );
      await user.click(screen.getByRole("checkbox", { name: "runway" }));
      await user.click(screen.getByRole("button", { name: "Save changes" }));
      expect(onCreate).toHaveBeenLastCalledWith(
        expect.objectContaining({ acceptsMessagesFrom: "listed", acceptsMessagesFromList: [2] }),
      );
    });

    it("pre-fills the saved consent and has no consent control when creating", () => {
      renderEdit({ initialAcceptsChildrenFrom: "none" });
      expect(
        screen.getByRole("combobox", { name: "Accepts children from other projects" }),
      ).toHaveValue("none");
    });
  });

  it("pre-fills mergeOnApprove/autoApprove from the project's current values", () => {
    vi.mocked(api.listProjectActions).mockResolvedValue([]);
    render(
      <CreateProjectModal
        mode="edit"
        initialName="mullion"
        initialPath="/home/x/mullion"
        projectId={1}
        initialMergeOnApprove={true}
        initialAutoApprove={true}
        onClose={vi.fn()}
        onCreate={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(
      screen.getByRole("checkbox", { name: /Merge a task's PR automatically once it's approved/ }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: /Approve a task automatically on a clean review/ }),
    ).toBeChecked();
  });
});

// Issue #1034 — manual re-check of the release-please auto-enable sweep for
// one project, surfacing in the project edit modal as a "Re-check now"
// button next to the Conventional Commits PR titles checkbox. The auto-enable
// sweep is one-shot, so a repo that adopts release-please AFTER first
// detection never gets re-probed by the reconciler tick; this is the
// human-triggered affordance that closes that gap.
describe("CreateProjectModal — release-please re-check affordance (issue #1034)", () => {
  it("shows a Re-check now button next to the Conventional Commits PR titles checkbox in edit mode", () => {
    vi.mocked(api.listProjectActions).mockResolvedValue([]);
    render(
      <CreateProjectModal
        mode="edit"
        initialName="mullion"
        initialPath="/home/x/mullion"
        projectId={1}
        onClose={vi.fn()}
        onCreate={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByRole("button", { name: /re-check now/i })).toBeInTheDocument();
  });

  it("does not show the Re-check now button in create mode (no projectId yet to re-check)", () => {
    render(
      <CreateProjectModal
        mode="create"
        onClose={vi.fn()}
        onCreate={vi.fn().mockResolvedValue(undefined)}
        initialPath="/x"
      />,
    );

    expect(screen.queryByRole("button", { name: /re-check now/i })).not.toBeInTheDocument();
  });

  it("POSTs to the re-check endpoint when the button is clicked", async () => {
    vi.mocked(api.listProjectActions).mockResolvedValue([]);
    vi.mocked(api.recheckReleasePlease).mockResolvedValue({
      ok: true,
      conventionalCommitTitlesResolvedAt: new Date("2025-01-02T00:00:00Z").toISOString(),
    });
    const user = userEvent.setup();
    render(
      <CreateProjectModal
        mode="edit"
        initialName="mullion"
        initialPath="/home/x/mullion"
        projectId={42}
        onClose={vi.fn()}
        onCreate={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await user.click(screen.getByRole("button", { name: /re-check now/i }));

    await waitFor(() => expect(api.recheckReleasePlease).toHaveBeenCalledWith(42));
  });
});

describe("CreateProjectModal — confirm-first directory creation and error handling", () => {
  it("renders the ApiError message on failure and does not call onClose", async () => {
    const onClose = vi.fn();
    const onCreate = vi
      .fn()
      .mockRejectedValue(
        new ApiError("Cannot access /x: permission denied.", 400, "PROJECT_DIR_UNREADABLE"),
      );
    const user = userEvent.setup();
    render(<CreateProjectModal onClose={onClose} onCreate={onCreate} initialPath="/x" />);

    await user.click(screen.getByRole("button", { name: "Add project" }));

    expect(await screen.findByText("Cannot access /x: permission denied.")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Create folder and add project" }),
    ).not.toBeInTheDocument();
  });

  it("offers Create folder for PROJECT_DIR_MISSING", async () => {
    const onCreate = vi
      .fn()
      .mockRejectedValue(
        new ApiError("Directory /new does not exist.", 400, "PROJECT_DIR_MISSING"),
      );
    const user = userEvent.setup();
    render(<CreateProjectModal onClose={vi.fn()} onCreate={onCreate} initialPath="/new" />);

    await user.click(screen.getByRole("button", { name: "Add project" }));

    expect(
      await screen.findByRole("button", { name: "Create folder and add project" }),
    ).toBeInTheDocument();
  });

  it("offers attach and 'Create a separate project anyway' for DUPLICATE_PROJECT (issue #2231)", async () => {
    const onClose = vi.fn();
    const onCreate = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError("This repository already has a project: Widgets.", 409, "DUPLICATE_PROJECT", {
          existingProjectId: 7,
          existingName: "Widgets",
        }),
      )
      .mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    render(<CreateProjectModal onClose={onClose} onCreate={onCreate} initialPath="/repo" />);

    await user.click(screen.getByRole("button", { name: "Add project" }));
    expect(
      await screen.findByRole("button", { name: "Add as checkout of Widgets" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create a separate project anyway" }));

    expect(onCreate).toHaveBeenLastCalledWith(expect.objectContaining({ allowDuplicate: true }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("hides attach when the duplicate lives on the same host", async () => {
    const onCreate = vi.fn().mockRejectedValue(
      new ApiError("dup", 409, "DUPLICATE_PROJECT", {
        existingProjectId: 7,
        existingName: "Widgets",
        existingHostId: "local",
      }),
    );
    const user = userEvent.setup();
    render(<CreateProjectModal onClose={vi.fn()} onCreate={onCreate} initialPath="/repo" />);
    await user.click(screen.getByRole("button", { name: "Add project" }));
    await screen.findByRole("button", { name: "Create a separate project anyway" });
    expect(screen.queryByRole("button", { name: /Add as checkout of/ })).not.toBeInTheDocument();
  });

  it("'Add as checkout of' attaches the path to the existing project and closes", async () => {
    vi.mocked(api.attachHostCheckout).mockResolvedValueOnce(makeProject({ id: 7 }));
    const onClose = vi.fn();
    const onCreate = vi.fn().mockRejectedValue(
      new ApiError("This repository already has a project: Widgets.", 409, "DUPLICATE_PROJECT", {
        existingProjectId: 7,
        existingName: "Widgets",
      }),
    );
    const user = userEvent.setup();
    render(<CreateProjectModal onClose={onClose} onCreate={onCreate} initialPath="/repo" />);

    await user.click(screen.getByRole("button", { name: "Add project" }));
    await user.click(await screen.findByRole("button", { name: "Add as checkout of Widgets" }));

    expect(api.attachHostCheckout).toHaveBeenCalledWith(7, "local", "/repo");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("shows the server's message when the attach is refused", async () => {
    vi.mocked(api.attachHostCheckout).mockRejectedValueOnce(
      new ApiError("That is the project's own host.", 400),
    );
    const onCreate = vi.fn().mockRejectedValue(
      new ApiError("This repository already has a project: Widgets.", 409, "DUPLICATE_PROJECT", {
        existingProjectId: 7,
        existingName: "Widgets",
      }),
    );
    const user = userEvent.setup();
    render(<CreateProjectModal onClose={vi.fn()} onCreate={onCreate} initialPath="/repo" />);

    await user.click(screen.getByRole("button", { name: "Add project" }));
    await user.click(await screen.findByRole("button", { name: "Add as checkout of Widgets" }));

    expect(await screen.findByText("That is the project's own host.")).toBeInTheDocument();
  });

  it("in edit mode a DUPLICATE_PROJECT only offers 'Save anyway'", async () => {
    const onCreate = vi.fn().mockRejectedValue(
      new ApiError("This repository already has a project: Widgets.", 409, "DUPLICATE_PROJECT", {
        existingProjectId: 7,
        existingName: "Widgets",
      }),
    );
    const user = userEvent.setup();
    render(
      <CreateProjectModal
        mode="edit"
        projectId={3}
        initialName="x"
        initialPath="/old"
        onClose={vi.fn()}
        onCreate={onCreate}
      />,
    );

    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(await screen.findByRole("button", { name: "Save anyway" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add as checkout of/ })).not.toBeInTheDocument();
  });

  it("does not offer Create folder for PROJECT_PARENT_MISSING — the typo case", async () => {
    const onCreate = vi
      .fn()
      .mockRejectedValue(
        new ApiError("Parent directory /nope does not exist.", 400, "PROJECT_PARENT_MISSING"),
      );
    const user = userEvent.setup();
    render(<CreateProjectModal onClose={vi.fn()} onCreate={onCreate} initialPath="/nope/x" />);

    await user.click(screen.getByRole("button", { name: "Add project" }));

    await screen.findByText("Parent directory /nope does not exist.");
    expect(
      screen.queryByRole("button", { name: "Create folder and add project" }),
    ).not.toBeInTheDocument();
  });

  it("clicking Create folder re-invokes onCreate with createDir: true and closes on success", async () => {
    const onClose = vi.fn();
    const onCreate = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError("Directory /new does not exist.", 400, "PROJECT_DIR_MISSING"),
      )
      .mockResolvedValueOnce({ dirCreated: true, gitInitialized: false });
    const user = userEvent.setup();
    render(<CreateProjectModal onClose={onClose} onCreate={onCreate} initialPath="/new" />);

    await user.click(screen.getByRole("button", { name: "Add project" }));
    await user.click(await screen.findByRole("button", { name: "Create folder and add project" }));

    expect(onCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({ createDir: true, gitInit: false }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("forwards gitInit: true only when the checkbox is checked", async () => {
    const onCreate = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError("Directory /new does not exist.", 400, "PROJECT_DIR_MISSING"),
      )
      .mockResolvedValueOnce({ dirCreated: true, gitInitialized: true });
    const user = userEvent.setup();
    render(<CreateProjectModal onClose={vi.fn()} onCreate={onCreate} initialPath="/new" />);

    await user.click(screen.getByRole("button", { name: "Add project" }));
    await user.click(await screen.findByRole("checkbox", { name: /initialize a git repository/i }));
    await user.click(screen.getByRole("button", { name: "Create folder and add project" }));

    expect(onCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({ createDir: true, gitInit: true }),
    );
  });

  it("shows a non-blocking warning and does not close when git init fails", async () => {
    const onClose = vi.fn();
    const onCreate = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError("Directory /new does not exist.", 400, "PROJECT_DIR_MISSING"),
      )
      .mockResolvedValueOnce({ dirCreated: true, gitInitialized: false });
    const user = userEvent.setup();
    render(<CreateProjectModal onClose={onClose} onCreate={onCreate} initialPath="/new" />);

    await user.click(screen.getByRole("button", { name: "Add project" }));
    await user.click(await screen.findByRole("checkbox", { name: /initialize a git repository/i }));
    await user.click(screen.getByRole("button", { name: "Create folder and add project" }));

    expect(await screen.findByText(/git init.*failed/i)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("does not show the git-init-failed warning when the directory already existed (dirCreated: false) — Hermes review, PR #620", async () => {
    // gitInitialized: false here means "never attempted" (the directory was
    // created concurrently between the initial 400 and this retry, so the
    // backend skipped git init entirely) — distinct from "attempted and
    // failed", which only ever happens when dirCreated is also true.
    const onClose = vi.fn();
    const onCreate = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError("Directory /new does not exist.", 400, "PROJECT_DIR_MISSING"),
      )
      .mockResolvedValueOnce({ dirCreated: false, gitInitialized: false });
    const user = userEvent.setup();
    render(<CreateProjectModal onClose={onClose} onCreate={onCreate} initialPath="/new" />);

    await user.click(screen.getByRole("button", { name: "Add project" }));
    await user.click(await screen.findByRole("checkbox", { name: /initialize a git repository/i }));
    await user.click(screen.getByRole("button", { name: "Create folder and add project" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(screen.queryByText(/git init.*failed/i)).not.toBeInTheDocument();
  });

  it("disables the submit button while the request is in flight", async () => {
    let resolveCreate: (
      v: { dirCreated?: boolean; gitInitialized?: boolean } | undefined,
    ) => void = () => {};
    const onCreate = vi.fn(
      () =>
        new Promise<{ dirCreated?: boolean; gitInitialized?: boolean } | undefined>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const user = userEvent.setup();
    render(<CreateProjectModal onClose={vi.fn()} onCreate={onCreate} initialPath="/x" />);

    await user.click(screen.getByRole("button", { name: "Add project" }));

    expect(screen.getByRole("button", { name: "Adding…" })).toBeDisabled();
    resolveCreate(undefined);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Adding…" })).not.toBeInTheDocument(),
    );
  });

  it("editing the path clears the error and hides the affordance", async () => {
    const onCreate = vi
      .fn()
      .mockRejectedValue(
        new ApiError("Directory /new does not exist.", 400, "PROJECT_DIR_MISSING"),
      );
    const user = userEvent.setup();
    render(<CreateProjectModal onClose={vi.fn()} onCreate={onCreate} initialPath="/new" />);

    await user.click(screen.getByRole("button", { name: "Add project" }));
    await screen.findByRole("button", { name: "Create folder and add project" });

    await user.type(screen.getByPlaceholderText("~/code/my-project"), "x");

    expect(
      screen.queryByRole("button", { name: "Create folder and add project" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Directory /new does not exist.")).not.toBeInTheDocument();
  });

  it("calls onClose on a plain successful create (no createDir involved)", async () => {
    const onClose = vi.fn();
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<CreateProjectModal onClose={onClose} onCreate={onCreate} initialPath="/x" />);

    await user.click(screen.getByRole("button", { name: "Add project" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("edit mode submits metadata without overwriting separately managed previews", async () => {
    const onClose = vi.fn();
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <CreateProjectModal
        mode="edit"
        initialName="mullion"
        initialPath="/home/x/mullion"
        initialDevServerUrl="3000"
        onClose={onClose}
        onCreate={onCreate}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onCreate).toHaveBeenCalledWith({
      name: "mullion",
      cwd: "/home/x/mullion",
      hostId: undefined,
      defaultAgent: null,
      defaultReviewAgent: null,
      mergeOnApprove: false,
      autoApprove: false,
      allowCrossProjectSpawn: false,
      maxAutoReturnRounds: null,
      conventionalCommitTitles: false,
      autoTagRelease: false,
      // Issue #1726 / roadmap 8.12 — the placement mode travels with
      // the payload in both modes (pinned is the default).
      placement: "pinned",
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
  it("does not expose preview configuration in Edit project", () => {
    render(
      <CreateProjectModal
        mode="edit"
        initialName="mullion"
        initialPath="/home/x/mullion"
        onClose={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    expect(screen.queryByText("Dev server")).not.toBeInTheDocument();
  });
});
