// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionLauncherHost } from "./SessionLauncher.js";
import { DEFAULT_SETTINGS } from "../api/index.js";
import type { AppSettings, Launcher, Project } from "../api/index.js";
import { jsonResponse } from "../test/jsonResponse.js";
import { mockFetch } from "../test/mockFetch.js";
import { makeSession, makeWorkspace } from "../test/fixtures.js";
import { resetStore } from "../test/resetStore.js";
import {
  dropdownLabel,
  dropdownOptions,
  dropdownValue,
  openDropdown,
  pickDropdownOption,
} from "../test/dropdown.js";
import { useDashboardStore } from "../store/index.js";
import launcherCss from "../styles/session-launcher.css?raw";

const PROJECT: Project = {
  id: 5,
  name: "mullion",
  cwd: "/home/x/mullion",
  hostId: "local",
  placement: "pinned",
  hostCwds: {},
  devServerUrl: null,
  detectedDevServerPort: null,
  currentBranch: null,
  autoFetch: null,
  ruleFiles: [],
  defaultAgent: null,
  defaultReviewAgent: null,
  mergeOnApprove: null,
  autoApprove: null,
  allowCrossProjectSpawn: null,
  maxAutoReturnRounds: null,
  conventionalCommitTitles: null,
  autoTagRelease: null,
  injectAgentGuide: null,
  injectProjectBriefing: null,
  injectWorkflowConventions: null,
  suppressConventionsInjectionAfterScaffold: null,
  conventionsHash: null,
  conventionsDrifted: false,
  createdAt: "2026-01-01T00:00:00.000Z",
};
const OTHER: Project = { ...PROJECT, id: 6, name: "runway", cwd: "/home/x/runway" };

const CLAUDE: Launcher = { id: "agent:claude", kind: "agent", title: "claude", command: "claude" };
const CODEX: Launcher = { id: "agent:codex", kind: "agent", title: "codex", command: "codex" };
const BASH: Launcher = { id: "shell:bash", kind: "shell", title: "bash", command: "bash" };
const DEV: Launcher = {
  id: "npm:dev",
  kind: "npm-script",
  title: "dev",
  command: "npm run dev",
};

function withSkip(skipPermissionsAgents: string[]): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    launchers: { ...DEFAULT_SETTINGS.launchers, skipPermissionsAgents },
  };
}

// The shared route-table harness (test/mockFetch.ts): an unstubbed request
// lands in `unexpectedCalls`, asserted empty after every test.
let unexpectedCalls: string[] = [];

function stubFetch(
  opts: {
    launchers?: Launcher[];
    launchersByProject?: Record<number, Launcher[]>;
    onCreateSession?: (body: Record<string, unknown>) => void;
    failCreate?: boolean;
    // Replaces the default 201 response, e.g. to hold the request open.
    createSession?: () => Promise<Response>;
    branches?: unknown;
    branchesByProject?: Record<number, unknown>;
    groups?: unknown[];
  } = {},
) {
  const empty = () => jsonResponse(200, []);
  const result = mockFetch({
    "GET /api/projects/:id/actions": ({ params }) =>
      jsonResponse(
        200,
        opts.launchersByProject?.[Number(params.id)] ??
          opts.launchers ?? [CLAUDE, CODEX, BASH, DEV],
      ),
    "GET /api/projects/:id/git-branches": ({ params }) => {
      const branches = opts.branchesByProject?.[Number(params.id)] ?? opts.branches;
      return branches ? jsonResponse(200, branches) : new Response(null, { status: 204 });
    },
    "GET /api/projects/discover": empty,
    "GET /api/codex/models": empty,
    "GET /api/agy/models": empty,
    "GET /api/opencode/models": empty,
    "GET /api/mcode/models": empty,
    "GET /api/sessions": empty,
    "GET /api/groups": () => jsonResponse(200, opts.groups ?? []),
    "POST /api/sessions": ({ init }) => {
      if (opts.failCreate) return jsonResponse(503, { message: "Host is unreachable" });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      opts.onCreateSession?.(body);
      if (opts.createSession) return opts.createSession();
      return jsonResponse(201, {
        id: 42,
        projectId: PROJECT.id,
        command: body.command,
        status: "active",
      });
    },
  });
  unexpectedCalls = result.unexpectedCalls;
  vi.stubGlobal("fetch", result.fetchMock);
  return result;
}

// #3054 — an /actions response held open until `release.current()` is called.
function holdActions(list: Launcher[], onCreateSession: (body: unknown) => void = () => {}) {
  const release: { current: (() => void) | null } = { current: null };
  const result = mockFetch({
    "GET /api/projects/:id/actions": () =>
      new Promise<Response>((resolve) => {
        release.current = () => resolve(jsonResponse(200, list));
      }),
    "GET /api/projects/:id/git-branches": () => new Response(null, { status: 204 }),
    "GET /api/codex/models": () => jsonResponse(200, []),
    "GET /api/sessions": () => jsonResponse(200, []),
    "POST /api/sessions": ({ init }) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      onCreateSession(body);
      return jsonResponse(201, { id: 42, projectId: PROJECT.id, command: body.command });
    },
  });
  unexpectedCalls = result.unexpectedCalls;
  vi.stubGlobal("fetch", result.fetchMock);
  return release;
}

