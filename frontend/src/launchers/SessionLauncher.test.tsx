// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionLauncherHost } from "./SessionLauncher.js";
import { DEFAULT_SETTINGS } from "../api/index.js";
import type { AppSettings, Launcher, Project } from "../api/index.js";
import { jsonResponse } from "../test/jsonResponse.js";
import { mockFetch } from "../test/mockFetch.js";
import { makeSession } from "../test/fixtures.js";
import { resetStore } from "../test/resetStore.js";
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
    "GET /api/projects/:id/git-branches": () =>
      opts.branches ? jsonResponse(200, opts.branches) : new Response(null, { status: 204 }),
    "GET /api/codex/models": empty,
    "GET /api/agy/models": empty,
    "GET /api/opencode/models": empty,
    "GET /api/mcode/models": empty,
    "GET /api/sessions": empty,
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

function renderHost(overrides: { onLaunched?: () => void; onOpenSession?: () => void } = {}) {
  const onLaunched = overrides.onLaunched ?? vi.fn();
  const onOpenSession = overrides.onOpenSession ?? vi.fn();
  const utils = render(
    <>
      <button type="button">trigger</button>
      <SessionLauncherHost
        panels={[]}
        phone={false}
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
    expect(within(dialog).getByText("Isolate in a new worktree")).toBeInTheDocument();
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
    await user.selectOptions(model, "opusplan");
    await user.click(screen.getByRole("button", { name: "Launch claude" }));

    await waitFor(() => expect(onLaunched).toHaveBeenCalledTimes(1));
    expect(onCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ command: "claude", model: "opusplan", skipPermissions: false }),
    );
    expect(onLaunched).toHaveBeenCalledWith(expect.objectContaining({ id: 42 }), {
      half: "right",
    });
    expect(useDashboardStore.getState().launcherRequest).toBeNull();
  });

  it("does not carry a model picked for one agent over to another", async () => {
    const onCreateSession = vi.fn();
    stubFetch({ onCreateSession });
    const user = userEvent.setup();
    renderHost();
    openLauncher();

    await user.selectOptions(
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

    await user.click(await screen.findByRole("checkbox", { name: /Isolate in a new worktree/ }));
    const base = await screen.findByDisplayValue(/main/);
    await user.selectOptions(base, "feature/x");
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
        .filter((el) => el.classList.contains("session-launcher-option"))
        .map((el) => el.className + ":" + [...el.children].map((c) => c.className).join("|"))
        .slice(-1)[0];
    };
    await screen.findByRole("switch", { name: "Skip permission prompts" });
    const claude = shape();
    await user.click(screen.getByRole("radio", { name: "opencode" }));
    const toggle = await screen.findByRole("switch", { name: "Skip permission prompts" });
    expect(toggle).toHaveAccessibleDescription("Off in settings for opencode");
    expect(shape()).toBe(claude);
    // The row is a two-column grid in CSS, not a wrapping flex row.
    expect(launcherCss).toMatch(/\.session-launcher-options \{[^}]*display:\s*grid/);
  });

  it("off in settings: the switch starts off, launches off, and the override turns it on", async () => {
    const onCreateSession = vi.fn();
    stubFetch({ onCreateSession });
    const user = userEvent.setup();
    renderHost();
    openLauncher();

    const toggle = await screen.findByRole("switch", { name: "Skip permission prompts" });
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
    const toggle = screen.getByRole("switch", { name: "Skip permission prompts" });
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

    await user.click(await screen.findByRole("switch", { name: "Skip permission prompts" }));
    await user.click(screen.getByRole("radio", { name: "codex" }));
    const toggle = screen.getByRole("switch", { name: "Skip permission prompts" });
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
    expect(project).toHaveValue(String(OTHER.id));
    expect(project).toBeEnabled();
  });

  it("switching the project reloads that project's launchers", async () => {
    stubFetch({ launchersByProject: { [PROJECT.id]: [CLAUDE], [OTHER.id]: [CODEX] } });
    const user = userEvent.setup();
    renderHost();
    openLauncher();

    expect(await screen.findByRole("radio", { name: "claude" })).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Project" }), String(OTHER.id));
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
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue(String(OTHER.id));
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
    expect(onLaunched).toHaveBeenCalledWith(expect.objectContaining({ id: 42 }), {
      projectId: PROJECT.id,
      split: { referencePanelId: "session-3", direction: "below" },
    });
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
      "GET /api/sessions": () => jsonResponse(200, []),
    });
    unexpectedCalls = result.unexpectedCalls;
    vi.stubGlobal("fetch", result.fetchMock);
    const user = userEvent.setup();
    renderHost();
    act(() => useDashboardStore.getState().openLauncher({ launcherId: CODEX.id }));

    await user.click(await screen.findByRole("radio", { name: "codex" }));
    const select = await screen.findByRole("combobox", { name: "Model for this session" });
    await waitFor(() =>
      expect(within(select).getByRole("option", { name: "gpt-6-astra" })).toBeInTheDocument(),
    );
    expect(within(select).getByRole("option", { name: "gpt-6-luna" })).toBeInTheDocument();
    // The static fallback list is not shown once the live catalog answers.
    expect(within(select).queryByRole("option", { name: "gpt-6-sol" })).toBeNull();
  });
});