function stubCoarsePointer() {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query === "(pointer: coarse)",
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

function renderHost(
  overrides: { onLaunched?: () => void; onOpenSession?: () => void; phone?: boolean } = {},
) {
  const onLaunched = overrides.onLaunched ?? vi.fn();
  const onOpenSession = overrides.onOpenSession ?? vi.fn();
  const utils = render(
    <>
      <button type="button">trigger</button>
      <SessionLauncherHost
        panels={[]}
        phone={overrides.phone ?? false}
        onLaunched={onLaunched}
        onOpenSession={onOpenSession}
      />
    </>,
  );
  return { ...utils, onLaunched, onOpenSession };
}

function openLauncher(target?: { half?: "left" | "right" }) {
  act(() => useDashboardStore.getState().openLauncher(target));
}

beforeEach(() => {
  localStorage.clear();
  resetStore({
    projects: [PROJECT, OTHER],
    sessions: [],
    settings: DEFAULT_SETTINGS,
    viewMode: "list",
    activePanelId: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  expect(unexpectedCalls).toEqual([]);
  unexpectedCalls = [];
});

describe("SessionLauncher — desktop dialog", () => {
  it("shows Where, agents as a radio group, and shells and scripts as a list — no tabs", async () => {
    stubFetch();
    renderHost();
    openLauncher();

    const dialog = await screen.findByRole("dialog", { name: "New session" });
    expect(within(dialog).getByRole("combobox", { name: "Project" })).toBeInTheDocument();
    expect(
      within(dialog).getByRole("switch", { name: "Isolate in a new worktree" }),
    ).toBeInTheDocument();
    const group = await within(dialog).findByRole("radiogroup", { name: "Agent" });
    const tiles = within(group).getAllByRole("radio");
    expect(tiles.map((t) => t.textContent)).toEqual(["claude", "codex"]);
    // The default agent (settings.launchers.defaultAgent = claude) starts selected.
    expect(within(group).getByRole("radio", { name: /claude/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(within(dialog).getByRole("button", { name: /bash/ })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /dev/ })).toBeInTheDocument();
    // Open existing is touch-only.
    expect(within(dialog).queryByRole("tablist")).toBeNull();
    expect(within(dialog).queryByText("Open existing")).toBeNull();
  });

  it("does not open outside a workspace view, and does not pop up on the way back", () => {
    stubFetch();
    useDashboardStore.setState({ viewMode: "kanban" });
    renderHost();
    openLauncher();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useDashboardStore.getState().launcherRequest).toBeNull();
    act(() => useDashboardStore.setState({ viewMode: "list" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("launches an agent with a non-default model and passes the target through", async () => {
    const onCreateSession = vi.fn();
    stubFetch({ onCreateSession });
    const user = userEvent.setup();
    const { onLaunched } = renderHost();
    openLauncher({ half: "right" });

    const model = await screen.findByRole("combobox", { name: "Model for this session" });
    pickDropdownOption(model, "opusplan");
    await user.click(screen.getByRole("button", { name: "Launch claude" }));

    await waitFor(() => expect(onLaunched).toHaveBeenCalledTimes(1));
    expect(onCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ command: "claude", model: "opusplan", skipPermissions: false }),
    );
    expect(onLaunched).toHaveBeenCalledWith(
      expect.objectContaining({ id: 42 }),
      { half: "right" },
      null,
    );
    expect(useDashboardStore.getState().launcherRequest).toBeNull();
  });

  it("does not carry a model picked for one agent over to another", async () => {
    const onCreateSession = vi.fn();
    stubFetch({ onCreateSession });
    const user = userEvent.setup();
    renderHost();
    openLauncher();

    pickDropdownOption(
      await screen.findByRole("combobox", { name: "Model for this session" }),
      "opusplan",
    );
    await user.click(screen.getByRole("radio", { name: /codex/ }));
    await user.click(screen.getByRole("button", { name: "Launch codex" }));

    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));
    expect(onCreateSession.mock.calls[0]![0]).not.toHaveProperty("model");
  });

  it("launches a shell on click, with no options", async () => {
    const onCreateSession = vi.fn();
    stubFetch({ onCreateSession });
    const user = userEvent.setup();
    const { onLaunched } = renderHost();
    openLauncher();

    await user.click(await screen.findByRole("button", { name: /bash/ }));

    await waitFor(() => expect(onLaunched).toHaveBeenCalledTimes(1));
    const body = onCreateSession.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.command).toBe("bash");
    expect(body).not.toHaveProperty("model");
    expect(body).not.toHaveProperty("skipPermissions");
  });

  it("sends the Where row's worktree choice with the launch", async () => {
    const onCreateSession = vi.fn();
    stubFetch({
      onCreateSession,
      branches: {
        branches: [
          { name: "main", isCurrent: true },
          { name: "feature/x", isCurrent: false },
        ],
        worktrees: [],
        remoteBranches: [],
        defaultBranch: "main",
      },
    });
    const user = userEvent.setup();
    const { onLaunched } = renderHost();
    openLauncher();

    await user.click(await screen.findByRole("switch", { name: /Isolate in a new worktree/ }));
    const base = await screen.findByRole("combobox", { name: "Base branch" });
    await waitFor(() => expect(dropdownLabel(base)).toMatch(/main/));
    pickDropdownOption(base, "feature/x");
    await user.click(screen.getByRole("button", { name: "Launch claude" }));

    await waitFor(() => expect(onLaunched).toHaveBeenCalledTimes(1));
    expect(onCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ worktree: { baseRef: "feature/x" } }),
    );
  });

  it("with no agent, Launch starts the first shell or script", async () => {
    const onCreateSession = vi.fn();
    stubFetch({ onCreateSession, launchers: [BASH, DEV] });
    const user = userEvent.setup();
    renderHost();
    openLauncher();

    expect(await screen.findByText("No agents found for this project.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Launch bash" }));
    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));
    expect(onCreateSession).toHaveBeenCalledWith(expect.objectContaining({ command: "bash" }));
  });

  it("shows a failed launch inline and stays open", async () => {
    stubFetch({ failCreate: true });
    const user = userEvent.setup();
    const { onLaunched } = renderHost();
    openLauncher();

    await user.click(await screen.findByRole("button", { name: "Launch claude" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/unreachable/i);
    // Only a launch that happened becomes the next open's default project.
    expect(localStorage.getItem("crs.lastLaunchProjectId")).toBeNull();
    expect(onLaunched).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "New session" })).toBeInTheDocument();
    expect(useDashboardStore.getState().launcherRequest).not.toBeNull();
    // The in-flight guard resets: the launch can be retried. Focus stayed on
    // the button (it is never `disabled`), so Tab and Escape still work.
    const launchButton = screen.getByRole("button", { name: "Launch claude" });
    expect(launchButton).toBeEnabled();
    expect(launchButton).not.toHaveAttribute("aria-disabled");
    expect(launchButton).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(useDashboardStore.getState().launcherRequest).toBeNull();
  });

  it("a launch that outlives its launcher does not close one opened after it", async () => {
    let resolveCreate: (() => void) | null = null;
    stubFetch({
      launchers: [CLAUDE, BASH],
      createSession: () =>
        new Promise<Response>((resolve) => {
          resolveCreate = () =>
            resolve(
              jsonResponse(201, {
                id: 42,
                projectId: PROJECT.id,
                command: "claude",
                status: "active",
              }),
            );
        }),
    });
    const user = userEvent.setup();
    const { onLaunched } = renderHost();
    openLauncher();

    await user.click(await screen.findByRole("button", { name: "Launch claude" }));
    await waitFor(() => expect(resolveCreate).not.toBeNull());
    await user.keyboard("{Escape}");
    openLauncher();
    await screen.findByRole("dialog", { name: "New session" });

    await act(async () => resolveCreate!());
    await waitFor(() => expect(onLaunched).toHaveBeenCalledTimes(1));
    expect(useDashboardStore.getState().launcherRequest).not.toBeNull();
    expect(screen.getByRole("dialog", { name: "New session" })).toBeInTheDocument();
  });
});

describe("SessionLauncher — skip permissions", () => {
  it("renders the override row with the same structure for every agent (#3055)", async () => {
    const OPENCODE: Launcher = {
      id: "agent:opencode",
      kind: "agent",
      title: "opencode",
      command: "opencode",
    };
    stubFetch({ launchers: [CLAUDE, OPENCODE, BASH] });
    const user = userEvent.setup();
    renderHost();
    openLauncher();
    const shape = () => {
      const row = screen.getByRole("group", { name: /^Options for/ });
      return [...row.children]
        .filter((el) => el.classList.contains("launcher-form-switch-row"))
        .map((el) => el.className + ":" + [...el.children].map((c) => c.className).join("|"))
        .slice(-1)[0];
    };
    await screen.findByRole("switch", { name: "Skip permissions (no permission prompts)" });
    const claude = shape();
    await user.click(screen.getByRole("radio", { name: "opencode" }));
    const toggle = await screen.findByRole("switch", {
      name: "Skip permissions (no permission prompts)",
    });
    expect(toggle).toHaveAccessibleDescription("Off in settings for opencode");
    expect(shape()).toBe(claude);
    // #3071 — a form row like Worktree: a grid with a fixed label column
    // ("Permissions"), the switch at the start of the control column.
    expect(launcherCss).toMatch(/\.launcher-form-row \{[^}]*display:\s*grid/);
    const row = toggle.closest(".launcher-form-row")!;
    expect(row.querySelector(".launcher-form-label")).toHaveTextContent("Permissions");
    const control = toggle.parentElement!;
    expect(control).toHaveClass("launcher-form-control");
    expect(control.firstElementChild).toBe(toggle);
    expect(control).toHaveTextContent("Skip permissions");
    // WCAG 2.5.3 label in name: the accessible name contains the visible label.
    expect(toggle).toHaveAccessibleName(expect.stringContaining("Skip permissions"));
  });

  it("off in settings: the switch starts off, launches off, and the override turns it on", async () => {
    const onCreateSession = vi.fn();
    stubFetch({ onCreateSession });
    const user = userEvent.setup();
    renderHost();
    openLauncher();

    const toggle = await screen.findByRole("switch", {
      name: "Skip permissions (no permission prompts)",
    });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toHaveAccessibleDescription("Off in settings for claude");
    // No settings flag on the tile.
    expect(screen.getByRole("radio", { name: "claude" })).toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toHaveAccessibleDescription("For this session only (off in settings)");
    await user.click(screen.getByRole("button", { name: "Launch claude" }));

    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));
    expect(onCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ skipPermissions: true }),
    );
  });

  it("off in settings and left alone: launches with prompts", async () => {
    const onCreateSession = vi.fn();
    stubFetch({ onCreateSession });
    const user = userEvent.setup();
    renderHost();
    openLauncher();

    await user.click(await screen.findByRole("button", { name: "Launch claude" }));
    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));
    expect(onCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ skipPermissions: false }),
    );
  });

  it("on in settings: the tile is flagged, the switch starts on, and the override turns it off", async () => {
    useDashboardStore.setState({ settings: withSkip(["claude"]) });
    const onCreateSession = vi.fn();
    stubFetch({ onCreateSession });
    const user = userEvent.setup();
    renderHost();
    openLauncher();

    expect(
      await screen.findByRole("radio", {
        name: /claude.*skips permission prompts by settings/,
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "codex" })).toBeInTheDocument();
    const toggle = screen.getByRole("switch", { name: "Skip permissions (no permission prompts)" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toHaveAccessibleDescription("On in settings for claude");

    await user.click(toggle);
    expect(toggle).toHaveAccessibleDescription("For this session only (on in settings)");
    await user.click(screen.getByRole("button", { name: "Launch claude" }));

    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));
    expect(onCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ skipPermissions: false }),
    );
  });

  it("on in settings and left alone: launches skipping prompts", async () => {
    useDashboardStore.setState({ settings: withSkip(["claude"]) });
    const onCreateSession = vi.fn();
    stubFetch({ onCreateSession });
    const user = userEvent.setup();
    renderHost();
    openLauncher();

    await user.click(await screen.findByRole("button", { name: "Launch claude" }));
    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));
    expect(onCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ skipPermissions: true }),
    );
  });

  it("an override applies to the agent it was set on only", async () => {
    const onCreateSession = vi.fn();
    stubFetch({ onCreateSession });
    const user = userEvent.setup();
    renderHost();
    openLauncher();

    await user.click(
      await screen.findByRole("switch", { name: "Skip permissions (no permission prompts)" }),
    );
    await user.click(screen.getByRole("radio", { name: "codex" }));
    const toggle = screen.getByRole("switch", { name: "Skip permissions (no permission prompts)" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toHaveAccessibleDescription("Off in settings for codex");
    await user.click(screen.getByRole("button", { name: "Launch codex" }));

    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));
    expect(onCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ command: "codex", skipPermissions: false }),
    );
  });
});

describe("SessionLauncher — keyboard", () => {
  it("typing filters, Enter launches the selected agent", async () => {
    const onCreateSession = vi.fn();
    stubFetch({ onCreateSession });
    const user = userEvent.setup();
    renderHost();
    openLauncher();

    const filter = await screen.findByRole("textbox", {
      name: "Filter agents, shells and scripts",
    });
    await screen.findByRole("radiogroup", { name: "Agent" });
    expect(filter).toHaveFocus();
    await user.keyboard("cod");
    expect(screen.queryByRole("radio", { name: "claude" })).toBeNull();
    expect(screen.getByRole("radio", { name: "codex" })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("button", { name: /bash/ })).toBeNull();
    await user.keyboard("{Enter}");

    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));
    expect(onCreateSession).toHaveBeenCalledWith(expect.objectContaining({ command: "codex" }));
  });

  it("Enter launches the first shell or script once no agent matches", async () => {
    const onCreateSession = vi.fn();
    stubFetch({ onCreateSession });
    const user = userEvent.setup();
    renderHost();
    openLauncher();

    await screen.findByRole("radiogroup", { name: "Agent" });
    await user.keyboard("npm{Enter}");

    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));
    expect(onCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ command: "npm run dev" }),
    );
  });

  it("arrow keys move through the tiles and on into the list", async () => {
    const onCreateSession = vi.fn();
    stubFetch({ onCreateSession });
    const user = userEvent.setup();
    renderHost();
    openLauncher();

    await screen.findByRole("radiogroup", { name: "Agent" });
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("radio", { name: "claude" })).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    const codex = screen.getByRole("radio", { name: "codex" });
    expect(codex).toHaveFocus();
    expect(codex).toHaveAttribute("aria-checked", "true");
    // The options region follows the selection, and says so.
    expect(screen.getByRole("group", { name: "Options for codex" })).toBeInTheDocument();
    expect(screen.getByText(/codex selected/)).toBeInTheDocument();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("button", { name: /bash/ })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("button", { name: /dev/ })).toHaveFocus();
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(codex).toHaveFocus();
    await user.keyboard("{Enter}");

    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));
    expect(onCreateSession).toHaveBeenCalledWith(expect.objectContaining({ command: "codex" }));
  });

  it("typing on a tile moves to the filter", async () => {
    stubFetch();
    const user = userEvent.setup();
    renderHost();
    openLauncher();

    await screen.findByRole("radiogroup", { name: "Agent" });
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("radio", { name: "claude" })).toHaveFocus();
    await user.keyboard("b");
    expect(
      screen.getByRole("textbox", { name: "Filter agents, shells and scripts" }),
    ).toHaveFocus();
  });

  it("Escape closes and returns focus to the trigger", async () => {
    stubFetch();
    const user = userEvent.setup();
    renderHost();
    const trigger = screen.getByRole("button", { name: "trigger" });
    trigger.focus();
    openLauncher();

    await screen.findByRole("radiogroup", { name: "Agent" });
    expect(trigger).not.toHaveFocus();
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useDashboardStore.getState().launcherRequest).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("a launch does not hand focus back to the trigger", async () => {
    stubFetch();
    const user = userEvent.setup();
    const { onLaunched } = renderHost();
    const trigger = screen.getByRole("button", { name: "trigger" });
    trigger.focus();
    openLauncher();

    await user.click(await screen.findByRole("button", { name: "Launch claude" }));
    await waitFor(() => expect(onLaunched).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).not.toHaveFocus();
  });

  it("a project's + preselects that project, which stays changeable", async () => {
    stubFetch({ launchersByProject: { [PROJECT.id]: [CLAUDE], [OTHER.id]: [CODEX] } });
    renderHost();
    act(() => useDashboardStore.getState().openLauncher({ projectId: OTHER.id }));

    expect(await screen.findByRole("radio", { name: "codex" })).toBeInTheDocument();
    const project = screen.getByRole("combobox", { name: "Project" });
    expect(dropdownValue(project)).toBe(String(OTHER.id));
    expect(project).toBeEnabled();
  });

  it("switching the project reloads that project's launchers", async () => {
    stubFetch({ launchersByProject: { [PROJECT.id]: [CLAUDE], [OTHER.id]: [CODEX] } });
    renderHost();
    openLauncher();

    expect(await screen.findByRole("radio", { name: "claude" })).toBeInTheDocument();
    pickDropdownOption(screen.getByRole("combobox", { name: "Project" }), String(OTHER.id));
    expect(await screen.findByRole("radio", { name: "codex" })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "claude" })).toBeNull();
  });
});

describe("SessionLauncher — touch sheet", () => {
  beforeEach(() => {
    stubCoarsePointer();
  });

  it("has two tabs, New session and Open existing, and no filter field", async () => {
    stubFetch();
    const user = userEvent.setup();
    renderHost();
    openLauncher();

    const sheet = await screen.findByRole("dialog", { name: "New session" });
    const tabs = within(sheet).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["New session", "Open existing"]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(await within(sheet).findByRole("radiogroup", { name: "Agent" })).toBeInTheDocument();
    expect(within(sheet).queryByRole("textbox")).toBeNull();

    await user.click(tabs[1]!);
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    expect(within(sheet).getByRole("tabpanel")).toHaveTextContent("No sessions yet.");
  });

  it("Open existing lists sessions by project, the project under each title, and opens one", async () => {
    stubFetch();
    const docs = makeSession({
      id: 7,
      projectId: PROJECT.id,
      name: "docs cleanup",
      nameLocked: true,
    });
    const importer = makeSession({
      id: 8,
      projectId: OTHER.id,
      name: "importer",
      nameLocked: true,
    });
    useDashboardStore.setState({ sessions: [docs, importer] });
    const user = userEvent.setup();
    const { onOpenSession } = renderHost();
    openLauncher({ half: "left" });

    await user.click(await screen.findByRole("tab", { name: "Open existing" }));
    const panel = screen.getByRole("tabpanel");
    const mullion = within(panel).getByRole("region", { name: "mullion" });
    const runway = within(panel).getByRole("region", { name: "runway" });
    const docsRow = within(mullion).getByRole("button", { name: /docs cleanup/ });
    expect(docsRow).toHaveTextContent("mullion");
    expect(within(runway).getByRole("button", { name: /importer/ })).toHaveTextContent("runway");

    await user.click(docsRow);
    expect(onOpenSession).toHaveBeenCalledWith(docs, { half: "left" });
    expect(useDashboardStore.getState().launcherRequest).toBeNull();
  });

  it("launches an agent from the sheet", async () => {
    const onCreateSession = vi.fn();
    stubFetch({ onCreateSession });
    const user = userEvent.setup();
    const { onLaunched } = renderHost();
    openLauncher();

    await user.click(await screen.findByRole("radio", { name: "codex" }));
    await user.click(screen.getByRole("button", { name: "Launch codex" }));
    await waitFor(() => expect(onLaunched).toHaveBeenCalledTimes(1));
    expect(onCreateSession).toHaveBeenCalledWith(expect.objectContaining({ command: "codex" }));
  });

  it("keeps the New session choices across a tab switch", async () => {
    const onCreateSession = vi.fn();
    stubFetch({ onCreateSession });
    const user = userEvent.setup();
    renderHost();
    openLauncher();

    await user.click(await screen.findByRole("radio", { name: "codex" }));
    await user.click(screen.getByRole("tab", { name: "Open existing" }));
    expect(screen.queryByRole("radio", { name: "codex" })).toBeNull();
    await user.click(screen.getByRole("tab", { name: "New session" }));
    expect(screen.getByRole("radio", { name: "codex" })).toHaveAttribute("aria-checked", "true");
  });

  it("starts each open on New session", async () => {
    stubFetch();
    const user = userEvent.setup();
    renderHost();
    openLauncher();
    await user.click(await screen.findByRole("tab", { name: "Open existing" }));
    act(() => useDashboardStore.getState().closeLauncher());
    openLauncher();
    expect(await screen.findByRole("tab", { name: "New session" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});

// #3054 — a launch entry chosen in the command palette opens the launcher on
// that entry; Launch takes focus once the launchers are in, so Enter launches
// it. A split's target passes through to the caller, which places the session.
describe("SessionLauncher — opened from the palette or a split (#3054)", () => {
  it("preselects an agent, focuses Launch, and Enter launches it", async () => {
    const onCreateSession = vi.fn();
    stubFetch({ onCreateSession });
    const user = userEvent.setup();
    renderHost();
    act(() =>
      useDashboardStore.getState().openLauncher({ projectId: OTHER.id, launcherId: CODEX.id }),
    );

    const launch = await screen.findByRole("button", { name: "Launch codex" });
    await waitFor(() => expect(launch).toHaveFocus());
    expect(screen.getByRole("radio", { name: "codex" })).toHaveAttribute("aria-checked", "true");
    expect(dropdownValue(screen.getByRole("combobox", { name: "Project" }))).toBe(String(OTHER.id));
    await user.keyboard("{Enter}");

    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));
    expect(onCreateSession).toHaveBeenCalledWith(expect.objectContaining({ command: "codex" }));
  });

  it("preselects a shell over the default agent, and choosing an agent takes over", async () => {
    const onCreateSession = vi.fn();
    stubFetch({ onCreateSession });
    const user = userEvent.setup();
    renderHost();
    act(() => useDashboardStore.getState().openLauncher({ launcherId: BASH.id }));

    const launch = await screen.findByRole("button", { name: "Launch bash" });
    await waitFor(() => expect(launch).toHaveFocus());
    expect(screen.getByRole("button", { name: "bash" })).toHaveAttribute("aria-current", "true");
    await user.click(screen.getByRole("radio", { name: "codex" }));
    expect(screen.getByRole("button", { name: "Launch codex" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "bash" })).not.toHaveAttribute("aria-current");

    act(() => useDashboardStore.getState().closeLauncher());
    act(() => useDashboardStore.getState().openLauncher({ launcherId: BASH.id }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Launch bash" })).toHaveFocus());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));
    expect(onCreateSession).toHaveBeenCalledWith(expect.objectContaining({ command: "bash" }));
  });

  it("a plain open keeps focus on the filter", async () => {
    stubFetch();
    renderHost();
    openLauncher();
    await screen.findByRole("radiogroup", { name: "Agent" });
    expect(
      screen.getByRole("textbox", { name: "Filter agents, shells and scripts" }),
    ).toHaveFocus();
  });

  it("hands a split target to the caller with the launched session", async () => {
    stubFetch();
    const user = userEvent.setup();
    const { onLaunched } = renderHost();
    act(() => useDashboardStore.getState().requestSplit("session-3", "below", PROJECT.id));

    await user.click(await screen.findByRole("button", { name: "Launch claude" }));
    await waitFor(() => expect(onLaunched).toHaveBeenCalledTimes(1));
    expect(onLaunched).toHaveBeenCalledWith(
      expect.objectContaining({ id: 42 }),
      {
        projectId: PROJECT.id,
        split: { referencePanelId: "session-3", direction: "below" },
      },
      // No workspace chosen (#3246): the active one.
      null,
    );
  });
});

describe("SessionLauncher — a fast Enter from the palette (#3054)", () => {
  it("an Enter pressed while the launchers load launches the preselected entry once they arrive", async () => {
    const onCreateSession = vi.fn();
    let releaseActions: (() => void) | null = null;
    const result = mockFetch({
      "GET /api/projects/:id/actions": () =>
        new Promise<Response>((resolve) => {
          releaseActions = () => resolve(jsonResponse(200, [CLAUDE, CODEX, BASH]));
        }),
      "GET /api/projects/:id/git-branches": () => new Response(null, { status: 204 }),
      "GET /api/codex/models": () => jsonResponse(200, []),
      "GET /api/sessions": () => jsonResponse(200, []),
      "POST /api/sessions": ({ init }) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        onCreateSession(body);
        return jsonResponse(201, { id: 42, projectId: PROJECT.id, command: body.command });
      },
    });
    unexpectedCalls = result.unexpectedCalls;
    vi.stubGlobal("fetch", result.fetchMock);
    const user = userEvent.setup();
    const { onLaunched } = renderHost();
    act(() => useDashboardStore.getState().openLauncher({ launcherId: CODEX.id }));

    await screen.findByText("Loading launchers…");
    await user.keyboard("{Enter}");
    expect(onCreateSession).not.toHaveBeenCalled();
    await waitFor(() => expect(releaseActions).not.toBeNull());
    await act(async () => releaseActions!());

    await waitFor(() => expect(onLaunched).toHaveBeenCalledTimes(1));
    expect(onCreateSession).toHaveBeenCalledTimes(1);
    expect(onCreateSession).toHaveBeenCalledWith(expect.objectContaining({ command: "codex" }));
  });

  // Review of #3061: the palette's list can still be the previous project's
  // when a row is picked, so the id may be missing from the launcher's list.
  it("an id the loaded list lacks is no preselection: the early Enter is dropped and focus stays", async () => {
    const onCreateSession = vi.fn();
    const release = holdActions([CLAUDE, BASH], onCreateSession);
    const user = userEvent.setup();
    renderHost();
    act(() => useDashboardStore.getState().openLauncher({ launcherId: "npm:gone" }));

    await screen.findByText("Loading launchers…");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(release.current).not.toBeNull());
    await act(async () => release.current!());

    await screen.findByRole("radiogroup", { name: "Agent" });
    expect(onCreateSession).not.toHaveBeenCalled();
    expect(
      screen.getByRole("textbox", { name: "Filter agents, shells and scripts" }),
    ).toHaveFocus();
    expect(screen.getByRole("button", { name: "bash" })).not.toHaveAttribute("aria-current");
  });

  // Review of #3061: a hidden agent is in the fetched list but not a tile,
  // so it must not count as found (Launch would run the first row instead).
  it("a hidden agent's id is no preselection either", async () => {
    const onCreateSession = vi.fn();
    useDashboardStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        launchers: { ...DEFAULT_SETTINGS.launchers, hiddenAgents: ["codex"] },
      },
    });
    const release = holdActions([CLAUDE, CODEX, BASH], onCreateSession);
    const user = userEvent.setup();
    renderHost();
    act(() => useDashboardStore.getState().openLauncher({ launcherId: CODEX.id }));

    await screen.findByText("Loading launchers…");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(release.current).not.toBeNull());
    await act(async () => release.current!());

    await screen.findByRole("radiogroup", { name: "Agent" });
    expect(screen.queryByRole("radio", { name: "codex" })).toBeNull();
    expect(onCreateSession).not.toHaveBeenCalled();
    expect(
      screen.getByRole("textbox", { name: "Filter agents, shells and scripts" }),
    ).toHaveFocus();
  });

  it("does not take focus from a user already typing in the filter", async () => {
    const release = holdActions([CLAUDE, CODEX, BASH]);
    const user = userEvent.setup();
    renderHost();
    act(() => useDashboardStore.getState().openLauncher({ launcherId: CODEX.id }));

    await screen.findByText("Loading launchers…");
    const filter = screen.getByRole("textbox", { name: "Filter agents, shells and scripts" });
    await user.keyboard("cod");
    await waitFor(() => expect(release.current).not.toBeNull());
    await act(async () => release.current!());

    await screen.findByRole("button", { name: "Launch codex" });
    expect(filter).toHaveFocus();
    await user.keyboard("e");
    expect(filter).toHaveValue("code");
  });

  it("populates Codex's model options from the live catalog", async () => {
    const result = mockFetch({
      "GET /api/projects/:id/actions": () => jsonResponse(200, [CLAUDE, CODEX]),
      "GET /api/codex/models": () => jsonResponse(200, ["gpt-6-astra", "gpt-6-luna"]),
      "GET /api/projects/:id/git-branches": () => new Response(null, { status: 204 }),
      "GET /api/sessions": () => jsonResponse(200, []),
    });
    unexpectedCalls = result.unexpectedCalls;
    vi.stubGlobal("fetch", result.fetchMock);
    const user = userEvent.setup();
    renderHost();
    act(() => useDashboardStore.getState().openLauncher({ launcherId: CODEX.id }));

    await user.click(await screen.findByRole("radio", { name: "codex" }));
    const select = await screen.findByRole("combobox", { name: "Model for this session" });
    const labels = () => dropdownOptions(select).map((o) => o.label);
    await waitFor(() => expect(labels()).toContain("gpt-6-astra"));
    expect(labels()).toContain("gpt-6-luna");
    // The static fallback list is not shown once the live catalog answers.
    expect(labels()).not.toContain("gpt-6-sol");
  });
});

// #3071 — the launcher is a fixed form: menus and switches never move the rows
// below them, and Add/Edit project replace the body instead of expanding.
describe("SessionLauncher — the fixed form (#3071)", () => {
  const BRANCHES = {
    branches: [
      { name: "main", isCurrent: true },
      { name: "feature/x", isCurrent: false },
    ],
    worktrees: [],
    remoteBranches: [],
    defaultBranch: "main",
  };

  it("the base-branch dropdown is always there, disabled until the switch is on", async () => {
    stubFetch({ branches: BRANCHES });
    const user = userEvent.setup();
    renderHost();
    openLauncher();

    const toggle = await screen.findByRole("switch", { name: "Isolate in a new worktree" });
    const base = await screen.findByRole("combobox", { name: "Base branch" });
    await waitFor(() => expect(dropdownValue(base)).toBe("main"));
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(base).toBeDisabled();
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    // The same element: switching does not insert or remove anything.
    expect(screen.getByRole("combobox", { name: "Base branch" })).toBe(base);
    expect(base).toBeEnabled();
  });

  it("a project without branches shows the reason and no dropdown", async () => {
    stubFetch();
    const user = userEvent.setup();
    renderHost();
    openLauncher();

    expect(await screen.findByText("No branches")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Base branch" })).toBeNull();
    const toggle = screen.getByRole("switch", { name: "Isolate in a new worktree" });
    expect(toggle).toHaveAttribute("aria-disabled", "true");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("a base branch picked in one project does not follow the launch into another", async () => {
    const onCreateSession = vi.fn();
    stubFetch({
      onCreateSession,
      branchesByProject: {
        [PROJECT.id]: BRANCHES,
        [OTHER.id]: {
          ...BRANCHES,
          branches: [{ name: "trunk", isCurrent: true }],
          defaultBranch: "trunk",
        },
      },
    });
    const user = userEvent.setup();
    renderHost();
    act(() => useDashboardStore.getState().openLauncher({ projectId: PROJECT.id }));

    const base = await screen.findByRole("combobox", { name: "Base branch" });
    await waitFor(() => expect(dropdownValue(base)).toBe("main"));
    await user.click(screen.getByRole("switch", { name: "Isolate in a new worktree" }));
    pickDropdownOption(base, "feature/x");
    pickDropdownOption(screen.getByRole("combobox", { name: "Project" }), "runway");
    await waitFor(() =>
      expect(dropdownValue(screen.getByRole("combobox", { name: "Base branch" }))).toBe("trunk"),
    );
    await user.click(await screen.findByRole("button", { name: "Launch claude" }));

    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));
    expect(onCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ worktree: { baseRef: "trunk" } }),
    );
  });

  it("a default branch seeded for one project gives way to the next one's default, even when both have it", async () => {
    const onCreateSession = vi.fn();
    stubFetch({
      onCreateSession,
      branchesByProject: {
        [PROJECT.id]: BRANCHES,
        [OTHER.id]: {
          branches: [
            { name: "main", isCurrent: false },
            { name: "develop", isCurrent: true },
          ],
          worktrees: [],
          remoteBranches: [],
          defaultBranch: "develop",
        },
      },
    });
    const user = userEvent.setup();
    renderHost();
    act(() => useDashboardStore.getState().openLauncher({ projectId: PROJECT.id }));

    const base = await screen.findByRole("combobox", { name: "Base branch" });
    await waitFor(() => expect(dropdownValue(base)).toBe("main"));
    pickDropdownOption(screen.getByRole("combobox", { name: "Project" }), "runway");
    await waitFor(() =>
      expect(dropdownValue(screen.getByRole("combobox", { name: "Base branch" }))).toBe("develop"),
    );
    await user.click(screen.getByRole("switch", { name: "Isolate in a new worktree" }));
    await user.click(await screen.findByRole("button", { name: "Launch claude" }));

    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));
    expect(onCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ worktree: { baseRef: "develop" } }),
    );
  });

  it("a failed branch list offers Retry, and a retry that works brings the dropdown back", async () => {
    let fail = true;
    const result = mockFetch({
      "GET /api/projects/:id/actions": () => jsonResponse(200, [CLAUDE, BASH]),
      "GET /api/projects/:id/git-branches": () =>
        fail ? jsonResponse(503, { message: "Host is unreachable" }) : jsonResponse(200, BRANCHES),
      "GET /api/sessions": () => jsonResponse(200, []),
    });
    unexpectedCalls = result.unexpectedCalls;
    vi.stubGlobal("fetch", result.fetchMock);
    const user = userEvent.setup();
    renderHost();
    openLauncher();

    expect(await screen.findByText(/Could not list branches/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Base branch" })).toBeNull();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    const base = await screen.findByRole("combobox", { name: "Base branch" });
    await waitFor(() => expect(dropdownValue(base)).toBe("main"));
    expect(screen.getByRole("switch", { name: "Isolate in a new worktree" })).not.toHaveAttribute(
      "aria-disabled",
    );
  });

  it("arrow keys and typeahead on the native project dropdown stop before Add project…", async () => {
    // The native select a coarse pointer keeps (#3245): the guard is its.
    stubCoarsePointer();
    stubFetch();
    renderHost();
    act(() => useDashboardStore.getState().openLauncher({ projectId: OTHER.id }));

    const project = await screen.findByRole("combobox", { name: "Project" });
    expect(dropdownValue(project)).toBe(String(OTHER.id));
    // runway is the last project: ArrowDown would land on Add project….
    expect(fireEvent.keyDown(project, { key: "ArrowDown" })).toBe(false);
    expect(fireEvent.keyDown(project, { key: "End" })).toBe(false);
    // "a" starts only Add project…; "m" starts a project and is left alone
    // (once the typeahead window "a" opened has closed).
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    expect(fireEvent.keyDown(project, { key: "a" })).toBe(false);
    now.mockReturnValue(5_000);
    expect(fireEvent.keyDown(project, { key: "m" })).toBe(true);
    now.mockRestore();
    // From the first project, ArrowDown moves on as usual.
    pickDropdownOption(project, "mullion");
    expect(fireEvent.keyDown(project, { key: "ArrowDown" })).toBe(true);
    // End and PageDown from an earlier project stop at the last project
    // rather than jumping to the final option, Add project….
    expect(fireEvent.keyDown(project, { key: "End" })).toBe(false);
    expect(dropdownValue(project)).toBe(String(OTHER.id));
    pickDropdownOption(project, "mullion");
    expect(fireEvent.keyDown(project, { key: "PageDown" })).toBe(false);
    expect(dropdownValue(project)).toBe(String(OTHER.id));
    expect(screen.queryByRole("group", { name: "Add project" })).toBeNull();
  });

  it("a letter on the styled project dropdown is its typeahead, not the launcher's filter", async () => {
    stubFetch();
    renderHost();
    act(() => useDashboardStore.getState().openLauncher({ projectId: PROJECT.id }));

    const project = await screen.findByRole("combobox", { name: "Project" });
    act(() => project.focus());
    fireEvent.keyDown(project, { key: "r" });
    expect(project).toHaveFocus();
    expect(project).toHaveAttribute("aria-expanded", "true");
    const active = document.getElementById(project.getAttribute("aria-activedescendant")!);
    expect(active).toHaveTextContent("runway");
  });

  it("typeahead on a letter a project shares with Add project… cycles the projects only", async () => {
    // The native select a coarse pointer keeps (#3245): the guard is its.
    stubCoarsePointer();
    const ALPHA = { ...PROJECT, id: 7, name: "alpha" };
    const ATLAS = { ...PROJECT, id: 8, name: "atlas" };
    resetStore({
      projects: [ALPHA, ATLAS],
      sessions: [],
      settings: DEFAULT_SETTINGS,
      viewMode: "list",
      activePanelId: null,
    });
    stubFetch();
    renderHost();
    act(() => useDashboardStore.getState().openLauncher({ projectId: ALPHA.id }));

    const project = await screen.findByRole("combobox", { name: "Project" });
    expect(fireEvent.keyDown(project, { key: "a" })).toBe(false);
    expect(dropdownValue(project)).toBe(String(ATLAS.id));
    expect(fireEvent.keyDown(project, { key: "A" })).toBe(false);
    expect(dropdownValue(project)).toBe(String(ALPHA.id));
    expect(screen.queryByRole("group", { name: "Add project" })).toBeNull();
  });

  it("a search that starts with that letter still narrows by the letters after it", async () => {
    // The native select a coarse pointer keeps (#3245): the guard is its.
    stubCoarsePointer();
    const ALPHA = { ...PROJECT, id: 7, name: "alpha" };
    const ATLAS = { ...PROJECT, id: 8, name: "atlas" };
    const MULL = { ...PROJECT, id: 9, name: "mull" };
    resetStore({
      projects: [ALPHA, ATLAS, MULL],
      sessions: [],
      settings: DEFAULT_SETTINGS,
      viewMode: "list",
      activePanelId: null,
    });
    stubFetch();
    renderHost();
    act(() => useDashboardStore.getState().openLauncher({ projectId: MULL.id }));

    const project = await screen.findByRole("combobox", { name: "Project" });
    // "a" then "t" within the typeahead window: atlas, not a fresh "t" search.
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    expect(fireEvent.keyDown(project, { key: "a" })).toBe(false);
    now.mockReturnValue(1_200);
    expect(fireEvent.keyDown(project, { key: "t" })).toBe(false);
    expect(dropdownValue(project)).toBe(String(ATLAS.id));
    // A letter after the window has closed is the browser's again.
    now.mockReturnValue(5_000);
    expect(fireEvent.keyDown(project, { key: "m" })).toBe(true);
    now.mockRestore();
  });

  it("the project ⋯ opens an anchored menu under a fine pointer", async () => {
    stubFetch();
    const user = userEvent.setup();
    renderHost();
    openLauncher();

    const trigger = await screen.findByRole("button", { name: "Manage mullion" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    await user.click(trigger);
    const menu = screen.getByRole("menu", { name: "mullion actions" });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((el) => el.textContent),
    ).toEqual(["Edit", "Git pull", "Delete project", "Add project…"]);
    // Not a dialog of its own, and nothing was inserted into the launcher.
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveFocus();
    // The launcher is still open.
    expect(screen.getByRole("dialog", { name: "New session" })).toBeInTheDocument();
  });

  it("the project ⋯ opens a sheet under a coarse pointer", async () => {
    stubCoarsePointer();
    stubFetch();
    const user = userEvent.setup();
    renderHost();
    openLauncher();

    const trigger = await screen.findByRole("button", { name: "Manage mullion" });
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    await user.click(trigger);
    const sheet = await screen.findByRole("dialog", { name: "mullion actions" });
    const menu = within(sheet).getByRole("menu", { name: "mullion actions" });
    expect(within(menu).getByRole("menuitem", { name: "Add project…" })).toBeInTheDocument();
    await user.click(within(sheet).getByRole("button", { name: "Close project actions" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "mullion actions" })).toBeNull(),
    );
  });

  it("Add project… in the dropdown opens the form view, and Back returns", async () => {
    stubFetch();
    const user = userEvent.setup();
    renderHost();
    openLauncher();

    const project = await screen.findByRole("combobox", { name: "Project" });
    await screen.findByRole("radio", { name: "codex" });
    await user.click(screen.getByRole("radio", { name: "codex" }));
    pickDropdownOption(project, "Add project…");
    // The selection did not move to the sentinel entry.
    const form = screen.getByRole("group", { name: "Add project" });
    expect(screen.queryByRole("radiogroup", { name: "Agent" })).toBeNull();
    await user.click(within(form).getByRole("button", { name: "Back" }));

    const again = await screen.findByRole("combobox", { name: "Project" });
    expect(dropdownValue(again)).toBe(String(PROJECT.id));
    await waitFor(() => expect(again).toHaveFocus());
    // The choices made before survive the round trip.
    expect(await screen.findByRole("radio", { name: "codex" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("an Edit view whose project is deleted elsewhere goes back to the launcher", async () => {
    stubFetch();
    const user = userEvent.setup();
    renderHost();
    openLauncher();

    await user.click(await screen.findByRole("button", { name: "Manage mullion" }));
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    expect(screen.getByRole("group", { name: "Edit project" })).toBeInTheDocument();
    act(() => useDashboardStore.setState({ projects: [OTHER] }));
    expect(await screen.findByRole("combobox", { name: "Project" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Edit project" })).toBeNull();
  });

  it("with no project yet, the dropdown still offers Add project…", async () => {
    resetStore({
      projects: [],
      sessions: [],
      settings: DEFAULT_SETTINGS,
      viewMode: "list",
      activePanelId: null,
    });
    stubFetch();
    renderHost();
    openLauncher();

    const project = await screen.findByRole("combobox", { name: "Project" });
    expect(
      within(openDropdown(project))
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["No projects yet", "Add project…"]);
    pickDropdownOption(project, "Add project…");
    expect(screen.getByRole("group", { name: "Add project" })).toBeInTheDocument();
  });
});

// #3246 — on the phone the launcher names the workspace a new session joins.
describe("SessionLauncher — phone Workspace row", () => {
  const A = makeWorkspace({ id: 1, name: "Default" });
  const B = makeWorkspace({ id: 2, name: "Review", groupId: 9, position: 0 });

  beforeEach(() => {
    stubCoarsePointer();
    useDashboardStore.setState({
      workspaces: [A, B],
      groups: [{ id: 9, name: "Work", position: 0, createdAt: "2026-01-01T00:00:00.000Z" }],
      activeWorkspaceId: A.id,
    } as never);
  });

  it("shows on the phone with two workspaces, preselected to the active one, grouped like the picker", async () => {
    stubFetch();
    renderHost({ phone: true });
    openLauncher();

    const row = await screen.findByRole("combobox", { name: "Workspace" });
    expect(row).toHaveValue(String(A.id));
    expect(
      within(row)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Work / Review", "Default"]);
  });

  it("lists a workspace whose group has not loaded yet, last, under its own name", async () => {
    useDashboardStore.setState({ groups: [] });
    stubFetch({ groups: [] });
    renderHost({ phone: true });
    openLauncher();

    const row = await screen.findByRole("combobox", { name: "Workspace" });
    expect(
      within(row)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Default", "Review"]);
  });

  it("with one workspace, is not shown and loads no groups", async () => {
    useDashboardStore.setState({ workspaces: [A], groups: [] });
    const { fetchMock } = stubFetch();
    renderHost({ phone: true });
    openLauncher();

    await screen.findByRole("radiogroup", { name: "Agent" });
    expect(screen.queryByRole("combobox", { name: "Workspace" })).toBeNull();
    const urls = fetchMock.mock.calls.map((call) => String((call as unknown[])[0]));
    expect(urls.some((url) => url.startsWith("/api/groups"))).toBe(false);
  });

  it("is not shown off the phone (the fold's sheet, or the desktop dialog)", async () => {
    stubFetch();
    renderHost({ phone: false });
    openLauncher();

    await screen.findByRole("radiogroup", { name: "Agent" });
    expect(screen.queryByRole("combobox", { name: "Workspace" })).toBeNull();
  });

  it("a launch with another workspace chosen passes it on; the active one passes null", async () => {
    stubFetch();
    const user = userEvent.setup();
    const { onLaunched } = renderHost({ phone: true });
    openLauncher();

    await user.selectOptions(await screen.findByRole("combobox", { name: "Workspace" }), "2");
    await user.click(await screen.findByRole("button", { name: /bash/ }));
    await waitFor(() => expect(onLaunched).toHaveBeenCalledTimes(1));
    expect(onLaunched).toHaveBeenCalledWith(expect.objectContaining({ id: 42 }), null, B.id);

    openLauncher();
    await user.click(await screen.findByRole("button", { name: /bash/ }));
    await waitFor(() => expect(onLaunched).toHaveBeenCalledTimes(2));
    expect(onLaunched).toHaveBeenLastCalledWith(expect.objectContaining({ id: 42 }), null, null);
  });

  it("the choice is per launch: closing without starting a session changes nothing", async () => {
    stubFetch();
    const user = userEvent.setup();
    const { onLaunched } = renderHost({ phone: true });
    openLauncher();

    await user.selectOptions(await screen.findByRole("combobox", { name: "Workspace" }), "2");
    act(() => useDashboardStore.getState().closeLauncher());
    expect(useDashboardStore.getState().activeWorkspaceId).toBe(A.id);
    expect(onLaunched).not.toHaveBeenCalled();

    openLauncher();
    expect(await screen.findByRole("combobox", { name: "Workspace" })).toHaveValue(String(A.id));
  });
});
